import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUpdater, downloadUpdate, installArgs, isNewer, MANUAL_UPDATE, RELEASES_PAGE, removeOldInstallers, updateFrom } from "../shell/updates.mjs";

const bytes = Buffer.from("a pretend installer");
const sha = createHash("sha256").update(bytes).digest("hex");
const asset = (version, extra = {}) => ({
  name: `Study-Hub-${version}-win-x64.exe`, size: bytes.length, digest: `sha256:${sha}`,
  browser_download_url: `https://github.com/Zemodeler/crawler/releases/download/v${version}/Study-Hub-${version}-win-x64.exe`, ...extra,
});
const release = (version, extra = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [asset(version)], ...extra });

test("versions compare numerically and odd tags are never newer", () => {
  assert.equal(isNewer("v1.0.4", "1.0.3"), true);
  assert.equal(isNewer("v1.0.10", "1.0.9"), true);
  assert.equal(isNewer("v2.0.0", "1.9.9"), true);
  assert.equal(isNewer("v1.0.3", "1.0.3"), false);
  assert.equal(isNewer("v1.0.2", "1.0.3"), false);
  assert.equal(isNewer("v1.1.0-beta", "1.0.3"), false);
  assert.equal(isNewer("latest", "1.0.3"), false);
});

test("an update needs a newer published release with this machine's installer and its checksum", () => {
  const update = updateFrom(release("1.0.4"), { version: "1.0.3", arch: "x64" });
  assert.deepEqual(update, { version: "1.0.4", name: "Study-Hub-1.0.4-win-x64.exe", url: asset("1.0.4").browser_download_url, size: bytes.length, sha256: sha });
  assert.equal(updateFrom(release("1.0.3"), { version: "1.0.3", arch: "x64" }), null);
  assert.equal(updateFrom(release("1.0.4", { draft: true }), { version: "1.0.3", arch: "x64" }), null);
  assert.equal(updateFrom(release("1.0.4", { prerelease: true }), { version: "1.0.3", arch: "x64" }), null);
  assert.equal(updateFrom(release("1.0.4"), { version: "1.0.3", arch: "arm64" }), null);
  assert.equal(updateFrom(release("1.0.4", { assets: [asset("1.0.4", { digest: null })] }), { version: "1.0.3", arch: "x64" }), null);
  assert.equal(updateFrom(release("1.0.4", { assets: [asset("1.0.4", { browser_download_url: "https://example.org/x.exe" })] }), { version: "1.0.3", arch: "x64" }), null);
  assert.equal(updateFrom(null, { version: "1.0.3", arch: "x64" }), null);
});

test("a download is kept only when its size and checksum match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studyhub-updates-"));
  const update = updateFrom(release("1.0.4"), { version: "1.0.3", arch: "x64" });
  let fetched = 0;
  const serve = (body) => async () => { fetched++; return new Response(body); };

  const path = await downloadUpdate({ fetch: serve(bytes), update, dir, version: "1.0.3" });
  assert.equal(path, join(dir, "Study-Hub-1.0.4-win-x64.exe"));
  assert.deepEqual(readFileSync(path), bytes);
  // A verified earlier download is reused without fetching again.
  await downloadUpdate({ fetch: serve(bytes), update, dir, version: "1.0.3" });
  assert.equal(fetched, 1);

  const other = mkdtempSync(join(tmpdir(), "studyhub-updates-"));
  const tampered = Buffer.from("a pretend installeR");
  await assert.rejects(downloadUpdate({ fetch: serve(tampered), update, dir: other, version: "1.0.3" }), /checksum/);
  await assert.rejects(downloadUpdate({ fetch: serve(bytes.subarray(1)), update, dir: other, version: "1.0.3" }), /incomplete/);
  await assert.rejects(downloadUpdate({ fetch: serve(Buffer.concat([bytes, bytes])), update, dir: other, version: "1.0.3" }), /larger/);
  await assert.rejects(downloadUpdate({ fetch: async () => new Response("no", { status: 404 }), update, dir: other, version: "1.0.3" }), /404/);
  assert.deepEqual(readdirSync(other), [], "nothing unverified is left behind");
});

test("old installers are removed, other files are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studyhub-updates-"));
  for (const name of ["Study-Hub-1.0.3-win-x64.exe", "Study-Hub-1.0.4-win-x64.exe", "Study-Hub-1.0.5-win-x64.exe.part", "notes.txt"]) writeFileSync(join(dir, name), "x");
  await removeOldInstallers(dir, "Study-Hub-1.0.4-win-x64.exe");
  assert.deepEqual(readdirSync(dir).sort(), ["Study-Hub-1.0.4-win-x64.exe", "notes.txt"]);
});

test("the installer runs silently as an update into this copy's folder, with /D= last", () => {
  const exe = "C:\\Users\\Sam Smith\\AppData\\Local\\Programs\\Study Hub\\Study Hub.exe";
  assert.deepEqual(installArgs(exe, { relaunch: true }), ["/S", "--updated", "--force-run", "/D=C:\\Users\\Sam Smith\\AppData\\Local\\Programs\\Study Hub"]);
  assert.deepEqual(installArgs(exe, { relaunch: false }), ["/S", "--updated", "/D=C:\\Users\\Sam Smith\\AppData\\Local\\Programs\\Study Hub"]);
});

