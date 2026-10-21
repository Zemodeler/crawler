import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { currentAcademicYear, safeJoin, sync, VleError } from "../src/index.ts";
import { readDeadlineFile, withDeadlineLock, writeDeadlineFile } from "../src/deadline-store.ts";
import type { AssessmentComponent, AiRunner, Course, Credentials, Deadline, UniversityAdapter, VleFile, VleItem } from "../src/index.ts";

const CREDENTIALS: Credentials = { site: "https://moodle.example.ac.uk", token: "x", privateToken: null };
const NOW = new Date("2026-10-16T09:00:00Z");
const LATER = new Date("2026-10-19T09:00:00Z");

const unix = (iso: string) => Date.parse(iso) / 1000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const course = (id: number, code: string, name: string, year = "2026/27"): Course => ({
  id,
  shortname: `${code} ${year}`,
  fullname: `${code} ${name} ${year}`,
  startdate: unix("2026-09-21T00:00:00Z"),
  enddate: unix("2027-06-01T00:00:00Z"),
  url: `https://moodle.example.ac.uk/course/view.php?id=${id}`,
});

type FileSpec = { id: number; name: string; content: string; modified: string; activity: string; section?: string };

/** A fake VLE whose files, assignments and failures the tests change between syncs. */
class FakeVle implements UniversityAdapter {
  id = "tst";
  platform = "moodle" as const;
  displayName = "Test University";
  site = CREDENTIALS.site;
  courses: Course[] = [];
  files = new Map<number, FileSpec[]>();
  assignments = new Map<number, { id: number; title: string; due: string | null }[]>();
  failing = new Set<number>();
  announcements = new Map<number, { id: number; subject: string; body: string }[]>();
  tokenExpired = false;
  downloads: string[] = [];
  brokenDownloads = new Set<string>();

