/**
 * M0 spike: one QMplus module end to end.
 *
 * Reuses the token saved by spikes/qmplus-login (no new sign-in), then for one
 * module:
 *   1. lists sections and activities (core_course_get_contents)
 *   2. downloads every file into a year-grouped, Study Hub–shaped folder,
 *      sorted by the rules in docs/design/03 (rules only, no AI)
 *   3. collects structured deadlines: assignments, quizzes, calendar events
 *   4. reads the announcements forum (subjects and dates only)
 *   5. writes a manifest, Deadlines.json and a report with timings and
 *      request counts
 *
 * Everything goes to spikes/qmplus-module/out/ (git-ignored). Video files are
 * skipped by design; files over MAX_FILE_BYTES are skipped and reported.
 *
 *   electron spikes/qmplus-module/main.mjs --course=ECS505U
 */

import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

app.setName("Crawler Spike"); // same userData folder as the login spike

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SITE = "https://qmplus.qmul.ac.uk";
const CONCURRENCY = 4;
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const courseArg = (process.argv.find((a) => a.startsWith("--course=")) || "").slice(9);

const stats = { wsCalls: 0, downloads: 0, bytes: 0, startedAt: Date.now(), phases: {} };
const log = (message) => console.log(`[qmplus-module] ${message}`);

/* ------------------------------------------------------------- moodle */

function loadToken() {
  const file = join(app.getPath("userData"), "tokens", "qmplus.bin");
  return JSON.parse(safeStorage.decryptString(readFileSync(file))).token;
}

async function ws(token, wsfunction, params = {}) {
  stats.wsCalls++;
  const body = new URLSearchParams({ wstoken: token, wsfunction, moodlewsrestformat: "json" });
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  const response = await fetch(`${SITE}/webservice/rest/server.php`, { method: "POST", body });
  const json = await response.json();
  if (json && json.exception) {
    const error = new Error(`${wsfunction}: ${json.errorcode} — ${json.message}`);
    error.errorcode = json.errorcode;
    throw error;
  }
  return json;
}

async function timed(name, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    stats.phases[name] = Date.now() - start;
  }
}

/* ------------------------------------------------------------- naming (design 03) */

const CODE = /[A-Z]{3}\d{3}[A-Z]?/;
const YEAR = /(20\d{2})\s*[/-]\s*(\d{2})/;

function academicYear(course) {
  const match = (course.fullname || "").match(YEAR) || (course.shortname || "").match(YEAR);
  if (match) return `${match[1]}-${match[2]}`;
  if (course.startdate) {
    const d = new Date(course.startdate * 1000);
    const start = d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  }
  return "Undated";
}

function sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)$/i, "_$1")
    .slice(0, 120) || "Untitled";
}

function moduleFolderName(course) {
  const full = course.fullname || course.shortname;
  const code = (full.match(CODE) || course.shortname.match(CODE) || [null])[0];
  let title = full.replace(YEAR, "").replace(/\s+-\s*$/, "");
  if (code) title = title.replace(code, "");
  title = title.replace(/^[\s\-–:|/]+|[\s\-–:|/]+$/g, "").replace(/\s{2,}/g, " ");
  return sanitize(code ? `${code} - ${title}` : title);
}

/* ------------------------------------------------------------- sorting (design 03, rules only) */

const RULES = [
  { category: "Past Papers", test: /past\s*(exam\s*)?papers?|past\s*exams?|exam\s*paper|mock\s*exam|\b(19|20)\d{2}\s*exam/i },
  { category: "Assessment Guidance", test: /coursework|assessment|assignment|\bbrief\b|specification|\bspec\b|marking|rubric|criteria|handbook|module\s*(guide|outline|info)/i },
  { category: "Labs and Seminars", test: /\blabs?\b|tutorials?|seminars?|worksheets?|exercises?|practicals?|problem\s*sheets?|\bsheet\s*\d/i },
  { category: "Transcripts", test: /transcript|captions?|\.vtt$|\.srt$/i },
  { category: "Lectures", test: /lectures?|slides?|\bweek\s*\d+|\blec\s*\d+|\bl\d{1,2}\b|\.pptx?$/i },
  { category: "Reference", test: /reading|textbook|reference|resources?|cheat\s*sheet|notes/i },
];

