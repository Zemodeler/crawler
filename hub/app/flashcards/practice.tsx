"use client";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection, isHosted } from "../../lib/ai/settings.ts";
import { ERROR_COPY, type AiError, type Progress } from "../../lib/ai/types.ts";
import { collectDirectory, loadHandles, type LocalFile } from "../../lib/course-fs.ts";
import { fetchTree, loadModule } from "../../lib/library.ts";
import { saveOwnNote, uploadOwnFile } from "../../lib/own-files.ts";
import {
  KIND_LABELS,
  buildAttempt,
  gradeBand,
  loadStore,
  progression,
  retryPaper,
  saveStore,
  topicScores,
  type Answer,
  type Attempt,
  type Paper,
  type PracticeKind,
  type PracticeStore,
  type SelfMark,
} from "../../lib/practice.ts";
import { COUNT_LIMITS, candidateSources, generatePaper, sourceRole } from "../../lib/practice-generate.ts";
import { Marker, Result, Taker } from "./practice-session.tsx";

type View =
  | { name: "papers" }
  | { name: "create" }
  | { name: "progress" }
  | { name: "take"; paper: Paper; retry: boolean }
  | { name: "mark"; paper: Paper; answers: Record<string, Answer>; seconds: number; retry: boolean }
  | { name: "result"; attempt: Attempt };

const KIND_HELP: Record<PracticeKind, string> = {
  exam: "A mixed paper of multiple-choice and written questions, in the style of your past papers.",
  mcq: "Multiple-choice only, marked instantly. Quick to do and good for covering a lot of ground.",
  exercise: "Short written exercises with worked solutions, which you mark yourself.",
};

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const bandClass = (percent: number) => `band-${gradeBand(percent).short.replace(":", "")}`;

const PROGRESS_TEXT: Record<Progress["phase"], string> = {
  connecting: "Connecting to your assistant…",
  streaming: "Writing the questions…",
  validating: "Checking every answer key…",
  repairing: "Fixing the format…",
};

