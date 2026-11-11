"use client";

/**
 * The study assistant: a round button in the bottom-right corner of every
 * page that docks a chat panel along the right edge. It answers from the
 * module the student has open plus their saved deadlines (see
 * chat-context.ts), through the configured AI connection, normally the Claude
 * or Codex command line on this computer. It never has internet access: web
 * search is not offered and every request asks for it to be off.
 *
 * It can also propose changes to the deadline list ("give this lab a date",
 * "add the formative quiz"); each one is a card the student applies or
 * dismisses (see chat-actions.ts). Conversations are saved in the module's
 * .study-hub folder after every turn (see chat-store.ts), because each page is
 * its own load and the panel would otherwise forget everything on the way.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_CHAT_TURNS, sendChatMessage, type ChatTurn } from "../../lib/ai/chat.ts";
import {
  actionDate,
  actionInstructions,
  actionsSummary,
  checkAction,
  extractActionLines,
  type ActionModule,
  type ChatAction,
} from "../../lib/ai/chat-actions.ts";
import { formatUsd } from "../../lib/ai/models.ts";
import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection, isHosted, loadSettings } from "../../lib/ai/settings.ts";
import type { AiClient, AiError } from "../../lib/ai/types.ts";
import { ATTACH_ACCEPT, MAX_ATTACHMENTS, attachmentContext, mergeAttachments, readAttachment, type Attachment } from "../../lib/attachments.ts";
import {
  conversationAttachments,
  emptyChatFile,
  loadChats,
  newChatId,
  saveChats,
  upsertChat,
  type ChatFile,
  type SavedTurn,
} from "../../lib/chat-store.ts";
import { uploadOwnFile } from "../../lib/own-files.ts";
import {
  ACTIVE_MODULE_EVENT,
  addDeadline,
  fetchDeadlines,
  fetchTree,
  loadModule,
  moduleCode,
  pickModule,
  removeDeadline,
  resolveDeadline,
  setDeadlineDone,
  type LibraryTree,
} from "../../lib/library.ts";
import { buildModuleScope, withDeadlines, type ChatScope } from "./chat-context.ts";
import { CHAT_ASK_EVENT, CHAT_STATE_EVENT, CHAT_TOGGLE_EVENT, LIBRARY_CHANGED_EVENT } from "../shell/AppShell.tsx";

const OPEN_KEY = "studyhub:chat:open";
const DRAFT_KEY = "studyhub:chat:draft";
const SUGGESTIONS = [
  "What's due in the next two weeks?",
  "What should I revise first?",
  "Is there anything on the course site that isn't in my deadlines yet?",
];

function rememberOpen(open: boolean) {
  try {
    sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* only a convenience across page loads */
  }
}
function readDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) || "";
  } catch {
    return "";
  }
}
function writeDraft(text: string) {
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY, text);
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* the draft just does not follow to the next page */
  }
}

/** Each module code once, in the newest academic year that has it. */
function actionModules(tree: LibraryTree): ActionModule[] {
  const seen = new Map<string, ActionModule>();
  for (const y of [...tree.years].sort((a, b) => b.year.localeCompare(a.year)))
    for (const folder of y.modules) {
      const code = moduleCode(folder);
      if (!seen.has(code)) seen.set(code, { code, year: y.year });
    }
  return [...seen.values()];
}

/** What a turn reads like to the model on later turns: its answer plus what became of its proposals. */
const forHistory = (turns: SavedTurn[]): ChatTurn[] =>
  turns.map((t) => {
    const summary = actionsSummary(t.actions);
    return { role: t.role, content: summary ? `${t.content}\n\n${summary}` : t.content };
  });

