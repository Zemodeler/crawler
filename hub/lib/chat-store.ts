/**
 * Saved assistant conversations. Every page in the app is its own load, so a
 * conversation held only in memory was lost the moment the student opened
 * another page. Each module keeps its conversations (and the one currently
 * open) in `.study-hub/chats.json`, written after every turn and every
 * applied change, so moving around the app picks the conversation up again.
 *
 * The file is validated on read: a hand-edited or half-written file loses
 * only the entries that do not parse, never the page.
 */

import type { ChatCitation, ChatTurn } from "./ai/chat.ts";
import type { ActionState, ChatAction, ProposedAction } from "./ai/chat-actions.ts";

export const CHATS_PATH = ".study-hub/chats.json";
/** Older conversations past this are dropped when a new one is saved. */
export const MAX_SAVED_CHATS = 30;
const GUARD = { "x-study-hub-host": "1" };

export type SavedTurn = ChatTurn & { actions?: ProposedAction[] };

export type SavedChat = {
  id: string;
  /** The first question, shortened: what the history list shows. */
  title: string;
  created: string;
  updated: string;
  turns: SavedTurn[];
};

export type ChatFile = { version: 1; current: string | null; chats: SavedChat[] };

export const emptyChatFile = (): ChatFile => ({ version: 1, current: null, chats: [] });

const STATES: ActionState[] = ["proposed", "applied", "dismissed", "failed", "refused"];

function parseCitation(value: unknown): ChatCitation | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (c.kind === "web" && typeof c.url === "string") return { kind: "web", url: c.url, evidence: String(c.evidence ?? "") };
  if (c.kind === "file" && typeof c.sourceFile === "string" && typeof c.evidence === "string" && typeof c.verdict === "string")
    return { kind: "file", sourceFile: c.sourceFile, evidence: c.evidence, verdict: c.verdict as Extract<ChatCitation, { kind: "file" }>["verdict"] };
  return null;
}

function parseAction(value: unknown): ProposedAction | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (typeof a.label !== "string" || !STATES.includes(a.state as ActionState)) return null;
  const action = a.action && typeof a.action === "object" && typeof (a.action as { type?: unknown }).type === "string" ? (a.action as ChatAction) : undefined;
  return { label: a.label, state: a.state as ActionState, ...(action ? { action } : {}), ...(typeof a.error === "string" ? { error: a.error } : {}) };
}

export function parseTurn(value: unknown): SavedTurn | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if ((t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") return null;
  const turn: SavedTurn = { role: t.role, content: t.content };
  if (Array.isArray(t.citations)) turn.citations = t.citations.map(parseCitation).filter((c): c is ChatCitation => c !== null);
  if (t.ungrounded === true) turn.ungrounded = true;
  if (t.usedWebSearch === true) turn.usedWebSearch = true;
  if (Array.isArray(t.actions)) turn.actions = t.actions.map(parseAction).filter((a): a is ProposedAction => a !== null);
  return turn;
}

export function parseChatFile(value: unknown): ChatFile {
  if (!value || typeof value !== "object") return emptyChatFile();
  const raw = value as Record<string, unknown>;
  const chats: SavedChat[] = [];
  for (const entry of Array.isArray(raw.chats) ? raw.chats : []) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id || !Array.isArray(c.turns)) continue;
    const turns = c.turns.map(parseTurn).filter((t): t is SavedTurn => t !== null);
    if (!turns.length) continue;
    chats.push({
      id: c.id,
      title: typeof c.title === "string" && c.title ? c.title : chatTitle(turns),
      created: typeof c.created === "string" ? c.created : new Date(0).toISOString(),
      updated: typeof c.updated === "string" ? c.updated : new Date(0).toISOString(),
      turns,
    });
  }
  const current = typeof raw.current === "string" && chats.some((c) => c.id === raw.current) ? raw.current : null;
  return { version: 1, current, chats };
}

/** The first question, cut at a word boundary near 60 characters. */
export function chatTitle(turns: ChatTurn[]): string {
  const first = turns.find((t) => t.role === "user")?.content.replace(/\s+/g, " ").trim() || "Conversation";
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}

/**
 * Puts one conversation into the file as the open one, newest first, and
 * keeps at most MAX_SAVED_CHATS. An empty conversation is not saved; it only
 * clears which one is open.
 */
export function upsertChat(file: ChatFile, id: string, turns: SavedTurn[], now = new Date()): ChatFile {
  if (!turns.length) return { ...file, current: null };
  const at = now.toISOString();
  const previous = file.chats.find((c) => c.id === id);
  const chat: SavedChat = { id, title: previous?.title || chatTitle(turns), created: previous?.created || at, updated: at, turns };
  const chats = [chat, ...file.chats.filter((c) => c.id !== id)].slice(0, MAX_SAVED_CHATS);
  return { version: 1, current: id, chats };
}

export const newChatId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A module's saved conversations (`<year>/<folder>`), or an empty file when there are none yet. */
export async function loadChats(moduleKey: string): Promise<ChatFile> {
  const response = await fetch(`/api/library/module-file?${new URLSearchParams({ module: moduleKey, path: CHATS_PATH })}`, { headers: GUARD });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Could not read saved conversations (${response.status}).`);
  if (typeof body.text !== "string") return emptyChatFile();
  try {
    return parseChatFile(JSON.parse(body.text));
  } catch {
    return emptyChatFile();
  }
}

export async function saveChats(moduleKey: string, file: ChatFile): Promise<void> {
  const response = await fetch("/api/library/module-file", {
    method: "PUT",
    headers: { ...GUARD, "content-type": "application/json" },
    body: JSON.stringify({ module: moduleKey, path: CHATS_PATH, content: JSON.stringify(file) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Could not save the conversation (${response.status}).`);
  }
}
