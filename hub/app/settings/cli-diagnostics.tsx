"use client";

/**
 * One row per AI command-line tool: is it installed, where, which version,
 * signed in, and — when something is wrong — the host's real error and the
 * command that fixes it. Replaces the single "found / not found" badge.
 */

import { useState } from "react";

import { CLI_KINDS, describeCli, type CliVerdict } from "../../lib/ai/cli-diagnostics.ts";
import type { HostHealth } from "../../lib/ai/host.ts";

const BADGE: Record<CliVerdict, string> = {
  ready: "badge-ok",
  "unchecked-auth": "badge-ok",
  "signed-out": "badge-err",
  broken: "badge-err",
  missing: "badge-err",
};

function CopyHint({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the command is still on screen to select */
    }
  };
  return (
    <span className="inline-row" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <code className="mono">{command}</code>
      <button type="button" className="btn btn-ghost" onClick={copy} aria-label={`Copy ${command}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function CliDiagnostics({
  host,
  checking,
  error,
  onRecheck,
}: {
  host: HostHealth | null;
  checking: boolean;
  error: { message: string; hint?: string } | null;
  onRecheck: () => void;
}) {
  const checkedAt = CLI_KINDS.map((kind) => host?.clis?.[kind]?.checkedAt)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <section aria-label="AI command-line tools" aria-busy={checking}>
      <div className="btn-row" style={{ marginTop: 0 }}>
        {checking && <span className="badge badge-idle">Looking for your AI tools…</span>}
        {/* The desktop smoke check finds this button by its exact text. */}
        <button className="btn btn-ghost" onClick={onRecheck} disabled={checking}>
          Check again
        </button>
        {checkedAt && !checking && <small>Last checked {new Date(checkedAt).toLocaleTimeString()}</small>}
      </div>

      {error && (
        <div className="callout callout-warn">
          <b>Study Hub could not check your tools</b>
          {error.message}
          {error.hint ? ` ${error.hint}` : ""}
        </div>
      )}

      {host &&
        CLI_KINDS.map((kind) => {
          const row = describeCli(kind, host.clis?.[kind]);
          return (
            <div key={kind} className={`callout${row.verdict === "ready" ? "" : " callout-warn"}`} data-cli={kind}>
              <b>
                {row.label} <span className={`badge ${BADGE[row.verdict]}`}>{row.summary}</span>
              </b>
              <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px" }}>
                <dt>Path</dt>
                <dd style={{ margin: 0, wordBreak: "break-all" }}>
                  {row.path ? <span className="mono">{row.path}</span> : "Not found"}
                </dd>
                <dt>Version</dt>
                <dd style={{ margin: 0 }}>{row.version || "Unknown"}</dd>
                <dt>Sign-in</dt>
                <dd style={{ margin: 0 }}>{row.signIn}</dd>
              </dl>
              {row.error && (
                <p role="status" style={{ margin: "8px 0 0", wordBreak: "break-word" }}>
                  {row.error}
                </p>
              )}
              {row.fix && (
                <p style={{ margin: "8px 0 0" }}>
                  {row.fix.text} <CopyHint command={row.fix.command} />
                </p>
              )}
            </div>
          );
        })}
    </section>
  );
}
