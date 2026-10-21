// Replays a capture (see capture.mjs) offline into a fresh library, through the real sync:
//   node tools/eval/replay.mjs [dir] [root]
// dir defaults to out/replay (holding capture/), root to <dir>/root, which is replaced.
// No network and no sign-in: VLE answers and file bytes come from the capture.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sync } from "../../src/sync.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const base = resolve(process.argv[2] ?? join(repo, "out", "replay"));
const dir = join(base, "capture");
const rec = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
const adapter = {
  id: rec.id,
  platform: "moodle",
  displayName: "Replay",
  site: rec.site,
  login: async () => {
    throw new Error("A replay cannot sign in.");
  },
  whoAmI: async () => rec.whoAmI,
  listCourses: async () => rec.courses,
  listItems: async (_credentials, course) => rec.items[course.shortname] ?? [],
  download: async (_credentials, file) =>
    new Response(readFileSync(join(dir, "files", createHash("sha1").update(file.url).digest("hex")))).body,
};
const root = resolve(process.argv[3] ?? join(base, "root"));
rmSync(root, { recursive: true, force: true });
const result = await sync({ adapter, credentials: { site: rec.site, token: "replay" }, root, now: new Date(rec.now), transcripts: false });
console.log(`${result.deadlines.length} deadlines -> ${root}`);
