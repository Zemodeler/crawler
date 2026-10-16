/**
 * M5.1 spike: Echo360 (Q-Review) captions behind a QMplus LTI activity.
 *
 * Reuses the token saved by spikes/qmplus-login (no new sign-in), then:
 *   1. finds the course and its `lti` activities (core_course_get_contents)
 *   2. mod_lti_get_tool_launch_data for the Echo360 one
 *   3. posts the LTI form inside an in-memory Electron session, so the
 *      Echo360 cookies stay in that session and never touch disk
 *   4. reads the section syllabus (lessons + media ids)
 *   5. tries candidate caption URLs for the first lesson with media
 *
 * report.json holds statuses, origins plus route shapes (redactUrl), content
 * types, field names and cookie *names* only: no token, no launch values, no
 * cookie values, no response bodies. Errors are reported as a stage and a fixed
 * code (SpikeError), never as caught error text, which can quote decrypted
 * credentials or response bodies. A caption file that downloads is saved
 * beside the report under out/ (git-ignored) for inspection.
 *
 *   electron spikes/echo360/main.mjs --course=ECS505U [--activity=<cmid>]
 */

import { app, safeStorage, session } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchForm, launchParameterNames, lessonsFromSyllabus, redactUrl, sectionFromUrl, vttToText } from "./parse.mjs";

app.setName("Crawler Spike"); // same userData folder as the login spike

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SITE = "https://qmplus.qmul.ac.uk";
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const courseArg = arg("course");
const activityArg = Number(arg("activity")) || null;
const PAUSE_MS = 500; // one request at a time on the Echo360 side, with a gap

const report = { startedAt: new Date().toISOString(), steps: [] };
let lastStep = "start";
const log = (message) => console.log(`[echo360] ${message}`);
const step = (name, data) => {
  lastStep = name;
  report.steps.push({ name, ...data });
  log(`${name}: ${JSON.stringify(data)}`);
};
const pause = () => new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

/** A failure reported as a stage name and a fixed code; it never carries caught text. */
class SpikeError extends Error {
  constructor(stage, code) {
    super(`${stage}: ${code}`);
    this.stage = stage;
    this.code = code;
  }
}
const fail = (stage, code) => {
  throw new SpikeError(stage, code);
};

/** Runs fn; anything it throws becomes SpikeError(stage, code) and its message is dropped. */
async function guard(stage, code, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SpikeError) throw error;
    throw new SpikeError(stage, code);
  }
}

async function loadToken() {
  const file = join(app.getPath("userData"), "tokens", "qmplus.bin");
  const saved = await guard("credentials", "credentials-unreadable", () =>
    JSON.parse(safeStorage.decryptString(readFileSync(file))),
  );
  if (typeof saved?.token !== "string" || !saved.token) fail("credentials", "credentials-no-token");
  return saved.token;
}

async function ws(token, wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction, moodlewsrestformat: "json" });
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  const response = await guard(wsfunction, "fetch-failed", () =>
    fetch(`${SITE}/webservice/rest/server.php`, { method: "POST", body }),
  );
  const json = await guard(wsfunction, "response-not-json", () => response.json());
  if (json && json.exception) fail(wsfunction, "ws-exception");
  return json;
}

/** Status of a response without its body; the URL goes through redactUrl. */
function describe(response) {
  return {
    status: response.status,
    url: redactUrl(response.url),
    redirected: response.redirected,
    contentType: response.headers.get("content-type"),
  };
}

/** Route shapes of the links on a page (redacted), never the links themselves. */
function linkShapes(html, base) {
  const shapes = new Set();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      shapes.add(redactUrl(new URL(match[1], base).href));
    } catch {
      shapes.add("<invalid-url>");
    }
  }
  return [...shapes].slice(0, 15);
}

async function cookieNames(ses) {
  const cookies = await ses.cookies.get({});
  return cookies.map((c) => `${c.domain} ${c.name}${c.httpOnly ? " (httpOnly)" : ""}`).sort();
}

/** Guessed caption URLs, tried in order. None is documented by Echo360; the report says which answered. */
function captionCandidates(host, lesson, media) {
  return [
    `${host}/api/ui/echoplayer/lessons/${lesson.id}/medias/${media.id}/transcript`,
    `${host}/api/ui/echoplayer/lessons/${lesson.id}/medias/${media.id}/transcript-file?format=vtt`,
    `${host}/media/${media.id}/transcript`,
    `${host}/media/${media.id}/vtt`,
  ];
}

