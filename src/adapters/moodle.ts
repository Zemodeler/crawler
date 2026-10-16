/**
 * Moodle adapter: the mobile-app web service (REST, JSON) behind one
 * UniversityAdapter. One module serves every Moodle university; the site is
 * config (see universities.ts). Design: docs/design/02-university-adapters.md.
 *
 * All HTTP goes through one client that limits requests in flight (a request
 * holds its slot until its body is read), retries 429/5xx/network failures,
 * and keeps the token out of every error message and every URL it returns.
 */

import { createHash, randomBytes } from "node:crypto";

import { VleError } from "../types.ts";
import type { Course, Credentials, LoginBrowser, Placement, UniversityAdapter, VleFile, VleItem } from "../types.ts";

export type MoodleSiteConfig = { id: string; displayName: string; site: string };
export type MoodleDeps = { fetch?: typeof fetch };

const MAX_IN_FLIGHT = 4;
const RETRIES = 2;
const BACKOFF_MS = 300;
const DAY = 24 * 60 * 60;
const CAPTURE_SCHEME = "moodlemobile://";

/* ------------------------------------------------------------- params */

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Moodle's form encoding: `{ events: { courseids: [5] } }` → `events[courseids][0]=5`. */
export function flattenParams(params: Record<string, Param>): [string, string][] {
  const out: [string, string][] = [];
  const walk = (key: string, value: Param): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((item, index) => walk(`${key}[${index}]`, item));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    else out.push([key, typeof value === "boolean" ? (value ? "1" : "0") : String(value)]);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return out;
}

/* ------------------------------------------------------------- redaction */

