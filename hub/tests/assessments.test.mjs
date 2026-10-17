import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { addDeadline, readAssessments, readDeadlines, removeDeadline, resolveDeadline, setDeadlineDone } from "../host/library.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "studyhub-assessments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "2026-27", "ECS529U - Project"), { recursive: true });
  return root;
}
const input = { module: "ECS529U", year: "2026-27", title: "Weekly lab marking", kind: "lab", date: "2026-11-04" };

test("reads assessment breakdowns with and without Assessments.json", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await readAssessments(root), []);
  const assessments = [{ module: "ECS529U", year: "2026-27", seq: "1", type: "PRA", description: "Lab assignments", weight: 30, submission: null, resit: false, source: { url: "https://example.org", title: "Assessment" } }];
  await writeFile(join(root, "Assessments.json"), JSON.stringify(assessments));
  assert.deepEqual(await readAssessments(root), assessments);
  await writeFile(join(root, "Assessments.json"), "{}");
  assert.deepEqual(await readAssessments(root), []);
});

test("adds dated deadlines with provenance, optional fields and London local times", async (t) => {
  const root = await fixture(t);
  const { deadline } = await addDeadline(root, { ...input, weight: 12.5, formative: false, note: "Ask the demonstrator" });
  assert.match(deadline.id, /^user:ECS529U:[a-f0-9]+$/);
  assert.equal(deadline.status, "user-verified");
  assert.deepEqual(deadline.due, { iso: "2026-11-04T00:00:00.000Z", allDay: true, tz: "Europe/London" });
  assert.deepEqual(deadline.sources, []);
  assert.equal(deadline.weight, 12.5);
  assert.equal(deadline.formative, false);
  assert.equal(deadline.userNote, "Ask the demonstrator");
  assert.deepEqual(deadline.history, [{ at: deadline.history[0].at, field: "added", from: null, to: "2026-11-04T00:00:00.000Z" }]);
  assert.ok(Number.isFinite(Date.parse(deadline.history[0].at)));
  const timed = (await addDeadline(root, { ...input, date: "2026-10-20T16:30" })).deadline;
  assert.notEqual(timed.id, deadline.id);
  assert.deepEqual(timed.due, { iso: "2026-10-20T15:30:00.000Z", allDay: false, tz: "Europe/London" });
  assert.equal(Object.hasOwn(timed, "weight"), false);
  assert.deepEqual(await readDeadlines(root), [deadline, timed]);
});

test("adding and resolving use UTC Instants for BST, GMT, London midnight and the first repeated hour", async (t) => {
  const root = await fixture(t);
  for (const [date, iso] of [
    ["2026-10-20T16:30", "2026-10-20T15:30:00.000Z"],
    ["2026-11-20T16:30", "2026-11-20T16:30:00.000Z"],
    ["2026-10-20", "2026-10-19T23:00:00.000Z"],
    ["2026-11-20", "2026-11-20T00:00:00.000Z"],
    ["2026-03-29", "2026-03-29T00:00:00.000Z"],
    ["2026-03-29T00:59", "2026-03-29T00:59:00.000Z"],
    ["2026-03-29T02:00", "2026-03-29T01:00:00.000Z"],
    ["2026-03-29T16:30", "2026-03-29T15:30:00.000Z"],
    ["2026-10-25", "2026-10-24T23:00:00.000Z"],
    ["2026-10-25T01:00", "2026-10-25T00:00:00.000Z"],
    ["2026-10-25T01:30", "2026-10-25T00:30:00.000Z"],
    ["2026-10-25T01:59", "2026-10-25T00:59:00.000Z"],
    ["2026-10-25T02:00", "2026-10-25T02:00:00.000Z"],
    ["2026-10-25T16:30", "2026-10-25T16:30:00.000Z"],
  ]) {
    const due = { iso, allDay: date.length === 10, tz: "Europe/London" };
    const { deadline } = await addDeadline(root, { ...input, date });
    assert.deepEqual(deadline.due, due, `add ${date}`);
    assert.equal(deadline.history[0].to, iso);
    const resolved = await resolveDeadline(root, { id: deadline.id, date });
    assert.deepEqual(resolved.deadline.due, due, `resolve ${date}`);
    assert.equal(resolved.deadline.history.at(-2).to, iso);
    assert.deepEqual((await readDeadlines(root)).find((d) => d.id === deadline.id).due, due);
  }
});

