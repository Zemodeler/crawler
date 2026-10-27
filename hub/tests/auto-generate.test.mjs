import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { removeModuleFile } from "../host/library.mjs";
import { AUTO_MODELS, MIN_REBUILD_DAYS, needsRun } from "../lib/auto-generate.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const lecture = (n) => ({ path: `Course Materials/Lectures/${String(n).padStart(2, "0")} - week ${n}.pdf` });
const manifest = (over = {}) => ({
  specVersion: 3,
  runId: "r",
  completedAt: NOW - 10 * DAY,
  profile: "stem",
  plan: { topics: [{ name: "Intro" }] },
  files: [],
  sourceFingerprints: [lecture(1), lecture(2)].map((f) => ({ ...f, size: 1 })),
  ...over,
});

test("automatic runs use the lighter model of each assistant", () => {
  assert.deepEqual(AUTO_MODELS, { claude: "claude-sonnet-5-5", codex: "gpt-6-luna", gemini: "" });
});

test("a module without packs, or with packs for another subject, is built", () => {
  assert.equal(needsRun(null, "stem", [lecture(1)], NOW).run, true);
  assert.equal(needsRun(manifest({ plan: { topics: [] } }), "stem", [], NOW).run, true);
  const legacy = needsRun(manifest({ profile: undefined }), "stem", [lecture(1)], NOW);
  assert.equal(legacy.run, true);
  assert.match(legacy.reason, /Law/i, "packs from before profiles were law");
});

test("new lecture files rebuild a module at most once a week; nothing new skips it", () => {
  assert.equal(needsRun(manifest(), "stem", [lecture(1), lecture(2)], NOW).run, false);
  assert.equal(needsRun(manifest(), "stem", [lecture(1), lecture(2), { path: "Course Materials/Other/notice.html" }], NOW).run, false);
  assert.equal(needsRun(manifest(), "stem", [lecture(1), lecture(2), lecture(3)], NOW).run, true);
  const recent = manifest({ completedAt: NOW - (MIN_REBUILD_DAYS - 1) * DAY });
  assert.equal(needsRun(recent, "stem", [lecture(1), lecture(2), lecture(3)], NOW).run, false);
});

test("only generated revision files can be removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "studyhub-auto-"));
  const moduleKey = "2026-27/ECS505U - Software Engineering";
  const dir = join(root, "2026-27", "ECS505U - Software Engineering");
  mkdirSync(join(dir, "Revision", "Guides"), { recursive: true });
  mkdirSync(join(dir, "Course Materials"), { recursive: true });
  writeFileSync(join(dir, "Revision", "Guides", "00 - Old.md"), "old");
  writeFileSync(join(dir, "Course Materials", "lecture.pdf"), "%PDF");
  assert.deepEqual(await removeModuleFile(root, moduleKey, "Revision/Guides/00 - Old.md"), { ok: true });
  assert.equal(existsSync(join(dir, "Revision", "Guides", "00 - Old.md")), false);
  assert.ok((await removeModuleFile(root, moduleKey, "Course Materials/lecture.pdf")).error);
  assert.ok((await removeModuleFile(root, moduleKey, "Revision/../Course Materials/lecture.pdf")).error);
  assert.equal(existsSync(join(dir, "Course Materials", "lecture.pdf")), true);
});

const own = (name, size = 1) => ({ path: `Course Materials/My Files/${name}`, file: { size } });

test("new or changed own files rebuild at once, even within the weekly wait", () => {
  const recent = manifest({
    completedAt: NOW - DAY,
    sourceFingerprints: [lecture(1), lecture(2), { path: own("Notes/week 1.md").path }].map((f) => ({ path: f.path, size: 1 })),
  });
  const base = [lecture(1), lecture(2), own("Notes/week 1.md")];
  assert.equal(needsRun(recent, "stem", base, NOW).run, false);
  const added = needsRun(recent, "stem", [...base, own("summary.pdf"), own("Notes/week 2.md")], NOW);
  assert.equal(added.run, true);
  assert.match(added.reason, /2 of your own files are new/);
  const edited = needsRun(recent, "stem", [lecture(1), lecture(2), own("Notes/week 1.md", 40)], NOW);
  assert.equal(edited.run, true);
  assert.match(edited.reason, /1 of your own files is new or changed/);
});

test("a lecture file whose size changed counts as new, under the weekly wait", () => {
  const resized = [lecture(1), { ...lecture(2), file: { size: 99 } }];
  assert.equal(needsRun(manifest(), "stem", resized, NOW).run, true);
  assert.match(needsRun(manifest(), "stem", resized, NOW).reason, /1 lecture file new or changed/);
  assert.equal(needsRun(manifest({ completedAt: NOW - DAY }), "stem", resized, NOW).run, false);
});
