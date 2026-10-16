/** Calendar command orchestration; desktop dependencies are supplied by the CLI. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CalendarClient, CalendarSyncReport, CalendarTokenStore } from "./calendar-types.ts";
import type { Deadline } from "./types.ts";
import { authorize } from "./gcal/oauth.ts";
import { createCalendarClient } from "./gcal/client.ts";
import { syncCalendar } from "./gcal/sync.ts";

export type CalendarEnv = {
  tokens: CalendarTokenStore;
  openBrowser(url: string): Promise<void>;
  clientId: string | null;
  clientSecret?: string;
  client?: CalendarClient;
  fetch?: typeof fetch;
};

const SETUP = 'Set CRAWLER_GOOGLE_CLIENT_ID or put {clientId, clientSecret} in <userData>/google-oauth.json.';

function clientFor(env: CalendarEnv): CalendarClient {
  if (env.client) return env.client;
  if (!env.clientId) throw new Error(SETUP);
  return createCalendarClient({ ...env, clientId: env.clientId });
}

export async function connectCalendar(env: CalendarEnv): Promise<string> {
  if (!env.clientId) throw new Error(SETUP);
  const token = await authorize({ ...env, clientId: env.clientId });
  await env.tokens.save(token);
  await clientFor(env).ensureCalendar("University deadlines");
  return 'Google Calendar connected: University deadlines.';
}

export async function syncCalendarFromRoot(root: string, env: CalendarEnv): Promise<CalendarSyncReport | null> {
  if (!await env.tokens.load()) return null;
  const deadlines = JSON.parse(await readFile(join(root, "Deadlines.json"), "utf8")) as Deadline[];
  return syncCalendar(clientFor(env), deadlines);
}

export async function disconnectCalendar(env: CalendarEnv): Promise<string> {
  await env.tokens.clear();
  return 'Google Calendar disconnected; the Google calendar and its events have not been deleted.';
}