function fakeApp(userData, { packaged = true } = {}) {
  const calls = { quit: 0 };
  return {
    calls,
    app: {
      isPackaged: packaged,
      getVersion: () => "1.0.3",
      getPath: (name) => (name === "userData" ? userData : "C:\\Apps\\Study Hub\\Study Hub.exe"),
      quit: () => calls.quit++,
    },
  };
}

test("a ready update asks to restart, installs and quits; Later installs on quit without reopening", async () => {
  const userData = mkdtempSync(join(tmpdir(), "studyhub-userdata-"));
  const { app, calls } = fakeApp(userData);
  const spawned = [];
  const answers = [1, 0];
  const asked = [];
  const window = { isVisible: () => true, isDestroyed: () => false };
  let busy = false;
  const fetch = async (url) => (String(url).startsWith("https://api.github.com/") ? Response.json(release("1.0.4")) : new Response(bytes));
  const updater = createUpdater({
    app, fetch, platform: "win32", arch: "x64", window: () => window, busy: () => busy, log: () => {},
    dialog: {
      showMessageBox: async (...args) => {
        const options = args.at(-1);
        if (options.message === "Study Hub is busy") return { response: 0 };
        asked.push(options);
        return { response: answers.shift() ?? 1 };
      },
    },
    spawn: (file, args, options) => { spawned.push({ file, args, options }); return { unref() {} }; },
  });
  assert.equal(updater.enabled, true);

  // First answer: Later. Nothing installs yet, and it is not asked twice.
  const state = await updater.check();
  assert.equal(state.state, "ready");
  assert.equal(state.version, "1.0.4");
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /1\.0\.4 is ready/);
  await updater.check();
  assert.equal(asked.length, 1);
  assert.equal(spawned.length, 0);
  assert.ok(existsSync(join(userData, "updates", "Study-Hub-1.0.4-win-x64.exe")));

  // During a sync, restarting is refused.
  busy = true;
  updater.restartNow();
  assert.equal(spawned.length, 0);
  busy = false;

  // A manual check asks again; second answer: Restart now.
  await updater.check({ manual: true });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, join(userData, "updates", "Study-Hub-1.0.4-win-x64.exe"));
  assert.deepEqual(spawned[0].args, ["/S", "--updated", "--force-run", "/D=C:\\Apps\\Study Hub"]);
  assert.equal(spawned[0].options.windowsVerbatimArguments, true);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(calls.quit, 1);
  // Quitting after that does not start a second installer.
  updater.installOnQuit();
  assert.equal(spawned.length, 1);

  // A second copy that chose Later installs on quit, without --force-run.
  const second = fakeApp(mkdtempSync(join(tmpdir(), "studyhub-userdata-"))).app;
  const quietSpawned = [];
  const quiet = createUpdater({
    app: second, fetch, platform: "win32", arch: "x64", window: () => window, log: () => {},
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    spawn: (file, args) => { quietSpawned.push(args); return { unref() {} }; },
  });
  await quiet.check();
  quiet.installOnQuit();
  assert.deepEqual(quietSpawned, [["/S", "--updated", "/D=C:\\Apps\\Study Hub"]]);
});

test("a hidden window gets a notification instead of a dialog", async () => {
  const { app } = fakeApp(mkdtempSync(join(tmpdir(), "studyhub-userdata-")));
  const shown = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on() {}
    show() { shown.push(this.options); }
  }
  const updater = createUpdater({
    app, Notification: FakeNotification, platform: "win32", arch: "x64", log: () => {},
    window: () => ({ isVisible: () => false }),
    fetch: async (url) => (String(url).startsWith("https://api.github.com/") ? Response.json(release("1.0.4")) : new Response(bytes)),
    dialog: { showMessageBox: async () => assert.fail("no dialog over a hidden window") },
    spawn: () => assert.fail("nothing installs without the student"),
  });
  await updater.check();
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /1\.0\.4 is ready/);
});

test("no newer release, a failed check and an unpackaged copy are all reported plainly", async () => {
  const messages = [];
  const dialog = { showMessageBox: async (options) => { messages.push(options); return { response: 0 }; } };
  const spawn = () => assert.fail("must not install");

  const current = createUpdater({ app: fakeApp(mkdtempSync(join(tmpdir(), "studyhub-userdata-"))).app, dialog, spawn, platform: "win32", log: () => {}, fetch: async () => Response.json(release("1.0.3")) });
  assert.equal((await current.check({ manual: true })).state, "idle");
  assert.match(messages.at(-1).message, /1\.0\.3 is the newest version/);

  const offline = createUpdater({ app: fakeApp(mkdtempSync(join(tmpdir(), "studyhub-userdata-"))).app, dialog, spawn, platform: "win32", log: () => {}, fetch: async () => { throw new Error("offline"); } });
  assert.equal((await offline.check({ manual: true })).state, "failed");
  assert.match(messages.at(-1).message, /could not check/);

  const dev = createUpdater({ app: fakeApp("unused", { packaged: false }).app, dialog, spawn, platform: "win32", log: () => {}, fetch: async () => assert.fail("no network when updates are off") });
  assert.equal(dev.enabled, false);
  dev.start();
  await dev.check({ manual: true });
  assert.equal(messages.at(-1).detail, MANUAL_UPDATE);
  assert.ok(MANUAL_UPDATE.includes(RELEASES_PAGE));
  assert.match(MANUAL_UPDATE, /library and Study Hub application data are kept/);

  const mac = createUpdater({ app: fakeApp("unused").app, dialog, spawn, platform: "darwin", log: () => {}, fetch: async () => assert.fail("no network on macOS") });
  assert.equal(mac.enabled, false);
});