export default function Practice({ course }: { course: string }) {
  const hosted = isHosted();
  const [store, setStore] = useState<PracticeStore>(() => loadStore(course));
  const storeRef = useRef(store);
  const [view, setView] = useState<View>({ name: "papers" });
  const [warning, setWarning] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [extra, setExtra] = useState<LocalFile[]>([]);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");

  function commit(next: PracticeStore) {
    storeRef.current = next;
    setStore(next);
    setWarning(saveStore(course, next) ? "" : "Your browser would not save this practice history (storage may be full or blocked). Download your study packs so nothing is lost.");
  }

  // The module's files, for choosing what a paper is written from.
  useEffect(() => {
    let live = true;
    (async () => {
      if (hosted) {
        const [year, ...rest] = course.split("/");
        const loaded = await loadModule(await fetchTree(), year, rest.join("/"));
        if (live) setFiles(loaded);
        return;
      }
      const { handles } = await loadHandles();
      const handle = handles.find((h) => h.name === course);
      if ((await handle?.queryPermission?.({ mode: "read" })) === "granted" && live)
        setFiles(await collectDirectory(handle!));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [course, hosted, reload]);

  const sources = useMemo(() => candidateSources([...files, ...extra]), [files, extra]);

  function finalize(paper: Paper, answers: Record<string, Answer>, seconds: number, retry: boolean) {
    const attempt = buildAttempt(paper, answers, seconds, Date.now(), retry);
    commit({ ...storeRef.current, attempts: [...storeRef.current.attempts, attempt] });
    setView({ name: "result", attempt });
  }

  function addPaper(paper: Paper) {
    commit({ ...storeRef.current, papers: [paper, ...storeRef.current.papers.filter((p) => p.id !== paper.id)] });
  }

  function retryMissed(attempt: Attempt) {
    const paper = retryPaper(attempt);
    if (!paper) return;
    addPaper(paper);
    setView({ name: "take", paper, retry: true });
  }

  const priorAttempt = (attempt: Attempt) =>
    store.attempts
      .filter((a) => a.paperId === attempt.paperId && a.createdAt < attempt.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);

  if (view.name === "take")
    return (
      <Taker
        key={view.paper.id}
        paper={view.paper}
        onExit={() => setView({ name: "papers" })}
        onFinish={(answers, seconds) =>
          view.paper.questions.some((q) => q.type === "short")
            ? setView({ name: "mark", paper: view.paper, answers, seconds, retry: view.retry })
            : finalize(view.paper, answers, seconds, view.retry)
        }
      />
    );
  if (view.name === "mark")
    return (
      <Marker
        questions={view.paper.questions.filter((q) => q.type === "short")}
        answers={view.answers}
        onDone={(marks: Record<string, SelfMark>) => {
          const answers = { ...view.answers };
          for (const [id, self] of Object.entries(marks)) answers[id] = { ...answers[id], self };
          finalize(view.paper, answers, view.seconds, view.retry);
        }}
      />
    );
  if (view.name === "result") {
    const { attempt } = view;
    const paper = store.papers.find((p) => p.id === attempt.paperId);
    return (
      <Result
        attempt={attempt}
        previous={priorAttempt(attempt)}
        onSaveNote={hosted ? async (name, text) => (await saveOwnNote(course, { title: name, text })).path : undefined}
        onRetryMissed={() => retryMissed(attempt)}
        onRetake={() => setView({ name: "take", paper: paper || { ...attempt, id: attempt.paperId, brief: "", sources: [] }, retry: false })}
        onBack={() => setView({ name: "papers" })}
      />
    );
  }

  return (
    <section className="pr-page">
      <div className="pr-tabs" role="tablist">
        {(
          [
            ["papers", "Papers"],
            ["create", "New paper"],
            ["progress", "Progress"],
          ] as const
        ).map(([name, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={view.name === name}
            className={view.name === name ? "active" : ""}
            key={name}
            onClick={() => setView({ name } as View)}
          >
            {label}
          </button>
        ))}
      </div>
      {warning && <p className="pr-error">{warning}</p>}
      {notice && view.name === "papers" && <p className="pr-note">{notice}</p>}

      {view.name === "papers" && (
        <Papers
          store={store}
          onCreate={() => setView({ name: "create" })}
          onStart={(paper) => setView({ name: "take", paper, retry: false })}
          onOpen={(attempt) => setView({ name: "result", attempt })}
          onDelete={(paper) => {
            if (window.confirm(`Delete "${paper.title}"? Your past attempts on it are kept.`))
              commit({ ...storeRef.current, papers: storeRef.current.papers.filter((p) => p.id !== paper.id) });
          }}
        />
      )}
      {view.name === "create" && (
        <Create
          course={course}
          hosted={hosted}
          sources={sources}
          onUpload={async (list) => {
            for (const file of list) {
              if (hosted) await uploadOwnFile(course, file);
              else {
                const ext = file.name.split(".").pop()?.toLowerCase() || "";
                const path = `Course Materials/My Files/${file.name}`;
                const text = ext === "txt" || ext === "md" ? await file.text() : undefined;
                setExtra((e) => [
                  ...e.filter((f) => f.path !== path),
                  { path, name: file.name, ext, file, text, category: "Source materials", topic: "" },
                ]);
              }
            }
            if (hosted) setReload((n) => n + 1);
          }}
          onCreated={(paper, notes) => {
            addPaper(paper);
            setNotice(notes.join(" "));
            setView({ name: "papers" });
          }}
        />
      )}
      {view.name === "progress" && (
        <Progression attempts={store.attempts} onOpen={(attempt) => setView({ name: "result", attempt })} />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- papers */

function Papers({
  store,
  onCreate,
  onStart,
  onOpen,
  onDelete,
}: {
  store: PracticeStore;
  onCreate: () => void;
  onStart: (paper: Paper) => void;
  onOpen: (attempt: Attempt) => void;
  onDelete: (paper: Paper) => void;
}) {
  const stats = progression(store.attempts);
  const latest = [...store.attempts].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!store.papers.length)
    return (
      <div className="pr-empty">
        <p className="eyebrow">Practice papers</p>
        <h1>Exam practice from your own course</h1>
        <p>
          Generate a paper in the style of your past papers, sit it, get a grade, and receive a study pack of exactly what you got wrong.
          Nothing is created until you ask for it.
        </p>
        <button type="button" className="pr-primary" onClick={onCreate}>
          Make my first paper
        </button>
        {store.attempts.length > 0 && <p className="pr-note">Your earlier attempts are kept under Progress.</p>}
      </div>
    );
  return (
    <>
      {stats && latest && (
        <div className="pr-summary">
          <div>
            <b>{stats.latest}%</b>
            <span>last attempt{stats.sinceLast !== null ? `, ${stats.sinceLast >= 0 ? "+" : ""}${stats.sinceLast} on the one before` : ""}</span>
          </div>
          <div>
            <b>{stats.average}%</b>
            <span>average over {stats.count}</span>
          </div>
          <div>
            <b>{stats.best}%</b>
            <span>best</span>
          </div>
          <button type="button" className="pr-quiet" onClick={() => onOpen(latest)}>
            Review last attempt
          </button>
        </div>
      )}
      <div className="pr-list">
        {store.papers.map((paper) => {
          const attempts = store.attempts.filter((a) => a.paperId === paper.id);
          const best = attempts.length ? Math.max(...attempts.map((a) => a.percent)) : null;
          return (
            <article className="pr-paper" key={paper.id}>
              <div>
                <p className="eyebrow">
                  {KIND_LABELS[paper.kind]} · {paper.questions.length} questions · {date(paper.createdAt)}
                </p>
                <h2>{paper.title}</h2>
                {paper.brief && <p className="pr-brief">&ldquo;{paper.brief}&rdquo;</p>}
                <p className="pr-meta">
                  {attempts.length ? `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}, best ${best}%` : "Not attempted yet"}
                </p>
              </div>
              <div className="pr-actions">
                <button type="button" className="pr-primary" onClick={() => onStart(paper)}>
                  {attempts.length ? "Retake" : "Start"}
                </button>
                <button type="button" className="pr-quiet" onClick={() => onDelete(paper)}>
                  Delete
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- create */

function Create({
  course,
  hosted,
  sources,
  onUpload,
  onCreated,
}: {
  course: string;
  hosted: boolean;
  sources: LocalFile[];
  onUpload: (files: File[]) => Promise<void>;
  onCreated: (paper: Paper, notes: string[]) => void;
}) {
  const [kind, setKind] = useState<PracticeKind>("exam");
  const [count, setCount] = useState(COUNT_LIMITS.exam.fallback);
  const [brief, setBrief] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<{ title: string; detail?: string; connect?: boolean } | null>(null);
  const [uploadError, setUploadError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const on = (file: LocalFile) => picked[file.path] ?? sourceRole(file) !== "material";
  const chosen = sources.filter(on);
  const pastPapers = sources.filter((f) => sourceRole(f) === "past-paper");
  const limits = COUNT_LIMITS[kind];

  function chooseKind(next: PracticeKind) {
    setKind(next);
    setCount(COUNT_LIMITS[next].fallback);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const list = [...(event.target.files || [])];
    event.target.value = "";
    setUploadError("");
    try {
      await onUpload(list);
    } catch (e) {
      setUploadError((e as Error).message || "Could not add that file.");
    }
  }

  async function run() {
    setError(null);
    if (!(await hasAnyConnection().catch(() => false))) {
      setError({ title: ERROR_COPY.no_credentials.title, detail: "Practice papers are written by your AI assistant.", connect: true });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(PROGRESS_TEXT.connecting);
    try {
      const client = await createConfiguredAiClient();
      const { paper, dropped, unread } = await generatePaper({
        client,
        kind,
        count,
        brief,
        module: course.split("/").slice(1).join("/") || course,
        sources: chosen,
        signal: controller.signal,
        onProgress: (p) => setStatus(PROGRESS_TEXT[p.phase]),
      });
      onCreated(paper, [
        dropped ? `${dropped} generated question${dropped === 1 ? " was" : "s were"} left out because the answer key could not be checked.` : "",
        unread.length ? `${unread.length} file${unread.length === 1 ? " was" : "s were"} too large or had no readable text and ${unread.length === 1 ? "was" : "were"} not used.` : "",
      ].filter(Boolean));
    } catch (e) {
      const err = e as AiError;
      if (err.code === "aborted" || controller.signal.aborted) setError(null);
      else {
        const copy = ERROR_COPY[err.code] || ERROR_COPY.unknown;
        setError({
          title: copy.title,
          detail: [err.message, err.hint].filter(Boolean).join(" "),
          connect: err.code === "no_credentials" || err.code === "invalid_key",
        });
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  const groups = [
    { role: "past-paper", title: "Past papers", note: "Questions copy their style, never their content." },
    { role: "own", title: "Your own files", note: "Anything you added to this module." },
    { role: "material", title: "Other course material", note: "Lectures, seminars and notes." },
  ] as const;

  return (
    <div className="pr-create">
      <h1>New paper</h1>

      <h2>What kind?</h2>
      <div className="pr-kinds" role="radiogroup" aria-label="Paper type">
        {(Object.keys(KIND_LABELS) as PracticeKind[]).map((k) => (
          <button type="button" role="radio" aria-checked={kind === k} className={kind === k ? "picked" : ""} key={k} onClick={() => chooseKind(k)}>
            <b>{KIND_LABELS[k]}</b>
            <span>{KIND_HELP[k]}</span>
          </button>
        ))}
      </div>

      <div className="pr-row">
        <label>
          <span>Questions</span>
          <input
            type="number"
            min={limits.min}
            max={limits.max}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>
        <label className="grow">
          <span>Anything you want? (optional)</span>
          <textarea
            rows={2}
            maxLength={600}
            value={brief}
            placeholder="e.g. harder than last year, focus on hypothesis testing, include worked calculations"
            onChange={(e) => setBrief(e.target.value)}
          />
        </label>
      </div>

      <div className="pr-section-head">
        <h2>Write it from</h2>
        <button type="button" className="pr-quiet" onClick={() => input.current?.click()}>
          Add a past paper or file
        </button>
        <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.pptx,.txt,.md" onChange={upload} />
      </div>
      {uploadError && <p className="pr-error">{uploadError}</p>}
      {!pastPapers.length && (
        <p className="pr-note">
          No past paper found in this module. Add one (PDF, Word or text) so the questions match your real exam, or write from the course material.
          {hosted ? " Files you add are kept in this module's My Files." : " Files you add here last until you leave this page."}
        </p>
      )}
      {sources.length === 0 && <p className="pr-note">There are no readable files yet.</p>}
      {groups.map((group) => {
        const list = sources.filter((f) => sourceRole(f) === group.role);
        if (!list.length) return null;
        return (
          <fieldset className="pr-sources" key={group.role}>
            <legend>
              {group.title} <small>{group.note}</small>
            </legend>
            {list.map((file) => (
              <label className="fc-check" key={file.path}>
                <input type="checkbox" checked={on(file)} onChange={(e) => setPicked((p) => ({ ...p, [file.path]: e.target.checked }))} />
                {file.name}
              </label>
            ))}
          </fieldset>
        );
      })}

      {error && (
        <div className="pr-error" role="alert">
          <b>{error.title}</b>
          {error.detail && <p>{error.detail}</p>}
          {error.connect && <a href="/connect">Set up your AI connection</a>}
        </div>
      )}
      <div className="pr-actions">
        <button type="button" className="pr-primary" disabled={busy || !chosen.length} onClick={run}>
          {busy ? "Generating…" : `Generate ${KIND_LABELS[kind].toLowerCase()}`}
        </button>
        {busy && (
          <button type="button" className="pr-quiet" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
        <span aria-live="polite">
          {busy
            ? `${status} This can take a minute or two.`
            : chosen.length
              ? `${chosen.length} file${chosen.length === 1 ? "" : "s"} will be sent to your assistant.`
              : "Choose at least one file."}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- progress */

function Progression({ attempts, onOpen }: { attempts: Attempt[]; onOpen: (attempt: Attempt) => void }) {
  const ordered = useMemo(() => [...attempts].sort((a, b) => a.createdAt - b.createdAt), [attempts]);
  const stats = progression(attempts);
  const topics = useMemo(() => topicScores(ordered), [ordered]);
  if (!stats)
    return (
      <div className="pr-empty">
        <h1>No attempts yet</h1>
        <p>Every paper you finish is kept here, so you can see your marks rise over time.</p>
      </div>
    );

  const W = 640;
  const H = 220;
  const pad = { l: 38, r: 12, t: 12, b: 24 };
  const x = (i: number) => (ordered.length === 1 ? (W + pad.l - pad.r) / 2 : pad.l + (i * (W - pad.l - pad.r)) / (ordered.length - 1));
  const y = (percent: number) => pad.t + ((100 - percent) * (H - pad.t - pad.b)) / 100;
  const line = ordered.map((a, i) => `${x(i)},${y(a.percent)}`).join(" ");

  return (
    <>
      <div className="pr-summary">
        <div>
          <b>{stats.count}</b>
          <span>attempts</span>
        </div>
        <div>
          <b>{stats.average}%</b>
          <span>average</span>
        </div>
        <div>
          <b>{stats.best}%</b>
          <span>best</span>
        </div>
        <div>
          <b>{stats.overall === null ? "–" : `${stats.overall > 0 ? "+" : ""}${stats.overall}`}</b>
          <span>{stats.overall === null ? "trend after 4 attempts" : "points since you started"}</span>
        </div>
      </div>

      <h2>Your marks over time</h2>
      <svg className="pr-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scores for ${stats.count} attempts, latest ${stats.latest} percent`}>
        {[0, 40, 50, 60, 70, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} className={g === 70 || g === 40 ? "pr-grid key" : "pr-grid"} />
            <text x={pad.l - 6} y={y(g) + 4} textAnchor="end">
              {g}
            </text>
          </g>
        ))}
        <polyline points={line} className="pr-line" />
        {ordered.map((a, i) => (
          <circle key={a.id} cx={x(i)} cy={y(a.percent)} r={5} className="pr-dot">
            <title>
              {a.title}: {a.percent}% on {date(a.createdAt)}
            </title>
          </circle>
        ))}
      </svg>
      <p className="pr-meta">Lines mark the 40% pass and the 70% first. Attempts are shown oldest to newest.</p>

      {topics.length > 1 && (
        <>
          <h2>Where to focus</h2>
          <div className="pr-topics">
            {topics.slice(0, 6).map((t) => (
              <div key={t.topic}>
                <span>{t.topic}</span>
                <div className="pr-bar" role="img" aria-label={`${t.topic}: ${t.percent}%`}>
                  <i style={{ width: `${t.percent}%` }} className={t.percent >= 70 ? "good" : t.percent >= 40 ? "mid" : "low"} />
                </div>
                <b>{t.percent}%</b>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Every attempt</h2>
      <div className="pr-attempts">
        {[...ordered].reverse().map((a, i, all) => {
          const before = all[i + 1];
          const delta = before ? a.percent - before.percent : null;
          return (
            <button type="button" key={a.id} onClick={() => onOpen(a)}>
              <span className={`pr-chip ${bandClass(a.percent)}`}>{a.percent}%</span>
              <span className="pr-attempt-title">
                {a.title}
                <small>
                  {KIND_LABELS[a.kind]} · {date(a.createdAt)} · {a.score}/{a.total} marks{a.retry ? " · retry of missed" : ""}
                </small>
              </span>
              <span className={`pr-delta ${delta === null ? "" : delta >= 0 ? "up" : "down"}`}>
                {delta === null ? "" : `${delta >= 0 ? "+" : ""}${delta}`}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
