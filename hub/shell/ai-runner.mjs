/**
 * Crawler's AiRunner, backed by the host's guarded CLI runner (host/cli.mjs),
 * so deadline extraction during a sync uses the same `claude` / `codex` the
 * student chose for Study Hub, with the same spawn guards and no API keys.
 */

import { findCli, runCli } from "../host/cli.mjs";

/** `kind` is "claude" or "codex"; anything else gives a runner with no CLI. */
export function createHostAiRunner(kind) {
  let cli = null;
  const current = () => {
    if (!cli?.path) cli = findCli(kind);
    return cli;
  };
  return {
    async available() {
      if (kind !== "claude" && kind !== "codex") return { cli: null };
      return { cli: current().path ? kind : null };
    },
    async structured({ system, prompt, schema }) {
      const full = `${system}\n\n${prompt}\n\nAnswer with JSON only, matching this JSON schema:\n${JSON.stringify(schema)}`;
      let text;
      try {
        text = await runCli(current(), kind, full, undefined, false);
      } catch (error) {
        // runCli rejects with { code, message }; never pass the prompt along.
        throw new Error(error?.message || `${kind} did not answer.`);
      }
      return parseJsonAnswer(text);
    },
  };
}

/** The whole answer, a fenced ```json block, or the outermost {…} / […]. */
export function parseJsonAnswer(text) {
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) attempts.push(fenced[1].trim());
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* try the next shape */
    }
  }
  throw new Error("The assistant's answer was not JSON.");
}
