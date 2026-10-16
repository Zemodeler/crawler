import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatLibrary } from "../host/auto-format.mjs";

test("indexes synced materials, refreshes owned indexes, and preserves edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "studyhub-format-"));
  const module = join(root, "2026-27", "ECS509U - Probability and Matrices");
  const materials = join(module, "Course Materials");
  const index = join(materials, "00 - COURSE MATERIALS INDEX.md");
  await mkdir(materials, { recursive: true });
  await writeFile(join(materials, "Lecture 1.pdf"), "one");

  assert.equal((await formatLibrary(root))[0].action, "created");
  const first = await readFile(index, "utf8");
  assert.match(first, /Lecture 1/);
  assert.doesNotMatch(first, /Back to the revision hub/);

  await writeFile(join(materials, "Lecture 2.pdf"), "two");
  await writeFile(join(materials, "[Release] notes.pdf"), "three");
  assert.equal((await formatLibrary(root))[0].action, "updated");
  const refreshed = await readFile(index, "utf8");
  assert.match(refreshed, /Lecture 2/);
  assert.match(refreshed, /\[Release notes\]\(<\[Release\] notes\.pdf>\)/);

  await writeFile(index, "my notes\n");
  assert.equal((await formatLibrary(root))[0].action, "preserved");
  assert.equal(await readFile(index, "utf8"), "my notes\n");
});