  async login(): Promise<Credentials> {
    return CREDENTIALS;
  }
  async whoAmI() {
    return { userId: 1, permittedFunctions: [] };
  }
  async listCourses() {
    if (this.tokenExpired) throw new VleError("invalid_token", "expired");
    return this.courses;
  }
  async listItems(_c: Credentials, c: Course): Promise<VleItem[]> {
    if (this.failing.has(c.id)) throw new VleError("unavailable", "the VLE is down");
    const items: VleItem[] = [];
    for (const f of this.files.get(c.id) ?? []) {
      items.push({
        kind: "file",
        file: { filename: f.name, filepath: "/", url: `${CREDENTIALS.site}/pluginfile.php/${f.id}/${f.name}`, size: f.content.length, mimetype: null, modified: unix(f.modified) },
        section: f.section ?? "Week 1",
        sectionIndex: 1,
        activity: f.activity,
        activityType: "resource",
        activityId: f.id,
        activityUrl: `${CREDENTIALS.site}/mod/resource/view.php?id=${f.id}`,
      });
    }
    for (const a of this.assignments.get(c.id) ?? []) {
      items.push({
        kind: "assignment",
        id: a.id,
        activityId: a.id,
        title: a.title,
        due: a.due ? unix(a.due) : null,
        cutoff: null,
        introHtml: "",
        briefFiles: [],
        url: `${CREDENTIALS.site}/mod/assign/view.php?id=${a.id}`,
        modified: null,
      });
    }
    for (const n of this.announcements.get(c.id) ?? []) {
      items.push({ kind: "announcement", id: n.id, subject: n.subject, bodyHtml: `<p>${n.body}</p>`, posted: unix("2026-10-10T09:00:00Z"), url: `${CREDENTIALS.site}/mod/forum/discuss.php?d=${n.id}` });
    }
    return items;
  }
  async download(_c: Credentials, file: VleFile): Promise<ReadableStream<Uint8Array>> {
    this.downloads.push(file.filename);
    if (this.brokenDownloads.has(file.filename)) throw new VleError("unavailable", "transfer cut off");
    const spec = [...this.files.values()].flat().find((f) => f.name === file.filename);
    return new Response(spec?.content ?? "").body!;
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "crawler-sync-"));
  const vle = new FakeVle();
  vle.courses = [course(1, "TST101U", "Testing Basics"), course(2, "TST202U", "Advanced Testing")];
  vle.files.set(1, [
    { id: 10, name: "Lecture1.pdf", content: "lecture one", modified: "2026-09-25T10:00:00Z", activity: "Week 1 lecture slides" },
    { id: 11, name: "Lab1.pdf", content: "lab one", modified: "2026-09-26T10:00:00Z", activity: "Lab 1 exercise" },
  ]);
  vle.files.set(2, [{ id: 20, name: "Notes.pdf", content: "notes", modified: "2026-09-27T10:00:00Z", activity: "Lecture notes" }]);
  vle.assignments.set(1, [{ id: 5, title: "Coursework 1 (20%)", due: "2026-12-14T10:00:00Z" }]);
  const run = (at = NOW, extra: Partial<Parameters<typeof sync>[0]> = {}) =>
    sync({ adapter: vle, credentials: CREDENTIALS, root, now: at, ...extra });
  const path = (...parts: string[]) => join(root, ...parts);
  const lectureDir = path("2026-27", "TST101U - Testing Basics", "Course Materials", "Lectures");
  const manifest = async () => JSON.parse(await readFile(path(".crawler", "manifest.json"), "utf8")) as { vleId: string; localPath: string; sha256: string }[];
  return { root, vle, run, path, lectureDir, manifest, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const read = (p: string) => readFile(p, "utf8");

test("overlapping syncs are rejected before touching files and a failed sync releases its lock", async () => {
  const t = await setup();
  try {
    const listCourses = t.vle.listCourses.bind(t.vle);
    t.vle.listCourses = async () => {
      await assert.rejects(t.run(), /already running/);
      return listCourses();
    };
    await t.run(NOW, { textDeadlines: false });
    t.vle.listCourses = async () => { throw new Error("temporary outage"); };
    await assert.rejects(t.run(), /temporary outage/);
    t.vle.listCourses = listCourses;
    await t.run(LATER, { textDeadlines: false });
  } finally { await t.cleanup(); }
});

test("sync preserves edits and manual additions made while course downloads are running", async () => {
  const t = await setup();
  try {
    await t.run(NOW, { textDeadlines: false });
    const listItems = t.vle.listItems.bind(t.vle);
    let edited = false;
    t.vle.listItems = async (credentials, c) => {
      if (!edited) {
        edited = true;
        await withDeadlineLock(t.root, async () => {
          const deadlines = await readDeadlineFile(t.root);
          deadlines[0]!.done = true;
          deadlines[0]!.status = "user-verified";
          deadlines[0]!.due = { iso: "2026-12-20T12:00:00.000Z", allDay: false, tz: "Europe/London" };
          deadlines.push({ ...deadlines[0]!, id: "user:added-during-sync", title: "Manual deadline" });
          await writeDeadlineFile(t.root, deadlines);
        });
      }
      return listItems(credentials, c);
    };
    const result = await t.run(LATER, { textDeadlines: false });
    assert.equal(result.deadlines.length, 2);
    assert.ok(result.deadlines.every((d) => d.done && d.status === "user-verified" && d.due?.iso === "2026-12-20T12:00:00.000Z"));
    assert.ok(result.deadlines.some((d) => d.id === "user:added-during-sync"));
    assert.deepEqual(await readDeadlineFile(t.root), result.deadlines);
  } finally { await t.cleanup(); }
});

test("sync refuses corrupt deadline data before querying the VLE", async () => {
  const t = await setup();
  try {
    await writeFile(t.path("Deadlines.json"), "{broken");
    t.vle.listCourses = async () => { throw new Error("VLE must not be queried"); };
    await assert.rejects(t.run(), /invalid JSON/);
    assert.equal(await read(t.path("Deadlines.json")), "{broken");
  } finally { await t.cleanup(); }
});

test("sync refuses deadline corruption introduced during downloads", async () => {
  const t = await setup();
  try {
    const listItems = t.vle.listItems.bind(t.vle);
    t.vle.listItems = async (credentials, c) => {
      await writeFile(t.path("Deadlines.json"), "{broken-during-sync");
      return listItems(credentials, c);
    };
    await assert.rejects(t.run(NOW, { textDeadlines: false }), /invalid JSON/);
    assert.equal(await read(t.path("Deadlines.json")), "{broken-during-sync");
  } finally { await t.cleanup(); }
});

test("sync reports corrupt assessments without replacing them or failing deadline sync", async () => {
  const t = await setup();
  try {
    for (const content of ["{broken", "{}"] ) {
      await writeFile(t.path("Assessments.json"), content);
      const result = await t.run(NOW, { textDeadlines: false });
      assert.ok(result.assessmentsError);
      assert.equal(await read(t.path("Assessments.json")), content);
      assert.equal((await readDeadlineFile(t.root)).length, 1);
    }
  } finally { await t.cleanup(); }
});

test("writes assessments from pages and assignment intros, replacing synced modules even without components", async () => {
  const t = await setup();
  try {
    const previous: AssessmentComponent = { module: "OLD101U", year: "2025-26", seq: "001", type: null, description: "Previous exam", weight: 100, submission: null, resit: false, source: { url: "https://example.org/old", title: "Old overview" } };
    const noComponents = { ...previous, module: "TST202U", year: "2026-27" };
    await writeFile(t.path("Assessments.json"), JSON.stringify([previous, noComponents, { ...noComponents, module: "TST101U" }]));
    const table = (seq: string, description: string) => `<table><tr><td>Seq</td><td>Description</td><td>Weight</td></tr><tr><td>${seq}</td><td>${description}</td><td>60%</td></tr></table>`;
    const listItems = t.vle.listItems.bind(t.vle);
    t.vle.listItems = async (credentials, c) => {
      const items = await listItems(credentials, c);
      if (c.id !== 1) return items;
      for (const item of items) if (item.kind === "assignment") item.introHtml = table("001", "Exam") + table("002", "Project");
      return [{ kind: "page", html: table("001", "Exam"), files: [], section: "Assessment", sectionIndex: 0, activity: "Overview", activityType: "page", activityId: 90, activityUrl: "https://example.org/overview" }, ...items];
    };
    await t.run(NOW, { textDeadlines: false });
    const saved = JSON.parse(await read(t.path("Assessments.json"))) as AssessmentComponent[];
    assert.equal(saved.length, 3);
    assert.deepEqual(saved.slice(0, 1), [previous]);
    assert.deepEqual(saved.slice(1, 3).map((row) => [row.module, row.seq, row.description]), [["TST101U", "001", "Exam"], ["TST101U", "002", "Project"]]);
    assert.equal(saved[1]!.source.url, "https://example.org/overview");
    assert.equal(saved[1]!.source.title, "Overview");
    assert.ok(saved[1]!.source.localPath?.endsWith("Overview.html"));
    assert.equal(saved[2]!.source.title, "Coursework 1 (20%)");
    assert.equal(saved[2]!.source.url, `${CREDENTIALS.site}/mod/assign/view.php?id=5`);
    await t.run(LATER, { textDeadlines: false });
    assert.deepEqual(JSON.parse(await read(t.path("Assessments.json"))), saved);
  } finally { await t.cleanup(); }
});

test("an assessments write failure still saves deadlines, calendar and sync state", async () => {
  const t = await setup();
  try {
    await mkdir(t.path("Assessments.json"));
    const result = await t.run(NOW, { textDeadlines: false });
    assert.ok(result.assessmentsError, "the non-fatal assessments error is reported");
    assert.deepEqual(result.courses.map((c) => c.status), ["synced", "synced"]);
    assert.equal(result.deadlines.length, 1);
    assert.equal(JSON.parse(await read(t.path("Deadlines.json"))).length, 1);
    assert.match(await read(t.path("Deadlines.ics")), /BEGIN:VEVENT/);
    assert.equal(JSON.parse(await read(t.path(".crawler", "state.json"))).lastSync, NOW.toISOString());
  } finally { await t.cleanup(); }
});

test("invalid previous assessments JSON is reported and preserved even when new components exist", async () => {
  const t = await setup();
  try {
    await writeFile(t.path("Assessments.json"), "{invalid JSON");
    const listItems = t.vle.listItems.bind(t.vle);
    t.vle.listItems = async (credentials, c) => {
      const items = await listItems(credentials, c);
      for (const item of items) if (item.kind === "assignment") {
        item.introHtml = "<table><tr><th>Description</th><th>Weight</th></tr><tr><td>Exam</td><td>100%</td></tr></table>";
      }
      return items;
    };
    const result = await t.run(NOW, { textDeadlines: false });
    assert.ok(result.assessmentsError);
    assert.equal(await read(t.path("Assessments.json")), "{invalid JSON");
    assert.match(await read(t.path("Deadlines.ics")), /BEGIN:VEVENT/);
    assert.equal(JSON.parse(await read(t.path(".crawler", "state.json"))).lastSync, NOW.toISOString());
  } finally { await t.cleanup(); }
});

test("an assessments parser failure does not fail the course or prevent calendar and state writes", async () => {
  const t = await setup();
  try {
    const listItems = t.vle.listItems.bind(t.vle);
    t.vle.listItems = async (credentials, c) => {
      const items = await listItems(credentials, c);
      for (const item of items) if (item.kind === "assignment") {
        Object.defineProperty(item, "introHtml", { get() { throw new Error("assessment HTML unavailable"); } });
      }
      return items;
    };
    const result = await t.run(NOW, { textDeadlines: false });
    assert.deepEqual(result.courses.map((c) => c.status), ["synced", "synced"]);
    assert.equal(result.courses[0]!.assessmentsError, "assessment HTML unavailable");
    assert.equal(result.courses[1]!.assessmentsError, undefined);
    assert.equal(result.deadlines.length, 1);
    assert.match(await read(t.path("Deadlines.ics")), /BEGIN:VEVENT/);
    assert.equal(JSON.parse(await read(t.path(".crawler", "state.json"))).lastSync, NOW.toISOString());
  } finally { await t.cleanup(); }
});

test("an assessments parser failure keeps previous entries and discards partial components", async () => {
  const t = await setup();
  try {
    const previous: AssessmentComponent = { module: "TST101U", year: "2026-27", seq: "001", type: null, description: "Previous exam", weight: 100, submission: null, resit: false, source: { url: "https://example.org/old", title: "Old overview" } };
    await writeFile(t.path("Assessments.json"), JSON.stringify([previous, { ...previous, module: "TST202U" }]));
    const listItems = t.vle.listItems.bind(t.vle);
    t.vle.listItems = async (credentials, c) => {
      const items = await listItems(credentials, c);
      if (c.id !== 1) return items;
      for (const item of items) if (item.kind === "assignment") {
        Object.defineProperty(item, "introHtml", { value: null });
      }
      return [{ kind: "page", html: "<table><tr><th>Description</th><th>Weight</th></tr><tr><td>New project</td><td>50%</td></tr></table>", files: [], section: "Assessment", sectionIndex: 0, activity: "Overview", activityType: "page", activityId: 90, activityUrl: "https://example.org/overview" }, ...items];
    };
    const result = await t.run(NOW, { textDeadlines: false });
    assert.deepEqual(result.courses.map((c) => c.status), ["synced", "synced"]);
    assert.match(result.courses[0]!.assessmentsError ?? "", /matchAll/);
    assert.equal(result.courses[1]!.assessmentsError, undefined);
    assert.deepEqual(JSON.parse(await read(t.path("Assessments.json"))), [previous]);
  } finally { await t.cleanup(); }
});

test("text disabled or failed retains text deadlines and document-filled VLE dates", async () => {
  const t = await setup();
  try {
    t.vle.assignments.set(1, [{ id: 5, title: "Coursework 1", due: null }]);
    t.vle.announcements.set(1, [
      { id: 1, subject: "Assessment", body: "Coursework 1 is due on 14 December 2026 at 10:00 through the QMplus link." },
      { id: 2, subject: "Exam", body: "The final exam takes place on 12 January 2027 at 10:00 in the main hall." },
    ]);
    const first = await t.run();
    const before = first.deadlines.filter((d) => d.module === "TST101U");
    assert.equal(before.length, 2);
    assert.ok(before.every((d) => d.due));
    const off = await t.run(LATER, { textDeadlines: false });
    const evidence = (deadlines: Deadline[]) => deadlines.filter((d) => d.module === "TST101U").map((d) => ({ ...d, sources: d.sources.filter((s) => s.type !== "vle-field") }));
    assert.deepEqual(evidence(off.deadlines), evidence(before));
    const failed = await t.run(LATER, { ai: {
      available: async () => { throw new Error("temporary runner failure"); },
      structured: async () => { throw new Error("must not run"); },
    } });
    assert.match(failed.courses[0]!.textError!, /temporary runner failure/);
    assert.deepEqual(evidence(failed.deadlines), evidence(before));
    assert.equal(failed.changes.length, 0);
  } finally { await t.cleanup(); }
});

test("local document deletion preserves its deadlines; VLE removal expires them", async () => {
  const t = await setup();
  try {
    t.vle.files.set(1, [{ id: 30, name: "Brief.txt", content: "The lab test is due on 3 December 2026 at 16:00 and counts for 10% of the module.", modified: NOW.toISOString(), activity: "Assessment brief" }]);
    const first = await t.run();
    const lab = first.deadlines.find((d) => d.kind === "lab")!;
    assert.ok(lab?.due);
    const entry = (await t.manifest()).find((e) => e.localPath.endsWith("Brief.txt"))!;
    await rm(t.path(entry.localPath));
    const deleted = await t.run(LATER);
    assert.deepEqual(deleted.deadlines.find((d) => d.id === lab.id), lab);
    t.vle.files.set(1, []);
    const removed = await t.run(LATER);
    assert.equal(removed.deadlines.find((d) => d.id === lab.id)!.status, "cancelled");
  } finally { await t.cleanup(); }
});

test("a successful AI reread can clear a document-filled VLE date", async () => {
  const t = await setup();
  try {
    t.vle.assignments.set(1, [{ id: 5, title: "Oral presentation", due: null }]);
    const body = "The oral presentation is worth 10% of the module mark. It happens on 4 December 2026 at 12:00.";
    t.vle.announcements.set(1, [{ id: 1, subject: "Presentation", body }]);
    let requests = 0;
    let items: unknown[] = [{ title: "Oral presentation", kind: "presentation", date: "2026-12-04T12:00", weekNumber: null, quote: "It happens on 4 December 2026 at 12:00.", page: 1, weight: 10, formative: false }];
    const ai: AiRunner = {
      available: async () => ({ cli: "codex" }),
      structured: async <T>() => { requests++; return { items } as T; },
    };
    const first = await t.run(NOW, { ai });
    const d = first.deadlines.find((d) => d.title === "Oral presentation")!;
    assert.equal(d.due?.iso, "2026-12-04T12:00:00.000Z");
    const second = await t.run(LATER, { ai });
    assert.equal(requests, 1);
    assert.equal(second.deadlines.find((v) => v.id === d.id)!.due?.iso, d.due!.iso);
    items = [];
    t.vle.announcements.set(1, [{ id: 1, subject: "Presentation", body: `${body} Updated.` }]);
    const third = await t.run(LATER, { ai });
    assert.equal(requests, 2);
    assert.equal(third.deadlines.find((v) => v.id === d.id)!.due, null);
    assert.equal(third.deadlines.find((v) => v.id === d.id)!.status, "tbc");
  } finally { await t.cleanup(); }
});

test("currentAcademicYear starts on 1 August", () => {
  assert.equal(currentAcademicYear(new Date("2026-07-31T23:00:00Z")), "2025-26");
  assert.equal(currentAcademicYear(new Date("2026-08-01T00:00:00Z")), "2026-27");
  assert.equal(currentAcademicYear(new Date("2027-01-05T00:00:00Z")), "2026-27");
});

test("safeJoin refuses to leave the folder", () => {
  assert.throws(() => safeJoin("/data/studies", "../outside.txt"));
  assert.throws(() => safeJoin("/data/studies", "2026-27/../../outside.txt"));
  assert.ok(safeJoin("/data/studies", "2026-27/ok.txt").endsWith("ok.txt"));
});

test("first sync writes files, manifest, deadlines, ics and changes for this year's modules", async () => {
  const t = await setup();
  try {
    const result = await t.run();
    assert.deepEqual(result.courses.map((c) => [c.shortname, c.status]), [["TST101U 2026/27", "synced"], ["TST202U 2026/27", "synced"]]);
    assert.equal(result.courses[0]!.files.new, 2);

    assert.equal(await read(join(t.lectureDir, "01 - Lecture1.pdf")), "lecture one");
    assert.equal(await exists(t.path("2026-27", "TST101U - Testing Basics", "Course Materials", "Labs and Seminars", "Lab1.pdf")), true);
    assert.equal(await exists(t.path("2026-27", "TST202U - Advanced Testing", "Course Materials", "Reference", "Notes.pdf")), true);

    const entries = await t.manifest();
    assert.equal(entries.length, 3);
    assert.ok(entries.every((e) => !e.localPath.startsWith("/") && !e.localPath.includes("..")));
    assert.equal(entries.find((e) => e.localPath.endsWith("Lecture1.pdf"))!.sha256, sha("lecture one"));

    const deadlines = JSON.parse(await read(t.path("Deadlines.json"))) as Deadline[];
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0]!.status, "confirmed");
    assert.equal(deadlines[0]!.weight, 20);
    assert.match(await read(t.path("Deadlines.ics")), /BEGIN:VEVENT/);
    assert.match(await read(t.path("Changes.md")), /new deadline, due 14 Dec 10:00/);
    assert.deepEqual((await readdir(t.path(".crawler", "tmp"))).length, 0, "no temp files left");
  } finally {
    await t.cleanup();
  }
});

