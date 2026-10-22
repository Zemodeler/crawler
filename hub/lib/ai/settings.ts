/**
 * Connection settings and API-key storage.
 *
 * Where the key lives, and what we can honestly claim about it:
 *
 *  - Default is `sessionStorage`: the key is gone when the tab closes.
 *  - "Remember on this device" moves it to IndexedDB, which is NOT more secure
 *    against same-origin script — it is the same trust boundary. What it buys is
 *    a timestamp, so an unused key self-deletes after 30 days, and it isn't
 *    swept up by the many one-liners that dump localStorage.
 *  - It is never written to localStorage, never put in a URL, and never sent to
 *    this app's own origin. The only hosts it reaches are the provider APIs.
 *
 * The UI copy must not claim encryption. It isn't encrypted.
 */

import { idbDelete, idbGet, idbPut, idbKeys } from "../course-fs.ts";
import { defaultModel } from "./models.ts";
import type { ProviderId, TransportId } from "./types.ts";

const SETTINGS_KEY = "studyhub:ai:settings";
const SESSION_KEY_PREFIX = "studyhub:ai:key:";
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type AiSettings = {
  provider: ProviderId;
  transport: TransportId;
  /** Empty string means "use the provider default". */
  model: string;
  /** Whether the key is kept in IndexedDB rather than just this tab. */
  remember: boolean;
};

export const DEFAULT_SETTINGS: AiSettings = {
  provider: "anthropic",
  transport: "apikey",
  model: "",
  remember: false,
};

type StoredKey = { provider: ProviderId; key: string; createdAt: number; lastUsedAt: number };

const browser = () => typeof window !== "undefined";

export function loadSettings(): AiSettings {
  if (!browser()) return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      provider: parsed.provider === "openai" ? "openai" : "anthropic",
      // "bridge" is what subscription mode was called before the desktop app.
      transport: (parsed.transport as string) === "bridge" || parsed.transport === "subscription" ? "subscription" : "apikey",
      model: typeof parsed.model === "string" ? parsed.model : "",
      remember: parsed.remember === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Settings carry no secret, so they are ordinary localStorage. */
export function saveSettings(settings: AiSettings): void {
  if (!browser()) return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function effectiveModel(settings: AiSettings): string {
  return settings.model || defaultModel(settings.provider);
}

/* ------------------------------------------------------------------- keys */

export async function saveKey(provider: ProviderId, key: string, remember: boolean): Promise<void> {
  if (!browser()) return;
  const trimmed = key.trim();
  sessionStorage.setItem(`${SESSION_KEY_PREFIX}${provider}`, trimmed);
  if (remember) {
    const now = Date.now();
    const existing = await idbGet<StoredKey>("secrets", provider).catch(() => undefined);
    await idbPut("secrets", provider, {
      provider,
      key: trimmed,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    } satisfies StoredKey);
  } else {
    await idbDelete("secrets", provider).catch(() => {});
  }
}

export async function loadKey(provider: ProviderId): Promise<string> {
  if (!browser()) return "";
  const fromSession = sessionStorage.getItem(`${SESSION_KEY_PREFIX}${provider}`);
  if (fromSession) return fromSession;
  const stored = await idbGet<StoredKey>("secrets", provider).catch(() => undefined);
  if (!stored?.key) return "";
  // A key nobody has used for a month is more liability than convenience.
  if (Date.now() - stored.lastUsedAt > PURGE_AFTER_MS) {
    await idbDelete("secrets", provider).catch(() => {});
    return "";
  }
  sessionStorage.setItem(`${SESSION_KEY_PREFIX}${provider}`, stored.key);
  await idbPut("secrets", provider, { ...stored, lastUsedAt: Date.now() }).catch(() => {});
  return stored.key;
}

export async function forgetKey(provider: ProviderId): Promise<void> {
  if (!browser()) return;
  sessionStorage.removeItem(`${SESSION_KEY_PREFIX}${provider}`);
  await idbDelete("secrets", provider).catch(() => {});
}

export async function forgetAllKeys(): Promise<void> {
  if (!browser()) return;
  for (const provider of ["anthropic", "openai"] as ProviderId[]) await forgetKey(provider);
}

/** Never render a raw key. */
export function redactKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}

/** True when at least one usable connection is configured. */
export async function hasAnyConnection(): Promise<boolean> {
  if (!browser()) return false;
  const settings = loadSettings();
  if (settings.transport === "subscription") return isHosted();
  if (await loadKey(settings.provider)) return true;
  // A remembered key for the other provider still counts as "set up".
  const keys = (await idbKeys("secrets").catch(() => [])) || [];
  return keys.length > 0;
}

/* ----------------------------------------------------------- desktop app */

/**
 * True when this page was served by the Study Hub host (host/index.mjs), which
 * runs the CLI on the same origin. The host sets this non-secret marker cookie beside its HttpOnly
 * session cookie; the session cookie itself is never readable from script.
 */
export function isHosted(): boolean {
  return browser() && /(?:^|;\s*)studyhub_host=1(?:;|$)/.test(document.cookie);
}
