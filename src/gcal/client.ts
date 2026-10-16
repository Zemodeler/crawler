/**
 * The CalendarClient over the Google Calendar v3 REST API. Design: docs/design/05.
 *
 * Every call takes an access token from the stored refresh token, retries
 * 429, 5xx, rate-limit 403s and network failures with backoff (honouring
 * Retry-After), and refreshes the access token once on a 401. Failures are
 * CalendarApiError with the HTTP status; tokens never appear in messages.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CalendarClient, CalendarEventInput, CalendarTokenStore, RemoteEvent } from "../calendar-types.ts";
import { GoogleAuthError, accessTokenFrom, forgetAccessToken } from "./oauth.ts";

export const API_BASE = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_TIME_ZONE = "Europe/London";

const RETRIES = 4;
const BACKOFF_MS = 500;
const MAX_WAIT_MS = 60_000;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export class CalendarApiError extends Error {
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** Google's error reason (e.g. "notFound"), when it gave one. */
  readonly reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
    this.reason = reason;
  }
}

export type CalendarClientDeps = {
  tokens: CalendarTokenStore;
  clientId: string;
  clientSecret?: string;
  fetch?: typeof fetch;
  /** Waits between retries; injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
};

type Json = Record<string, unknown>;
type Request = { method: string; path: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> };

export function createCalendarClient(deps: CalendarClientDeps): CalendarClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const oauth = { clientId: deps.clientId, clientSecret: deps.clientSecret, fetch: deps.fetch };

  async function refreshToken(): Promise<string> {
    const stored = await deps.tokens.load();
    if (stored === null) throw new GoogleAuthError("no-token", "Not signed in to Google Calendar");
    return stored.refreshToken;
  }

  /** One API call with retries; returns the response, ok or not, for the caller to judge. */
  async function send(req: Request): Promise<Response> {
    const rt = await refreshToken();
    const url = new URL(API_BASE + req.path);
    if (req.query !== undefined) url.search = new URLSearchParams(req.query).toString();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await accessTokenFrom(oauth, rt);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...req.headers };
      if (req.body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
      } catch (err) {
        if (attempt < RETRIES) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new CalendarApiError(0, `${req.method} ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        forgetAccessToken(deps.clientId, rt);
        await res.body?.cancel();
        attempt--;
        continue;
      }
      if (attempt < RETRIES && (await retryable(res))) {
        await res.body?.cancel();
        await sleep(retryAfter(res) ?? backoff(attempt));
        continue;
      }
      return res;
    }
  }

  async function call(req: Request, ok: (status: number) => boolean = (s) => s >= 200 && s < 300): Promise<Json | null> {
    const res = await send(req);
    if (!ok(res.status)) throw await apiError(req, res);
    if (res.status === 204 || res.status >= 300) {
      await res.body?.cancel();
      return null;
    }
    const text = await res.text();
    if (text === "") return null;
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new CalendarApiError(res.status, `${req.method} ${req.path}: response was not JSON`);
    }
  }

  async function* pages(path: string, query: Record<string, string>): AsyncGenerator<Json> {
    let pageToken: string | undefined;
    do {
      const q = pageToken === undefined ? query : { ...query, pageToken };
      const json = (await call({ method: "GET", path, query: q })) ?? {};
      for (const item of Array.isArray(json.items) ? json.items : []) yield item as Json;
      pageToken = typeof json.nextPageToken === "string" && json.nextPageToken !== "" ? json.nextPageToken : undefined;
    } while (pageToken !== undefined);
  }

  const eventsPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}/events`;

  return {
    async ensureCalendar(name) {
      // With the calendar.app.created scope the list holds only calendars this app made.
      for await (const cal of pages("/users/me/calendarList", { minAccessRole: "owner", maxResults: "250" })) {
        if (cal.summary === name && typeof cal.id === "string") return cal.id;
      }
      const created = await call({ method: "POST", path: "/calendars", body: { summary: name, timeZone: CALENDAR_TIME_ZONE } });
      if (created === null || typeof created.id !== "string") {
        throw new CalendarApiError(200, "POST /calendars: response had no calendar id");
      }
      return created.id;
    },

    async listEvents(calendarId) {
      const events: RemoteEvent[] = [];
      const query = { singleEvents: "false", showDeleted: "false", maxResults: "2500" };
      for await (const item of pages(eventsPath(calendarId), query)) events.push(toRemoteEvent(item));
      return events;
    },

    async insert(calendarId, event) {
      const json = await call({ method: "POST", path: eventsPath(calendarId), body: event });
      return toRemoteEvent(json ?? {});
    },

    async update(calendarId, eventId, event, etag) {
      const req: Request = {
        method: "PUT",
        path: `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`,
        body: event,
        headers: { "if-match": etag },
      };
      const res = await send(req);
      if (res.status === 412) {
        await res.body?.cancel();
        return "precondition-failed";
      }
      if (!res.ok) throw await apiError(req, res);
      return toRemoteEvent((await res.json()) as Json);
    },

    async delete(calendarId, eventId) {
      // 404/410: already gone, which is what was asked for.
      await call(
        { method: "DELETE", path: `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}` },
        (s) => (s >= 200 && s < 300) || s === 404 || s === 410,
      );
    },
  };
}

/* ----------------------------------------------------------- helpers */

function toRemoteEvent(item: Json): RemoteEvent {
  const ext = (item.extendedProperties ?? {}) as { private?: Record<string, unknown> };
  const priv = ext.private ?? {};
  const event: RemoteEvent = {
    id: String(item.id ?? ""),
    etag: String(item.etag ?? ""),
    summary: typeof item.summary === "string" ? item.summary : "",
    description: typeof item.description === "string" ? item.description : "",
    start: (item.start ?? {}) as RemoteEvent["start"],
    end: (item.end ?? {}) as RemoteEvent["end"],
    extendedProperties: {
      private: {
        crawlerId: typeof priv.crawlerId === "string" ? priv.crawlerId : "",
        crawlerHash: typeof priv.crawlerHash === "string" ? priv.crawlerHash : "",
      },
    },
  };
  if (item.status === "confirmed" || item.status === "tentative" || item.status === "cancelled") event.status = item.status;
  return event;
}

async function retryable(res: Response): Promise<boolean> {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status !== 403) return false;
  const reason = errorReason(await peekJson(res));
  return reason !== undefined && RATE_LIMIT_REASONS.has(reason);
}

/** Reads a JSON body without consuming the response the caller may still read. */
async function peekJson(res: Response): Promise<Json | null> {
  try {
    return (await res.clone().json()) as Json;
  } catch {
    return null;
  }
}

function errorReason(json: Json | null): string | undefined {
  const error = json?.error as { errors?: { reason?: unknown }[]; status?: unknown } | undefined;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === "string" ? reason : undefined;
}

async function apiError(req: Request, res: Response): Promise<CalendarApiError> {
  const json = await peekJson(res);
  await res.body?.cancel().catch(() => {});
  const error = json?.error as { message?: unknown } | undefined;
  const detail = typeof error?.message === "string" ? `: ${error.message}` : "";
  return new CalendarApiError(res.status, `${req.method} ${req.path} answered ${res.status}${detail}`, errorReason(json));
}

/** Retry-After as milliseconds (seconds or an HTTP date), capped; undefined when absent. */
function retryAfter(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

function backoff(attempt: number): number {
  return Math.min(BACKOFF_MS * 2 ** attempt * (1 + Math.random() * 0.25), MAX_WAIT_MS);
}

/* --------------------------------------------------------- token store */

/**
 * DEV/TEST ONLY: keeps the refresh token as plain JSON in `path`. The app
 * injects an encrypted store (OS credential store) instead.
 */
export function fileCalendarTokenStore(path: string): CalendarTokenStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      const json = JSON.parse(text) as { refreshToken?: unknown };
      return typeof json.refreshToken === "string" ? { refreshToken: json.refreshToken } : null;
    },
    async save(token) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ refreshToken: token.refreshToken }), { encoding: "utf8", mode: 0o600 });
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}