test("Changes.md names a few new files but summarises many", async () => {
  const t = await setup();
  try {
    t.vle.files.set(1, Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, name: `Slides${i + 1}.pdf`, content: `s${i}`, modified: "2026-09-25T10:00:00Z", activity: `Week ${i + 1} lecture slides` })));
    const result = await t.run();
    assert.ok(result.changes.includes("TST101U · 8 new files (Lectures 8)"), result.changes.join(" | "));
    assert.ok(result.changes.includes("TST202U · new file Notes.pdf"));
    assert.equal(result.changes.filter((l) => l.includes("Slides")).length, 0);
  } finally {
    await t.cleanup();
  }
});

test("a second sync with nothing changed downloads nothing and writes no changes", async () => {
  const t = await setup();
  try {
    await t.run();
    t.vle.downloads.length = 0;
    const before = await read(t.path("Changes.md"));
    const result = await t.run(LATER);
    assert.deepEqual(t.vle.downloads, []);
    assert.equal(result.courses[0]!.files.unchanged, 2);
    assert.deepEqual(result.changes, []);
    assert.equal(await read(t.path("Changes.md")), before);
  } finally {
    await t.cleanup();
  }
});

test("last year's modules and non-module sites are listed but not synced", async () => {
  const t = await setup();
  try {
    t.vle.courses.push(course(3, "TST101U", "Old Module", "2025/26"));
    t.vle.courses.push({ ...course(4, "XXX", "Academic Integrity at Queen Mary Year 2"), shortname: "Academic Integrity2-2026/27", fullname: "Academic Integrity at Queen Mary Year 2 - 2026/27" });
    const result = await t.run();
    assert.deepEqual(result.courses.map((c) => c.status), ["synced", "synced", "skipped", "skipped"]);
    assert.equal(await exists(t.path("2025-26")), false);
  } finally {
    await t.cleanup();
  }
});

