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
import { mkdir, writeFile } from "node:fs/promises";

import { createMoodleAdapter } from "./adapters/moodle.ts";
import { UNIVERSITIES } from "./adapters/universities.ts";
import { doctor } from "./doctor.ts";
import { placeCourse } from "./naming.ts";
import { defaultSelection, readState, STATE_DIR, sync } from "./sync.ts";
import type { SyncEvent, SyncResult } from "./sync.ts";
import { VleError } from "./types.ts";
import type { LoginBrowser, TokenStore, UniversityAdapter } from "./types.ts";

export type CliEnv = {
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

const VALUE_FLAGS = new Set(["root", "university", "site"]);

const HELP = `Crawler — sync your university's course site into a folder of files and deadlines.

  crawler login    Sign in (opens the university's own sign-in page)
  crawler sync     Download new files and refresh deadlines
  crawler courses  List your courses; "enable"/"disable <name>" turns one on or off
  crawler doctor <url>   Check whether a Moodle site works with Crawler

Options:
  --university <id>   ${UNIVERSITIES.map((u) => u.id).join(", ")} (default ${UNIVERSITIES[0]?.id})
  --site <url>        Any Moodle site, instead of --university
  --root <folder>     Where files go (default: Documents/My Studies)
  --include-past      sync: also sync last year's modules
`;

function adapterFor(parsed: Parsed, env: CliEnv): UniversityAdapter | string {
  const site = parsed.flags.get("site");
  if (typeof site === "string") {
    const url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    return createMoodleAdapter({ id: url.hostname, displayName: url.hostname, site: url.origin }, env.fetch ? { fetch: env.fetch } : {});
  }
  const id = parsed.flags.get("university");
  const config = UNIVERSITIES.find((u) => u.id === (typeof id === "string" ? id : UNIVERSITIES[0]?.id));
  if (!config) return `Unknown university "${String(id)}". Known: ${UNIVERSITIES.map((u) => u.id).join(", ")}. For any other Moodle site use --site <url>.`;
  return createMoodleAdapter(config, env.fetch ? { fetch: env.fetch } : {});
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
          onProgress: (event) => progress(env, event),
        });
        summarize(env, result, root);
        const problems = result.courses.some((c) => c.status === "failed" || c.files.failed > 0);
        return problems ? 2 : 0;
      }

      default:
        env.err(`Unknown command "${parsed.command}".`);
        env.out(HELP);
        return 1;
    }
  } catch (error) {
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