test("adding and resolving reject the skipped UK hour without modifying deadlines", async (t) => {
  const root = await fixture(t);
  const { deadline } = await addDeadline(root, input);
  const before = await readFile(join(root, "Deadlines.json"), "utf8");
  const expected = { error: "That time does not exist in the UK: clocks go forward at 01:00 on that day." };
  for (const date of ["2026-03-29T01:00", "2026-03-29T01:30", "2026-03-29T01:59"]) {
    assert.deepEqual(await addDeadline(root, { ...input, date }), expected, `add ${date}`);
    assert.equal(await readFile(join(root, "Deadlines.json"), "utf8"), before);
    assert.deepEqual(await resolveDeadline(root, { id: deadline.id, date }), expected, `resolve ${date}`);
    assert.equal(await readFile(join(root, "Deadlines.json"), "utf8"), before);
  }
});

test("component matching leaves ambiguous deadlines unassigned", async () => {
  const page = await readFile(new URL("../app/assessments/page.tsx", import.meta.url), "utf8");
  const source = page.match(/^function componentFor\([\s\S]*?^}/m)?.[0];
  assert.ok(source);
  const componentFor = runInNewContext(`${stripTypeScriptTypes(source)}\ncomponentFor`);
  const components = [
    { type: "CWK", description: "Research report" },
    { type: "CWK", description: "Design project" },
  ];
  const deadline = { kind: "coursework", title: "Submission" };
  assert.equal(componentFor(deadline, components), -1, "type-only tie");
  assert.equal(componentFor({ ...deadline, title: "Research design" }, components), -1, "title-word tie");
  assert.equal(componentFor({ ...deadline, title: "Design submission" }, components), 1, "unique title match");
  assert.equal(componentFor(deadline, components.slice(0, 1)), 0, "single type fallback");
  assert.equal(componentFor(deadline, []), -1, "no components");
  assert.equal(componentFor({ kind: "exam", title: "Research report" }, components), -1, "unrelated exam");
});

test("invalid deadline fields do not modify the file", async (t) => {
  const root = await fixture(t);
  await addDeadline(root, input);
  const before = await readFile(join(root, "Deadlines.json"), "utf8");
  for (const patch of [
    { module: "../ECS529U" }, { module: "UNKNOWN" }, { module: 1 }, { year: "2026-28" }, { year: "2025-26" },
    { title: " " }, { title: "x".repeat(501) }, { title: 1 }, { kind: "assignment" },
    { date: "2026-02-30" }, { date: "2026-13-04" }, { date: "2026-11-04T24:00" }, { date: "2026-11-04T12:60" },
    { date: "tomorrow" }, { date: null }, { weight: -1 }, { weight: 101 }, { weight: "30" }, { weight: NaN },
    { formative: "false" }, { note: 12 }, { note: "x".repeat(4001) },
  ]) assert.ok((await addDeadline(root, { ...input, ...patch })).error, JSON.stringify(patch));
  assert.ok((await addDeadline(root, null)).error);
  assert.equal(await readFile(join(root, "Deadlines.json"), "utf8"), before);
});

test("done toggles persist for user and Crawler deadlines; only user deadlines may be removed", async (t) => {
  const root = await fixture(t);
  const crawler = { id: "qmul:1", module: "ECS529U", year: "2026-27", title: "Project", status: "confirmed", due: null, sources: [], history: [] };
  await writeFile(join(root, "Deadlines.json"), JSON.stringify([crawler]));
  const { deadline } = await addDeadline(root, input);
  for (const id of [crawler.id, deadline.id]) {
    assert.equal((await setDeadlineDone(root, { id, done: true })).deadline.done, true);
    assert.equal((await readDeadlines(root)).find((d) => d.id === id).done, true);
    assert.equal(Object.hasOwn((await setDeadlineDone(root, { id, done: false })).deadline, "done"), false);
  }
  for (const body of [{ id: crawler.id, done: 1 }, { id: "missing", done: true }, null])
    assert.ok((await setDeadlineDone(root, body)).error);
  assert.ok((await removeDeadline(root, { id: crawler.id })).error);
  assert.ok((await removeDeadline(root, { id: "user:missing" })).error);
  assert.ok((await removeDeadline(root, null)).error);
  assert.deepEqual(await removeDeadline(root, { id: deadline.id }), { ok: true });
  assert.deepEqual(await readDeadlines(root), [crawler]);
});