test("a file changed on the VLE replaces an untouched local copy", async () => {
  const t = await setup();
  try {
    await t.run();
    t.vle.files.get(1)![0] = { ...t.vle.files.get(1)![0]!, content: "lecture one, corrected", modified: "2026-10-17T10:00:00Z" };
    const result = await t.run(LATER);
    assert.equal(result.courses[0]!.files.updated, 1);
    assert.equal(await read(join(t.lectureDir, "01 - Lecture1.pdf")), "lecture one, corrected");
    assert.ok(result.changes.some((l) => l.includes("updated 01 - Lecture1.pdf")));
    const entry = (await t.manifest()).find((e) => e.localPath.endsWith("Lecture1.pdf"))!;
    assert.equal(entry.sha256, sha("lecture one, corrected"));
  } finally {
    await t.cleanup();
  }
});

test("a file the student edited is never overwritten; the new version is saved beside it, once", async () => {
  const t = await setup();
  try {
    await t.run();
    const mine = join(t.lectureDir, "01 - Lecture1.pdf");
    await writeFile(mine, "lecture one WITH MY NOTES");
    t.vle.files.get(1)![0] = { ...t.vle.files.get(1)![0]!, content: "lecture one v2", modified: "2026-10-17T10:00:00Z" };

    const result = await t.run(LATER);
    assert.equal(result.courses[0]!.files["kept-your-edit"], 1);
    assert.equal(await read(mine), "lecture one WITH MY NOTES");
    assert.equal(await read(join(t.lectureDir, "01 - Lecture1 (updated 2026-10-19).pdf")), "lecture one v2");
    assert.ok(result.changes.some((l) => l.includes("your edited copy was kept")));

    // The next sync does not pile up more copies.
    t.vle.downloads.length = 0;
    const again = await t.run(new Date("2026-10-20T09:00:00Z"));
    assert.deepEqual(t.vle.downloads, []);
    assert.equal(again.courses[0]!.files.unchanged, 2);
    assert.equal((await readdir(t.lectureDir)).length, 2);
  } finally {
    await t.cleanup();
  }
});

