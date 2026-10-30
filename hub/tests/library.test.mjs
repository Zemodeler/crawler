import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listLibrary, readTexts, removeOwnFile, resolveDeadline, resolveInside, writeOwnFile, writeOwnNote } from "../host/library.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "studyhub-library-"));
  const moduleDir = join(root, "2026-27", "ECS505U - Software Engineering");
  mkdirSync(join(moduleDir, "Course Materials"), { recursive: true });
  writeFileSync(join(moduleDir, "Start Here.md"), "# Start here\n");
  writeFileSync(join(moduleDir, "Course Materials", "Week 1.pdf"), "%PDF-1.4");
  mkdirSync(join(root, "2025-26", "ECS401U - Procedural Programming"), { recursive: true });
  mkdirSync(join(root, ".crawler"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), "outside the modules");
  writeFileSync(
    join(root, "Deadlines.json"),
    JSON.stringify([
      {
        id: "d1", module: "ECS505U", year: "2026-27", title: "Coursework 1", kind: "coursework", status: "conflict",
        due: { iso: "2026-11-07T16:00:00", allDay: false, tz: "Europe/London" },
        sources: [
          { type: "vle-field", strength: "structured", seenAt: "2026-10-16T09:00:00Z", url: "https://example.org/a", quote: "Due 7 Nov", date: { iso: "2026-11-07T16:00:00", allDay: false, tz: "Europe/London" } },
          { type: "document", strength: "quoted", seenAt: "2026-10-16T09:00:00Z", url: "", localPath: "2026-27/ECS505U - Software Engineering/Course Materials/Week 1.pdf", page: 4, quote: "Due 14 November", date: { iso: "2026-11-14", allDay: true, tz: "Europe/London" } },
        ],
        history: [],
      },
    ]),
  );
  return root;
}

test("lists years newest first and only files inside modules", async () => {
  const root = fixture();
  const tree = await listLibrary(root);
  assert.deepEqual(tree.years.map((y) => y.year), ["2026-27", "2025-26"]);
  assert.deepEqual(tree.years[0].modules, ["ECS505U - Software Engineering"]);
  assert.deepEqual(tree.files.map((f) => f.path).sort(), [
    "2026-27/ECS505U - Software Engineering/Course Materials/Week 1.pdf",
    "2026-27/ECS505U - Software Engineering/Start Here.md",
  ]);
});

test("undated modules are listed after every dated year", async () => {
  const root = fixture();
  mkdirSync(join(root, "Undated", "COM1025 - Foundations of Computing"), { recursive: true });
  writeFileSync(join(root, "Undated", "COM1025 - Foundations of Computing", "Start Here.md"), "# Start here\n");
  mkdirSync(join(root, "Notes"), { recursive: true });
  const tree = await listLibrary(root);
  assert.deepEqual(tree.years.map((y) => y.year), ["2026-27", "2025-26", "Undated"]);
  assert.deepEqual(tree.years[2].modules, ["COM1025 - Foundations of Computing"]);
  assert.ok(tree.files.some((f) => f.path === "Undated/COM1025 - Foundations of Computing/Start Here.md"));

  // Surrey courses without a year in their name are all undated: the hub must still open them.
  const only = mkdtempSync(join(tmpdir(), "studyhub-library-"));
  mkdirSync(join(only, "Undated", "COM1025 - Foundations of Computing"), { recursive: true });
  assert.deepEqual((await listLibrary(only)).years, [{ year: "Undated", modules: ["COM1025 - Foundations of Computing"] }]);
});

test("a missing library is reported, not thrown", async () => {
  const tree = await listLibrary(join(tmpdir(), "no-such-library-folder"));
  assert.equal(tree.found, false);
});

test("paths cannot leave the library", () => {
  const root = fixture();
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/Windows/win.ini", "a\\..\\b", ".crawler/token", "", "a//b"])
    assert.equal(resolveInside(root, bad), null, bad);
  assert.ok(resolveInside(root, "2026-27/ECS505U - Software Engineering/Start Here.md"));
});

test("reads only small text files", async () => {
  const root = fixture();
  const texts = await readTexts(root, [
    "2026-27/ECS505U - Software Engineering/Start Here.md",
    "2026-27/ECS505U - Software Engineering/Course Materials/Week 1.pdf",
    "../outside.md",
  ]);
  assert.deepEqual(Object.keys(texts), ["2026-27/ECS505U - Software Engineering/Start Here.md"]);
});

test("resolving a deadline with a source's date marks it user-verified and keeps history", async () => {
  const root = fixture();
  const { deadline } = await resolveDeadline(root, { id: "d1", sourceIndex: 1 });
  assert.equal(deadline.status, "user-verified");
  assert.equal(deadline.due.iso, "2026-11-14");
  const saved = JSON.parse(readFileSync(join(root, "Deadlines.json"), "utf8"))[0];
  assert.equal(saved.status, "user-verified");
  assert.deepEqual(saved.history.map((h) => h.field), ["due", "status"]);
});

test("resolving with a typed date, and refusing bad input", async () => {
  const root = fixture();
  const { deadline } = await resolveDeadline(root, { id: "d1", date: "2026-11-20" });
  assert.deepEqual(deadline.due, { iso: "2026-11-20T00:00:00.000Z", allDay: true, tz: "Europe/London" });
  assert.ok((await resolveDeadline(root, { id: "d1", date: "next week" })).error);
  assert.ok((await resolveDeadline(root, { id: "nope", sourceIndex: 0 })).error);
});

