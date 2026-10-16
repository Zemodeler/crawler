"use client";

/**
 * "Ask about this" — a slide-over chat panel scoped to whatever the user had
 * open when they launched it (see chat-context.ts for how that scope is
 * built). A second, independent AI surface next to the batch generation
 * pipeline: free-form and multi-turn, grounded by default, internet access
 * only on explicit per-conversation opt-in.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { MAX_CHAT_TURNS, sendChatMessage, type ChatTurn } from "../../lib/ai/chat.ts";
import type { LocalFile, Manifest } from "../../lib/course-fs.ts";
import { approxTokens, estimateCost, formatUsd } from "../../lib/ai/models.ts";
import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import {
  effectiveModel,
  loadChatInternet,
  loadSettings,
  saveChatInternet,
} from "../../lib/ai/settings.ts";
import { PROVIDER_LABELS, type AiClient, type AiError } from "../../lib/ai/types.ts";
import { buildChatScope, type ChatScope } from "./chat-context.ts";

type Props = {
  onClose: () => void;
  files: LocalFile[];
  selected: string;
  manifest: Manifest | null;
  aiReady: boolean;
};

export default function ChatPanel({ onClose, files, selected, manifest, aiReady }: Props) {
  // Captured once at mount: switching what's scoped mid-conversation would be
  // confusing, so re-scoping means closing and reopening the panel.
  const [scope, setScope] = useState<ChatScope | null>(null);
  const [client, setClient] = useState<AiClient | null>(null);
  const [clientError, setClientError] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [internet, setInternet] = useState(false);
  const [spent, setSpent] = useState({ tokens: 0, costUsd: 0, messages: 0 });
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInternet(loadChatInternet());
    buildChatScope(selected, files, manifest)
      .then(setScope)
      .catch(() => setScope(null));
    if (!aiReady) return;
    createConfiguredAiClient()
      .then(setClient)
      .catch((err) => setClientError((err as Error).message || "Could not connect."));
    // Intentionally empty: this runs once, against the file that was open the
    // moment the panel was launched. See the comment on `scope` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [turns, sending]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const settings = useMemo(() => loadSettings(), []);
  const capable = client?.chatCapabilities().webSearch ?? false;
  const atCap = turns.length >= MAX_CHAT_TURNS;
  const providerLabel = PROVIDER_LABELS[settings.provider];

  const estimate = useMemo(() => {
    if (!scope) return null;
    const contextTokens = approxTokens(scope.contextBlock);
    const low = estimateCost(settings.provider, effectiveModel(settings), contextTokens, 500);
    return { contextTokens, low };
  }, [scope, settings]);

  const toggleInternet = (value: boolean) => {
    setInternet(value);
    saveChatInternet(value);
  };

  const startFresh = () => {
    setTurns([]);
    setError(null);
    setSpent({ tokens: 0, costUsd: 0, messages: 0 });
  };

  const send = async () => {
    const question = input.trim();
    if (!question || !client || !scope || sending || atCap) return;
    setInput("");
    setError(null);
    const userTurn: ChatTurn = { role: "user", content: question };
    const historySoFar = [...turns, userTurn];
    setTurns(historySoFar);
    setSending(true);
    try {
      const { turn, result } = await sendChatMessage({
        client,
        scopeLabel: scope.scopeLabel,
        contextLabel: scope.contextLabel,
        contextBlock: scope.contextBlock,
        history: historySoFar,
        question,
        webSearch: internet,
        extracts: scope.extracts,
        allText: scope.allText,
      });
      setTurns((prev) => [...prev, turn]);
      setSpent((prev) => ({
        tokens: prev.tokens + (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0),
        costUsd: prev.costUsd + (result.costUsd || 0),
        messages: prev.messages + 1,
      }));
    } catch (err) {
      const aiError = err as AiError;
      setError({ message: aiError.message || "Something went wrong.", hint: aiError.hint });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="chat-backdrop" />
      <aside className="chat-panel" role="dialog" aria-modal="true" aria-labelledby="chat-title">
        <div className="chat-head">
          <div>
            <h2 id="chat-title">Ask about this</h2>
            <small>{scope ? scope.contextLabel : "Loading…"}</small>
          </div>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="chat-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={internet}
              disabled={!capable}
              onChange={(event) => toggleInternet(event.target.checked)}
            />
            Also search the internet
          </label>
          {internet && capable && <span className="chat-pill">Internet: on for this chat</span>}
        </div>
        <div className="chat-toggle-note">
          {capable
            ? internet
              ? `${providerLabel} may search the web for this conversation. Anything found that way is` +
                ' labelled "From the web" below, never shown as if it came from your own files.'
              : "Off by default. Answers are grounded in your own course files only, unless you turn this on."
            : settings.transport === "subscription"
              ? "Not available yet for this connection — web access isn't confirmed safe for this command-line tool."
              : "Not available for this connection."}
        </div>

        <div className="chat-messages" ref={messagesRef}>
          {!aiReady && (
            <p className="chat-empty">
              No AI connection is set up. <a href="/connect">Set one up</a> to use this.
            </p>
          )}
          {aiReady && clientError && <p className="chat-empty">{clientError}</p>}
          {aiReady && !clientError && !client && <p className="chat-empty">Connecting…</p>}
          {aiReady && client && turns.length === 0 && (
            <p className="chat-empty">Ask a question about {scope?.contextLabel || "this"}.</p>
          )}
          {turns.map((turn, i) => (
            <div key={i} className={`chat-msg ${turn.role}`}>
              {turn.content}
              {turn.role === "assistant" && turn.usedWebSearch && <div className="chat-searched">Searched the web</div>}
              {turn.role === "assistant" && turn.citations && turn.citations.length > 0 && (
                <div className="chat-citations">
                  {turn.citations.map((citation, j) =>
                    citation.kind === "web" ? (
                      <a
                        key={j}
                        className="chat-citation web"
                        href={citation.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        From the web
                      </a>
                    ) : (
                      <span
                        key={j}
                        className={`chat-citation ${citation.verdict === "verified" ? "verified" : "unverified"}`}
                        title={citation.evidence}
                      >
                        {citation.verdict === "verified"
                          ? `Grounded in ${citation.sourceFile}`
                          : `Check ${citation.sourceFile}`}
                      </span>
                    ),
                  )}
                </div>
              )}
              {turn.role === "assistant" && turn.ungrounded && (
                <div className="chat-ungrounded">
                  This answer isn&rsquo;t tied to a quote from your files — verify before relying on it.
                </div>
              )}
            </div>
          ))}
          {sending && <div className="chat-msg assistant">…</div>}
        </div>

        {estimate && turns.length === 0 && (
          <div className="chat-estimate callout">
            <b>What this will cost</b>
            {scope?.linkedFiles.length || 0} file{scope?.linkedFiles.length === 1 ? "" : "s"} in scope, about{" "}
            {estimate.contextTokens.toLocaleString()} tokens.{" "}
            {settings.transport === "subscription"
              ? "Uses your subscription, not billed per message."
              : estimate.low !== null
                ? `About ${formatUsd(estimate.low)} for a typical message.`
                : "Cost per message is not published for this model."}
          </div>
        )}
        {spent.messages > 0 && (
          <div className="chat-estimate">
            {settings.transport === "subscription"
              ? `${spent.messages} message${spent.messages === 1 ? "" : "s"} this conversation.`
              : `${spent.tokens.toLocaleString()} tokens${spent.costUsd ? `, ${formatUsd(spent.costUsd)}` : ""} this conversation.`}
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
                  rows={2}
                  placeholder={scope ? `Ask about ${scope.contextLabel}…` : "Ask a question…"}
                  value={input}
                  disabled={!client || sending}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <button className="btn btn-primary" onClick={send} disabled={!client || !input.trim() || sending}>
                  Send
                </button>
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
    </>
  );
}
