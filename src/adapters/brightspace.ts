/**
 * Brightspace (D2L) adapter: the Valence REST routes Brightspace's own pages
 * use, called with the session cookies of a sign-in window. Design:
 * docs/design/02-university-adapters.md, "Brightspace (SurreyLearn)".
 *
 * The HTTP client mirrors moodle.ts: at most 4 requests in flight (a request
 * holds its slot until its body is read), retries on 429/5xx/network failures,
 * and the cookie never reaches an error message or a returned URL.
 *
 * Shapes below follow D2L's public Valence docs and are unconfirmed on
 * SurreyLearn until the live spike runs.
 */

import { VleError } from "../types.ts";
import type { Course, Credentials, LoginBrowser, Placement, UniversityAdapter, VleFile, VleItem } from "../types.ts";

export type BrightspaceSiteConfig = { id: string; displayName: string; site: string };
export type BrightspaceDeps = {
  fetch?: typeof fetch;
  /** A download nobody reads for this long is abandoned, freeing its request slot. */
  streamIdleMs?: number;
};

const MAX_IN_FLIGHT = 4;
const DEFAULT_STREAM_IDLE_MS = 120_000;
const RETRIES = 2;
const BACKOFF_MS = 300;
const MAX_PAGES = 50;
const COURSE_OFFERING = 3; // D2L org unit type id of a course offering

/* ------------------------------------------------------------- redaction */

