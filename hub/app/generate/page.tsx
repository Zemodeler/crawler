"use client";

/**
 * The conversion workspace.
 *
 * A run can take minutes and spends real money or subscription quota, so the
 * screen is built around three commitments: you see the topic list before any
 * content is generated, you see the complete list of files before anything is
 * written, and you can watch exactly why a card was rejected while it happens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SubjectControl, useModuleSubject } from "../subject-control.tsx";

import { fetchPacksStatus, fetchTree, rebuildAllPacks, rebuildPacks, hostModuleHandle, loadModule, pickModule } from "../../lib/library.ts";

import { Markdown } from "../markdown.tsx";
import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { approxTokens, estimateCost, formatUsd } from "../../lib/ai/models.ts";
import { effectiveModel, isHosted, loadSettings } from "../../lib/ai/settings.ts";
import { AiError, PROVIDER_LABELS } from "../../lib/ai/types.ts";
import {
  ConversionRun,
  STAGE_LABELS,
  discardRun,
  loadRun,
  planDiff,
  readManifest,
  validateStaged,
  type ConversionMode,
  type DiffRow,
  type RunSnapshot,
  type StagedFile,
} from "../../lib/conversion-run.ts";
import { normaliseTopicName, parseCSV, validateCourse, type FormatReport } from "../../lib/course-format.ts";
import {
  collectDirectory,
  hasPermission,
  loadHandles,
  type DirectoryHandle,
  type LocalFile,
  type Manifest,
} from "../../lib/course-fs.ts";
import type { PlanResult, PlanTopic } from "../../lib/ai-conversion.ts";
import type { Extract } from "../../lib/source-extract.ts";
import { getProfile } from "../../lib/subject-profiles.ts";
import { SOURCE_CATEGORIES, fileName, parseSourceParams } from "../../lib/exam-focus.ts";

type Phase = "loading" | "no-folder" | "intro" | "extracting" | "plan-review" | "running" | "review" | "written" | "error";

const COST_CONFIRM_THRESHOLD = 1;

export default function Generate() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [mode, setMode] = useState<ConversionMode>("generate");
  const [handle, setHandle] = useState<DirectoryHandle | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [diff, setDiff] = useState<DiffRow[]>([]);
  const [expanded, setExpanded] = useState<string>("");
  const [message, setMessage] = useState("");
  const [resumable, setResumable] = useState<RunSnapshot | null>(null);
  const [syllabus, setSyllabus] = useState("");
  const [busy, setBusy] = useState(false);
  /** Set when the desktop app is already building this module's packs in the background. */
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [moduleKey, setModuleKey] = useState("");
  /**
   * The source files chosen for this run, by path. null means every source file
   * in the module. The Assessments page opens this page with the files it picked
   * automatically for an exam; the student can change them or go back to all.
   */
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedFor, setPickedFor] = useState("");

  const subject = useModuleSubject(handle, files);
  const profile = subject.profile;
  /** The files a student can pick between: the course material the packs are built from. */
  const candidates = useMemo(
    () => files.filter((file) => SOURCE_CATEGORIES.includes(file.category)),
    [files],
  );
  /** The files a run reads: every non-source file, and only the picked source files. */
  const activeFiles = useMemo(() => {
    if (!picked) return files;
    const chosen = new Set(picked);
    return files.filter((file) => !SOURCE_CATEGORIES.includes(file.category) || chosen.has(file.path));
  }, [files, picked]);
  const report = useMemo(() => subject.choice ? validateCourse(files, {
    courseName: handle?.name,
    manifestPresent: Boolean(manifest),
  }, profile) : null, [files, handle, manifest, profile, subject.choice]);

  const runRef = useRef<ConversionRun | null>(null);
  const extractsRef = useRef<Map<string, Extract>>(new Map());
  const settings = useMemo(() => loadSettings(), []);

  /* --------------------------------------------------------------- load */

  useEffect(() => {
    // The query string and the remembered folder handle both live outside React,
    // so reading them on mount is what effects are for. There is no server-side
    // value to hydrate against, which rules out a lazy state initialiser.
    const requested = new URLSearchParams(window.location.search).get("mode");
    const preselected = parseSourceParams(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requested === "restructure" || requested === "scaffold") setMode(requested);
    /** Keeps only the preselected files this module really has. */
    const preselect = (imported: LocalFile[]) => {
      const known = new Set(imported.map((file) => file.path));
      const valid = preselected.sources.filter((path) => known.has(path));
      setPicked(valid.length ? valid : null);
      setPickedFor(valid.length && preselected.auto ? preselected.exam : "");
    };

    (async () => {
      try {
        if (isHosted()) {
          // The desktop app: convert the module open on the hub, read from My
          // Studies and written back through the host.
          const tree = await fetchTree();
          const target = pickModule(tree, preselected.module || undefined);
          if (!target) {
            setPhase("no-folder");
            return;
          }
          const key = `${target.year}/${target.module}`;
          setModuleKey(key);
          const moduleHandle = hostModuleHandle(key);
          const imported = await loadModule(tree, target.year, target.module);
          const loadedManifest = await readManifest(moduleHandle);
          setHandle(moduleHandle);
          setFiles(imported);
          preselect(imported);
          setManifest(loadedManifest);
          setResumable(await loadRun(moduleHandle.name));
          setPhase("intro");
          return;
        }
        const { active, handles } = await loadHandles();
        const found = handles.find((entry) => entry.name === active) || handles[0];
        if (!found || !(await hasPermission(found, "read"))) {
          setPhase("no-folder");
          return;
        }
        const imported = await collectDirectory(found);
        const loadedManifest = await readManifest(found);
        setHandle(found);
        setFiles(imported);
        preselect(imported);
        setManifest(loadedManifest);
        setResumable(await loadRun(found.name));
        setPhase("intro");
      } catch (error) {
        setMessage((error as Error).message);
        setPhase("error");
      }
    })();
  }, []);

  /** The module the desktop app is building packs for right now, if any. */
  const [packsModule, setPacksModule] = useState<string | null>(null);

  useEffect(() => {
    if (!moduleKey) return;
    const check = () =>
      fetchPacksStatus()
        .then((status) => {
          setPacksModule(status.state === "running" ? status.module : null);
          setAutoBuilding(status.state === "running" && status.module === moduleKey);
        })
        .catch(() => {
          setPacksModule(null);
          setAutoBuilding(false);
        });
    check();
    const timer = setInterval(check, 15_000);
    return () => clearInterval(timer);
  }, [moduleKey]);

  const [rebuilding, setRebuilding] = useState(false);
  const startRebuild = (request: () => Promise<unknown>) => {
    setRebuilding(true);
    setMessage("");
    request()
      .then(() => fetchPacksStatus())
      .then((status) => {
        setPacksModule(status.state === "running" ? status.module : null);
        setAutoBuilding(status.state === "running" && status.module === moduleKey);
      })
      .catch((error) => setMessage((error as Error).message))
      .finally(() => setRebuilding(false));
  };

  const fail = useCallback((error: unknown) => {
    const aiError = error as AiError;
    if (aiError?.code === "aborted") {
      setMessage("Cancelled. Nothing was written to your folder.");
      setPhase("intro");
      return;
    }
    setMessage([aiError?.message, aiError?.hint, aiError?.detail].filter(Boolean).join(" — "));
    setPhase("error");
  }, []);

  /* ------------------------------------------------------------- actions */

  const start = async () => {
    if (!handle || !report) return;
    if (!subject.choice?.confirmed) return;
    setBusy(true);
    setMessage("");
    const run = ConversionRun.create(handle.name, mode, { onChange: setSnapshot }, { profile: profile.id });
    runRef.current = run;
    setPhase("extracting");
    try {
      const client = mode === "generate" ? await createConfiguredAiClient() : null;
      const result = await run.plan({ client, files: activeFiles, report, pastedSyllabus: syllabus });
      extractsRef.current = result?.extracts ?? new Map();
      if (!result) {
        // Restructure and scaffold need no plan and no AI.
        await stageScaffoldOnly(run);
        return;
      }
      setPlan(result.plan);
      setExcluded(new Set());
      setPhase("plan-review");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const stageScaffoldOnly = async (run: ConversionRun) => {
    const emptyPlan: PlanResult = {
      subject: handle?.name || "Course",
      level: "unknown",
      examFormat: "unknown",
      examTarget: [`Know the syllabus, the ${profile.terms.authorities}, and how to apply them under exam conditions.`],
      topics: [],
      excluded: [],
      unreadable: [],
    };
    const staged = run.buildScaffold(emptyPlan, files, []);
    run.state.staged.push(...staged);
    setSnapshot({ ...run.state, staged });
    setDiff(planDiff(staged, files, manifest, false));
    setPhase("review");
  };

  const runGeneration = async () => {
    const run = runRef.current;
    if (!run || !plan) return;
    setBusy(true);
    setPhase("running");
    try {
      const client = await createConfiguredAiClient();
      const chosen: PlanResult = {
        ...plan,
        topics: plan.topics
          .filter((topic) => !excluded.has(topic.number))
          .map((topic, index) => ({ ...topic, number: index + 1, name: normaliseTopicName(topic.name) })),
      };
      const existing = new Map(files.filter((file) => file.text).map((file) => [file.path, file.text!]));
      const staged = await run.generate({
        client,
        plan: chosen,
        files: activeFiles,
        extracts: extractsRef.current,
        existing,
      });
      setDiff(planDiff(staged, files, manifest, false));
      setPhase("review");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const write = async () => {
    const run = runRef.current;
    if (!run || !handle) return;
    setBusy(true);
    try {
      const { results, remap } = await run.commit({ handle, files, manifest, allowUpdate: false });
      const created = results.filter((result) => result.action === "create").length;
      const pinned = results.filter((result) => result.action === "pinned").length;
      setMessage(
        [
          `Wrote ${created} file${created === 1 ? "" : "s"}.`,
          pinned ? `${pinned} left untouched because you had edited them.` : "",
          remap,
        ]
          .filter(Boolean)
          .join(" "),
      );
      setPhase("written");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------------------------------------------- views */

  if (phase === "loading")
    return (
      <main className="hub-page">
        <div className="hub-card">
          <p className="hub-lede">Reading your folder…</p>
        </div>
      </main>
    );

  if (phase === "no-folder")
    return (
      <main className="hub-page">
        <div className="hub-card">
          <BackLink />
          <h1>No folder open</h1>
          <p className="hub-lede">
            Open a course folder on the main page first — Study Hub needs to see your materials before
            it can build anything from them.
          </p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="btn btn-primary" href="/">
            Choose a folder
          </a>
        </div>
      </main>
    );

  return (
    <main className="hub-page">
      <div className="hub-card">
        <BackLink />
        <h1>Build packs and flashcards</h1>
        <p>Conversion subject: {subject.choice ? profile.label : "Loading subject…"}</p>
        <SubjectControl target={handle} subject={subject} disabled={busy || !["intro", "error"].includes(phase)} />
        <p className="hub-lede">
          From <b>{handle?.name}</b> — {files.length} files, {report?.counts.sources ?? 0} of them
          lectures, transcripts, seminars or past papers.
        </p>

        {message && (
          <div className={phase === "error" ? "callout callout-warn" : "callout"}>
            <b>{phase === "error" ? "Something went wrong" : phase === "written" ? "Done" : "Conversion stopped"}</b>
            {message}
          </div>
        )}

        {autoBuilding && ["intro", "error"].includes(phase) && (
          <div className="callout">
            <b>Study Hub is already building this module&apos;s packs</b>
            It started on its own after the last sync and works in the background. Its packs and flashcards
            appear here when it finishes, so there is no need to build them again. Starting your own run now
            works too, but spends twice the usage.
          </div>
        )}

        {["intro", "error"].includes(phase) && moduleKey && (
          <div className="callout">
            <b>Rebuild with the latest material</b>
            Your assistant rebuilds the study packs and flashcards in the background, with no review step. It
            reads new course files, your own files and notes in My Files, and starts from the current packs to
            improve on them. Files you edited are kept as they are.{" "}
            <button disabled={autoBuilding || rebuilding} onClick={() => startRebuild(() => rebuildPacks(moduleKey))}>
              {autoBuilding ? "Rebuilding…" : "Rebuild this module"}
            </button>{" "}
            <button className="secondary" disabled={rebuilding} onClick={() => startRebuild(rebuildAllPacks)}>
              Rebuild all modules
            </button>
            {packsModule && (
              <p>Building packs now: {packsModule.split("/").slice(1).join("/")}. Others wait their turn.</p>
            )}
          </div>
        )}

        {phase === "intro" && (
          <IntroPanel
            mode={mode}
            setMode={setMode}
            report={report}
            files={activeFiles}
            candidates={candidates}
            picked={picked}
            setPicked={(paths) => {
              setPicked(paths);
              setPickedFor("");
            }}
            pickedFor={pickedFor}
            settings={settings}
            resumable={resumable}
            syllabus={syllabus}
            setSyllabus={setSyllabus}
            busy={busy}
            subjectConfirmed={Boolean(subject.choice?.confirmed)}
            onStart={start}
            onDiscardResume={async () => {
              if (handle) await discardRun(handle.name);
              setResumable(null);
            }}
          />
        )}

        {(phase === "extracting" || phase === "running") && snapshot && (
          <ProgressPanel snapshot={snapshot} onCancel={() => runRef.current?.cancel()} />
        )}

        {phase === "plan-review" && plan && (
          <PlanReview
            plan={plan}
            setPlan={setPlan}
            excluded={excluded}
            setExcluded={setExcluded}
            busy={busy}
            onBack={() => setPhase("intro")}
            onGo={runGeneration}
          />
        )}

        {(phase === "review" || phase === "written") && snapshot && (
          <ReviewPanel
            snapshot={snapshot}
            diff={diff}
            files={files}
            expanded={expanded}
            setExpanded={setExpanded}
            written={phase === "written"}
            busy={busy}
            onWrite={write}
          />
        )}
      </div>

      {snapshot?.log.length ? <LogPanel snapshot={snapshot} authorities={profile.terms.authorities} /> : null}
    </main>
  );
}

function BackLink() {
  return (
    /* A full page load is wanted: the workspace re-reads the folder on mount. */
    /* eslint-disable-next-line @next/next/no-html-link-for-pages */
    <a className="hub-back" href="/">
      ← Back to Study Hub
    </a>
  );
}

function IntroPanel({
  mode,
  setMode,
  report,
  files,
  candidates,
  picked,
  setPicked,
  pickedFor,
  settings,
  resumable,
  syllabus,
  setSyllabus,
  busy,
  subjectConfirmed,
  onStart,
  onDiscardResume,
}: {
  mode: ConversionMode;
  setMode: (mode: ConversionMode) => void;
  report: FormatReport | null;
  /** The files a run will read, after any source picking. */
  files: LocalFile[];
  /** Every source file the student could pick from. */
  candidates: LocalFile[];
  picked: string[] | null;
  setPicked: (paths: string[] | null) => void;
  /** The assessment the picked files were chosen for automatically, if any. */
  pickedFor: string;
  settings: ReturnType<typeof loadSettings>;
  resumable: RunSnapshot | null;
  syllabus: string;
  setSyllabus: (value: string) => void;
  busy: boolean;
  subjectConfirmed: boolean;
  onStart: () => void;
  onDiscardResume: () => void;
}) {
  const sources = files.filter((file) =>
    ["Source materials", "Seminars", "Past papers", "Course materials"].includes(file.category),
  );
  // Rough, and labelled as such — a real tokenizer is not worth the bundle.
  const estimatedInput = sources.reduce(
    (total, file) => total + approxTokens(file.text || "") + (file.text ? 0 : Math.min(file.file.size / 12, 40_000)),
    0,
  );
  const topics = Math.max(report?.topics.length || 0, 8);
  const perTopicOut = 13_000;
  const model = effectiveModel(settings);
  const low = estimateCost(settings.provider, model, estimatedInput, topics * perTopicOut);
  const high = low === null ? null : low * 2.2;
  const subscription = settings.transport === "subscription";
  const [changing, setChanging] = useState(false);
  const chosen = picked ?? candidates.map((file) => file.path);
  const shown = picked
    ? picked.slice(0, 3).map(fileName).join(", ") + (picked.length > 3 ? ` and ${picked.length - 3} more` : "")
    : `all ${candidates.length} course files`;

  return (
    <>
      {resumable && (
        <div className="callout callout-warn">
          <b>An earlier run was interrupted</b>
          It stopped at &ldquo;{STAGE_LABELS[resumable.stage]}&rdquo; with {resumable.staged.length} files
          staged. Nothing was written to your folder. Starting again re-reads your materials from the
          cache, so extraction will be quick.
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={onDiscardResume}>
              Discard it
            </button>
          </div>
        </div>
      )}

      <h3>What to build</h3>
      <div className="choice-grid">
        <button
          className="choice"
          aria-pressed={mode === "generate"}
          onClick={() => setMode("generate")}
        >
          <b>Packs and flashcards</b>
          <small>
            Reads your lectures and transcripts, proposes a topic list for you to approve, then writes a
            topic pack and two flashcard decks per topic, plus the revision guides.
          </small>
        </button>
        <button
          className="choice"
          aria-pressed={mode === "restructure"}
          onClick={() => setMode("restructure")}
        >
          <b>Structure only</b>
          <small>
            Creates the hub and an index of your original materials, with working links. No AI, no cost,
            no new writing.
          </small>
        </button>
      </div>

      {mode === "generate" && candidates.length > 0 && (
        <>
          <h3>Course files to read</h3>
          <p>
            Using: {shown}
            {pickedFor && <> (picked for {pickedFor})</>}
            {" · "}
            <button className="text-link" aria-expanded={changing} onClick={() => setChanging(!changing)}>
              Change
            </button>
          </p>
          {changing && (
            <fieldset className="source-picker">
              <legend>Build from these files</legend>
              {candidates.map((file) => (
                <label key={file.path}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(file.path)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...chosen, file.path]
                        : chosen.filter((path) => path !== file.path);
                      setPicked(next.length === candidates.length ? null : next);
                    }}
                  />
                  <span>{file.path}</span>
                </label>
              ))}
              {picked && (
                <button className="text-link" onClick={() => setPicked(null)}>
                  Use all course files
                </button>
              )}
            </fieldset>
          )}
        </>
      )}

      {mode === "generate" && !report?.canConvert && (
        <div className="field">
          <label htmlFor="syllabus">Paste your syllabus</label>
          <textarea
            id="syllabus"
            rows={6}
            value={syllabus}
            onChange={(event) => setSyllabus(event.target.value)}
            placeholder="Topic list, module handbook, or reading list…"
          />
          <small>
            There are no readable lectures or transcripts in this folder, so Study Hub has nothing to
            work from unless you paste something here. It will never invent a syllabus from the folder
            name.
          </small>
        </div>
      )}

      {mode === "generate" && (
        <>
          <h3>What it will cost</h3>
          <div className="cost-line">
            <span>Files sent to {PROVIDER_LABELS[settings.provider]}</span>
            <b>
              {sources.length} ({Math.round(estimatedInput / 1000)}k tokens, approx.)
            </b>
          </div>
          <div className="cost-line">
            <span>Requests</span>
            <b>about {topics * 4 + 5}</b>
          </div>
          <div className="cost-line">
            <span>Estimated cost</span>
            <b>
              {subscription
                ? "Your subscription quota"
                : low === null
                  ? "Depends on your model's rates"
                  : `${formatUsd(low)} – ${formatUsd(high!)}`}
            </b>
          </div>
          {subscription ? (
            <div className="callout">
              <b>Using your subscription</b>
              This runs {topics * 4 + 5} requests on this computer, one at a time. Expect
              several minutes. Heavy use can hit your subscription&rsquo;s own rate limits.
            </div>
          ) : (
            low !== null &&
            high! > COST_CONFIRM_THRESHOLD && (
              <div className="callout callout-warn">
                <b>This run may cost more than {formatUsd(COST_CONFIRM_THRESHOLD)}</b>
                The estimate is rough — it depends on how much text your lectures contain. You can
                cancel at any point, and nothing is written to your folder until you approve the file
                list.
              </div>
            )
          )}
          <div className="callout">
            <b>What leaves your device</b>
            The text of those {sources.length} files, and nothing else. Your flashcard progress,
            reading history and notes are never sent.
          </div>
        </>
      )}

      <div className="btn-row">
        <button
          className="btn btn-primary"
          onClick={onStart}
          disabled={busy || !subjectConfirmed || !report || (mode === "generate" && picked?.length === 0)}
        >
          {mode === "generate" ? "Read my materials and propose topics" : "Build the structure"}
        </button>
      </div>
    </>
  );
}

function ProgressPanel({ snapshot, onCancel }: { snapshot: RunSnapshot; onCancel: () => void }) {
  const done = snapshot.topics.filter((topic) => topic.status === "done" || topic.status === "degraded").length;
  // Ticked from an effect rather than read during render: a clock read while
  // rendering only advances when something else happens to re-render, so the
  // counter would sit still for minutes at a time during a long model call.
  const [elapsed, setElapsed] = useState(0);
  const startedAt = snapshot.startedAt;
  useEffect(() => {
    const update = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <>
      <div className="run-head">
        <div>
          <h2 style={{ margin: 0 }}>{STAGE_LABELS[snapshot.stage]}</h2>
          <div className="run-meta">
            {snapshot.topics.length > 0 && (
              <span>
                {done} of {snapshot.topics.length} topics
              </span>
            )}
            <span>
              {Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed
            </span>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div>
        {(["extract", "plan", "packs", "decks", "guides", "assemble"] as const).map((stage) => {
          const order = ["extract", "plan", "packs", "decks", "guides", "assemble", "review", "write", "done"];
          const position = order.indexOf(stage);
          const current = order.indexOf(snapshot.stage);
          const state = position < current ? "done" : position === current ? "running" : "";
          return (
            <div className={`run-stage ${state}`} key={stage}>
              <div>
                <i />
                <b>{STAGE_LABELS[stage]}</b>
              </div>
            </div>
          );
        })}
      </div>

      {snapshot.topics.length > 0 && (
        <div className="run-topics">
          {snapshot.topics.map((topic) => (
            <div key={topic.key}>
              <b>{topic.label}</b>
              <span>
                {topic.status === "running"
                  ? `working — ${topic.detail || ""}`
                  : topic.status === "queued"
                    ? "waiting"
                    : topic.status === "degraded"
                      ? `needs review — ${topic.detail || ""}`
                      : topic.status === "failed"
                        ? `failed — ${topic.detail || ""}`
                        : topic.detail || "done"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="callout">
        <b>You can leave this running</b>
        Nothing is written to your folder until you approve the file list. If you close this tab, the
        work done so far is kept and you can pick it up again.
      </div>
    </>
  );
}

function PlanReview({
  plan,
  setPlan,
  excluded,
  setExcluded,
  busy,
  onBack,
  onGo,
}: {
  plan: PlanResult;
  setPlan: (plan: PlanResult) => void;
  excluded: Set<number>;
  setExcluded: (value: Set<number>) => void;
  busy: boolean;
  onBack: () => void;
  onGo: () => void;
}) {
  const setTopic = (number: number, patch: Partial<PlanTopic>) =>
    setPlan({
      ...plan,
      topics: plan.topics.map((topic) => (topic.number === number ? { ...topic, ...patch } : topic)),
    });
  const keeping = plan.topics.filter((topic) => !excluded.has(topic.number));

  return (
    <>
      <h3>Check the topic list before anything is written</h3>
      <p className="hub-lede">
        This is the plan for <b>{plan.subject}</b>, read from your own materials. Correct any names and
        untick anything your exam does not cover — each topic you keep costs four requests.
      </p>

      <table className="plan-table">
        <thead>
          <tr>
            <th style={{ width: 34 }}>Keep</th>
            <th style={{ width: 34 }}>#</th>
            <th>Topic</th>
            <th style={{ width: "38%" }}>Built from</th>
          </tr>
        </thead>
        <tbody>
          {plan.topics.map((topic) => (
            <tr key={topic.number}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Keep ${topic.name}`}
                  checked={!excluded.has(topic.number)}
                  onChange={(event) => {
                    const next = new Set(excluded);
                    if (event.target.checked) next.delete(topic.number);
                    else next.add(topic.number);
                    setExcluded(next);
                  }}
                />
              </td>
              <td>{topic.number}</td>
              <td>
                <input
                  type="text"
                  value={topic.name}
                  aria-label={`Name of topic ${topic.number}`}
                  onChange={(event) => setTopic(topic.number, { name: event.target.value })}
                />
                {topic.note && <small>{topic.note}</small>}
              </td>
              <td>
                <small>
                  {topic.sourceFiles.length
                    ? topic.sourceFiles.map((file) => file.split("/").pop()).join(", ")
                    : "no source file matched"}
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {plan.excluded.length > 0 && (
        <div className="callout">
          <b>Left out on purpose</b>
          {plan.excluded.map((entry) => `${entry.name} — ${entry.reason}`).join("; ")}
        </div>
      )}
      {plan.unreadable.length > 0 && (
        <div className="callout callout-warn">
          <b>{plan.unreadable.length} files could not be read</b>
          {plan.unreadable.slice(0, 6).join(", ")}
          {plan.unreadable.length > 6 ? ", …" : ""}
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onGo} disabled={busy || !keeping.length}>
          Build {keeping.length} topic{keeping.length === 1 ? "" : "s"}
        </button>
      </div>
    </>
  );
}

function ReviewPanel({
  snapshot,
  diff,
  files,
  expanded,
  setExpanded,
  written,
  busy,
  onWrite,
}: {
  snapshot: RunSnapshot;
  diff: DiffRow[];
  files: LocalFile[];
  expanded: string;
  setExpanded: (path: string) => void;
  written: boolean;
  busy: boolean;
  onWrite: () => void;
}) {
  const creates = diff.filter((row) => row.action === "create");
  const pinned = diff.filter((row) => row.action === "pinned");
  const skips = diff.filter((row) => row.action === "skip");
  const totalBytes = creates.reduce((sum, row) => sum + row.bytes, 0);
  const after = useMemo(
    () => validateStaged(files, snapshot.staged as StagedFile[], snapshot.courseName, getProfile(snapshot.profile ?? "law")),
    [files, snapshot.staged, snapshot.courseName, snapshot.profile],
  );

  return (
    <>
      <h3>{written ? "What was written" : "Review before writing"}</h3>
      {!written && (
        <div className="callout">
          <b>
            {creates.length} new file{creates.length === 1 ? "" : "s"}, {Math.round(totalBytes / 1024)} KB
          </b>
          Nothing existing is modified, moved, renamed or deleted. Your lectures, transcripts, seminars
          and past papers are never touched.
        </div>
      )}

      <div>
        {diff.map((row) => (
          <div key={row.path}>
            <div className={`diff-row ${row.action}`}>
              <em>{row.action}</em>
              <span>{row.path}</span>
              <button onClick={() => setExpanded(expanded === row.path ? "" : row.path)}>
                {expanded === row.path ? "Hide" : "Preview"}
              </button>
            </div>
            {expanded === row.path && (
              <div className="diff-preview">
                {row.path.endsWith(".csv") ? (
                  <CsvPreview content={row.content} />
                ) : (
                  <Markdown text={row.content} path={row.path} onLink={() => {}} checks={{}} toggleCheck={() => {}} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {pinned.length > 0 && (
        <div className="callout callout-warn">
          <b>{pinned.length} left alone</b>
          You edited {pinned.length === 1 ? "this file" : "these files"}, so Study Hub will not
          overwrite {pinned.length === 1 ? "it" : "them"}.
        </div>
      )}
      {skips.length > 0 && (
        <p className="fmt-summary">{skips.length} files are already identical and will be skipped.</p>
      )}

      <div className="callout">
        <b>After writing, this folder will be &ldquo;{after.level}&rdquo;</b>
        {after.topics.length} topics, {after.counts.cards} cards, {after.links.broken} broken links.
      </div>

      {!written && (
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onWrite} disabled={busy || !creates.length}>
            Write {creates.length} file{creates.length === 1 ? "" : "s"} to my folder
          </button>
        </div>
      )}
      {written && (
        <div className="btn-row">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="btn btn-primary" href="/">
            Open the workspace
          </a>
        </div>
      )}
    </>
  );
}

function CsvPreview({ content }: { content: string }) {
  const rows = parseCSV(content.replace(/^\uFEFF/, "")).slice(0, 21);
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) =>
                index === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>,
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogPanel({ snapshot, authorities }: { snapshot: RunSnapshot; authorities: string }) {
  return (
    <div className="hub-card">
      <h2>Run log</h2>
      <p className="hub-lede">
        Every rejection is shown here. A card is dropped when its quote cannot be found in the file it
        claims to come from — that is how Study Hub keeps invented {authorities} out of your revision.
      </p>
      <div className="run-log">
        {snapshot.log.map((line, index) => (
          <p key={index} className={line.kind === "bad" ? "bad" : line.kind === "fix" ? "fix" : undefined}>
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}