/** First rule that matches the most specific evidence wins: file → activity → section. */
function categorize({ filename, activity, section }) {
  for (const [where, text] of [["file", filename], ["activity", activity], ["section", section]]) {
    for (const rule of RULES) if (text && rule.test.test(text)) return { category: rule.category, reason: `${where}:"${text}"` };
  }
  return { category: "Other", reason: "no rule matched" };
}

/* ------------------------------------------------------------- downloads */

async function downloadAll(token, jobs) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const url = new URL(job.fileurl);
        url.searchParams.set("token", token);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        mkdirSync(dirname(job.target), { recursive: true });
        const hash = createHash("sha256");
        const body = Readable.fromWeb(response.body);
        body.on("data", (chunk) => hash.update(chunk));
        await pipeline(body, createWriteStream(job.target));
        const size = statSync(job.target).size;
        stats.downloads++;
        stats.bytes += size;
        results.push({ ...job, sha256: hash.digest("hex"), size, ok: true });
      } catch (error) {
        results.push({ ...job, ok: false, error: error.message });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

function uniquePath(path, taken) {
  if (!taken.has(path.toLowerCase())) {
    taken.add(path.toLowerCase());
    return path;
  }
  const ext = extname(path);
  for (let n = 2; ; n++) {
    const candidate = `${path.slice(0, path.length - ext.length)} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/* ------------------------------------------------------------- run */

async function run() {
  const token = loadToken();
  const info = await timed("siteInfo", () => ws(token, "core_webservice_get_site_info"));
  const courses = await timed("courses", () => ws(token, "core_enrol_get_users_courses", { userid: info.userid }));
  const course = courses.find((c) => `${c.shortname} ${c.fullname}`.toUpperCase().includes(courseArg.toUpperCase()));
  if (!courseArg || !course) throw new Error(`Pass --course=<code>. Not found: "${courseArg}".`);

  const year = academicYear(course);
  const moduleName = moduleFolderName(course);
  const root = join(OUT, "My Studies");
  const moduleRel = join(year, moduleName);
  const moduleDir = join(root, moduleRel);
  if (existsSync(moduleDir)) rmSync(moduleDir, { recursive: true, force: true }); // spike: fresh each run
  log(`Module: ${course.shortname} → ${moduleRel}`);

  // 1. contents
  const sections = await timed("contents", () => ws(token, "core_course_get_contents", { courseid: course.id }));
  const activities = [];
  const linkHosts = {};
  const ltiTools = [];
  const jobs = [];
  const skipped = [];
  const taken = new Set();
  let lectureIndex = 0;
  for (const section of sections) {
    for (const mod of section.modules || []) {
      activities.push({ section: section.name, name: mod.name, modname: mod.modname, visible: mod.uservisible !== false });
      if (mod.modname === "url" && mod.contents?.[0]?.fileurl) {
        try {
          linkHosts[new URL(mod.contents[0].fileurl).host] = (linkHosts[new URL(mod.contents[0].fileurl).host] || 0) + 1;
        } catch {
          linkHosts["(not a URL)"] = (linkHosts["(not a URL)"] || 0) + 1;
        }
      }
      if (mod.modname === "lti") ltiTools.push({ name: mod.name, section: section.name });
      for (const file of mod.contents || []) {
        if (file.type !== "file" || !file.fileurl) continue;
        const mimetype = file.mimetype || "";
        if (mimetype.startsWith("video/") || /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(file.filename)) {
          skipped.push({ filename: file.filename, why: "video", size: file.filesize });
          continue;
        }
        if (file.filesize > MAX_FILE_BYTES) {
          skipped.push({ filename: file.filename, why: "too large", size: file.filesize });
          continue;
        }
        const { category, reason } = categorize({ filename: file.filename, activity: mod.name, section: section.name });
        const sub = file.filepath && file.filepath !== "/" ? file.filepath.split("/").filter(Boolean).map(sanitize) : [];
        let name = sanitize(file.filename);
        if (category === "Lectures") name = `${String(++lectureIndex).padStart(2, "0")} - ${name}`;
        const relative = join(moduleRel, "Course Materials", category, ...(mod.modname === "folder" ? [sanitize(mod.name), ...sub] : []), name);
        jobs.push({
          vleId: `qmul:file:${mod.id}:${file.filename}`,
          module: course.shortname,
          section: section.name,
          activity: mod.name,
          modname: mod.modname,
          category,
          categoryReason: reason,
          fileurl: file.fileurl,
          vleModified: file.timemodified ? new Date(file.timemodified * 1000).toISOString() : null,
          expectedSize: file.filesize,
          relative: uniquePath(relative, taken),
        });
      }
    }
  }
  for (const job of jobs) job.target = join(root, job.relative);
  log(`${sections.length} sections, ${activities.length} activities, ${jobs.length} files to download.`);

  // 2. downloads
  const downloaded = await timed("downloads", () => downloadAll(token, jobs));

  // 3. structured deadlines
  const deadlines = [];
  const source = (type, url, quote, date) => ({ type, strength: "structured", url, quote, date, seenAt: new Date().toISOString() });
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);

  const assignResult = await timed("assignments", () =>
    ws(token, "mod_assign_get_assignments", { "courseids[0]": course.id }).catch((e) => ({ error: e.message })),
  );
  for (const assign of assignResult.courses?.[0]?.assignments || []) {
    const url = `${SITE}/mod/assign/view.php?id=${assign.cmid}`;
    deadlines.push({
      id: `qmul:${course.shortname}:assign:${assign.id}`,
      module: course.shortname,
      title: assign.name,
      kind: "coursework",
      status: assign.duedate ? "confirmed" : "tbc",
      due: iso(assign.duedate),
      cutoff: iso(assign.cutoffdate),
      sources: [source("vle-field", url, `Due: ${iso(assign.duedate) || "not set"}`, iso(assign.duedate))],
    });
  }

  const quizResult = await timed("quizzes", () =>
    ws(token, "mod_quiz_get_quizzes_by_courses", { "courseids[0]": course.id }).catch((e) => ({ error: e.message })),
  );
  for (const quiz of quizResult.quizzes || []) {
    const url = `${SITE}/mod/quiz/view.php?id=${quiz.coursemodule}`;
    deadlines.push({
      id: `qmul:${course.shortname}:quiz:${quiz.id}`,
      module: course.shortname,
      title: quiz.name,
      kind: "quiz",
      status: quiz.timeclose ? "confirmed" : "tbc",
      due: iso(quiz.timeclose),
      window: quiz.timeopen && quiz.timeclose ? { from: iso(quiz.timeopen), to: iso(quiz.timeclose) } : undefined,
      sources: [source("vle-field", url, `Closes: ${iso(quiz.timeclose) || "not set"}`, iso(quiz.timeclose))],
    });
  }

  const eventResult = await timed("calendar", () =>
    ws(token, "core_calendar_get_calendar_events", {
      "events[courseids][0]": course.id,
      "options[timestart]": Math.floor(Date.UTC(Number(year.slice(0, 4)), 7, 1) / 1000),
      "options[timeend]": Math.floor(Date.UTC(Number(year.slice(0, 4)) + 1, 8, 30) / 1000),
    }).catch((e) => ({ error: e.message })),
  );
  const calendarEvents = (eventResult.events || []).map((e) => ({
    name: e.name,
    modulename: e.modulename || null,
    eventtype: e.eventtype,
    start: iso(e.timestart),
  }));
  for (const event of eventResult.events || []) {
    // Assignment and quiz events duplicate the activities above.
    if (event.modulename === "assign" || event.modulename === "quiz") continue;
    deadlines.push({
      id: `qmul:${course.shortname}:event:${event.id}`,
      module: course.shortname,
      title: event.name,
      kind: event.modulename === "lesson" ? "other" : "other",
      status: "confirmed",
      due: iso(event.timestart),
      sources: [source("vle-field", `${SITE}/calendar/view.php?view=day&time=${event.timestart}`, `Event: ${event.name}`, iso(event.timestart))],
    });
  }

  // 4. announcements — subjects and dates only
  const forums = await timed("forums", () =>
    ws(token, "mod_forum_get_forums_by_courses", { "courseids[0]": course.id }).catch((e) => ({ error: e.message })),
  );
  const news = Array.isArray(forums) ? forums.filter((f) => f.type === "news") : [];
  let announcements = [];
  for (const forum of news) {
    const list = await timed(`discussions:${forum.id}`, () =>
      ws(token, "mod_forum_get_forum_discussions", { forumid: forum.id, perpage: 50 }).catch((e) => ({ error: e.message })),
    );
    announcements = announcements.concat(
      (list.discussions || []).map((d) => ({ subject: d.subject || d.name, posted: iso(d.created || d.timemodified) })),
    );
  }
  const dateWords = /\b(due|deadline|submi|extension|exam|test|moved|postpone|resched)/i;

  // 5. write
  const manifest = downloaded
    .filter((d) => d.ok)
    .map(({ vleId, module, fileurl, relative, category, categoryReason, vleModified, sha256 }) => ({
      vleId,
      module,
      // Without the token, never with it.
      sourceUrl: fileurl.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, ""),
      localPath: relative.split("\\").join("/"),
      category,
      categoryReason,
      vleModified,
      sha256,
      writtenAt: new Date().toISOString(),
    }));
  mkdirSync(join(root, ".crawler"), { recursive: true });
  writeFileSync(join(root, ".crawler", "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(root, "Deadlines.json"), JSON.stringify(deadlines, null, 2));

  const byCategory = {};
  for (const m of manifest) byCategory[m.category] = (byCategory[m.category] || 0) + 1;
  const byModname = {};
  for (const a of activities) byModname[a.modname] = (byModname[a.modname] || 0) + 1;
  const report = {
    module: course.shortname,
    folder: moduleRel.split("\\").join("/"),
    sections: sections.length,
    activities: activities.length,
    activityTypes: byModname,
    linkHosts,
    ltiTools,
    files: { planned: jobs.length, downloaded: manifest.length, failed: downloaded.filter((d) => !d.ok).map((d) => ({ file: d.relative, error: d.error })), skipped },
    byCategory,
    other: manifest.filter((m) => m.category === "Other").map((m) => m.localPath.split("/").slice(-1)[0]),
    deadlines: deadlines.map((d) => ({ title: d.title, kind: d.kind, status: d.status, due: d.due })),
    calendarEvents,
    assignmentsCall: assignResult.error || "ok",
    quizzesCall: quizResult.error || "ok",
    calendarCall: eventResult.error || "ok",
    announcements: { count: announcements.length, mentioningDates: announcements.filter((a) => dateWords.test(a.subject)) },
    stats: { ...stats, totalMs: Date.now() - stats.startedAt, megabytes: +(stats.bytes / 1e6).toFixed(1) },
  };
  writeFileSync(join(OUT, `report-${course.shortname.replace(/[^A-Za-z0-9]+/g, "_")}.json`), JSON.stringify(report, null, 2));
  log(`Done: ${manifest.length}/${jobs.length} files, ${report.stats.megabytes} MB, ${deadlines.length} deadlines, ${stats.wsCalls} API calls, ${report.stats.totalMs} ms.`);
  return report;
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (error) {
    log(`FAILED ${error.errorcode === "invalidtoken" ? "Token expired or revoked — run spikes/qmplus-login again." : error.message}`);
    app.exit(1);
  }
});