test("the Converter may write only Study Hub's own files inside a module", async () => {
  const { readModuleFile, writeModuleFile } = await import("../host/library.mjs");
  const root = fixture();
  const moduleKey = "2026-27/ECS505U - Software Engineering";
  assert.deepEqual(await writeModuleFile(root, moduleKey, "0 - START HERE.md", "# Hub\n"), { ok: true });
  assert.deepEqual(await writeModuleFile(root, moduleKey, ".study-hub/manifest.json", "{}"), { ok: true });
  assert.equal((await readModuleFile(root, moduleKey, "0 - START HERE.md")).text, "# Hub\n");
  assert.equal((await readModuleFile(root, moduleKey, "Revision/Topic Packs/missing.md")).text, null);
  // Downloaded files, other modules, the library root and escapes are refused.
  assert.ok((await writeModuleFile(root, moduleKey, "Course Materials/Week 1.pdf", "x")).error);
  assert.ok((await writeModuleFile(root, moduleKey, "../ECS401U/0 - START HERE.md", "x")).error);
  assert.ok((await writeModuleFile(root, "2026-27", "0 - START HERE.md", "x")).error);
  assert.ok((await writeModuleFile(root, "../outside/x", "0 - START HERE.md", "x")).error);
  assert.ok((await writeModuleFile(root, "2026-27/No Such Module", "0 - START HERE.md", "x")).error);
  assert.ok((await readModuleFile(root, moduleKey, "Course Materials/Week 1.pdf")).error);
});

const MODULE = "2026-27/ECS505U - Software Engineering";
const OWN = join("2026-27", "ECS505U - Software Engineering", "Course Materials", "My Files");

test("own files are written to My Files and never overwrite", async () => {
  const root = fixture();
  assert.deepEqual(await writeOwnFile(root, MODULE, "Notes.pdf", Buffer.from("one")), { ok: true, path: "Course Materials/My Files/Notes.pdf" });
  assert.deepEqual(await writeOwnFile(root, MODULE, "Notes.pdf", Buffer.from("two")), { ok: true, path: "Course Materials/My Files/Notes (2).pdf" });
  assert.equal(readFileSync(join(root, OWN, "Notes.pdf"), "utf8"), "one");
  assert.equal(readFileSync(join(root, OWN, "Notes (2).pdf"), "utf8"), "two");
});

test("own files refuse other extensions, unsafe names and modules outside the library", async () => {
  const root = fixture();
  assert.ok((await writeOwnFile(root, MODULE, "run.exe", Buffer.from("x"))).error);
  for (const name of ["../escape.pdf", "a/b.pdf", "a\b.pdf", ".hidden.pdf", "CON.pdf", "x\u0001.pdf", `${"a".repeat(151)}.pdf`])
    assert.ok((await writeOwnFile(root, MODULE, name, Buffer.from("x"))).error, name);
  for (const dir of ["../2026-27/ECS505U - Software Engineering", "2026-27/..", "2026-27", ".crawler/x", "2026-27/Missing"])
    assert.ok((await writeOwnFile(root, dir, "ok.pdf", Buffer.from("x"))).error, dir);
  assert.equal(existsSync(join(root, "escape.pdf")), false);
});

test("own notes are created and updated under My Files/Notes", async () => {
  const root = fixture();
  const created = await writeOwnNote(root, { module: MODULE, title: "Week 1: recap", text: "# Recap\n" });
  assert.equal(created.path, "Course Materials/My Files/Notes/Week 1- recap.md");
  const again = await writeOwnNote(root, { module: MODULE, title: "Week 1: recap", text: "other" });
  assert.equal(again.path, "Course Materials/My Files/Notes/Week 1- recap (2).md");
  assert.deepEqual(await writeOwnNote(root, { module: MODULE, title: "ignored", text: "updated", path: created.path }), { ok: true, path: created.path });
  assert.equal(readFileSync(join(root, OWN, "Notes", "Week 1- recap.md"), "utf8"), "updated");
  assert.ok((await writeOwnNote(root, { module: MODULE, title: "x", text: "y", path: "Start Here.md" })).error);
  assert.ok((await writeOwnNote(root, { module: MODULE, title: "x", text: "y", path: "Course Materials/My Files/Notes/missing.md" })).error);
  assert.ok((await writeOwnNote(root, { module: MODULE, title: "x", text: "y".repeat(2 * 1024 * 1024 + 1) })).error);
});

test("removing own files refuses anything outside My Files", async () => {
  const root = fixture();
  const { path } = await writeOwnFile(root, MODULE, "Mine.txt", Buffer.from("x"));
  for (const outside of ["Course Materials/Week 1.pdf", "Start Here.md", "Course Materials/My Files/../Week 1.pdf", "../../secret.txt"])
    assert.ok((await removeOwnFile(root, { module: MODULE, path: outside })).error, outside);
  assert.ok(existsSync(join(root, "2026-27", "ECS505U - Software Engineering", "Course Materials", "Week 1.pdf")));
  assert.deepEqual(await removeOwnFile(root, { module: MODULE, path }), { ok: true });
  assert.equal(existsSync(join(root, OWN, "Mine.txt")), false);
});