test("a file the student moved is followed by its content, and a deleted one is not brought back", async () => {
  const t = await setup();
  try {
    await t.run();
    const lecture = join(t.lectureDir, "01 - Lecture1.pdf");
    const kept = t.path("2026-27", "TST101U - Testing Basics", "Revision", "my lecture.pdf");
    await mkdir(join(kept, ".."), { recursive: true });
    await rename(lecture, kept);
    await rm(t.path("2026-27", "TST101U - Testing Basics", "Course Materials", "Labs and Seminars", "Lab1.pdf"));

    t.vle.downloads.length = 0;
    const result = await t.run(LATER);
    assert.deepEqual(t.vle.downloads, []);
    assert.equal(result.courses[0]!.files["moved-by-you"], 1);
    assert.equal(result.courses[0]!.files["deleted-by-you"], 1);
    assert.equal(await exists(lecture), false);
    assert.equal((await t.manifest()).find((e) => e.vleId.includes(":10:"))!.localPath, "2026-27/TST101U - Testing Basics/Revision/my lecture.pdf");

    // Now it changes upstream: the moved copy (untouched) is replaced where the student put it.
    t.vle.files.get(1)![0] = { ...t.vle.files.get(1)![0]!, content: "lecture one v3", modified: "2026-10-21T10:00:00Z" };
    await t.run(new Date("2026-10-22T09:00:00Z"));
    assert.equal(await read(kept), "lecture one v3");
    assert.equal(await exists(lecture), false);
  } finally {
    await t.cleanup();
  }
});

