"use client";
/**
 * Practising tutorial sheets: one exercise at a time on the left, the lecture
 * slides it comes from on the right, opened at the right page.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection } from "../../lib/ai/settings.ts";
import { AiError, ERROR_COPY, type Progress } from "../../lib/ai/types.ts";
import type { LocalFile } from "../../lib/course-fs.ts";
import type { SelfMark } from "../../lib/practice.ts";
import {
  exerciseKey,
  packsFor,
  referenceSheets,
  withExplanation,
  type Exercise,
  type TutorialFile,
  type TutorialPart,
  type TutorialProgress,
  type TutorialSheet,
} from "../../lib/tutorial.ts";
import { reviseTarget } from "../../lib/practice-view.ts";
import type { TopicReadiness } from "../../lib/readiness.ts";
import { explainPart } from "../../lib/tutorial-generate.ts";
import { CHAT_ASK_EVENT } from "../shell/AppShell.tsx";
import { MathText } from "./math-text.tsx";

const BASICS_KEY = "studyhub:tutorial-basics-open";

const EXPLAIN_TEXT: Record<Progress["phase"], string> = {
  connecting: "Connecting to your assistant…",
  streaming: "Writing the explanation…",
  validating: "Checking it…",
  repairing: "Fixing the format…",
};

const MARKS: { value: SelfMark; label: string; key: string }[] = [
  { value: "right", label: "Got it", key: "1" },
  { value: "partly", label: "Partly", key: "2" },
  { value: "wrong", label: "Missed", key: "3" },
];
const MARK_LABEL: Record<SelfMark, string> = { right: "got it", partly: "partly", wrong: "missed" };

type Entry = { key: string; sheet: TutorialSheet; exercise: Exercise };
type Doc = { path: string; page?: number; nonce: number };

const fileName = (path: string) => path.split("/").pop() || path;

/** Where the material pane opens for an exercise: its first slide link, else its sheet's lecture. */
function docFor(entry: Entry | undefined, nonce: number): Doc {
  if (!entry) return { path: "", nonce };
  const refs = entry.exercise.refs;
  const ref = refs.find((r) => r.path === entry.sheet.lecturePath) || refs[0];
  if (ref) return { path: ref.path, page: ref.page, nonce };
  return { path: entry.sheet.lecturePath || "", nonce };
}

