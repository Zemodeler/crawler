"use client";

/**
 * The study assistant: a round button in the bottom-right corner of every
 * page that docks a chat panel along the right edge. It answers from the
 * module the student has open plus their saved deadlines (see
 * chat-context.ts), through the configured AI connection, normally the Claude
 * or Codex command line on this computer. It never has internet access: web
 * search is not offered and every request asks for it to be off.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_CHAT_TURNS, sendChatMessage, type ChatTurn } from "../../lib/ai/chat.ts";
import { formatUsd } from "../../lib/ai/models.ts";
import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection, isHosted, loadSettings } from "../../lib/ai/settings.ts";
import type { AiClient, AiError } from "../../lib/ai/types.ts";
import { ACTIVE_MODULE_EVENT, fetchDeadlines, fetchTree, loadModule, pickModule } from "../../lib/library.ts";
import { buildModuleScope, type ChatScope } from "./chat-context.ts";

const OPEN_KEY = "studyhub:chat:open";
const SUGGESTIONS = ["What's due in the next two weeks?", "What topics does this module cover?", "What should I revise first?"];

function rememberOpen(open: boolean) {
  try {
    sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* only a convenience across page loads */
  }
}

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
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [spent, setSpent] = useState({ tokens: 0, costUsd: 0, messages: 0 });
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

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
    queueMicrotask(() => {
      setAvailable(true);
      setOpen(remembered);
    });
  }, []);

  const loadScope = useCallback(async () => {
    setScopeState("loading");
    try {
      const [tree, deadlines] = await Promise.all([fetchTree(), fetchDeadlines()]);
      const picked = pickModule(tree);
      if (!picked) {
        setScope(await buildModuleScope("no module yet", [], deadlines, new Date()));
        setScopeKey("");
      } else {
        const files = await loadModule(tree, picked.year, picked.module);
        setScope(await buildModuleScope(picked.module, files, deadlines, new Date()));
        setScopeKey(`${picked.year}/${picked.module}`);
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
    if (open) inputRef.current?.focus();
    return () => document.body.classList.remove("chat-docked");
  }, [open, available]);

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
    setSpent({ tokens: 0, costUsd: 0, messages: 0 });
    void loadScope();
  };

  const send = async (text = input) => {
    const question = text.trim();
    if (!question || !client || !scope || sending || turns.length >= MAX_CHAT_TURNS) return;
    setInput("");
    setError(null);
    const historySoFar: ChatTurn[] = [...turns, { role: "user", content: question }];
    setTurns(historySoFar);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { turn, result } = await sendChatMessage({
        client,
        scopeLabel: scope.scopeLabel,
        contextLabel: scope.contextLabel,
        contextBlock: scope.contextBlock,
        history: historySoFar,
        question,
        webSearch: false,
        extracts: scope.extracts,
        allText: scope.allText,
        signal: controller.signal,
      });
      setTurns((prev) => [...prev, turn]);
      setSpent((prev) => ({
        tokens: prev.tokens + (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0),
        costUsd: prev.costUsd + (result.costUsd || 0),
        messages: prev.messages + 1,
      }));
    } catch (err) {
      if (controller.signal.aborted) {
        setTurns((prev) => prev.slice(0, -1));
        setInput(question);
      } else {
        const aiError = err as AiError;
        setError({ message: aiError.message || "Something went wrong.", hint: aiError.hint });
      }
    } finally {
      abortRef.current = null;
      setSending(false);
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

  return (
    <aside className="chat-panel" aria-labelledby="chat-title">
      <div className="chat-head">
        <div>
          <h2 id="chat-title">Study assistant</h2>
          <small>
            {scopeState === "ready" && scope ? scope.contextLabel : scopeState === "error" ? "Could not read your library" : "Reading your module…"}
          </small>
        </div>
        <button onClick={() => toggle(false)} aria-label="Close the study assistant">
          ×
        </button>
      </div>
      <div className="chat-toggle-note">
        No internet. Answers come only from this module&rsquo;s files and your saved deadlines
        {scope ? ` (${scope.linkedFiles.length} file${scope.linkedFiles.length === 1 ? "" : "s"} read)` : ""}.
      </div>
      {switchedTo && (
        <div className="chat-estimate callout">
          You opened {switchedTo.split("/").pop()}. This conversation is still about {scope?.contextLabel}.{" "}
          <button className="text-link" onClick={startFresh}>
            Start a new one about it
          </button>
        </div>
      )}

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
            <p>Ask about {scope?.contextLabel} or your deadlines.</p>
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
            {turn.role === "assistant" && turn.citations && turn.citations.length > 0 && (
              <div className="chat-citations">
                {turn.citations.map((citation, j) =>
                  citation.kind === "file" ? (
                    <span
                      key={j}
                      className={`chat-citation ${citation.verdict === "verified" ? "verified" : "unverified"}`}
                      title={citation.evidence}
                    >
                      {citation.verdict === "verified" ? `From ${citation.sourceFile}` : `Check ${citation.sourceFile}`}
                    </span>
                  ) : null,
                )}
              </div>
            )}
            {turn.role === "assistant" && turn.ungrounded && (
              <div className="chat-ungrounded">Not tied to a quote from your files: check before relying on it.</div>
            )}
          </div>
        ))}
        {sending && <div className="chat-msg assistant chat-thinking">Thinking…</div>}
      </div>

      {spent.messages > 0 && !subscription && (
        <div className="chat-estimate">
          {spent.tokens.toLocaleString()} tokens{spent.costUsd ? `, ${formatUsd(spent.costUsd)}` : ""} this conversation.
        </div>
      )}
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
            <div className="chat-input-row">
              <textarea
                ref={inputRef}
                rows={2}
                placeholder="Ask a question…"
                aria-label="Your question"
                value={input}
                disabled={!canSend}
                onChange={(event) => setInput(event.target.value)}
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
                <button className="btn btn-primary" onClick={() => void send()} disabled={!canSend || !input.trim()}>
                  Send
                </button>
              )}
            </div>
            {turns.length > 0 && (
              <div className="chat-meta-row">
                <span>
                  {turns.length}/{MAX_CHAT_TURNS} turns
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