test("a file already in the way is not overwritten", async () => {
  const t = await setup();
  try {
    await mkdir(t.lectureDir, { recursive: true });
    await writeFile(join(t.lectureDir, "01 - Lecture1.pdf"), "something of mine");
    await t.run();
    assert.equal(await read(join(t.lectureDir, "01 - Lecture1.pdf")), "something of mine");
    assert.equal(await read(join(t.lectureDir, "01 - Lecture1 (from QMplus).pdf")), "lecture one");
  } finally {
    await t.cleanup();
  }
});

test("a failed download is reported and retried; the rest of the course still syncs", async () => {
  const t = await setup();
  try {
    t.vle.brokenDownloads.add("Lab1.pdf");
    const result = await t.run();
    assert.equal(result.courses[0]!.files.failed, 1);
    assert.equal(result.courses[0]!.files.new, 1);
    assert.ok(result.changes.some((l) => l.includes("could not download Lab1.pdf")));
    assert.equal((await t.manifest()).some((e) => e.localPath.endsWith("Lab1.pdf")), false);
    assert.deepEqual(await readdir(t.path(".crawler", "tmp")), []);

    t.vle.brokenDownloads.clear();
    const again = await t.run(LATER);
    assert.equal(again.courses[0]!.files.new, 1);
    assert.equal(again.courses[0]!.files.unchanged, 1);
  } finally {
    await t.cleanup();
  }
});

test("a failing course does not stop the others and keeps its previous deadlines", async () => {
  const t = await setup();
  try {
    await t.run();
    t.vle.failing.add(1);
    const result = await t.run(LATER);
    assert.equal(result.courses[0]!.status, "failed");
    assert.match(result.courses[0]!.error ?? "", /VLE is down/);
    assert.equal(result.courses[1]!.status, "synced");
    // Course 1's deadline must neither vanish nor be cancelled.
    assert.equal(result.deadlines.length, 1);
    assert.equal(result.deadlines[0]!.status, "confirmed");
  } finally {
    await t.cleanup();
  }
});

test("an expired token stops the sync with invalid_token", async () => {
  const t = await setup();
  try {
    t.vle.tokenExpired = true;
    await assert.rejects(t.run(), (error: unknown) => error instanceof VleError && error.code === "invalid_token");
  } finally {
    await t.cleanup();
  }
});