/** Removes `token`/`wstoken` query parameters, so a URL is safe to keep or show. */
export function stripToken(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("token") && !parsed.searchParams.has("wstoken")) return url;
    parsed.searchParams.delete("token");
    parsed.searchParams.delete("wstoken");
    return parsed.toString();
  } catch {
    return url.replace(/([?&])(ws)?token=[^&#]*&?/g, "$1").replace(/[?&](#|$)/, "$1");
  }
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/* ------------------------------------------------------------- limiter */

/** Slots for requests in flight. `acquire` waits for one and returns its (idempotent) release. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function acquire(): Promise<() => void> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else active--;
    };
  };
}

/** Passes `body` through, calling `release` once it ends, errors or is cancelled. */
function releasing(body: ReadableStream<Uint8Array>, release: () => void, what: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        release();
        // The underlying error can quote the URL, which carries the token.
        if (!cancelled) controller.error(new VleError("unavailable", `${what}: the transfer was cut off.`));
        return;
      }
      if (cancelled) return;
      if (chunk.done) {
        release();
        controller.close();
      } else controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      cancelled = true;
      release();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------- moodle json shapes (the parts we read) */

type MoodleFile = {
  type?: string;
  filename?: string;
  filepath?: string | null;
  filesize?: number;
  fileurl?: string;
  timemodified?: number | null;
  mimetype?: string | null;
};
type MoodleModule = {
  id: number;
  name: string;
  modname: string;
  url?: string;
  contents?: MoodleFile[];
};
type MoodleSection = { id: number; name: string; section?: number; modules?: MoodleModule[] };
type MoodleCourse = { id: number; shortname: string; fullname: string; startdate?: number; enddate?: number };
type MoodleAssignment = {
  id: number;
  cmid: number;
  name: string;
  duedate?: number;
  cutoffdate?: number;
  intro?: string;
  introattachments?: MoodleFile[];
  timemodified?: number;
};
type MoodleQuiz = { id: number; coursemodule: number; name: string; timeopen?: number; timeclose?: number };
type MoodleEvent = { id: number; name: string; timestart: number; modulename?: string | null };
type MoodleForum = { id: number; type: string };
type MoodleDiscussion = {
  id: number;
  discussion: number;
  name?: string;
  subject?: string;
  message?: string;
  created?: number;
  timemodified?: number;
};

/* ------------------------------------------------------------- adapter */

export function createMoodleAdapter(config: MoodleSiteConfig, deps: MoodleDeps = {}): UniversityAdapter {
  const site = config.site.replace(/\/+$/, "");
  const doFetch = deps.fetch ?? globalThis.fetch;
  const acquire = limiter(MAX_IN_FLIGHT);
  const userIds = new Map<string, number>();

  const nonZero = (value: number | null | undefined) => (value ? value : null);

  /**
   * Reads a response body inside its slot. `keep()` hands the slot to the reader,
   * which must call the release it returns; otherwise the slot frees when `read` settles.
   */
  type Read<T> = (response: Response, keep: () => () => void) => Promise<T>;
  type Attempt<T> = { done: true; value: T } | { done: false; failure: string };

  /** One HTTP exchange and body read with retries; never lets the token into an error. */
  async function request<T>(url: string, init: RequestInit, token: string, what: string, read: Read<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await once(url, init, token, what, read);
      if (outcome.done) return outcome.value;
      if (attempt < RETRIES) {
        await sleep(BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw new VleError("unavailable", `${what}: ${outcome.failure}`);
    }
  }

  /** One attempt, holding a slot from the fetch until the body is read (or handed on). */
  async function once<T>(url: string, init: RequestInit, token: string, what: string, read: Read<T>): Promise<Attempt<T>> {
    const release = await acquire();
    let kept = false;
    try {
      let response: Response;
      try {
        response = await doFetch(url, init);
      } catch {
        // The underlying error can quote the URL, which may carry the token.
        return { done: false, failure: `could not reach ${site}.` };
      }
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => {});
        if (status === 429 || status >= 500) return { done: false, failure: `${site} answered HTTP ${status}.` };
        if (status === 401 || status === 403) throw new VleError("access_denied", `${what}: HTTP ${status}.`);
        throw new VleError("bad_response", redact(`${what}: HTTP ${status}.`, token));
      }
      try {
        const value = await read(response, () => {
          kept = true;
          return release;
        });
        return { done: true, value };
      } catch (error) {
        if (error instanceof VleError) throw error;
        return { done: false, failure: `the answer from ${site} was cut off.` };
      }
    } finally {
      if (!kept) release();
    }
  }

  const text = (response: Response) => response.text();

  async function ws<T>(credentials: Credentials, wsfunction: string, params: Record<string, Param> = {}): Promise<T> {
    const token = credentials.token;
    const body = new URLSearchParams({ wstoken: token, wsfunction, moodlewsrestformat: "json" });
    for (const [key, value] of flattenParams(params)) body.append(key, value);
    const answer = await request(
      `${site}/webservice/rest/server.php`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      token,
      wsfunction,
      text,
    );
    let json: unknown;
    try {
      json = JSON.parse(answer);
    } catch {
      throw new VleError("bad_response", `${wsfunction}: the answer was not JSON.`);
    }
    if (json && typeof json === "object" && "exception" in json) {
      const { exception, errorcode, message } = json as { exception?: string; errorcode?: string; message?: string };
      const detail = redact(`${wsfunction}: ${errorcode ?? exception} — ${message ?? ""}`.trim(), token);
      if (errorcode === "invalidtoken") throw new VleError("invalid_token", detail);
      if (
        exception === "webservice_access_exception" ||
        errorcode === "accessexception" ||
        errorcode === "nopermissions"
      )
        throw new VleError("access_denied", detail);
      throw new VleError("bad_response", detail);
    }
    return json as T;
  }

  /** GET a site file with the token attached. Refuses other hosts, so the token never leaves the site. */
  async function fetchFile<T>(credentials: Credentials, url: string, what: string, read: Read<T>): Promise<T> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new VleError("bad_response", `${what}: not a URL.`);
    }
    if (target.origin !== new URL(site).origin)
      throw new VleError("bad_response", `${what}: file is not on ${site}; not sending the token there.`);
    target.searchParams.set("token", credentials.token);
    return request(target.toString(), { method: "GET" }, credentials.token, what, read);
  }

  /** Runs an optional call; a missing permission drops that item kind instead of the sync. */
  async function optional<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof VleError && error.code === "access_denied") return fallback;
      throw error;
    }
  }

  function toFile(file: MoodleFile): VleFile {
    return {
      filename: file.filename ?? "",
      filepath: file.filepath || "/",
      url: stripToken(file.fileurl ?? ""),
      size: file.filesize ?? 0,
      mimetype: file.mimetype || null,
      modified: nonZero(file.timemodified),
    };
  }

  const isFile = (file: MoodleFile) => file.type === "file" && Boolean(file.fileurl);

  async function whoAmI(credentials: Credentials) {
    const info = await ws<{ userid: number; functions?: { name: string }[] }>(credentials, "core_webservice_get_site_info");
    userIds.set(credentials.token, info.userid);
    return { userId: info.userid, permittedFunctions: (info.functions ?? []).map((f) => f.name) };
  }

  async function contentItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const sections = await ws<MoodleSection[]>(credentials, "core_course_get_contents", { courseid: course.id });
    const items: VleItem[] = [];
    const pages: Promise<void>[] = [];
    sections.forEach((section, position) => {
      for (const mod of section.modules ?? []) {
        const placement: Placement = {
          section: section.name,
          sectionIndex: section.section ?? position,
          activity: mod.name,
          activityType: mod.modname,
          activityId: mod.id,
          activityUrl: stripToken(mod.url ?? `${site}/mod/${mod.modname}/view.php?id=${mod.id}`),
        };
        const contents = mod.contents ?? [];
        switch (mod.modname) {
          case "resource":
          case "folder":
            for (const file of contents.filter(isFile)) items.push({ kind: "file", file: toFile(file), ...placement });
            break;
          case "page": {
            const files = contents.filter(isFile);
            const index = files.find((f) => f.filename === "index.html");
            const item: VleItem = {
              kind: "page",
              html: "",
              files: files.filter((f) => f !== index).map(toFile),
              ...placement,
            };
            items.push(item);
            if (index?.fileurl) {
              pages.push(
                fetchFile(credentials, index.fileurl, `page ${mod.id}`, text).then((html) => {
                  item.html = html;
                }),
              );
            }
            break;
          }
          case "url":
            if (contents[0]?.fileurl) items.push({ kind: "link", target: stripToken(contents[0].fileurl), ...placement });
            break;
          case "lti":
            items.push({ kind: "external-tool", toolName: mod.name, ...placement });
            break;
          default:
            // label, subsection, forum, questionnaire: nothing to keep here.
            // assign and quiz come from their own calls below.
            break;
        }
      }
    });
    await Promise.all(pages);
    return items;
  }

  async function assignmentItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const result = await ws<{ courses?: { id: number; assignments?: MoodleAssignment[] }[] }>(
      credentials,
      "mod_assign_get_assignments",
      { courseids: [course.id] },
    );
    const assignments = (result.courses ?? []).flatMap((c) => (c.id === course.id ? (c.assignments ?? []) : []));
    return assignments.map((a) => ({
      kind: "assignment",
      id: a.id,
      activityId: a.cmid,
      title: a.name,
      due: nonZero(a.duedate),
      cutoff: nonZero(a.cutoffdate),
      introHtml: a.intro ?? "",
      briefFiles: (a.introattachments ?? []).filter((f) => f.fileurl).map(toFile),
      url: stripToken(`${site}/mod/assign/view.php?id=${a.cmid}`),
      modified: nonZero(a.timemodified),
    }));
  }

  async function quizItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const result = await ws<{ quizzes?: (MoodleQuiz & { course?: number })[] }>(
      credentials,
      "mod_quiz_get_quizzes_by_courses",
      { courseids: [course.id] },
    );
    return (result.quizzes ?? []).map((q) => ({
      kind: "quiz",
      id: q.id,
      activityId: q.coursemodule,
      title: q.name,
      opens: nonZero(q.timeopen),
      closes: nonZero(q.timeclose),
      url: stripToken(`${site}/mod/quiz/view.php?id=${q.coursemodule}`),
    }));
  }

  async function eventItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const now = Math.floor(Date.now() / 1000);
    const start = course.startdate ?? now - 365 * DAY;
    const timestart = course.startdate ? course.startdate - 60 * DAY : start;
    const timeend = course.enddate ? course.enddate + 120 * DAY : start + 400 * DAY;
    const result = await ws<{ events?: MoodleEvent[] }>(credentials, "core_calendar_get_calendar_events", {
      events: { courseids: [course.id] },
      options: { timestart, timeend },
    });
    return (result.events ?? []).map((e) => ({
      kind: "event",
      id: e.id,
      title: e.name,
      start: e.timestart,
      activityType: e.modulename || null,
      url: stripToken(`${site}/calendar/view.php?view=day&time=${e.timestart}`),
    }));
  }

  async function announcementItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const forums = await ws<MoodleForum[]>(credentials, "mod_forum_get_forums_by_courses", { courseids: [course.id] });
    const news = (Array.isArray(forums) ? forums : []).filter((f) => f.type === "news");
    const lists = await Promise.all(
      news.map((forum) =>
        ws<{ discussions?: MoodleDiscussion[] }>(credentials, "mod_forum_get_forum_discussions", {
          forumid: forum.id,
          perpage: 50,
        }),
      ),
    );
    return lists.flatMap((list) =>
      (list.discussions ?? []).map((d) => ({
        kind: "announcement" as const,
        id: d.discussion,
        subject: d.subject ?? d.name ?? "",
        bodyHtml: d.message ?? "",
        posted: d.created ?? d.timemodified ?? 0,
        url: stripToken(`${site}/mod/forum/discuss.php?d=${d.discussion}`),
      })),
    );
  }

  return {
    id: config.id,
    platform: "moodle",
    displayName: config.displayName,
    site,

    async login(browser: LoginBrowser): Promise<Credentials> {
      const passport = randomBytes(16).toString("hex");
      const url =
        `${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app` +
        `&passport=${passport}&urlscheme=moodlemobile`;
      const redirect = await browser.capture(url, CAPTURE_SCHEME);
      return decodeLaunch(redirect, site, passport);
    },

    whoAmI,

    async listCourses(credentials: Credentials): Promise<Course[]> {
      const userid = userIds.get(credentials.token) ?? (await whoAmI(credentials)).userId;
      const courses = await ws<MoodleCourse[]>(credentials, "core_enrol_get_users_courses", { userid });
      return courses.map((c) => ({
        id: c.id,
        shortname: c.shortname,
        fullname: c.fullname,
        startdate: nonZero(c.startdate),
        enddate: nonZero(c.enddate),
        url: stripToken(`${site}/course/view.php?id=${c.id}`),
      }));
    },

    async listItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
      const groups = await Promise.all([
        contentItems(credentials, course),
        optional(() => assignmentItems(credentials, course), []),
        optional(() => quizItems(credentials, course), []),
        optional(() => eventItems(credentials, course), []),
        optional(() => announcementItems(credentials, course), []),
      ]);
      return groups.flat();
    },

    async download(credentials: Credentials, file: VleFile): Promise<ReadableStream<Uint8Array>> {
      const what = `download ${file.filename}`;
      // The stream keeps its slot until it ends, errors or is cancelled.
      return fetchFile(credentials, file.url, what, async (response, keep) => {
        if (!response.body) throw new VleError("bad_response", `${what}: empty body.`);
        return releasing(response.body, keep(), what);
      });
    },
  };
}

/* ------------------------------------------------------------- login */

/** `moodlemobile://token=BASE64(md5(wwwroot+passport):::token[:::privatetoken])` */
export function decodeLaunch(url: string, site: string, passport: string): Credentials {
  const match = url.match(/token=([^&#]+)/);
  if (!match?.[1]) throw new VleError("bad_response", "Sign-in redirect had no token parameter.");
  const decoded = Buffer.from(decodeURIComponent(match[1]), "base64").toString("utf8");
  const [signature, token, privateToken] = decoded.split(":::");
  const expected = createHash("md5").update(site + passport).digest("hex");
  const expectedSlash = createHash("md5").update(`${site}/` + passport).digest("hex");
  if (signature !== expected && signature !== expectedSlash)
    throw new VleError("bad_response", "Sign-in token signature did not match this site and passport. Refusing it.");
  if (!token) throw new VleError("bad_response", "Sign-in redirect carried no token.");
  return { site, token, privateToken: privateToken || null };
}
