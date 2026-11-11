"use client";

/**
 * Essays, in Practice: the student writes an essay here (or imports a Word or
 * Markdown file) and works on it with the assistant, which reads the module's
 * files and the draft. It plans the work for the hours the student gives it,
 * reviews the draft and marks the passages that are not good enough, suggests
 * readings that would make it stand out (checked against the course files and,
 * when the Claude command line allows it, a web search), and answers questions.
 *
 * Every answer links back to the course files it used. Essays are saved in the
 * module's .study-hub folder as the student types (see lib/essay.ts).
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { sendChatMessage, type ChatCitation } from "../../lib/ai/chat.ts";
import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection, isHosted } from "../../lib/ai/settings.ts";
import { fenceUntrusted } from "../../lib/ai/structured.ts";
import type { AiClient, AiError } from "../../lib/ai/types.ts";
import { inferCategory, topicLabel } from "../../lib/course-format.ts";
import {
  chatInstructions,
  essayBlock,
  loadEssays,
  markedSegments,
  newEssay,
  parseReadings,
  parseReview,
  planInstructions,
  readingsInstructions,
  reviewInstructions,
  saveEssays,
  wordCount,
  type Essay,
  type EssayFile,
  type EssayTurn,
} from "../../lib/essay.ts";
import { isExamLike } from "../../lib/exam-focus.ts";
import { fetchDeadlines, fetchTree, loadModule, moduleCode, type Deadline } from "../../lib/library.ts";
import { ATTACH_ACCEPT, MAX_ATTACHMENTS, attachmentContext, mergeAttachments, readAttachment, type Attachment } from "../../lib/attachments.ts";
import { uploadOwnFile } from "../../lib/own-files.ts";
import { extractFile } from "../../lib/source-extract.ts";
import { buildModuleScope, type ChatScope } from "../chat/chat-context.ts";
import { Markdown } from "../markdown.tsx";

type Task = "plan" | "review" | "readings" | "chat";
const TASK_LABEL: Record<Task, string> = { plan: "Plan", review: "Feedback", readings: "Readings", chat: "Ask" };
const MAX_ESSAY_CHAT = 30;

/** London calendar day of an instant, YYYY-MM-DD. */
const londonDay = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** The day a deadline is due, for prefilling an essay's due date. */
function deadlineDay(d: Deadline): string | null {
  if (d.due) return londonDay(d.due.iso);
  if (d.window) return londonDay(d.window.to.iso);
  return null;
}

/** "From Week 3 slides.pdf" chips that open the course file. */
function Citations({ citations, scope }: { citations: ChatCitation[]; scope: ChatScope | null }) {
  const files = citations.filter((c): c is Extract<ChatCitation, { kind: "file" }> => c.kind === "file" && c.sourceFile !== "Essay" && c.sourceFile !== "Deadlines");
  const web = citations.filter((c): c is Extract<ChatCitation, { kind: "web" }> => c.kind === "web");
  if (!files.length && !web.length) return null;
  const seen = new Set<string>();
  return (
    <div className="chat-citations">
      {files.map((c, i) => {
        if (seen.has(c.sourceFile)) return null;
        seen.add(c.sourceFile);
        const url = scope?.fileUrls[c.sourceFile];
        const className = `chat-citation ${c.verdict === "verified" ? "verified" : "unverified"}`;
        const label = c.verdict === "verified" ? `From ${c.sourceFile}` : `Check ${c.sourceFile}`;
        return url ? (
          <a key={i} className={className} href={url} target="_blank" rel="noopener noreferrer" title={c.evidence}>{label}</a>
        ) : (
          <span key={i} className={className} title={c.evidence}>{label}</span>
        );
      })}
      {web.map((c, i) => (
        <a key={`w${i}`} className="chat-citation web" href={c.url} target="_blank" rel="noopener noreferrer" title={c.evidence}>
          {(() => {
            try { return new URL(c.url).hostname; } catch { return "Web page"; }
          })()}
        </a>
      ))}
    </div>
  );
}