export default function ChatDock() {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState<AiClient | null>(null);
  const [aiState, setAiState] = useState<"checking" | "none" | "ready" | "error">("checking");
  const [clientError, setClientError] = useState("");
  const [scope, setScope] = useState<ChatScope | null>(null);
  const [scopeState, setScopeState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  /** The module `scope` was built for, as `<year>/<module>`. */
  const [scopeKey, setScopeKey] = useState("");
  const [switchedTo, setSwitchedTo] = useState("");
  const [modules, setModules] = useState<ActionModule[]>([]);
  const [turns, setTurns] = useState<SavedTurn[]>([]);
  const [chatId, setChatId] = useState(newChatId);
  const [saved, setSaved] = useState<ChatFile>(emptyChatFile);
  const [saveError, setSaveError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState("");
  /** Files picked for the next question, not sent yet. */
  const [pending, setPending] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  /** Also copy picked files into the module's My Files folder. */
  const [keepCopy, setKeepCopy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [spent, setSpent] = useState({ tokens: 0, costUsd: 0, messages: 0 });
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  // The latest values for async work that outlives a render (a reply arriving, a save finishing).
  const savedRef = useRef(saved);
  const keyRef = useRef(scopeKey);
  useEffect(() => {
    savedRef.current = saved;
    keyRef.current = scopeKey;
  }, [saved, scopeKey]);

  // Hosted only: the library, the deadlines and the command line all live in
  // the desktop app. Not on first-run setup, where nothing is synced yet.
  useEffect(() => {
    if (!isHosted() || window.location.pathname.startsWith("/welcome")) return;
    let remembered = false;
    try {
      remembered = sessionStorage.getItem(OPEN_KEY) === "1";
    } catch {
      /* closed by default */
    }
    const draft = readDraft();
    queueMicrotask(() => {
      setAvailable(true);
      setOpen(remembered);
      if (draft) setInput(draft);
    });
  }, []);

  /** Writes one conversation into the module's saved file, as the open one. */
  const persist = useCallback((id: string, next: SavedTurn[]) => {
    const key = keyRef.current;
    if (!key) return;
    const file = upsertChat(savedRef.current, id, next);
    savedRef.current = file;
    setSaved(file);
    saveChats(key, file).then(
      () => setSaveError(""),
      (err: Error) => setSaveError(err.message || "Could not save this conversation."),
    );
  }, []);

  /** Reads the open module; `fresh` starts a new conversation instead of reopening the saved one. */
  const loadScope = useCallback(async (fresh = false) => {
    setScopeState("loading");
    try {
      const [tree, deadlines] = await Promise.all([fetchTree(), fetchDeadlines()]);
      setModules(actionModules(tree));
      const picked = pickModule(tree);
      if (!picked) {
        setScope(await buildModuleScope("no module yet", [], deadlines, new Date()));
        setScopeKey("");
        keyRef.current = "";
        setSaved(emptyChatFile());
      } else {
        const key = `${picked.year}/${picked.module}`;
        const [files, chats] = await Promise.all([
          loadModule(tree, picked.year, picked.module),
          loadChats(key).catch(() => emptyChatFile()),
        ]);
        setScope(await buildModuleScope(picked.module, files, deadlines, new Date()));
        setScopeKey(key);
        keyRef.current = key;
        const file = fresh ? { ...chats, current: null } : chats;
        savedRef.current = file;
        setSaved(file);
        const current = file.current ? file.chats.find((c) => c.id === file.current) : undefined;
        setTurns(current ? current.turns : []);
        setChatId(current ? current.id : newChatId());
      }
      setSwitchedTo("");
      setScopeState("ready");
    } catch {
      setScopeState("error");
    }
  }, []);

  // Connect and read the module the first time the panel opens.
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    hasAnyConnection()
      .then(async (ready) => {
        if (!ready) return setAiState("none");
        try {
          setClient(await createConfiguredAiClient());
          setAiState("ready");
        } catch (err) {
          setClientError((err as Error).message || "Could not connect.");
          setAiState("error");
        }
      })
      .catch(() => setAiState("none"));
    void loadScope();
  }, [open, loadScope]);

  // Switching module on the hub: follow it straight away in an empty
  // conversation, otherwise offer to, so an answer never mixes two modules.
  useEffect(() => {
    const onSwitch = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      if (!key || key === scopeKey || scopeState === "idle") return;
      if (turns.length === 0 && !sending) void loadScope();
      else setSwitchedTo(key);
    };
    window.addEventListener(ACTIVE_MODULE_EVENT, onSwitch);
    return () => window.removeEventListener(ACTIVE_MODULE_EVENT, onSwitch);
  }, [scopeKey, scopeState, turns.length, sending, loadScope]);

  useEffect(() => {
    if (!available) return;
    document.body.classList.toggle("chat-docked", open);
    window.dispatchEvent(new CustomEvent(CHAT_STATE_EVENT, { detail: open }));
    if (open) inputRef.current?.focus();
    return () => document.body.classList.remove("chat-docked");
  }, [open, available]);

  // The rail's "Ask the assistant" opens and closes the panel.
  useEffect(() => {
    const onToggle = (event: Event) => {
      const value = Boolean((event as CustomEvent<boolean>).detail);
      setOpen(value);
      rememberOpen(value);
    };
    window.addEventListener(CHAT_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(CHAT_TOGGLE_EVENT, onToggle);
  }, []);

  // A page asks a question for the student: open with it typed in, never sent on its own.
  useEffect(() => {
    const onAsk = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (typeof text !== "string") return;
      setOpen(true);
      rememberOpen(true);
      setInput(text);
      writeDraft(text);
      requestAnimationFrame(() => {
        const box = inputRef.current;
        if (!box) return;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      });
    };
    window.addEventListener(CHAT_ASK_EVENT, onAsk);
    return () => window.removeEventListener(CHAT_ASK_EVENT, onAsk);
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [turns, sending]);

  const toggle = (value: boolean) => {
    setOpen(value);
    rememberOpen(value);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const startFresh = () => {
    abortRef.current?.abort();
    setTurns([]);
    setError(null);
    setShowHistory(false);
    setSpent({ tokens: 0, costUsd: 0, messages: 0 });
    void loadScope(true);
  };

  const reopen = (id: string) => {
    const chat = saved.chats.find((c) => c.id === id);
    if (!chat || sending) return;
    setChatId(chat.id);
    setTurns(chat.turns);
    setError(null);
    setShowHistory(false);
    persist(chat.id, chat.turns);
  };

  const send = async (text = input, base: SavedTurn[] = turns, files: Attachment[] = pending) => {
    const question = text.trim() || (files.length ? `I attached ${files.map((f) => f.name).join(", ")}. What should I do with it?` : "");
    if (!question || !client || !scope || sending || base.length >= MAX_CHAT_TURNS) return;
    setInput("");
    writeDraft("");
    setPending([]);
    setAttachError("");
    setError(null);
    const id = chatId;
    const historySoFar: SavedTurn[] = [...base, { role: "user", content: question, ...(files.length ? { attachments: files } : {}) }];
    // Files attached anywhere in this conversation stay readable for the rest of it.
    const attached = attachmentContext(conversationAttachments(historySoFar));
    setTurns(historySoFar);
    // Saved before the reply, so a question asked just before changing page is not lost.
    persist(id, historySoFar);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { turn, result } = await sendChatMessage({
        client,
        scopeLabel: scope.scopeLabel,
        contextLabel: scope.contextLabel,
        contextBlock: [scope.contextBlock, attached.block].filter(Boolean).join("\n\n"),
        history: forHistory(historySoFar),
        question,
        webSearch: false,
        extracts: new Map([...scope.extracts, ...attached.extracts]),
        allText: [scope.allText, attached.text].filter(Boolean).join("\n\n"),
        signal: controller.signal,
        instructions: [
          actionInstructions(modules),
          attached.extracts.length
            ? "The student attached files that are not in their library (marked as attached). Read them as course material; " +
              "when one states a deadline the Deadlines list does not have, propose it with add_deadline and say where the file states it."
            : "",
        ].filter(Boolean).join("\n"),
      });
      const deadlines = await fetchDeadlines().catch(() => []);
      const { prose, lines } = extractActionLines(turn.content);
      const actions = lines.map((line) => checkAction(line, deadlines, modules));
      const answer: SavedTurn = {
        ...turn,
        content: prose || (actions.length ? "Here is what I can change for you:" : turn.content),
        ...(actions.length ? { actions, ungrounded: false } : {}),
      };
      const next = [...historySoFar, answer];
      setTurns(next);
      persist(id, next);
      setSpent((prev) => ({
        tokens: prev.tokens + (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0),
        costUsd: prev.costUsd + (result.costUsd || 0),
        messages: prev.messages + 1,
      }));
    } catch (err) {
      if (controller.signal.aborted) {
        setTurns(base);
        persist(id, base);
        setInput(text);
        writeDraft(text);
        setPending(files);
      } else {
        const aiError = err as AiError;
        setError({ message: aiError.message || "Something went wrong.", hint: aiError.hint });
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  /** Reads picked files on this computer; with `keepCopy`, also saves each into the module's My Files. */
  const attach = async (list: FileList | null) => {
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    setAttaching(true);
    setAttachError("");
    const read: Attachment[] = [];
    const problems: string[] = [];
    for (const file of picked.slice(0, MAX_ATTACHMENTS)) {
      try {
        const attachment = await readAttachment(file);
        if (keepCopy && scopeKey) {
          try {
            attachment.savedPath = (await uploadOwnFile(scopeKey, file)).path;
          } catch (err) {
            problems.push(`${file.name} was read but not saved to your module: ${(err as Error).message}`);
          }
        }
        read.push(attachment);
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    if (read.some((a) => a.savedPath)) window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
    setPending((current) => mergeAttachments(current, read));
    setAttachError(problems.join(" "));
    setAttaching(false);
  };

  /** Runs one proposed change against the library, after the student clicked Apply. */
  async function runAction(action: ChatAction) {
    if (action.type === "add_deadline") {
      const place = modules.find((m) => m.code === action.module);
      if (!place) throw new Error(`${action.module} is not one of your modules.`);
      await addDeadline({
        module: place.code,
        year: place.year,
        title: action.title,
        kind: action.kind,
        date: actionDate(action),
        ...(action.weight !== undefined ? { weight: action.weight } : {}),
        ...(action.formative !== undefined ? { formative: action.formative } : {}),
        ...(action.note ? { note: action.note } : {}),
      });
    } else if (action.type === "set_date") await resolveDeadline(action.id, { date: actionDate(action) });
    else if (action.type === "mark_done") await setDeadlineDone(action.id, action.done);
    else await removeDeadline(action.id);
  }

  const settle = async (turnIndex: number, actionIndex: number, apply: boolean) => {
    const proposal = turns[turnIndex]?.actions?.[actionIndex];
    if (!proposal || proposal.state !== "proposed" || applying) return;
    const update = (patch: Partial<typeof proposal>) => {
      const next = turns.map((t, i) =>
        i !== turnIndex ? t : { ...t, actions: t.actions!.map((a, j) => (j === actionIndex ? { ...a, ...patch } : a)) },
      );
      setTurns(next);
      persist(chatId, next);
    };
    if (!apply || !proposal.action) return update({ state: "dismissed" });
    setApplying(`${turnIndex}:${actionIndex}`);
    try {
      await runAction(proposal.action);
      update({ state: "applied" });
      const deadlines = await fetchDeadlines();
      setScope((current) => (current ? withDeadlines(current, deadlines, new Date()) : current));
      window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
    } catch (err) {
      update({ state: "failed", error: (err as Error).message || "Study Hub could not make that change." });
    } finally {
      setApplying("");
    }
  };

  if (!available) return null;

  if (!open)
    return (
      <button className="chat-fab" onClick={() => toggle(true)} aria-label="Open the study assistant" title="Ask about your module and deadlines">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 3C6.5 3 2 6.8 2 11.5c0 2.4 1.2 4.6 3.1 6.1L4.4 21l3.9-2c1.2.4 2.4.5 3.7.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3Zm-4 9.7a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"
          />
        </svg>
      </button>
    );

  const subscription = loadSettings().transport === "subscription";
  const atCap = turns.length >= MAX_CHAT_TURNS;
  const canSend = aiState === "ready" && scopeState === "ready" && !sending;
  // A question saved without its reply: the page changed or the app closed while it was being answered.
  const unanswered = !sending && turns.length > 0 && turns[turns.length - 1].role === "user";
  const others = saved.chats.filter((c) => c.id !== chatId || turns.length === 0);
  const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <aside className="chat-panel" aria-labelledby="chat-title">
      <div className="chat-head">
        <div>
          <h2 id="chat-title">Study assistant</h2>
          <small>
            {scopeState === "ready" && scope ? scope.contextLabel : scopeState === "error" ? "Could not read your library" : "Reading your module…"}
          </small>
        </div>
        {scopeKey && (
          <button
            className="chat-history-toggle"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            title="Saved conversations for this module"
          >
            History
          </button>
        )}
        <button onClick={() => toggle(false)} aria-label="Close the study assistant">
          ×
        </button>
      </div>
      <div className="chat-toggle-note">
        No internet. Answers come only from this module&rsquo;s files, files you attach and your saved deadlines
        {scope ? ` (${scope.linkedFiles.length} file${scope.linkedFiles.length === 1 ? "" : "s"} read)` : ""}. You can also ask it to add, date or
        tick off deadlines; nothing changes until you click Apply.
      </div>
      {switchedTo && (
        <div className="chat-estimate callout">
          You opened {switchedTo.split("/").pop()}. This conversation is still about {scope?.contextLabel}.{" "}
          <button className="text-link" onClick={startFresh}>
            Start a new one about it
          </button>
        </div>
      )}

      {showHistory ? (
        <div className="chat-messages chat-history">
          <p className="chat-history-note">Conversations are saved in this module&rsquo;s folder and reopen when you come back.</p>
          {others.length === 0 && <p className="chat-empty">No other saved conversations for this module yet.</p>}
          <ul>
            {others.map((c) => (
              <li key={c.id}>
                <button onClick={() => reopen(c.id)} disabled={sending}>
                  <span>{c.title}</span>
                  <small>
                    {fmtWhen(c.updated)} · {c.turns.length} message{c.turns.length === 1 ? "" : "s"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost" onClick={() => setShowHistory(false)}>
            Back to the conversation
          </button>
        </div>
      ) : (
        <div className="chat-messages" ref={messagesRef}>
          {aiState === "none" && (
            <p className="chat-empty">
              No AI connection is set up. <a href="/connect">Set one up</a> to use this.
            </p>
          )}
          {aiState === "error" && <p className="chat-empty">{clientError}</p>}
          {scopeState === "error" && (
            <p className="chat-empty">
              Could not read your module.{" "}
              <button className="text-link" onClick={() => void loadScope()}>
                Try again
              </button>
            </p>
          )}
          {(aiState === "checking" || (aiState === "ready" && scopeState === "loading")) && <p className="chat-empty">Getting ready…</p>}
          {canSend && turns.length === 0 && (
            <div className="chat-empty">
              <p>Ask about {scope?.contextLabel} or your deadlines, or tell it to change one.</p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={i} className={`chat-msg ${turn.role}`}>
              {turn.content}
              {turn.attachments && turn.attachments.length > 0 && (
                <div className="chat-attached">
                  {turn.attachments.map((a) => (
                    <span key={a.name} className="chat-file" title={a.savedPath ? `Saved to ${a.savedPath}` : "Not saved to your library"}>
                      {a.name}
                      {a.truncated ? " (first part)" : ""}
                    </span>
                  ))}
                </div>
              )}
              {turn.role === "assistant" && turn.citations && turn.citations.length > 0 && (
                <div className="chat-citations">
                  {turn.citations.map((citation, j, all) => {
                    if (citation.kind !== "file") return null;
                    // One chip per file and verdict, however many quotes came from it.
                    if (all.findIndex((c) => c.kind === "file" && c.sourceFile === citation.sourceFile && c.verdict === citation.verdict) !== j) return null;
                    const label = citation.verdict === "verified" ? `From ${citation.sourceFile}` : `Check ${citation.sourceFile}`;
                    const className = `chat-citation ${citation.verdict === "verified" ? "verified" : "unverified"}`;
                    const url = scope?.fileUrls[citation.sourceFile];
                    return url ? (
                      <a key={j} className={className} title={citation.evidence} href={url} target="_blank" rel="noopener noreferrer">
                        {label}
                      </a>
                    ) : (
                      <span key={j} className={className} title={citation.evidence}>
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}
              {turn.actions && turn.actions.length > 0 && (
                <ul className="chat-actions">
                  {turn.actions.map((proposal, j) => (
                    <li key={j} className={`chat-action chat-action-${proposal.state}`}>
                      <span className="chat-action-label">{proposal.label}</span>
                      {proposal.error && <small>{proposal.error}</small>}
                      {proposal.state === "proposed" ? (
                        <span className="chat-action-buttons">
                          <button className="btn btn-primary" disabled={Boolean(applying)} onClick={() => void settle(i, j, true)}>
                            {applying === `${i}:${j}` ? "Applying…" : "Apply"}
                          </button>
                          <button className="btn btn-ghost" disabled={Boolean(applying)} onClick={() => void settle(i, j, false)}>
                            Dismiss
                          </button>
                        </span>
                      ) : (
                        <small className="chat-action-state">
                          {{ applied: "Applied", dismissed: "Dismissed", failed: "Could not apply", refused: "Not possible", proposed: "" }[proposal.state]}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {turn.role === "assistant" && turn.ungrounded && (
                <div className="chat-ungrounded">Not tied to a quote from your files: check before relying on it.</div>
              )}
            </div>
          ))}
          {unanswered && canSend && (
            <div className="chat-estimate callout">
              No reply arrived for your last question (the page changed or the app closed).{" "}
              <button className="text-link" onClick={() => void send(turns[turns.length - 1].content, turns.slice(0, -1))}>
                Ask again
              </button>
            </div>
          )}
          {sending && <div className="chat-msg assistant chat-thinking">Thinking…</div>}
        </div>
      )}

      {spent.messages > 0 && !subscription && (
        <div className="chat-estimate">
          {spent.tokens.toLocaleString()} tokens{spent.costUsd ? `, ${formatUsd(spent.costUsd)}` : ""} this conversation.
        </div>
      )}
      {saveError && <div className="chat-estimate callout callout-warn">{saveError}</div>}
      {error && (
        <div className="chat-estimate callout callout-warn">
          <b>Could not send that</b>
          {error.message}
          {error.hint ? ` ${error.hint}` : ""}
        </div>
      )}

      <div className="chat-input-area">
        {atCap ? (
          <div className="chat-meta-row">
            <span>This conversation has reached its length limit.</span>
            <button onClick={startFresh}>Start a new conversation</button>
          </div>
        ) : (
          <>
            {(pending.length > 0 || attachError || attaching) && (
              <div className="chat-pending">
                {pending.map((a) => (
                  <span key={a.name} className="chat-file">
                    {a.name}
                    {a.savedPath ? " · saved" : ""}
                    <button aria-label={`Remove ${a.name}`} onClick={() => setPending((p) => p.filter((x) => x.name !== a.name))}>
                      ×
                    </button>
                  </span>
                ))}
                {attaching && <span className="chat-file">Reading…</span>}
                {attachError && <small className="chat-attach-error">{attachError}</small>}
              </div>
            )}
            <div className="chat-input-row">
              <button
                className="btn btn-ghost chat-attach"
                onClick={() => fileRef.current?.click()}
                disabled={!canSend || attaching || pending.length >= MAX_ATTACHMENTS}
                aria-label="Attach a file that is not in your library"
                title="Attach a brief, rubric or any file that is not in your library"
              >
                +
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={ATTACH_ACCEPT}
                multiple
                hidden
                onChange={(event) => {
                  void attach(event.target.files);
                  event.target.value = "";
                }}
              />
              <textarea
                ref={inputRef}
                rows={2}
                placeholder="Ask a question, or tell it what to change…"
                aria-label="Your question"
                value={input}
                disabled={!canSend}
                onChange={(event) => {
                  setInput(event.target.value);
                  writeDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {sending ? (
                <button className="btn btn-ghost" onClick={() => abortRef.current?.abort()}>
                  Stop
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => void send()} disabled={!canSend || (!input.trim() && !pending.length)}>
                  Send
                </button>
              )}
            </div>
            {scopeKey && (
              <label className="chat-keep">
                <input type="checkbox" checked={keepCopy} onChange={(event) => setKeepCopy(event.target.checked)} />
                Also save attached files to {scope?.contextLabel ?? "this module"} (My Files)
              </label>
            )}
            {turns.length > 0 && (
              <div className="chat-meta-row">
                <span>
                  {turns.length}/{MAX_CHAT_TURNS} turns · saved
                </span>
                <button onClick={startFresh}>Start a new conversation</button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