test("a deadline that moves is reported, kept in history, and the calendar follows", async () => {
  const t = await setup();
  try {
    await t.run();
    t.vle.assignments.set(1, [{ id: 5, title: "Coursework 1 (20%)", due: "2026-12-21T10:00:00Z" }]);
    const result = await t.run(LATER);
    assert.ok(result.changes.some((l) => l.includes("due moved 14 Dec 10:00 → 21 Dec 10:00")), result.changes.join("\n"));
    const d = result.deadlines[0]!;
    assert.equal(d.due?.iso, "2026-12-21T10:00:00.000Z");
    assert.deepEqual(d.history.map((h) => h.field), ["added", "due"]);
    assert.match(await read(t.path("Deadlines.ics")), /SEQUENCE:2/);
    const changes = await read(t.path("Changes.md"));
    assert.ok(changes.indexOf("2026-10-19") < changes.indexOf("2026-10-16"), "newest section first");
  } finally {
    await t.cleanup();
  }
});

test("a deadline removed from the VLE is cancelled, but a switched-off course keeps its deadlines", async () => {
  const t = await setup();
  try {
    await t.run();
    // Turn course 1 off in state.json: its deadline must survive an empty sync of it.
    await writeFile(t.path(".crawler", "state.json"), JSON.stringify({ version: 1, lastSync: null, courses: { "TST101U 2026/27": { enabled: false } } }));
    t.vle.assignments.set(1, []);
    const off = await t.run(LATER);
    assert.equal(off.courses[0]!.status, "skipped");
    assert.equal(off.deadlines[0]!.status, "confirmed");

    await writeFile(t.path(".crawler", "state.json"), JSON.stringify({ version: 1, lastSync: null, courses: {} }));
    const on = await t.run(new Date("2026-10-20T09:00:00Z"));
    assert.equal(on.deadlines[0]!.status, "cancelled");
    assert.ok(on.changes.some((l) => l.includes("removed from QMplus")));
  } finally {
    await t.cleanup();
  }
});

test("a hostile file name cannot write outside the folder", async () => {
  const t = await setup();
  try {
    t.vle.files.set(1, [{ id: 30, name: "..\\..\\..\\evil.pdf", content: "x", modified: "2026-09-25T10:00:00Z", activity: "Week 1 lecture slides" }]);
    await t.run();
    const outside = join(t.root, "..", "evil.pdf");
    assert.equal(await exists(outside), false);
    for (const e of await t.manifest()) assert.ok(!e.localPath.includes(".."));
  } finally {
    await t.cleanup();
  }
});

const EXTENDED = "Coursework 1 deadline has been extended to 21 December 2026 at 12:00 for everyone in the module.";

test("an announcement that extends a deadline shows as a conflict, with a notification", async () => {
  const t = await setup();
  try {
    const first = await t.run();
    assert.equal(first.deadlines[0]!.status, "confirmed");
    assert.deepEqual(first.courses[0]!.text, { sources: 0, candidates: 0, verified: 0, rejected: 0, adjusted: 0, aiRuns: 0, aiMs: 0 });
    // First sync: one summary event, then the files line.
    assert.deepEqual(first.notifications.map((n) => [n.kind, n.title]), [
      ["new-deadline", "Found 1 deadline in 1 module"],
      ["files-summary", "3 new files in 2 modules"],
    ]);

    t.vle.announcements.set(1, [{ id: 7, subject: "Coursework 1", body: EXTENDED }]);
    const result = await t.run(LATER);
    assert.deepEqual(result.courses[0]!.text, { sources: 1, candidates: 1, verified: 1, rejected: 0, adjusted: 0, aiRuns: 0, aiMs: 0 });
    const d = result.deadlines[0]!;
    assert.equal(d.status, "conflict");
    assert.equal(d.due?.iso, "2026-12-14T10:00:00.000Z");
    assert.deepEqual(d.sources.map((s) => s.type), ["vle-field", "announcement"]);
    assert.ok(result.changes.some((l) => l.includes("conflict: sources disagree (14 Dec 10:00 vs 21 Dec 12:00)")), result.changes.join("\n"));
    assert.deepEqual(result.notifications.map((n) => [n.kind, n.deadlineId]), [["new-conflict", d.id]]);
    assert.equal(result.notifications[0]!.sourceUrl, `${CREDENTIALS.site}/mod/assign/view.php?id=5`);

    const saved = JSON.parse(await read(t.path("Deadlines.json"))) as Deadline[];
    assert.equal(saved[0]!.status, "conflict");
    assert.deepEqual(JSON.parse(await read(t.path(".crawler", "rejected.json"))), []);
  } finally {
    await t.cleanup();
  }
});

test("a deadline only an announcement mentions is added and notified", async () => {
  const t = await setup();
  try {
    await t.run();
    t.vle.announcements.set(1, [{ id: 8, subject: "Exam", body: "Remember that the final exam takes place on 12 January 2027 at 10:00 in the main hall." }]);
    const result = await t.run(LATER);
    assert.equal(result.deadlines.length, 2);
    const exam = result.deadlines.find((d) => d.id.includes(":text:"))!;
    assert.match(exam.id, /^tst:TST101U:text:/);
    assert.deepEqual(result.notifications.map((n) => [n.kind, n.title]), [["new-deadline", "TST101U · Final exam"]]);
    assert.ok(result.changes.some((l) => l.includes("Final exam — new deadline, due 12 Jan 10:00")), result.changes.join("\n"));
    assert.equal(result.courses[0]!.deadlines, 2);

    // Still there on the next sync even though the VLE never lists it.
    const again = await t.run(new Date("2026-10-22T09:00:00Z"));
    assert.equal(again.deadlines.length, 2);
    assert.deepEqual(again.notifications, []);
  } finally {
    await t.cleanup();
  }
});

