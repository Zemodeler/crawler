/**
 * What the AI settings panel says about each CLI: a verdict, the real reason,
 * and the one command that is most likely to fix it. Pure, so it is tested
 * without a browser.
 */

import type { CliStatus } from "./host.ts";

export type CliKind = "claude" | "codex" | "gemini";

export type CliVerdict = "ready" | "signed-out" | "unchecked-auth" | "broken" | "missing";

export type CliRow = {
  kind: CliKind;
  label: string;
  verdict: CliVerdict;
  /** One short phrase for the badge. */
  summary: string;
  path: string | null;
  version: string | null;
  signIn: string;
  /** The reason it is not usable, in the host's own words. */
  error: string | null;
  /** `command` is null when there is nothing worth copying into a terminal. */
  fix: { text: string; command: string | null } | null;
};

const LABELS: Record<CliKind, string> = { claude: "Claude CLI", codex: "Codex CLI", gemini: "Gemini CLI" };

const INSTALL: Record<CliKind, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @google/gemini-cli",
};

const APPS: Record<CliKind, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

// Copies the desktop apps bundle (Windows folders, or inside a macOS .app) and
// WinGet packages are updated by their own installer; npm cannot repair them.
const DESKTOP_APP = /[\\/]Claude[\\/]claude-code[\\/]|[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]|\.app[\\/]/i;
const WINGET = /[\\/]WinGet[\\/]/i;

/** How to repair the copy at `path` that was found but would not run. */
function repair(kind: CliKind, path: string): { text: string; command: string | null } {
  if (DESKTOP_APP.test(path))
    return {
      text: `This copy came with the ${APPS[kind]} desktop app. Update or reinstall the app, then press Check again.`,
      command: null,
    };
  if (WINGET.test(path))
    return { text: "This copy was installed with WinGet. Update or reinstall it with WinGet, then press Check again.", command: "winget upgrade" };
  return { text: "Reinstall it, then press Check again.", command: INSTALL[kind] };
}

const SIGN_IN: Record<CliKind, { text: string; command: string }> = {
  claude: { text: "Open a terminal, run `claude`, and sign in (type /login if it asks). Then press Check again.", command: "claude" },
  codex: { text: "Run this in a terminal and finish signing in, then press Check again.", command: "codex login" },
  gemini: { text: "Run `gemini` in a terminal and choose Sign in with Google, then press Check again.", command: "gemini" },
};

export function describeCli(kind: CliKind, status: CliStatus | undefined): CliRow {
  const label = LABELS[kind];
  const base = {
    kind,
    label,
    path: status?.path ?? null,
    version: status?.version ?? null,
    error: status?.error ?? null,
  };
  if (!status)
    return { ...base, verdict: "missing", summary: "Not checked yet", signIn: "Unknown", fix: null };

  if (!status.present) {
    // A path with no `present` means it was found but would not run.
    const found = status.path ?? null;
    return {
      ...base,
      verdict: found ? "broken" : "missing",
      summary: found ? "Found, but will not run" : "Not installed",
      signIn: "Unknown",
      error: status.error || `${label} was not found on this computer.`,
      fix: found ? repair(kind, found) : { text: "Install it, sign in once, then press Check again.", command: INSTALL[kind] },
    };
  }

  const auth = status.authenticated ?? "unknown";
  if (auth === false)
    return {
      ...base,
      verdict: "signed-out",
      summary: "Installed, not signed in",
      signIn: status.authDetail || "Not signed in",
      fix: SIGN_IN[kind],
    };
  return {
    ...base,
    verdict: auth === true ? "ready" : "unchecked-auth",
    summary: auth === true ? "Ready" : "Installed",
    signIn: auth === true ? "Signed in" : status.authDetail || "Could not be checked — the first request will tell",
    fix: null,
  };
}

export const CLI_KINDS: CliKind[] = ["claude", "codex", "gemini"];
