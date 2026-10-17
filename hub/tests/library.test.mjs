import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listLibrary, readTexts, resolveDeadline, resolveInside } from "../host/library.mjs";

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
          { type: "vle-field", strength: "structured", url: "https://example.org/a", quote: "Due 7 Nov", date: { iso: "2026-11-07T16:00:00", allDay: false, tz: "Europe/London" } },
          { type: "document", strength: "quoted", url: "", localPath: "2026-27/ECS505U - Software Engineering/Course Materials/Week 1.pdf", page: 4, quote: "Due 14 November", date: { iso: "2026-11-14", allDay: true, tz: "Europe/London" } },
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
