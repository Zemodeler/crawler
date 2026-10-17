/**
 * The Crawler command line. Pure Node: everything that needs a desktop (the
 * sign-in window, encrypted token storage) is handed in through CliEnv, so this
 * file is tested without Electron. bin/crawler.mjs supplies the real ones.
 *
 *   crawler login   [--university qmul | --site https://…]
 *   crawler sync    [--root <folder>] [--university …] [--include-past]
 *   crawler courses [enable|disable <shortname>…]
 *   crawler doctor  <url>
 *
 * Exit codes: 0 ok, 1 a problem the student can fix (sign in again, bad
 * argument), 2 some courses or files failed.
 */

import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createMoodleAdapter } from "./adapters/moodle.ts";
import { ALL_UNIVERSITIES, getUniversity } from "./adapters/universities.ts";
import { doctor } from "./doctor.ts";
import { placeCourse } from "./naming.ts";
import { defaultSelection, readState, STATE_DIR, sync } from "./sync.ts";
import type { SyncEvent, SyncResult } from "./sync.ts";
import { VleError } from "./types.ts";
import type { AiRunner, LoginBrowser, TokenStore, UniversityAdapter } from "./types.ts";

import { connectCalendar, disconnectCalendar, syncCalendarFromRoot } from "./calendar-run.ts";
import type { CalendarEnv } from "./calendar-run.ts";
import type { CalendarSyncReport } from "./calendar-types.ts";
import { GoogleAuthError } from "./gcal/oauth.ts";
import { describeFreshness, syncDue } from "./schedule.ts";

export type CliEnv = {
  calendar?: CalendarEnv;
  /** Used by `sync --ai`: the local claude/codex CLI. */
  ai?: AiRunner;
  tokenStore: TokenStore;
  loginBrowser: LoginBrowser;
  /** "Documents/My Studies" unless overridden by --root. */
  defaultRoot: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
};

type Parsed = { command: string; positionals: string[]; flags: Map<string, string | true> };

export function parseArgs(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--") && VALUE_FLAGS.has(arg.slice(2))) flags.set(arg.slice(2), rest[++i] as string);
      else flags.set(arg.slice(2), true);
    } else positionals.push(arg);
  }
  return { command, positionals, flags };
}

const VALUE_FLAGS = new Set(["root", "university", "site", "every"]);

const HELP = `Crawler — sync your university's course site into a folder of files and deadlines.

  crawler login    Sign in (opens the university's own sign-in page)
  crawler sync     Download new files and refresh deadlines
  crawler courses  List your courses; "enable"/"disable <name>" turns one on or off
  crawler calendar connect|sync|disconnect|status [--root <folder>]
  crawler schedule [--root <folder>] [--every 1|3|7]
  crawler doctor <url>   Check whether a Moodle site works with Crawler

Options:
  --university <id>   ${ALL_UNIVERSITIES.map((u) => u.id).join(", ")} (default ${ALL_UNIVERSITIES[0]?.id})
  --site <url>        Any Moodle site, instead of --university
  --root <folder>     Where files go (default: Documents/My Studies)
  --include-past      sync: also sync last year's modules
  --ai                sync: also let your claude or codex CLI read changed documents for deadlines
  --no-transcripts    sync: skip lecture-recording captions
`;