/** Removes the whole Cookie header and each cookie value from `text`. */
function redact(text: string, cookies: string): string {
  if (!cookies) return text;
  const secrets = [cookies, ...cookies.split(";").map((part) => part.slice(part.indexOf("=") + 1).trim())]
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/* ------------------------------------------------------------- limiter (as in moodle.ts) */

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

/** Passes `body` through, releasing its slot when it ends, errors, is cancelled or sits unread for `idleMs`. */
function releasing(
  body: ReadableStream<Uint8Array>,
  release: () => void,
  what: string,
  idleMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cancelled = false;
  let abandoned = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
  };
  const arm = () => {
    disarm();
    idle = setTimeout(() => {
      abandoned = true;
      release();
      reader.cancel().catch(() => {});
    }, idleMs);
  };
  arm();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        disarm();
        if (abandoned) {
          controller.error(new VleError("unavailable", `${what}: the download was abandoned because it was not read.`));
          return;
        }
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          release();
          if (!cancelled) controller.error(new VleError("unavailable", `${what}: the transfer was cut off.`));
          return;
        }
        if (cancelled) return;
        if (chunk.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
          arm();
        }
      },
      async cancel(reason) {
        cancelled = true;
        disarm();
        release();
        await reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 404: the feature is not there for this course. Optional features drop it. */
class NotFound extends VleError {
  constructor(message: string) {
    super("bad_response", message);
  }
}

/** ISO date (UTC) → unix seconds; null when missing or unparseable. */
export function isoToUnix(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/* ------------------------------------------------------------- valence json shapes (the parts we read) */

type ProductVersions = { ProductCode: string; LatestVersion: string; SupportedVersions?: string[] };
type WhoAmI = { Identifier: string; FirstName?: string; LastName?: string; UniqueName?: string };
type Enrollment = {
  OrgUnit: { Id: number; Type?: { Id: number }; Name: string; Code: string | null };
  Access?: { StartDate?: string | null; EndDate?: string | null; CanAccess?: boolean };
};
type Paged<T> = { PagingInfo?: { Bookmark?: string | null; HasMoreItems?: boolean }; Items?: T[] };
type TocTopic = {
  TopicId: number;
  Title: string;
  TypeIdentifier?: string; // "File" | "Link"
  Url?: string | null;
  LastModifiedDate?: string | null;
  IsBroken?: boolean;
};
type TocModule = { ModuleId: number; Title: string; Modules?: TocModule[]; Topics?: TocTopic[] };
type RichText = { Text?: string; Html?: string | null };
type DropboxFolder = {
  Id: number;
  Name: string;
  DueDate?: string | null;
  Availability?: { StartDate?: string | null; EndDate?: string | null } | null;
  CustomInstructions?: RichText | null;
  Attachments?: { FileId: number; FileName: string; Size?: number }[];
};
type Quiz = { QuizId: number; Name: string; StartDate?: string | null; EndDate?: string | null; DueDate?: string | null };
type CalendarEvent = {
  CalendarEventId: number;
  Title: string;
  StartDateTime?: string | null;
  AssociatedEntity?: { AssociatedEntityType?: string | null } | null;
};
type NewsItem = {
  Id: number;
  Title: string;
  Body?: RichText | null;
  StartDate?: string | null;
  CreatedDate?: string | null;
  IsPublished?: boolean;
};

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  zip: "application/zip",
};
const extension = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

/** LTI and other tools launched through D2L rather than linked directly. */
const isToolUrl = (url: string) => /\/d2l\/le\/lti\/|\/d2l\/common\/dialogs\/quickLink\/|\/d2l\/lor\//i.test(url);

/* ------------------------------------------------------------- adapter */

export function createBrightspaceAdapter(config: BrightspaceSiteConfig, deps: BrightspaceDeps = {}): UniversityAdapter {
  const site = config.site.replace(/\/+$/, "");
  const origin = new URL(site).origin;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const acquire = limiter(MAX_IN_FLIGHT);
  let versions: Promise<{ lp: string; le: string; supported: string[] }> | null = null;

  type Read<T> = (response: Response, keep: () => () => void) => Promise<T>;
  type Attempt<T> = { done: true; value: T } | { done: false; failure: string };

  const cookiesOf = (credentials: Credentials) => {
    if (!credentials.cookies) throw new VleError("invalid_token", "No SurreyLearn session; sign in again.");
    return credentials.cookies;
  };

  async function request<T>(url: string, cookies: string, what: string, read: Read<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await once(url, cookies, what, read);
      if (outcome.done) return outcome.value;
      if (attempt < RETRIES) {
        await sleep(BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw new VleError("unavailable", redact(`${what}: ${outcome.failure}`, cookies));
    }
  }

  async function once<T>(url: string, cookies: string, what: string, read: Read<T>): Promise<Attempt<T>> {
    const release = await acquire();
    let kept = false;
    try {
      let response: Response;
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (cookies) headers.cookie = cookies;
        // redirect "manual": an expired session redirects to the login page, which must not look like success.
        response = await doFetch(url, { method: "GET", headers, redirect: "manual" });
      } catch {
        return { done: false, failure: `could not reach ${site}.` };
      }
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => {});
        if (status === 429 || status >= 500) return { done: false, failure: `${site} answered HTTP ${status}.` };
        if (status === 401 || (status >= 300 && status < 400) || status === 0)
          throw new VleError("invalid_token", `${what}: the SurreyLearn session has ended; sign in again.`);
        if (status === 403) throw new VleError("access_denied", `${what}: HTTP 403.`);
        if (status === 404) throw new NotFound(`${what}: HTTP 404.`);
        throw new VleError("bad_response", `${what}: HTTP ${status}.`);
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

  async function getJson<T>(path: string, cookies: string, what: string): Promise<T> {
    const body = await request(`${site}${path}`, cookies, what, (response) => response.text());
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new VleError("bad_response", `${what}: the answer was not JSON.`);
    }
  }

  /** A core call: 403 here means the session no longer counts, not a missing feature. */
  async function core<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof VleError && error.code === "access_denied")
        throw new VleError("invalid_token", `${error.message} The SurreyLearn session may have ended; sign in again.`);
      throw error;
    }
  }

  /** An optional feature: 403/404 drops that item kind instead of the sync. */
  async function optional<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof NotFound || (error instanceof VleError && error.code === "access_denied")) return fallback;
      throw error;
    }
  }

  function apiVersions() {
    versions ??= (async () => {
      // Public route; no cookie needed.
      const list = await getJson<ProductVersions[]>("/d2l/api/versions/", "", "versions");
      const pick = (code: string) => {
        const product = Array.isArray(list) ? list.find((p) => p.ProductCode === code) : undefined;
        if (!product?.LatestVersion) throw new VleError("bad_response", `versions: ${site} lists no "${code}" API.`);
        return product.LatestVersion;
      };
      return { lp: pick("lp"), le: pick("le"), supported: ["lp", "le"] };
    })();
    versions.catch(() => {
      versions = null;
    });
    return versions;
  }

  const lp = async (path: string) => `/d2l/api/lp/${(await apiVersions()).lp}${path}`;
  const le = async (orgUnit: number, path: string) => `/d2l/api/le/${(await apiVersions()).le}/${orgUnit}${path}`;

  async function whoAmI(credentials: Credentials) {
    const cookies = cookiesOf(credentials);
    const v = await apiVersions();
    const me = await core(() => getJson<WhoAmI>(`/d2l/api/lp/${v.lp}/users/whoami`, cookies, "whoami"));
    const userId = Number(me.Identifier);
    if (!Number.isFinite(userId)) throw new VleError("bad_response", "whoami: no numeric Identifier.");
    // Brightspace has no per-function list like Moodle's; report the product APIs in use, "lp/1.47".
    return { userId, permittedFunctions: [`lp/${v.lp}`, `le/${v.le}`] };
  }

  function topicFile(orgUnit: number, topic: TocTopic, leVersion: string): VleFile {
    const path = (topic.Url ?? "").split(/[?#]/)[0] ?? "";
    let filename = path.slice(path.lastIndexOf("/") + 1);
    try {
      filename = decodeURIComponent(filename);
    } catch {
      // keep it encoded
    }
    if (!filename) filename = topic.Title;
    return {
      filename,
      filepath: "/",
      url: `${site}/d2l/api/le/${leVersion}/${orgUnit}/content/topics/${topic.TopicId}/file`,
      size: 0, // the TOC carries no size
      mimetype: EXT_MIME[extension(filename)] ?? null,
      modified: isoToUnix(topic.LastModifiedDate),
    };
  }

  async function contentItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const cookies = cookiesOf(credentials);
    const v = await apiVersions();
    const toc = await core(async () => getJson<{ Modules?: TocModule[] }>(await le(course.id, "/content/toc"), cookies, "content toc"));
    const items: VleItem[] = [];
    const pages: Promise<void>[] = [];
    const walk = (module: TocModule, trail: string[], sectionIndex: number) => {
      const section = [...trail, module.Title].join(" / ");
      for (const topic of module.Topics ?? []) {
        if (topic.IsBroken) continue;
        const url = topic.Url ?? "";
        const placement: Placement = {
          section,
          sectionIndex,
          activity: topic.Title,
          activityType: topic.TypeIdentifier ?? "",
          activityId: topic.TopicId,
          activityUrl: `${site}/d2l/le/content/${course.id}/viewContent/${topic.TopicId}/View`,
        };
        if (topic.TypeIdentifier === "File") {
          const file = topicFile(course.id, topic, v.le);
          if (file.mimetype === "text/html") {
            const item: VleItem = { kind: "page", html: "", files: [], ...placement };
            items.push(item);
            pages.push(
              optional(() => request(`${file.url}`, cookies, `page ${topic.TopicId}`, (r) => r.text()), "").then((html) => {
                item.html = html;
              }),
            );
          } else items.push({ kind: "file", file, ...placement });
        } else if (topic.TypeIdentifier === "Link" && url) {
          if (isToolUrl(url)) items.push({ kind: "external-tool", toolName: topic.Title, ...placement });
          else items.push({ kind: "link", target: /^https?:/i.test(url) ? url : `${origin}${url.startsWith("/") ? "" : "/"}${url}`, ...placement });
        }
        // Other topic types (SCORM, discussions, quizzes linked into content) come from their own calls or are skipped.
      }
      for (const child of module.Modules ?? []) walk(child, [...trail, module.Title], sectionIndex);
    };
    (toc.Modules ?? []).forEach((module, index) => walk(module, [], index));
    await Promise.all(pages);
    return items;
  }

  async function assignmentItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const cookies = cookiesOf(credentials);
    const v = await apiVersions();
    const folders = await getJson<DropboxFolder[]>(await le(course.id, "/dropbox/folders/"), cookies, "dropbox folders");
    return (Array.isArray(folders) ? folders : []).map((f) => ({
      kind: "assignment",
      id: f.Id,
      activityId: f.Id, // no separate course-module id in Brightspace
      title: f.Name,
      due: isoToUnix(f.DueDate),
      cutoff: isoToUnix(f.Availability?.EndDate),
      introHtml: f.CustomInstructions?.Html || f.CustomInstructions?.Text || "",
      briefFiles: (f.Attachments ?? []).map((a) => ({
        filename: a.FileName,
        filepath: "/",
        url: `${site}/d2l/api/le/${v.le}/${course.id}/dropbox/folders/${f.Id}/attachments/${a.FileId}`,
        size: a.Size ?? 0,
        mimetype: EXT_MIME[extension(a.FileName)] ?? null,
        modified: null,
      })),
      url: `${site}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=${course.id}&db=${f.Id}`,
      modified: null, // the folder list carries no modified date
    }));
  }

  async function quizItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const cookies = cookiesOf(credentials);
    const quizzes: Quiz[] = [];
    let path: string | null = await le(course.id, "/quizzes/");
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const got: { Objects?: Quiz[]; Next?: string | null } = await getJson(path, cookies, "quizzes");
      quizzes.push(...(got.Objects ?? []));
      // Next is a full URL on the same site; keep only its path so the cookie never leaves the site.
      path = got.Next ? nextPath(got.Next) : null;
    }
    return quizzes.map((q) => ({
      kind: "quiz",
      id: q.QuizId,
      activityId: q.QuizId,
      title: q.Name,
      opens: isoToUnix(q.StartDate),
      closes: isoToUnix(q.DueDate) ?? isoToUnix(q.EndDate),
      url: `${site}/d2l/lms/quizzing/user/quiz_summary.d2l?ou=${course.id}&qi=${q.QuizId}`,
    }));
  }

  function nextPath(next: string): string | null {
    try {
      const url = new URL(next, origin);
      return url.origin === origin ? `${url.pathname}${url.search}` : null;
    } catch {
      return null;
    }
  }

  async function eventItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const cookies = cookiesOf(credentials);
    const events = await getJson<CalendarEvent[]>(await le(course.id, "/calendar/events/"), cookies, "calendar events");
    const items: VleItem[] = [];
    for (const e of Array.isArray(events) ? events : []) {
      const start = isoToUnix(e.StartDateTime);
      if (start === null) continue;
      items.push({
        kind: "event",
        id: e.CalendarEventId,
        title: e.Title,
        start,
        activityType: e.AssociatedEntity?.AssociatedEntityType || null,
        url: `${site}/d2l/le/calendar/${course.id}/event/${e.CalendarEventId}/detailsview`,
      });
    }
    return items;
  }

  async function newsItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
    const cookies = cookiesOf(credentials);
    const news = await getJson<NewsItem[]>(await le(course.id, "/news/"), cookies, "news");
    return (Array.isArray(news) ? news : [])
      .filter((n) => n.IsPublished !== false)
      .map((n) => ({
        kind: "announcement",
        id: n.Id,
        subject: n.Title,
        bodyHtml: n.Body?.Html || n.Body?.Text || "",
        posted: isoToUnix(n.StartDate) ?? isoToUnix(n.CreatedDate) ?? 0,
        url: `${site}/d2l/le/news/${course.id}/${n.Id}/view`,
      }));
  }

  return {
    id: config.id,
    platform: "brightspace",
    displayName: config.displayName,
    site,

    async login(browser: LoginBrowser): Promise<Credentials> {
      if (!browser.captureCookies)
        throw new VleError("unavailable", `Signing in to ${config.displayName} needs a sign-in window that can read cookies; this app's does not.`);
      const cookies = await browser.captureCookies(`${site}/d2l/login`, `${site}/d2l/home`, site);
      if (!cookies) throw new VleError("bad_response", "Sign-in finished without a session cookie.");
      return { site, token: "", privateToken: null, cookies };
    },

    whoAmI,

    async listCourses(credentials: Credentials): Promise<Course[]> {
      const cookies = cookiesOf(credentials);
      const base = await lp("/enrollments/myenrollments/");
      const courses: Course[] = [];
      let bookmark: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ orgUnitTypeId: String(COURSE_OFFERING) });
        if (bookmark) query.set("bookmark", bookmark);
        const got = await core(() => getJson<Paged<Enrollment>>(`${base}?${query}`, cookies, "myenrollments"));
        for (const { OrgUnit: ou, Access: access } of got.Items ?? []) {
          if (access?.CanAccess === false) continue;
          courses.push({
            id: ou.Id,
            shortname: ou.Code || ou.Name, // D2L Code can be null; Name is the fallback
            fullname: ou.Name,
            startdate: isoToUnix(access?.StartDate),
            enddate: isoToUnix(access?.EndDate),
            url: `${site}/d2l/home/${ou.Id}`,
          });
        }
        bookmark = got.PagingInfo?.HasMoreItems ? (got.PagingInfo.Bookmark ?? null) : null;
        if (!bookmark) break;
      }
      return courses;
    },

    async listItems(credentials: Credentials, course: Course): Promise<VleItem[]> {
      const groups = await Promise.all([
        contentItems(credentials, course),
        optional(() => assignmentItems(credentials, course), []),
        optional(() => quizItems(credentials, course), []),
        optional(() => eventItems(credentials, course), []),
        optional(() => newsItems(credentials, course), []),
      ]);
      return groups.flat();
    },

    async download(credentials: Credentials, file: VleFile): Promise<ReadableStream<Uint8Array>> {
      const what = `download ${file.filename}`;
      const cookies = cookiesOf(credentials);
      let target: URL;
      try {
        target = new URL(file.url);
      } catch {
        throw new VleError("bad_response", `${what}: not a URL.`);
      }
      if (target.origin !== origin) throw new VleError("bad_response", `${what}: file is not on ${site}; not sending the session there.`);
      return core(() =>
        request(target.toString(), cookies, what, async (response, keep) => {
          if (!response.body) throw new VleError("bad_response", `${what}: empty body.`);
          return releasing(response.body, keep(), what, deps.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS);
        }),
      );
    },
  };
}
