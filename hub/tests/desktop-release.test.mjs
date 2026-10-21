import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { stageRuntime } from "../build/desktop-release.mjs";
import config from "../electron-builder.config.mjs";

test("staging retains direct src imports and crawler self-reference without modifying its input", async () => {
  const outputs = fileURLToPath(new URL("../outputs/", import.meta.url));
  await mkdir(outputs, { recursive: true });
  const work = await mkdtemp(join(outputs, "desktop-test-"));
  const dist = join(work, "dist");
  await mkdir(join(dist, "server"), { recursive: true });
  await mkdir(join(dist, "client"));
  await writeFile(join(dist, "server/BUILD_ID"), "test-build");
  await writeFile(join(dist, "server/index.js"), "export default {};");
  const stage = join(work, "app");
  await stageRuntime({ destination: stage, dist });
  assert.equal(await readFile(join(dist, "server/BUILD_ID"), "utf8"), "test-build");
  assert.match(await readFile(join(stage, "hub/host/library.mjs"), "utf8"), /\.\.\/\.\.\/src\/deadline-store\.js/);
  await assert.rejects(access(join(stage, "hub/package.json")));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { readDeadlines } from './hub/host/library.mjs';
    import { sync, STATE_DIR, extractText } from 'crawler';
    import { readFile } from 'node:fs/promises';
    import { createTokenStore } from 'crawler/electron';
    import { teachingWeekAt } from 'crawler/weeks';
    import assert from 'node:assert/strict';
    assert.equal(typeof readDeadlines, 'function');
    assert.equal(typeof sync, 'function');
    assert.equal(typeof STATE_DIR, 'string');
    assert.equal(typeof createTokenStore, 'function');
    assert.equal(typeof teachingWeekAt, 'function');
    await import('pdfjs-dist/package.json', { with: { type: 'json' } });
    await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await extractText(await readFile(${JSON.stringify(fileURLToPath(new URL("../../test/fixtures/extract/handbook.pdf", import.meta.url)))}), 'handbook.pdf');
    assert.ok(pdf.pages.length > 0, 'PDF text extraction must work in the staged runtime');
  `], { cwd: stage, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stageRuntime({ destination: stage, dist }), { code: "EEXIST" });
  assert.equal(await readFile(join(stage, "hub/dist/server/BUILD_ID"), "utf8"), "test-build");
});

test("builder is unsigned, unpacked, offline for updates and preserves application data", () => {
  assert.equal(config.asar, false);
  assert.equal(config.publish, null);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.win.signAndEditExecutable, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("packaged Electron serves pages and extracts PDF text", { skip: !process.env.STUDYHUB_PACKAGED_EXE }, async () => {
  const executable = resolve(process.env.STUDYHUB_PACKAGED_EXE);
  const outputs = fileURLToPath(new URL("../outputs/", import.meta.url));
  await mkdir(outputs, { recursive: true });
  const temp = await mkdtemp(join(outputs, "desktop-smoke-"));
  const fixture = fileURLToPath(new URL("../../test/fixtures/extract/handbook.pdf", import.meta.url));
  const child = spawnSync(executable, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { startHost } from './hub/host/index.mjs';
    import { extractText } from 'crawler';
    const host = await startHost();
    try {
      for (const page of ['', 'calendar']) {
        const response = await fetch(host.url + page);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /<html/);
      }
      const pdf = await extractText(await readFile(${JSON.stringify(fixture)}), 'handbook.pdf');
      assert.ok(pdf.pages.length > 0);
      console.log('PACKAGED_RUNTIME_OK');
    } finally { host.server.close(); }
  `], {
    cwd: join(dirname(executable), "resources/app"), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TEMP: temp, TMP: temp, TMPDIR: temp, STUDYHUB_LIBRARY: join(temp, "library") },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /PACKAGED_RUNTIME_OK/);
});