function adapterFor(parsed: Parsed, env: CliEnv): UniversityAdapter | string {
  const site = parsed.flags.get("site");
  if (typeof site === "string") {
    const url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    return createMoodleAdapter({ id: url.hostname, displayName: url.hostname, site: url.origin }, env.fetch ? { fetch: env.fetch } : {});
  }
  const id = parsed.flags.get("university");
  const adapter = getUniversity(typeof id === "string" ? id : (ALL_UNIVERSITIES[0]?.id ?? ""), env.fetch ? { fetch: env.fetch } : {});
  if (!adapter) return `Unknown university "${String(id)}". Known: ${ALL_UNIVERSITIES.map((u) => u.id).join(", ")}. For any other Moodle site use --site <url>.`;
  return adapter;
}

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const parsed = parseArgs(argv);
  const now = env.now ?? (() => new Date());

  try {
    switch (parsed.command) {
      case "help":
      case "--help":
      case "-h":
        env.out(HELP);
        return 0;

      case "doctor": {
        const url = parsed.positionals[0];
        if (!url) {
          env.err("Usage: crawler doctor <url>");
          return 1;
        }
        const result = await doctor(url, env.fetch);
        for (const line of result.lines) env.out(line);
        return result.verdict === "works" ? 0 : 1;
      }

      case "calendar": {
        const calendar = env.calendar;
        if (!calendar) return fail(env, "Google Calendar is unavailable in this environment.");
        const action = parsed.positionals[0];
        const root = resolve(typeof parsed.flags.get("root") === "string" ? parsed.flags.get("root") as string : env.defaultRoot);
        if (action === "connect") env.out(await connectCalendar(calendar));
        else if (action === "disconnect") env.out(await disconnectCalendar(calendar));
        else if (action === "status") env.out(await calendar.tokens.load() ? "Google Calendar connected." : "Google Calendar not connected; run crawler calendar connect.");
        else if (action === "sync") {
          const report = await syncCalendarFromRoot(root, calendar);
          if (!report) return fail(env, "Google Calendar not connected; run crawler calendar connect.");
          env.out(calendarSummary(report));
        } else return fail(env, "Usage: crawler calendar connect|sync|disconnect|status [--root <folder>]");
        return 0;
      }

      case "schedule": {
        const root = resolve(typeof parsed.flags.get("root") === "string" ? parsed.flags.get("root") as string : env.defaultRoot);
        const file = join(root, STATE_DIR, "schedule.json");
        let everyDays: 1 | 3 | 7 = 3;
        const repairing = parsed.flags.has("every");
        try {
          const saved = JSON.parse(await readFile(file, "utf8")) as { everyDays?: unknown } | null;
          if (saved && (saved.everyDays === 1 || saved.everyDays === 3 || saved.everyDays === 7)) everyDays = saved.everyDays;
          else if (!repairing) return fail(env, "Invalid schedule.json: everyDays must be 1, 3 or 7. Fix it with: crawler schedule --every 3");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !repairing) return fail(env, "Could not read schedule.json. Fix it with: crawler schedule --every 3");
        }
        if (repairing) {
          const value = parsed.flags.get("every");
          if (value !== "1" && value !== "3" && value !== "7") return fail(env, "--every must be 1, 3 or 7.");
          everyDays = Number(value) as 1 | 3 | 7;
          await mkdir(join(root, STATE_DIR), { recursive: true });
          await writeFile(file, `${JSON.stringify({ everyDays }, null, 2)}\n`);
        }
        const state = await readState(root);
        const at = now();
        const due = syncDue(state.lastSync, at, { everyDays });
        env.out(`${describeFreshness(state.lastSync, at)}; sync ${due.due ? "due" : "not due"}; every ${everyDays} day(s).`);
        return 0;
      }

      case "login": {
        const adapter = adapterFor(parsed, env);
        if (typeof adapter === "string") return fail(env, adapter);
        env.out(`Opening ${adapter.displayName}'s sign-in page. Sign in there as you normally do; Crawler never sees your password.`);
        const credentials = await adapter.login(env.loginBrowser);
        const who = await adapter.whoAmI(credentials);
        await env.tokenStore.save(credentials);
        env.out(`Signed in. (${who.permittedFunctions.length} web-service functions allowed.)`);
        return 0;
      }

      case "courses":
      case "sync": {
        const adapter = adapterFor(parsed, env);
        if (typeof adapter === "string") return fail(env, adapter);
        const credentials = await env.tokenStore.load(adapter.site);
        if (!credentials) return fail(env, `Not signed in to ${adapter.displayName}. Run: crawler login`);
        const root = resolve(typeof parsed.flags.get("root") === "string" ? (parsed.flags.get("root") as string) : env.defaultRoot);

        if (parsed.command === "courses") return await coursesCommand(parsed, env, adapter, credentials, root, now());

        const result = await sync({
          adapter,
          credentials,
          root,
          now: now(),
          ...(parsed.flags.has("include-past") ? { select: (_c: unknown, p: { isModule: boolean }) => p.isModule } : {}),
          // --ai: the student asked for it on the command line, so no further confirmation.
          ...(parsed.flags.has("ai") && env.ai ? { ai: env.ai, confirmAi: async () => true } : {}),
          ...(parsed.flags.has("no-transcripts") ? { transcripts: false } : {}),
          onProgress: (event) => progress(env, event),
        });
        summarize(env, result, root);
        const problems = result.courses.some((c) => c.status === "failed" || c.files.failed > 0);
        if (!problems && env.calendar) {
          try {
            const report = await syncCalendarFromRoot(root, env.calendar);
            if (report) env.out(calendarSummary(report));
          } catch (error) {
            env.err(`Warning: ${calendarError(error)}`);
          }
        }
        return problems ? 2 : 0;
      }

      default:
        env.err(`Unknown command "${parsed.command}".`);
        env.out(HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof GoogleAuthError) return fail(env, calendarError(error));
    if (error instanceof VleError && error.code === "invalid_token") {
      return fail(env, "Your sign-in has expired. Run: crawler login");
    }
    return fail(env, error instanceof Error ? error.message : String(error));
  }
}

function fail(env: CliEnv, message: string): number {
  env.err(message);
  return 1;
}