function readBasicsOpen(): boolean {
  try {
    return localStorage.getItem(BASICS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The question the assistant is opened with: everything it needs, nothing sent until the student says so. */
function askText(sheet: TutorialSheet, exercise: Exercise, part: TutorialPart): string {
  const where = `${sheet.label}, exercise ${exercise.number}${part.label ? `, part (${part.label})` : ""}`;
  return [
    `I'm working on ${where}${exercise.title ? ` (${exercise.title})` : ""}.`,
    `The question is: ${part.question || exercise.stem}`,
    `The official answer is: ${part.final}`,
    "Explain it to me like a beginner, using the lecture slides.",
  ].join("\n");
}

export function TutorialSession({
  hosted,
  moduleName,
  files,
  data,
  title,
  keys,
  start,
  progress,
  topics,
  onRevise,
  onProgress,
  onUpdate,
  onExit,
}: {
  hosted: boolean;
  moduleName: string;
  files: LocalFile[];
  data: TutorialFile;
  title: string;
  /** The exercises in this run, as exerciseKey()s. */
  keys: string[];
  start: number;
  progress: TutorialProgress;
  /** The module's topics, to find the cards on an exercise's topic. */
  topics: TopicReadiness[];
  /** Opens the Cards view filtered to a topic; without it there is no link. */
  onRevise?: (topic: string) => void;
  onProgress: (change: (p: TutorialProgress) => TutorialProgress) => void;
  onUpdate: (change: (file: TutorialFile) => TutorialFile) => Promise<void>;
  onExit: () => void;
}) {
  const entries = useMemo(() => {
    const byKey = new Map<string, Entry>();
    for (const sheet of data.sheets)
      for (const exercise of sheet.exercises) byKey.set(exerciseKey(sheet, exercise), { key: exerciseKey(sheet, exercise), sheet, exercise });
    return keys.map((k) => byKey.get(k)).filter((e): e is Entry => Boolean(e));
  }, [data, keys]);

  const [index, setIndex] = useState(() => Math.min(start, Math.max(0, entries.length - 1)));
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [hints, setHints] = useState<Record<string, boolean>>({});
  const [doc, setDoc] = useState<Doc>(() => docFor(entries[index], 0));
  const [hidden, setHidden] = useState(false);
  const [finished, setFinished] = useState(false);
  const [basicsOpen, setBasicsOpen] = useState(readBasicsOpen);

  const entry = entries[index];
  const multiSheet = new Set(entries.map((e) => e.sheet.id)).size > 1;

  // Remember where the student is, so the next run starts here.
  const currentKey = entry?.key;
  useEffect(() => {
    if (currentKey) onProgress((p) => (p.current === currentKey ? p : { ...p, current: currentKey }));
    // onProgress is a new function every render; only the exercise matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  function go(next: number) {
    if (next < 0 || next >= entries.length) return;
    setIndex(next);
    setFinished(false);
    setDoc((d) => docFor(entries[next], d.nonce + 1));
  }

  function openDoc(path: string, page?: number) {
    setHidden(false);
    setDoc((d) => ({ path, ...(page ? { page } : {}), nonce: d.nonce + 1 }));
  }

  const partKey = (i: number) => `${entry?.key}:${i}`;

  function revealNext() {
    if (!entry || finished) return;
    const next = entry.exercise.parts.findIndex((_, i) => !revealed[partKey(i)]);
    if (next >= 0) setRevealed((r) => ({ ...r, [partKey(next)]: true }));
  }

  function revealAll() {
    if (!entry) return;
    setRevealed((r) => ({ ...r, ...Object.fromEntries(entry.exercise.parts.map((_, i) => [partKey(i), true])) }));
  }

  function mark(value: SelfMark) {
    if (!entry || finished) return;
    const key = entry.key;
    onProgress((p) => ({ ...p, marks: { ...p.marks, [key]: value } }));
    if (index < entries.length - 1) go(index + 1);
    else setFinished(true);
  }

  // Keys: arrows move, R reveals the next part, 1/2/3 mark. Never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "ArrowRight") go(index + 1);
      else if (event.key === "ArrowLeft") go(index - 1);
      else if (event.key === "r" || event.key === "R") revealNext();
      else {
        const picked = MARKS.find((m) => m.key === event.key);
        if (picked) mark(picked.value);
        else return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function explain(target: Entry, partIndex: number, signal: AbortSignal, onPhase: (text: string) => void) {
    if (!(await hasAnyConnection().catch(() => false)))
      throw new AiError("no_credentials", "Explanations are written by your AI assistant.");
    const client = await createConfiguredAiClient();
    const text = await explainPart({
      client,
      module: moduleName,
      sheet: target.sheet,
      exercise: target.exercise,
      part: target.exercise.parts[partIndex],
      files,
      signal,
      onProgress: (p) => onPhase(EXPLAIN_TEXT[p.phase]),
    });
    if (signal.aborted) throw new AiError("aborted", "Cancelled");
    await onUpdate((file) => withExplanation(file, target.sheet.id, target.exercise.id, partIndex, text));
  }

  if (!entry)
    return (
      <div className="pr-empty">
        <h1>Nothing to practise here</h1>
        <p>These exercises are no longer in your converted sheets. Convert the sheet again, then come back.</p>
        <button type="button" className="pr-primary" onClick={onExit}>
          Back to my sheets
        </button>
      </div>
    );

  const { sheet, exercise } = entry;
  const reviseTopic = onRevise ? reviseTarget(topics, entry.key) : null;
  const packs = packsFor(
    exercise,
    files.filter((f) => f.category === "Study packs" && f.ext === "md"),
  );
  const runTally = entries.reduce(
    (t, e) => {
      const m = progress.marks[e.key];
      if (m) t[m]++;
      return t;
    },
    { right: 0, partly: 0, wrong: 0 },
  );

  return (
    <section className={`tu-session${hidden ? " material-hidden" : ""}`}>
      <header className="tu-session-head">
        <button type="button" className="pr-quiet tu-small" onClick={onExit}>
          ← Back to my sheets
        </button>
        <span className="tu-run-title">
          {title} · {index + 1} of {entries.length}
        </span>
        <button type="button" className="pr-quiet tu-small" aria-pressed={hidden} onClick={() => setHidden(!hidden)}>
          {hidden ? "Show material" : "Hide material"}
        </button>
      </header>

      <div className="tu-panes">
        <div className="tu-left">
          <p className="eyebrow">
            {sheet.label} · Exercise {exercise.number}
            {exercise.topic ? ` · ${exercise.topic}` : ""}
          </p>
          <h1 className="tu-title">{exercise.title || `Exercise ${exercise.number}`}</h1>

          <nav className="tu-chips" aria-label="Exercises in this run">
            {entries.map((e, i) => {
              const m = progress.marks[e.key];
              return (
                <button
                  type="button"
                  key={e.key}
                  className={`${m || ""}${i === index ? " current" : ""}`}
                  aria-current={i === index ? "step" : undefined}
                  aria-label={`${e.sheet.label} exercise ${e.exercise.number}${m ? `, ${MARK_LABEL[m]}` : ""}`}
                  onClick={() => go(i)}
                >
                  {multiSheet ? `${e.sheet.label.replace(/^Week /, "")} · ${e.exercise.number}` : e.exercise.number}
                </button>
              );
            })}
          </nav>

          {finished ? (
            <div className="tu-finished">
              <h2>That was the last one</h2>
              <p>
                {runTally.right} got it, {runTally.partly} partly, {runTally.wrong} missed, out of {entries.length}.
              </p>
              <div className="pr-actions">
                <button type="button" className="pr-primary" onClick={onExit}>
                  Back to my sheets
                </button>
                <button type="button" className="pr-quiet" onClick={() => go(0)}>
                  Go through them again
                </button>
              </div>
            </div>
          ) : (
            <>
              {exercise.stem && <MathText className="tu-stem" text={exercise.stem} />}

              {exercise.basics && (
                <div className="tu-box">
                  <button
                    type="button"
                    className="tu-box-head"
                    aria-expanded={basicsOpen}
                    onClick={() => {
                      const next = !basicsOpen;
                      setBasicsOpen(next);
                      try {
                        localStorage.setItem(BASICS_KEY, next ? "1" : "0");
                      } catch {
                        /* only a convenience */
                      }
                    }}
                  >
                    <span>Before you start</span>
                    <span className="tu-caret" aria-hidden="true">
                      {basicsOpen ? "−" : "+"}
                    </span>
                  </button>
                  {basicsOpen && <MathText className="tu-box-body" text={exercise.basics} />}
                </div>
              )}

              <div className="tu-refs">
                <h2>Where this is in the lectures</h2>
                {exercise.refs.length ? (
                  <div className="tu-ref-list">
                    {exercise.refs.map((ref, i) => (
                      <button
                        type="button"
                        key={`${ref.path}:${ref.page}:${i}`}
                        className={doc.path === ref.path && doc.page === ref.page ? "open" : ""}
                        title={fileName(ref.path)}
                        onClick={() => openDoc(ref.path, ref.page)}
                      >
                        <span>
                          Slide {ref.page} · {ref.label}
                        </span>
                        {ref.same && <em>same example</em>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="pr-meta">No slide is linked to this exercise.</p>
                )}
                {packs.length ? (
                  <ul className="tu-packs">
                    {packs.map((pack) => (
                      <li key={pack.path}>
                        <a href={`/?file=${encodeURIComponent(pack.path)}`}>Read the study pack: {pack.name.replace(/\.md$/i, "")}</a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pr-meta">No study pack on this topic yet.</p>
                )}
                {reviseTopic && (
                  <p className="pv-crosslink">
                    <button type="button" className="pv-link" onClick={() => onRevise?.(reviseTopic)}>
                      Revise the cards for this topic
                    </button>
                  </p>
                )}
              </div>

              {exercise.hint && (
                <div className="tu-hint">
                  <button
                    type="button"
                    className="pr-quiet tu-small"
                    aria-expanded={Boolean(hints[entry.key])}
                    onClick={() => setHints((h) => ({ ...h, [entry.key]: !h[entry.key] }))}
                  >
                    {hints[entry.key] ? "Hide the hint" : "Show a hint"}
                  </button>
                  {hints[entry.key] && <MathText className="tu-hint-body" text={exercise.hint} />}
                </div>
              )}

              {exercise.parts.map((part, i) => (
                <PartView
                  key={partKey(i)}
                  part={part}
                  revealed={Boolean(revealed[partKey(i)])}
                  onReveal={() => setRevealed((r) => ({ ...r, [partKey(i)]: true }))}
                  onExplain={(signal, onPhase) => explain(entry, i, signal, onPhase)}
                  onAsk={
                    hosted
                      ? () => window.dispatchEvent(new CustomEvent(CHAT_ASK_EVENT, { detail: askText(sheet, exercise, part) }))
                      : undefined
                  }
                />
              ))}

              <ScratchPad
                key={entry.key}
                initial={progress.notes[entry.key] || ""}
                onSave={(text) => {
                  const key = entry.key;
                  onProgress((p) => {
                    const notes = { ...p.notes };
                    if (text.trim()) notes[key] = text;
                    else delete notes[key];
                    return { ...p, notes };
                  });
                }}
              />
            </>
          )}

          <footer className="tu-foot">
            <button type="button" className="pr-quiet" disabled={index === 0} onClick={() => go(index - 1)}>
              ← Previous
            </button>
            <button type="button" className="pr-quiet" disabled={finished} onClick={revealAll}>
              Reveal all
            </button>
            <div className="pr-selfmark" role="group" aria-label="How did you do?">
              {MARKS.map((m) => (
                <button
                  type="button"
                  key={m.value}
                  disabled={finished}
                  aria-pressed={progress.marks[entry.key] === m.value}
                  className={`${m.value} ${progress.marks[entry.key] === m.value ? "picked" : ""}`}
                  onClick={() => mark(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button type="button" className="pr-quiet" disabled={index >= entries.length - 1} onClick={() => go(index + 1)}>
              Next →
            </button>
          </footer>
          <p className="pr-hint">Keys: ← → move, R shows the next answer, 1 2 3 mark Got it, Partly or Missed.</p>
        </div>

        {!hidden && <Material files={files} sheet={sheet} exercise={exercise} doc={doc} onOpen={openDoc} />}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- parts */

function PartView({
  part,
  revealed,
  onReveal,
  onExplain,
  onAsk,
}: {
  part: TutorialPart;
  revealed: boolean;
  onReveal: () => void;
  onExplain: (signal: AbortSignal, onPhase: (text: string) => void) => Promise<void>;
  /** Present only in the desktop app, where the study assistant lives. */
  onAsk?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<{ title: string; detail?: string; connect?: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function explain() {
    if (part.explain) {
      setOpen(!open);
      return;
    }
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(EXPLAIN_TEXT.connecting);
    try {
      await onExplain(controller.signal, setStatus);
      setOpen(true);
    } catch (e) {
      const err = e as AiError;
      if (err.code !== "aborted" && !controller.signal.aborted) {
        const copy = ERROR_COPY[err.code] || ERROR_COPY.unknown;
        setError({
          title: copy.title,
          detail: [err.message, err.hint].filter(Boolean).join(" "),
          connect: err.code === "no_credentials" || err.code === "invalid_key",
        });
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }

  return (
    <article className="tu-part">
      <div className="tu-question">
        {part.label && <b className="tu-part-label">({part.label})</b>}
        <MathText text={part.question} />
      </div>
      {!revealed ? (
        <button type="button" className="pr-quiet tu-small" onClick={onReveal}>
          Reveal answer
        </button>
      ) : (
        <div className="tu-answer">
          <div className="tu-final">
            <span>Answer</span>
            <MathText text={part.final} />
          </div>
          {part.working && <MathText className="tu-working-steps" text={part.working} />}
          {part.note && (
            <div className="callout callout-warn tu-correction">
              <b>Correction</b>
              <MathText text={part.note} />
            </div>
          )}
          <div className="pr-actions tu-part-actions">
            <button type="button" className="pr-quiet tu-small" disabled={busy} aria-expanded={part.explain ? open : undefined} onClick={explain}>
              {part.explain ? (open ? "Hide the explanation" : "Explain step by step") : busy ? "Explaining…" : "Explain step by step"}
            </button>
            {busy && (
              <button type="button" className="pr-quiet tu-small" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            )}
            {onAsk && (
              <button type="button" className="pr-quiet tu-small" onClick={onAsk}>
                Ask the assistant
              </button>
            )}
            {busy && <span aria-live="polite">{status}</span>}
          </div>
          {error && (
            <div className="pr-error" role="alert">
              <b>{error.title}</b>
              {error.detail && <p>{error.detail}</p>}
              {error.connect && <a href="/connect">Set up your AI connection</a>}
            </div>
          )}
          {part.explain && open && <MathText className="tu-explain" text={part.explain} />}
        </div>
      )}
    </article>
  );
}

/* ----------------------------------------------------------- scratch pad */

function ScratchPad({ initial, onSave }: { initial: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  });

  // Whatever is still waiting is saved when the exercise changes.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) save.current(pending.current);
    },
    [],
  );

  return (
    <label className="tu-scratch">
      <span>Scratch pad (kept for this exercise)</span>
      <textarea
        rows={4}
        value={text}
        placeholder="Work it out here before you reveal the answer."
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          pending.current = value;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            pending.current = null;
            save.current(value);
          }, 600);
        }}
      />
    </label>
  );
}

/* -------------------------------------------------------------- material */

function Material({
  files,
  sheet,
  exercise,
  doc,
  onOpen,
}: {
  files: LocalFile[];
  sheet: TutorialSheet;
  exercise: Exercise;
  doc: Doc;
  onOpen: (path: string, page?: number) => void;
}) {
  const options = useMemo(() => {
    const list: { path: string; label: string }[] = [];
    const add = (path: string | undefined, label: string) => {
      if (path && !list.some((o) => o.path === path)) list.push({ path, label });
    };
    add(sheet.lecturePath, sheet.lecturePath ? `Lecture: ${fileName(sheet.lecturePath)}` : "");
    for (const ref of exercise.refs) add(ref.path, `Slides: ${fileName(ref.path)}`);
    for (const ref of referenceSheets(files)) add(ref.path, ref.name);
    add(sheet.solutionPath, "Official solutions (spoilers)");
    add(doc.path, fileName(doc.path));
    return list;
  }, [files, sheet, exercise, doc.path]);

  const file = files.find((f) => f.path === doc.path);
  const [blob, setBlob] = useState<{ path: string; url: string } | null>(null);

  // A picked folder has no URLs: show its file through an object URL, released when it changes.
  useEffect(() => {
    if (!file || file.url) return;
    const url = URL.createObjectURL(file.file);
    queueMicrotask(() => setBlob({ path: file.path, url }));
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const base = file?.url || (blob && file && blob.path === file.path ? blob.url : "");
  const src = base ? `${base}${doc.page ? `#page=${doc.page}` : ""}` : "";
  const label = options.find((o) => o.path === doc.path)?.label || "Material";

  return (
    <aside className="tu-material" aria-label="Lecture material">
      <div className="tu-material-head">
        <select aria-label="Material to show" value={doc.path} onChange={(e) => onOpen(e.target.value)}>
          {!doc.path && <option value="">Choose a file</option>}
          {options.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </select>
        {src && (
          <a href={src} target="_blank" rel="noopener noreferrer">
            Open in new window
          </a>
        )}
      </div>
      {!doc.path ? (
        <p className="pr-note">No lecture is linked to this sheet. Choose a file above.</p>
      ) : !file ? (
        <p className="pr-note">{fileName(doc.path)} is no longer in this module.</p>
      ) : file.ext !== "pdf" ? (
        <p className="pr-note">
          {file.name} cannot be shown here, only PDFs can.{" "}
          {src && (
            <a href={src} target="_blank" rel="noopener noreferrer">
              Open it in a new window
            </a>
          )}
        </p>
      ) : src ? (
        // Chromium keeps a PDF in place when only the #page changes, so every jump remounts the frame.
        <iframe key={`${doc.path}|${doc.page ?? ""}|${doc.nonce}`} className="tu-frame" title={label} src={src} />
      ) : (
        <p className="pr-meta">Opening {file.name}…</p>
      )}
    </aside>
  );
}
