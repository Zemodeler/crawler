import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { currentAcademicYear, safeJoin, sync, VleError } from "../src/index.ts";
import type { Course, Credentials, Deadline, UniversityAdapter, VleFile, VleItem } from "../src/index.ts";

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