async function run() {
  const token = await loadToken();
  const me = await ws(token, "core_webservice_get_site_info");
  const courses = await ws(token, "core_enrol_get_users_courses", { userid: me.userid });
  const course = courses.find((c) => `${c.shortname} ${c.fullname}`.includes(courseArg));
  if (!course) fail("course", "no-matching-course");
  step("course", { id: course.id, shortname: course.shortname });

  const sections = await ws(token, "core_course_get_contents", { courseid: course.id });
  const ltis = sections.flatMap((s) =>
    (s.modules || []).filter((m) => m.modname === "lti").map((m) => ({ cmid: m.id, instance: m.instance, name: m.name, section: s.name })),
  );
  step("lti-activities", { count: ltis.length, activities: ltis });
  const target = ltis.find((m) => (activityArg ? m.cmid === activityArg : /echo|q-review|recording/i.test(m.name)));
  if (!target) fail("lti-activities", "no-echo360-activity"); // pass --activity=<cmid>

  const launch = await ws(token, "mod_lti_get_tool_launch_data", { toolid: target.instance });
  const { endpoint, fields } = await guard("launch-data", "launch-data-invalid", () => launchForm(launch));
  step("launch-data", {
    endpoint: redactUrl(endpoint),
    parameterNames: launchParameterNames(launch),
    ltiVersion: fields.get("lti_version"),
    warnings: launch.warnings ? launch.warnings.length : 0,
  });

  // In-memory partition (no "persist:"): the Echo360 session dies with the spike.
  const ses = session.fromPartition("echo360-spike");
  ses.setUserAgent(ses.getUserAgent().replace(/\s*Electron\/\S+/, ""));
  const landed = await guard("lti-post", "fetch-failed", () =>
    ses.fetch(endpoint, {
      method: "POST",
      body: fields.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );
  const landingHtml = await guard("lti-post", "body-unreadable", () => landed.text());
  let host = null;
  let sectionId = null;
  try {
    ({ host, sectionId } = sectionFromUrl(landed.url));
  } catch {
    // reported below as sectionFound: false, with the landing route shape
  }
  // Electron's fetch may not report the final URL of a POST; the landing page
  // (a single-page app) still names its section.
  const inPage = [...new Set([...landingHtml.matchAll(/section[s]?[\/"':= ]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((m) => m[1]))];
  if (!sectionId && inPage.length) {
    sectionId = inPage[0];
    host = new URL(endpoint).origin;
  }
  step("lti-post", {
    ...describe(landed),
    sectionFound: Boolean(sectionId),
    sectionIdsInPage: inPage.length,
    landingBytes: landingHtml.length,
    landingTitle: (/<title>([^<]{0,80})/i.exec(landingHtml)?.[1] ?? "").trim(),
    // Shapes only: which kind of next hop the landing page asks for.
    metaRefresh: /<meta[^>]+http-equiv=["']?refresh/i.test(landingHtml),
    scriptRedirect: /(window\.)?location(\.href)?\s*=|location\.replace\(/i.test(landingHtml),
    landingLinks: linkShapes(landingHtml, landed.url),
    // An auto-submitting form means a second hop (e.g. LTI 1.3 or a SAML bounce) the spike doesn't follow.
    autoSubmitForm: /<form[^>]+(onload|submit\(\))/i.test(landingHtml) || /document\.forms\[0\]\.submit/i.test(landingHtml),
    cookies: await cookieNames(ses),
  });
  if (!sectionId) fail("lti-post", "no-section-in-landing-url"); // see lti-post in the report

  await pause();
  const syl = await guard("syllabus", "fetch-failed", () =>
    ses.fetch(`${host}/section/${sectionId}/syllabus`, { headers: { accept: "application/json" } }),
  );
  let json = null;
  try {
    json = await syl.json();
  } catch {
    // not JSON: reported as topLevelKeys null
  }
  const lessons = lessonsFromSyllabus(json);
  const rows = Array.isArray(json?.data) ? json.data : [];
  const withMedia = rows.find((r) => r?.lesson?.medias?.length);
  step("syllabus", {
    ...describe(syl),
    topLevelKeys: json ? Object.keys(json) : null,
    rowTypes: [...new Set(rows.map((r) => r?.type))],
    firstRowKeys: rows[0] ? Object.keys(rows[0]) : null,
    firstLessonKeys: rows[0]?.lesson ? Object.keys(rows[0].lesson) : null,
    firstMediaKeys: withMedia ? Object.keys(withMedia.lesson.medias[0]) : null,
    lessons: lessons.length,
    withVideo: lessons.filter((l) => l.hasVideo).length,
    hasTranscriptValues: [...new Set(lessons.flatMap((l) => l.medias.map((m) => String(m.hasTranscript))))],
  });

  const lesson = lessons.find((l) => l.medias.length);
  if (!lesson) return step("captions", { skipped: "no lesson with media" });
  const attempts = [];
  for (const url of captionCandidates(host, lesson, lesson.medias[0])) {
    await pause();
    let r;
    let body;
    try {
      r = await ses.fetch(url, { headers: { accept: "text/vtt, application/json;q=0.9, */*;q=0.1" } });
      body = await r.text();
    } catch {
      attempts.push({ url: redactUrl(url), error: "fetch-failed" });
      continue;
    }
    const attempt = { ...describe(r), bytes: body.length, looksVtt: body.startsWith("WEBVTT") };
    if (attempt.contentType && attempt.contentType.includes("json")) {
      try {
        attempt.jsonKeys = Object.keys(JSON.parse(body));
      } catch {
        // not JSON after all
      }
    }
    attempts.push(attempt);
    if (r.ok && attempt.looksVtt) {
      await guard("captions", "save-failed", () => {
        writeFileSync(join(OUT, "caption.vtt"), body);
        writeFileSync(join(OUT, "caption.txt"), vttToText(body));
      });
      attempt.saved = "out/caption.vtt";
      break;
    }
  }
  step("captions", { attempts });
}

app.on("window-all-closed", () => {}); // no windows here, but keep the spike pattern
app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  try {
    await run();
    report.outcome = "ok";
  } catch (error) {
    // Stage and code only: a caught message can quote decrypted credentials or a response body.
    const { stage, code } = error instanceof SpikeError ? error : { stage: `after-${lastStep}`, code: "unexpected-error" };
    report.outcome = "error";
    report.error = { stage, code };
    log(`ERROR ${stage} ${code}`);
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log(`report: ${join(OUT, "report.json")}`);
  app.quit();
});