function progress(env: CliEnv, event: SyncEvent): void {
  if (event.type === "course-start") env.out(`${event.course}  →  ${event.folder}`);
  else if (event.type === "course-failed") env.err(`  ${event.course} failed: ${event.message}`);
  else if (event.type === "file" && event.result !== "unchanged") env.out(`  ${event.result.padEnd(14)} ${event.path.split("/").slice(2).join("/")}`);
}

function summarize(env: CliEnv, result: SyncResult, root: string): void {
  env.out("");
  for (const c of result.courses) {
    if (c.status === "skipped") continue;
    const f = c.files;
    const parts = [
      f.new && `${f.new} new`,
      f.updated && `${f.updated} updated`,
      f["kept-your-edit"] && `${f["kept-your-edit"]} changed (your edit kept)`,
      f.unchanged && `${f.unchanged} unchanged`,
      f.failed && `${f.failed} FAILED`,
      f.videosSkipped && `${f.videosSkipped} videos skipped`,
    ].filter(Boolean);
    env.out(`${c.status === "failed" ? "✗" : "✓"} ${c.shortname}: ${c.status === "failed" ? c.error : parts.join(", ") || "nothing to do"}; ${c.deadlines} deadlines`);
  }
  const skipped = result.courses.filter((c) => c.status === "skipped").length;
  if (skipped) env.out(`${skipped} other course(s) not synced — see: crawler courses`);
  const transcripts = result.courses.reduce((n, c) => n + (c.transcripts?.added ?? 0), 0);
  if (transcripts) env.out(`${transcripts} lecture transcript(s) saved in Transcripts/`);
  const aiRuns = result.courses.reduce((n, c) => n + (c.text?.aiRuns ?? 0), 0);
  if (aiRuns) {
    const seconds = Math.round(result.courses.reduce((n, c) => n + (c.text?.aiMs ?? 0), 0) / 1000);
    env.out(`AI read ${aiRuns} document(s) in ${seconds}s; every date it found was checked against the document`);
  }
  const needCheck = result.deadlines.filter((d) => d.status === "needs-check").length;
  const conflicts = result.deadlines.filter((d) => d.status === "conflict").length;
  if (needCheck) env.out(`${needCheck} deadline(s) need checking (the date looks wrong); see Deadlines.json`);
  if (conflicts) env.out(`${conflicts} deadline(s) have sources that disagree; see Deadlines.json`);
  if (result.changes.length) env.out(`${result.changes.length} change(s) written to Changes.md`);
  env.out(`Folder: ${root}`);
}

async function coursesCommand(parsed: Parsed, env: CliEnv, adapter: UniversityAdapter, credentials: Parameters<UniversityAdapter["listCourses"]>[0], root: string, now: Date): Promise<number> {
  const [action, ...names] = parsed.positionals;
  const courses = await adapter.listCourses(credentials);
  const state = await readState(root);
  const byDefault = defaultSelection(now);

  if (action === "enable" || action === "disable") {
    if (!names.length) return fail(env, `Usage: crawler courses ${action} <course name or code>…`);
    for (const name of names) {
      const matches = courses.filter((c) => `${c.shortname} ${c.fullname}`.toLowerCase().includes(name.toLowerCase()));
      if (matches.length !== 1) return fail(env, matches.length ? `"${name}" matches ${matches.length} courses; be more specific.` : `No course matches "${name}".`);
      state.courses[matches[0]!.shortname] = { ...state.courses[matches[0]!.shortname], enabled: action === "enable" };
      env.out(`${action === "enable" ? "Enabled" : "Disabled"}: ${matches[0]!.fullname}`);
    }
    await mkdir(join(root, STATE_DIR), { recursive: true });
    await writeFile(join(root, STATE_DIR, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  if (action !== undefined) return fail(env, `Unknown action "${action}". Use: crawler courses [enable|disable <name>]`);

  for (const course of courses) {
    const placement = placeCourse(course);
    const chosen = state.courses[course.shortname]?.enabled;
    const on = chosen ?? byDefault(course, placement);
    env.out(`${on ? "[x]" : "[ ]"} ${placement.year.padEnd(8)} ${course.fullname}${chosen === undefined ? "" : "  (set by you)"}`);
  }
  return 0;
}

function calendarError(error: unknown): string {
  if (error instanceof GoogleAuthError && error.code === "revoked") return "Google Calendar access was revoked; run crawler calendar connect";
  return error instanceof Error ? error.message : String(error);
}

function calendarSummary(report: CalendarSyncReport): string {
  const reasons = new Map<string, number>();
  for (const skipped of report.skipped) reasons.set(skipped.reason, (reasons.get(skipped.reason) ?? 0) + 1);
  const edited = report.editedByUser.map((event) => JSON.stringify(event.summary)).join(", ");
  return `Google Calendar: ${report.created.length} created, ${report.updated.length} updated, ${report.deleted.length} deleted, ${report.unchanged} unchanged; student edits kept: ${edited || "none"}; skipped: ${[...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ") || "0"}.`;
}