test("a failing text step keeps the VLE deadlines and does not fail the course", async () => {
  const t = await setup();
  try {
    const broken: AiRunner = {
      available: async () => {
        throw new Error("the AI tool crashed");
      },
      structured: async () => assert.fail("not called"),
    };
    const result = await t.run(NOW, { ai: broken });
    assert.equal(result.courses[0]!.status, "synced");
    assert.equal(result.courses[0]!.text, undefined);
    assert.equal(result.courses[0]!.textError, "the AI tool crashed");
    assert.equal(result.courses[0]!.files.new, 2);
    assert.equal(result.deadlines.length, 1);
    assert.equal(result.deadlines[0]!.status, "confirmed");
  } finally {
    await t.cleanup();
  }
});

test("textDeadlines: false leaves the VLE deadlines alone", async () => {
  const t = await setup();
  try {
    t.vle.announcements.set(1, [{ id: 7, subject: "Coursework 1", body: EXTENDED }]);
    const result = await t.run(NOW, { textDeadlines: false });
    assert.equal(result.courses[0]!.text, undefined);
    assert.equal(result.deadlines[0]!.status, "confirmed");
    assert.equal(await exists(t.path(".crawler", "rejected.json")), false);
  } finally {
    await t.cleanup();
  }
});

test("downloaded text documents are read for deadlines in the same sync", async () => {
  const t = await setup();
  try {
    t.vle.files.set(1, [{ id: 40, name: "Brief.txt", content: "The lab test is due on 3 December 2026 at 16:00 and counts for 10% of the module.", modified: "2026-09-25T10:00:00Z", activity: "Assessment brief" }]);
    const result = await t.run();
    const lab = result.deadlines.find((d) => d.id.includes(":text:"))!;
    assert.equal(lab.sources[0]!.type, "document");
    assert.match(lab.sources[0]!.localPath ?? "", /Brief\.txt$/);
    assert.equal(lab.due?.iso, "2026-12-03T16:00:00.000Z");
    assert.equal(result.courses[0]!.text?.sources, 1);
  } finally {
    await t.cleanup();
  }
});

test("lecture captions become transcripts once, are not read for deadlines, and count as new files", async () => {
  const t = await setup();
  try {
    const recordings: VleItem = {
      kind: "external-tool", toolName: "EchoVideo (Q-Review) Lecture Recordings", instance: 42, section: "Recordings", sectionIndex: 0,
      activity: "EchoVideo (Q-Review) Lecture Recordings", activityType: "lti", activityId: 70, activityUrl: `${CREDENTIALS.site}/mod/lti/view.php?id=70`,
    };
    const listItems = t.vle.listItems.bind(t.vle);
    t.vle.listItems = async (c, k) => (k.id === 1 ? [...(await listItems(c, k)), recordings] : listItems(c, k));
    Object.assign(t.vle, { ltiLaunch: async () => ({ endpoint: "https://echo.example/lti/1", fields: new URLSearchParams() }) });
    const section = "11111111-1111-1111-1111-111111111111";
    let captionRequests = 0;
    const transcriptFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/lti/")) return new Response(`<title>Class List</title> section/${section}`);
      if (url.endsWith("/syllabus")) {
        return Response.json({ data: [{ lesson: { lesson: { id: "l1", displayName: "Lecture 1" }, startTimeUTC: "2026-09-22T09:00:00Z", medias: [{ id: "m1", isAvailable: true }] } }] });
      }
      captionRequests++;
      return new Response("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nThe exam is on 12 January 2027 at 10:00.\n", { headers: { "content-type": "text/vtt" } });
    }) as typeof fetch;

    const first = await t.run(NOW, { transcriptFetch, transcriptPauseMs: 0 });
    const tst = first.courses.find((c) => c.shortname.startsWith("TST101U"))!;
    assert.equal(tst.transcripts?.added, 1);
    const saved = await readdir(t.path("2026-27", "TST101U - Testing Basics", "Course Materials", "Transcripts"));
    assert.deepEqual(saved, ["01 - Lecture 1 (2026-09-22).txt"]);
    assert.ok(first.changes.some((line) => /1 new lecture transcript in Transcripts\//.test(line)));
    assert.ok(!first.deadlines.some((d) => d.kind === "exam"), "spoken dates are not turned into deadlines");

    const second = await t.run(LATER, { transcriptFetch, transcriptPauseMs: 0 });
    assert.equal(second.courses.find((c) => c.shortname.startsWith("TST101U"))!.transcripts?.added, 0);
    assert.equal(captionRequests, 1);

    const off = await t.run(LATER, { transcriptFetch, transcripts: false });
    assert.equal(off.courses.find((c) => c.shortname.startsWith("TST101U"))!.transcripts, undefined);
  } finally {
    await t.cleanup();
  }
});