export default function Essays({ course }: { course: string }) {
  const hosted = isHosted();
  const moduleName = course.split("/").pop() || course;
  const [file, setFile] = useState<EssayFile | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState("");
  const [task, setTask] = useState<Task>("plan");
  const [showMarks, setShowMarks] = useState(false);
  const [activeMark, setActiveMark] = useState<number | null>(null);
  const [busy, setBusy] = useState<Task | "">("");
  const [aiError, setAiError] = useState<{ message: string; hint?: string } | null>(null);
  const [question, setQuestion] = useState("");
  const [notice, setNotice] = useState("");
  const clientRef = useRef<AiClient | null>(null);
  const scopeRef = useRef<ChatScope | null>(null);
  const [scope, setScope] = useState<ChatScope | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<EssayFile | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  /** Attachments for the essay being created, before it exists. */
  const [newFiles, setNewFiles] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [keepCopy, setKeepCopy] = useState(false);
  const attachRef = useRef<HTMLInputElement>(null);
  /** Which essay the shared file picker adds to; null is the one being created. */
  const attachTarget = useRef<Essay | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    loadEssays(course, hosted)
      .then((loaded) => {
        if (!active) return;
        fileRef.current = loaded;
        setFile(loaded);
      })
      .catch((err: Error) => active && setLoadError(err.message));
    if (hosted) {
      const code = moduleCode(moduleName);
      fetchDeadlines()
        .then((all) => active && setDeadlines(all.filter((d) => d.module === code && d.status !== "cancelled" && !isExamLike(d))))
        .catch(() => {});
    }
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [course, hosted, moduleName]);

  // Write what is pending before the page goes away.
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current && fileRef.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void saveEssays(course, hosted, fileRef.current);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [course, hosted]);

  /** Changes one essay and saves the file shortly after the last change. */
  const update = useCallback(
    (id: string, patch: Partial<Essay> | ((essay: Essay) => Partial<Essay>)) => {
      const current = fileRef.current;
      if (!current) return;
      const next: EssayFile = {
        version: 1,
        essays: current.essays.map((e) =>
          e.id === id ? { ...e, ...(typeof patch === "function" ? patch(e) : patch), updated: new Date().toISOString() } : e,
        ),
      };
      fileRef.current = next;
      setFile(next);
      setSaveState("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        saveEssays(course, hosted, fileRef.current!).then(
          () => { setSaveState("saved"); setSaveError(""); },
          (err: Error) => { setSaveState("error"); setSaveError(err.message); },
        );
      }, 700);
    },
    [course, hosted],
  );

  const replaceFile = (next: EssayFile) => {
    fileRef.current = next;
    setFile(next);
    setSaveState("saving");
    saveEssays(course, hosted, next).then(
      () => { setSaveState("saved"); setSaveError(""); },
      (err: Error) => { setSaveState("error"); setSaveError(err.message); },
    );
  };

  const essay = file?.essays.find((e) => e.id === selected) || null;

  /** The AI connection and the module's files, read once, the first time the assistant is asked. */
  async function ensureAi(): Promise<{ client: AiClient; scope: ChatScope }> {
    if (!clientRef.current) {
      if (!(await hasAnyConnection())) throw Object.assign(new Error("No AI connection is set up."), { hint: "Set one up under AI settings." });
      clientRef.current = await createConfiguredAiClient();
    }
    if (!scopeRef.current) {
      if (hosted) {
        const [tree, all] = await Promise.all([fetchTree(), fetchDeadlines().catch(() => [])]);
        const [year, ...rest] = course.split("/");
        const files = await loadModule(tree, year, rest.join("/"));
        scopeRef.current = await buildModuleScope(moduleName, files, all, new Date());
      } else {
        scopeRef.current = await buildModuleScope(moduleName, [], [], new Date());
      }
      setScope(scopeRef.current);
    }
    return { client: clientRef.current, scope: scopeRef.current };
  }

  async function ask(kind: Task, target: Essay, text = "") {
    if (busy) return;
    setBusy(kind);
    setAiError(null);
    setNotice("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { client, scope: base } = await ensureAi();
      const essayText = essayBlock(target);
      const attached = attachmentContext(target.attachments);
      const extracts = new Map([...base.extracts, ...attached.extracts]);
      extracts.set("Essay", { path: "Essay", text: essayText, chunks: [] });
      const webSearch = kind === "readings" && client.chatCapabilities().webSearch;
      const today = londonDay(new Date().toISOString());
      const prompts: Record<Task, { instructions: string; question: string }> = {
        plan: { instructions: planInstructions(target, today), question: "Make my plan for this essay." },
        review: { instructions: reviewInstructions(target), question: "Review my draft and mark what is not good enough yet." },
        readings: { instructions: readingsInstructions(webSearch), question: "What should I read to make this essay stand out?" },
        chat: { instructions: chatInstructions(), question: text },
      };
      const { instructions, question: asked } = prompts[kind];
      const { turn, result } = await sendChatMessage({
        client,
        scopeLabel: `their essay "${target.title}" for the module "${moduleName}"`,
        contextLabel: moduleName,
        contextBlock: [base.contextBlock, attached.block, "### FILE: Essay (the student's essay, brief and current draft)", fenceUntrusted("Essay", essayText)]
          .filter(Boolean)
          .join("\n\n"),
        history: kind === "chat" ? target.chat.slice(-8) : [],
        question: asked,
        webSearch,
        extracts,
        allText: [base.allText, attached.text, essayText].filter(Boolean).join("\n\n"),
        signal: controller.signal,
        instructions,
        style: kind === "chat" ? "conversation" : "document",
      });
      const at = new Date().toISOString();
      const citations = turn.citations ?? [];
      if (kind === "plan") update(target.id, { plan: { markdown: turn.content, at, citations } });
      else if (kind === "review") {
        const parsed = parseReview(turn.content, target.text);
        update(target.id, { review: { ...parsed, at, citations } });
        setShowMarks(parsed.marks.length > 0);
      } else if (kind === "readings") {
        const parsed = parseReadings(turn.content, citations, Boolean(result.usedWebSearch));
        update(target.id, { readings: { ...parsed, at, usedWebSearch: Boolean(result.usedWebSearch) } });
        if (webSearch && !result.usedWebSearch) setNotice("Web search was not available for this answer, so readings not in your course files are marked to check.");
      } else {
        const reply: EssayTurn = { role: "assistant", content: turn.content, citations, ...(turn.ungrounded ? { ungrounded: true } : {}) };
        const asked: EssayTurn = { role: "user", content: text };
        update(target.id, (e) => ({ chat: [...e.chat, asked, reply].slice(-MAX_ESSAY_CHAT) }));
        setQuestion("");
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const error = err as AiError;
        setAiError({ message: error.message || "Something went wrong.", hint: error.hint });
      }
    } finally {
      abortRef.current = null;
      setBusy("");
    }
  }

  async function importDraft(event: ChangeEvent<HTMLInputElement>, target: Essay) {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    const ext = picked.name.split(".").pop()?.toLowerCase() || "";
    if (!["docx", "md", "txt"].includes(ext)) {
      setNotice("Choose a Word (.docx), Markdown (.md) or text (.txt) file.");
      return;
    }
    if (target.text.trim() && !window.confirm(`Replace your current draft with the text of ${picked.name}?`)) return;
    try {
      const text = ext === "docx"
        ? (await extractFile({ path: picked.name, name: picked.name, ext, file: picked, category: inferCategory(picked.name, ext), topic: topicLabel(picked.name) })).text
        : await picked.text();
      if (!text.trim()) throw new Error("empty");
      update(target.id, { text: text.replace(/\r\n/g, "\n").trim() });
      setShowMarks(false);
      setNotice(`Imported ${wordCount(text)} words from ${picked.name}.`);
    } catch {
      setNotice(`Could not read any text from ${picked.name}.`);
    }
  }

  /**
   * Reads files the student picked (a brief, a rubric, a reading not in the
   * library) for one essay, or for the essay being created when `target` is
   * null. With `keepCopy`, each is also saved to the module's My Files.
   */
  async function attachFiles(list: FileList | null, target: Essay | null) {
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    setAttaching(true);
    setNotice("");
    const read: Attachment[] = [];
    const problems: string[] = [];
    for (const file of picked.slice(0, MAX_ATTACHMENTS)) {
      try {
        const attachment = await readAttachment(file);
        if (keepCopy && hosted) {
          try {
            attachment.savedPath = (await uploadOwnFile(course, file)).path;
          } catch (err) {
            problems.push(`${file.name} was read but not saved to your module: ${(err as Error).message}`);
          }
        }
        read.push(attachment);
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    if (target) update(target.id, (e) => ({ attachments: mergeAttachments(e.attachments, read) }));
    else setNewFiles((current) => mergeAttachments(current, read));
    setNotice(problems.join(" ") || (read.length ? `Added ${read.map((a) => a.name).join(", ")}. Study Hub reads ${read.length === 1 ? "it" : "them"} with every answer.` : ""));
    setAttaching(false);
  }

  /** The attached files with a remove button, and the button that adds more. */
  function removeAttachment(target: Essay | null, name: string) {
    if (target) update(target.id, (e) => ({ attachments: e.attachments.filter((a) => a.name !== name) }));
    else setNewFiles((f) => f.filter((a) => a.name !== name));
  }

  function attachmentList(files: Attachment[], target: Essay | null) {
    return (
      <div className="es-files">
        {files.map((a) => (
          <span key={a.name} className="chat-file" title={a.savedPath ? `Saved to ${a.savedPath}` : "Kept with this essay only"}>
            {a.name}
            {a.truncated ? " (first part)" : ""}
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(target, a.name)}>×</button>
          </span>
        ))}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={attaching || files.length >= MAX_ATTACHMENTS}
          onClick={() => {
            attachTarget.current = target;
            attachRef.current?.click();
          }}
        >
          {attaching ? "Reading…" : "Attach a file"}
        </button>
        {hosted && (
          <label className="chat-keep">
            <input type="checkbox" checked={keepCopy} onChange={(e) => setKeepCopy(e.target.checked)} />
            Also save to this module (My Files)
          </label>
        )}
      </div>
    );
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const deadlineId = String(form.get("deadline") || "");
    const linked = deadlines.find((d) => d.id === deadlineId);
    const due = String(form.get("due") || "") || (linked ? deadlineDay(linked) : null);
    const words = Number(form.get("words"));
    const hours = Number(form.get("hours"));
    const made = newEssay({
      title: String(form.get("title") || linked?.title || ""),
      question: String(form.get("question") || ""),
      brief: String(form.get("brief") || ""),
      wordLimit: Number.isFinite(words) && words > 0 ? Math.round(words) : null,
      due: due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
      hours: Number.isFinite(hours) && hours > 0 ? hours : null,
      ...(linked ? { deadlineId: linked.id } : {}),
      attachments: newFiles,
    });
    replaceFile({ version: 1, essays: [made, ...(fileRef.current?.essays || [])] });
    setNewFiles([]);
    setCreating(false);
    setSelected(made.id);
    setTask("plan");
  }

  function remove(target: Essay) {
    if (!window.confirm(`Delete "${target.title}" and everything Study Hub saved about it? This cannot be undone.`)) return;
    replaceFile({ version: 1, essays: (fileRef.current?.essays || []).filter((e) => e.id !== target.id) });
    setSelected("");
  }

  const segments = essay?.review ? markedSegments(essay.text, essay.review.marks) : [];

  /** One hidden picker for every "Attach a file" button; `attachTarget` says which essay it is for. */
  const picker = (
    <input
      ref={attachRef}
      type="file"
      accept={ATTACH_ACCEPT}
      multiple
      hidden
      onChange={(e) => {
        void attachFiles(e.target.files, attachTarget.current);
        e.target.value = "";
      }}
    />
  );

  if (loadError) return <div className="pv-page"><p role="alert">{loadError}</p></div>;
  if (!file) return <div className="pv-page"><p className="pv-meta">Reading your essays…</p></div>;

  /* ------------------------------------------------------------ the list */
  if (!essay) {
    return (
      <div className="pv-page es-page">
        <p className="eyebrow">{moduleName}</p>
        <h1>Essays</h1>
        <p className="pv-lede">
          Write your essay here or import it, and work on it with Study Hub: a plan for the time you have, feedback that marks what is not
          good enough yet, readings that make it stand out, and answers that point you to the right course files.
        </p>
        {!creating && (
          <button className="btn btn-primary es-new" onClick={() => setCreating(true)}>New essay</button>
        )}
        {creating && (
          <form className="panel es-form" onSubmit={create}>
            <h2>New essay</h2>
            {deadlines.length > 0 && (
              <label>
                Which assessment is it for? (optional)
                <select name="deadline" defaultValue="">
                  <option value="">Not linked to a deadline</option>
                  {deadlines.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{deadlineDay(d) ? ` (due ${deadlineDay(d)})` : ""}</option>
                  ))}
                </select>
              </label>
            )}
            <label>Title<input name="title" maxLength={200} placeholder="e.g. Coursework 2: Design patterns report" /></label>
            <label>The question or task<textarea name="question" rows={3} maxLength={4000} placeholder="Paste the essay question" /></label>
            <label>Brief and marking criteria (optional)<textarea name="brief" rows={5} maxLength={20000} placeholder="Paste the brief or rubric: feedback is measured against it" /></label>
            <div className="es-field">
              <span>Or attach the brief, rubric or any reading that is not in your library</span>
              {attachmentList(newFiles, null)}
            </div>
            <div className="es-form-row">
              <label>Word limit<input name="words" type="number" min="1" step="1" /></label>
              <label>Due date<input name="due" type="date" /></label>
              <label>Hours you will give it<input name="hours" type="number" min="1" step="0.5" placeholder="e.g. 12" /></label>
            </div>
            <div className="es-form-actions">
              <button className="btn btn-primary" type="submit">Start writing</button>
              <button className="btn btn-ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        )}
        {file.essays.length === 0 && !creating && <p className="pv-meta">No essays for this module yet.</p>}
        {file.essays.length > 0 && (
          <ul className="es-list">
            {file.essays.map((e) => (
              <li key={e.id}>
                <button onClick={() => { setSelected(e.id); setTask(e.plan ? "review" : "plan"); setShowMarks(false); }}>
                  <strong>{e.title}</strong>
                  <small>
                    {wordCount(e.text)}{e.wordLimit ? ` / ${e.wordLimit}` : ""} words
                    {e.due ? ` · due ${e.due}` : ""}
                    {e.review ? ` · ${e.review.marks.filter((m) => m.severity !== "strength").length} points to fix` : ""}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
        {saveError && <p role="alert">{saveError}</p>}
        {notice && <p className="pv-meta" role="status">{notice}</p>}
        {picker}
      </div>
    );
  }

  /* ------------------------------------------------------------ one essay */
  const words = wordCount(essay.text);
  const over = essay.wordLimit !== null && words > essay.wordLimit;
  const toFix = essay.review?.marks.filter((m) => m.severity !== "strength").length ?? 0;
  const when = (iso: string) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "");

  return (
    <div className="es-work">
      {picker}
      <header className="es-head">
        <button className="pv-link" onClick={() => { abortRef.current?.abort(); setSelected(""); }}>← All essays</button>
        <input
          className="es-title"
          aria-label="Essay title"
          value={essay.title}
          maxLength={200}
          onChange={(e) => update(essay.id, { title: e.target.value })}
        />
        <span className="es-save" role="status">
          {saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}
        </span>
      </header>
      <details className="es-details">
        <summary>Question, brief, deadline and time</summary>
        <label>The question or task<textarea rows={3} value={essay.question} onChange={(e) => update(essay.id, { question: e.target.value })} /></label>
        <label>Brief and marking criteria<textarea rows={4} value={essay.brief} onChange={(e) => update(essay.id, { brief: e.target.value })} /></label>
        <div className="es-form-row">
          <label>Word limit
            <input type="number" min="1" value={essay.wordLimit ?? ""} onChange={(e) => update(essay.id, { wordLimit: Number(e.target.value) > 0 ? Math.round(Number(e.target.value)) : null })} />
          </label>
          <label>Due date
            <input type="date" value={essay.due ?? ""} onChange={(e) => update(essay.id, { due: e.target.value || null })} />
          </label>
          <label>Hours you will give it
            <input type="number" min="1" step="0.5" value={essay.hours ?? ""} onChange={(e) => update(essay.id, { hours: Number(e.target.value) > 0 ? Number(e.target.value) : null })} />
          </label>
        </div>
        <div className="es-field">
          <span>Files for this essay (brief, rubric, readings not in your library)</span>
          {attachmentList(essay.attachments, essay)}
        </div>
        <button className="text-link es-delete" onClick={() => remove(essay)}>Delete this essay</button>
      </details>
      {saveError && <p role="alert" className="es-alert">{saveError}</p>}

      <div className="es-panes">
        <section className="es-editor" aria-label="Your draft">
          <div className="es-toolbar">
            <span className={over ? "es-count over" : "es-count"}>
              {words}{essay.wordLimit ? ` / ${essay.wordLimit}` : ""} words
            </span>
            {essay.review && essay.review.marks.length > 0 && (
              <button className={`btn btn-ghost${showMarks ? " active" : ""}`} aria-pressed={showMarks} onClick={() => setShowMarks((v) => !v)}>
                {showMarks ? "Back to editing" : `Show marks (${essay.review.marks.length})`}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => importRef.current?.click()}>Import a file</button>
            <input ref={importRef} type="file" accept=".docx,.md,.txt" hidden onChange={(e) => void importDraft(e, essay)} />
          </div>
          {showMarks && essay.review ? (
            <div className="es-marked" aria-label="Your draft with feedback marks">
              {segments.map((s, i) =>
                s.mark ? (
                  <button
                    key={i}
                    type="button"
                    className={`es-mark es-mark-${s.mark.severity}${activeMark === s.index ? " active" : ""}`}
                    onClick={() => { setActiveMark(s.index!); setTask("review"); }}
                    title={s.mark.comment}
                  >
                    {s.text}
                  </button>
                ) : (
                  <span key={i}>{s.text}</span>
                ),
              )}
            </div>
          ) : (
            <textarea
              className="es-text"
              aria-label="Essay text"
              value={essay.text}
              placeholder="Start writing, or import your draft from a Word file."
              onChange={(e) => update(essay.id, { text: e.target.value })}
            />
          )}
        </section>

        <section className="es-side" aria-label="Work on it with Study Hub">
          <nav className="pv-subtabs es-tabs" aria-label="Essay help">
            {(Object.keys(TASK_LABEL) as Task[]).map((t) => (
              <button key={t} type="button" className={task === t ? "active" : ""} aria-current={task === t ? "page" : undefined} onClick={() => setTask(t)}>
                {TASK_LABEL[t]}{t === "review" && toFix ? ` (${toFix})` : ""}
              </button>
            ))}
          </nav>
          {aiError && (
            <div className="callout callout-warn es-alert">
              <b>Study Hub could not answer</b> {aiError.message}{aiError.hint ? ` ${aiError.hint}` : ""}
            </div>
          )}
          {notice && <p className="pv-meta" role="status">{notice}</p>}

          {task === "plan" && (
            <div className="es-panel">
              <p className="pv-meta">
                A step-by-step plan for {essay.hours ? `the ${essay.hours} hours you set` : "the time you have (set your hours above)"}
                {essay.due ? `, finishing by ${essay.due}` : ""}, with the course files to read.
              </p>
              <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void ask("plan", essay)}>
                {busy === "plan" ? "Planning…" : essay.plan ? "Make a new plan" : "Make my plan"}
              </button>
              {essay.plan && (
                <div className="es-result">
                  <small className="pv-meta">Made {when(essay.plan.at)}</small>
                  <div className="es-markdown">
                    <Markdown text={essay.plan.markdown} path={`essay:${essay.id}:plan`} onLink={() => {}} checks={{}} toggleCheck={() => {}} />
                  </div>
                  <Citations citations={essay.plan.citations} scope={scope} />
                </div>
              )}
            </div>
          )}

          {task === "review" && (
            <div className="es-panel">
              <p className="pv-meta">Study Hub reads your draft like a strict marker, against the question and brief, and marks what needs work.</p>
              <button className="btn btn-primary" disabled={Boolean(busy) || !essay.text.trim()} onClick={() => void ask("review", essay)}>
                {busy === "review" ? "Reading your draft…" : essay.review ? "Review again" : "Review my draft"}
              </button>
              {!essay.text.trim() && <p className="pv-meta">Write or import a draft first.</p>}
              {essay.review && (
                <div className="es-result">
                  <small className="pv-meta">Reviewed {when(essay.review.at)}{essay.review.dropped ? ` · ${essay.review.dropped} comment${essay.review.dropped === 1 ? "" : "s"} left out because the quoted words are not in your draft` : ""}</small>
                  <div className="es-markdown">
                    <Markdown text={essay.review.summary} path={`essay:${essay.id}:review`} onLink={() => {}} checks={{}} toggleCheck={() => {}} />
                  </div>
                  <ol className="es-marks">
                    {essay.review.marks.map((m, i) => (
                      <li key={i} className={`es-mark-item es-mark-${m.severity}${activeMark === i ? " active" : ""}`}>
                        <button onClick={() => { setActiveMark(i); setShowMarks(true); }}>
                          <span className="es-sev">{m.severity === "major" ? "Not good enough" : m.severity === "minor" ? "Polish" : "Strength"}</span>
                          <q>{m.quote}</q>
                        </button>
                        <p>{m.comment}</p>
                      </li>
                    ))}
                  </ol>
                  <Citations citations={essay.review.citations} scope={scope} />
                </div>
              )}
            </div>
          )}

          {task === "readings" && (
            <div className="es-panel">
              <p className="pv-meta">Readings from your course first, then wider ones that would make the essay stand out. Each says whether Study Hub could check it.</p>
              <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void ask("readings", essay)}>
                {busy === "readings" ? "Finding readings…" : essay.readings ? "Suggest again" : "Suggest readings"}
              </button>
              {essay.readings && (
                <div className="es-result">
                  <small className="pv-meta">Suggested {when(essay.readings.at)}{essay.readings.usedWebSearch ? " · checked with a web search" : " · no web search"}</small>
                  {essay.readings.intro && <p>{essay.readings.intro}</p>}
                  <ul className="es-readings">
                    {essay.readings.items.map((r, i) => {
                      const fileUrl = r.file ? scope?.fileUrls[r.file] : undefined;
                      return (
                        <li key={i}>
                          <strong>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a> : fileUrl ? <a href={fileUrl} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}</strong>
                          {r.author && <span> · {r.author}</span>}
                          <span className={`es-badge ${r.verified ? "ok" : "check"}`}>
                            {r.verified
                              ? r.source === "course" ? `In your course: ${r.file}` : "Checked on the web"
                              : r.source === "course" ? "Said to be in your course: check it" : r.source === "web" ? "Web link not confirmed: check it" : "Not checked: confirm it exists"}
                          </span>
                          {r.why && <p>{r.why}</p>}
                        </li>
                      );
                    })}
                  </ul>
                  {essay.readings.items.length === 0 && <p className="pv-meta">No readings came back in a form Study Hub could read. Try again.</p>}
                </div>
              )}
            </div>
          )}

          {task === "chat" && (
            <div className="es-panel es-chat">
              <div className="es-chat-messages">
                {essay.chat.length === 0 && (
                  <p className="pv-meta">Ask anything about this essay: how to structure it, whether an argument holds, which lecture covers a point, how to reference.</p>
                )}
                {essay.chat.map((t, i) => (
                  <div key={i} className={`chat-msg ${t.role}`}>
                    {t.content}
                    {t.role === "assistant" && t.citations && <Citations citations={t.citations} scope={scope} />}
                    {t.role === "assistant" && t.ungrounded && <div className="chat-ungrounded">Not tied to your course files: check before relying on it.</div>}
                  </div>
                ))}
                {busy === "chat" && <div className="chat-msg assistant chat-thinking">Thinking…</div>}
              </div>
              <form
                className="chat-input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (question.trim()) void ask("chat", essay, question.trim());
                }}
              >
                <textarea
                  rows={2}
                  aria-label="Your question about the essay"
                  placeholder="Ask about your essay…"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (question.trim()) void ask("chat", essay, question.trim());
                    }
                  }}
                />
                <button className="btn btn-primary" type="submit" disabled={Boolean(busy) || !question.trim()}>Send</button>
              </form>
              {essay.chat.length > 0 && (
                <button className="text-link" onClick={() => update(essay.id, { chat: [] })}>Clear this conversation</button>
              )}
            </div>
          )}
          {busy && (
            <button className="text-link" onClick={() => abortRef.current?.abort()}>Stop</button>
          )}
        </section>
      </div>
    </div>
  );
}
