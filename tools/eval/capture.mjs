// Records one live sync (VLE answers and file bytes) for offline replay with replay.mjs:
//   electron tools/eval/capture.mjs [dir] [university]
// dir defaults to out/replay; it gets capture/ (private course data: keep it under out/)
// and live-root/, the library that live sync wrote. Uses the saved Crawler sign-in;
// skips transcripts. Progress and errors go to <dir>/capture.log.
import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTokenStore } from "../../bin/electron-env.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const base = resolve(args[0] ?? join(repo, "out", "replay"));
const universityId = args[1] ?? "qmul";

app.setName("Crawler");
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  mkdirSync(base, { recursive: true });
  const log = (line) => appendFileSync(join(base, "capture.log"), `${line}\n`);
  try {
    const { getUniversity } = await import("../../src/adapters/universities.ts");
    const { sync } = await import("../../src/sync.ts");
    const tokenStore = createTokenStore({ safeStorage, dir: join(app.getPath("userData"), "tokens") });
    const adapter = getUniversity(universityId, {});
    if (!adapter) throw new Error(`Unknown university ${universityId}`);
    const credentials = await tokenStore.load(adapter.site);
    if (!credentials) throw new Error("Not signed in. Run: pnpm crawler login");
    const dir = join(base, "capture");
    mkdirSync(join(dir, "files"), { recursive: true });
    const now = new Date();
    const rec = { now: now.toISOString(), site: adapter.site, id: adapter.id, items: {} };
    const recording = {
      ...adapter,
      whoAmI: async (c) => (rec.whoAmI = await adapter.whoAmI(c)),
      listCourses: async (c) => (rec.courses = await adapter.listCourses(c)),
      listItems: async (c, course) => (rec.items[course.shortname] = await adapter.listItems(c, course)),
      download: async (c, file) => {
        const bytes = Buffer.from(await new Response(await adapter.download(c, file)).arrayBuffer());
        writeFileSync(join(dir, "files", createHash("sha1").update(file.url).digest("hex")), bytes);
        return new Response(bytes).body;
      },
    };
    delete recording.ltiLaunch;
    const result = await sync({ adapter: recording, credentials, root: join(base, "live-root"), now, transcripts: false });
    writeFileSync(join(dir, "record.json"), JSON.stringify(rec));
    log(`${now.toISOString()} captured ${result.courses.filter((c) => c.status === "synced").length} modules, ${result.deadlines.length} deadlines`);
  } catch (error) {
    log(`ERROR ${error instanceof Error ? error.stack : String(error)}`);
  }
  app.exit(0);
});
