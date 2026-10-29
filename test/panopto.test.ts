import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPanoptoClient, PANOPTO_SITES, panoptoRefs, srtToText } from "../src/adapters/panopto.ts";
import { syncTranscripts } from "../src/transcripts.ts";
import type { TranscriptOptions } from "../src/transcripts.ts";
import type { UniversityAdapter, VleItem } from "../src/types.ts";

const site = "https://panopto.example";
const folder = "aaaaaaaa-0000-0000-0000-000000000001";
const d = (n: number) => `dddddddd-0000-0000-0000-00000000000${n}`;
const srt = "1\n00:00:02,160 --> 00:00:05,760\n[Auto-generated transcript. Edits may have been applied for clarity.]\nWelcome back.\n\n2\n00:00:05,760 --> 00:00:07,000\n<i>Welcome back.</i>\nToday: graphs\n";
const placement: Placement = { section: "Week 1", sectionIndex: 0, activity: "Recordings", activityType: "Link", activityId: 9, activityUrl: "https://vle.example/topic/9" };
type Placement = Omit<Extract<VleItem, { kind: "link" }>, "kind" | "target">;

/** A fake Panopto site: folder sessions d1, d2 (d2 without captions), d3 linked singly. */
function fakeSite(seen: { url: string; init?: RequestInit }[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    seen.push({ url: url.href, init });
    if (url.pathname.endsWith("/GetSessions")) {
      const { queryParameters } = JSON.parse(String(init?.body));
      if (queryParameters.folderID !== folder) return Response.json({ d: { Results: [] } });
      return Response.json({ d: { Results: [
        { DeliveryID: d(2).toUpperCase(), SessionName: "Lecture 2", StartTime: "/Date(1790935200000)/", HasCaptions: false },
        { DeliveryID: d(1), SessionName: "Lecture 1", StartTime: "/Date(1790330400000)/", HasCaptions: true },
        { DeliveryID: "not-a-guid" },
      ] } });
    }
    if (url.pathname.endsWith("/DeliveryInfo.aspx")) {
      const id = new URLSearchParams(String(init?.body)).get("deliveryId");
      if (id === d(4)) return Response.json({ ErrorCode: 5, ErrorMessage: "This session link is invalid.", LoginRedirect: false });
      return Response.json({ Delivery: { SessionName: `Single ${id}`, SessionStartTime: 13434627842.965, HasCaptions: true,
        AvailableCaptions: [{ Language: 1 }], AvailableLanguages: [1] } });
    }
    if (url.pathname.endsWith("/GenerateSRT.ashx")) return new Response(url.searchParams.get("language") === "1" ? srt : "", { headers: { "content-type": "text/plain" } });
    return new Response("not found", { status: 404 });
  };
}

test("finds folder and recording ids only in links to the Panopto site", () => {
  const html = `<a href="${site}/Panopto/Pages/Sessions/List.aspx#folderID=%22${folder.toUpperCase()}%22">all</a>
    <iframe src="${site}/Panopto/Pages/Embed.aspx?id=${d(3)}&amp;autoplay=false"></iframe>
    <a href="${site}/Panopto/Pages/Viewer.aspx?pid=${d(5)}">public id</a>
    <a href="https://elsewhere.example/Panopto/Pages/Viewer.aspx?id=${d(6)}">other</a>`;
  assert.deepEqual(panoptoRefs(html, site), { folders: [folder], deliveries: [d(3)] });
  assert.deepEqual(panoptoRefs(`${site}/Panopto/Pages/Viewer.aspx?start=10&id=${d(7)}`, site).deliveries, [d(7)]);
  assert.equal(PANOPTO_SITES.surrey, "https://surrey.cloud.panopto.eu");
});

test("SRT conversion drops numbering, timings, tags, the auto-caption notice and repeats", () => {
  assert.equal(srtToText(`${String.fromCharCode(0xfeff)}${srt.replace(/\n/g, "\r\n")}`), "Welcome back.\nToday: graphs");
});

test("client sends cookies only to the site, never follows redirects and types its errors", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const client = createPanoptoClient({ site, cookies: ".ASPXAUTH=secret", pauseMs: 0, fetch: async (input, init) => {
    seen.push({ url: String(input), init });
    return new Response(null, { status: 302, headers: { location: "/Panopto/Pages/Auth/Login.aspx" } });
  } });
  await assert.rejects(client.sessions(folder), { name: "PanoptoError", message: "sessions: 302" });
  assert.equal(new Headers(seen[0]!.init!.headers).get("cookie"), ".ASPXAUTH=secret");
  assert.equal(seen[0]!.init!.redirect, "manual");
  await assert.rejects(client.delivery(d(1)), { message: "delivery: 302" });
  await assert.rejects(client.captionsSrt(d(1), 1), { message: "captions: 302" });
  const thrown = createPanoptoClient({ site, fetch: async () => { throw new Error("secret detail"); } });
  await assert.rejects(thrown.sessions(folder), (error: Error) => error.message === "sessions: 0");
  const offsite = createPanoptoClient({ site: "not a url", fetch: async () => assert.fail("must not fetch") });
  await assert.rejects(offsite.captionsSrt(d(1), 1), { message: "captions: 0" });
});

test("client reads sessions oldest first, delivery info and captions", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const client = createPanoptoClient({ site, pauseMs: 0, fetch: fakeSite(seen) });
  assert.deepEqual(await client.sessions(folder), [
    { deliveryId: d(1), title: "Lecture 1", startUtc: "2026-09-25T10:00:00.000Z", hasCaptions: true },
    { deliveryId: d(2), title: "Lecture 2", startUtc: "2026-10-02T10:00:00.000Z", hasCaptions: false },
  ]);
  assert.equal(seen[0]!.init!.method, "POST");
  const delivery = await client.delivery(d(3));
  assert.equal(delivery?.title, `Single ${d(3)}`);
  assert.deepEqual(delivery?.languages, [1]);
  assert.match(delivery!.startUtc!, /^2026-09-23T/);
  assert.equal(await client.delivery(d(4)), null);
  assert.equal(await client.captionsSrt(d(1), 1), srt);
  assert.equal(await client.captionsSrt(d(1), 0), null);
});

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "crawler-panopto-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: { url: string; init?: RequestInit }[] = [];
  const items: VleItem[] = [
    { kind: "link", target: `${site}/Panopto/Pages/Sessions/List.aspx#folderID="${folder}"`, ...placement },
    { kind: "page", html: `<iframe src="${site}/Panopto/Pages/Embed.aspx?id=${d(3)}"></iframe><a href="${site}/Panopto/Pages/Viewer.aspx?id=${d(1)}">again</a>`, files: [], ...placement },
    { kind: "announcement", id: 1, subject: "Recording", bodyHtml: `<a href="${site}/Panopto/Pages/Viewer.aspx?id=${d(4)}">gone</a>`, posted: 0, url: "https://vle.example/news/1" },
    // Brightspace has no ltiLaunch: an LTI quicklink is not an Echo360 launch.
    { kind: "external-tool", toolName: "Lecture recordings", instance: 3, ...placement },
  ];
  const options: TranscriptOptions = {
    root, now: new Date("2026-10-16T12:00:00Z"), manifest: new Map(), items, pauseMs: 0,
    credentials: { site: "https://vle.example", token: "", privateToken: null, cookies: "d2lSessionVal=vle-secret" },
    course: { id: 1, shortname: "COM1001", fullname: "Testing", startdate: null, enddate: null, url: "https://vle.example/d2l/home/1" },
    placement: { code: "COM1001", title: "Testing", folder: "COM1001 - Testing", year: "2026-27", isModule: true },
    adapter: { id: "surrey" } as unknown as UniversityAdapter,
    panopto: { site, cookies: ".ASPXAUTH=panopto-secret" },
    fetch: fakeSite(seen),
  };
  return { options, seen };
}

test("writes Panopto transcripts once, in lecture order, with the viewer link and no secrets", async (t) => {
  const { options, seen } = await setup(t);
  const result = await syncTranscripts(options);
  assert.deepEqual(result.added.map((path) => path.split("/").slice(-1)[0]), [
    "01 - Lecture 1 (2026-09-25).txt", `03 - Single ${d(3)} (2026-09-23).txt`,
  ]);
  assert.equal(result.skippedNoCaptions, 1); // d4 is not viewable; d2 has no captions and is not fetched
  assert.equal(result.failed, 0);
  assert.ok(seen.every((r) => r.url.startsWith(`${site}/`)));
  assert.ok(seen.every((r) => !String(new Headers(r.init?.headers).get("cookie")).includes("vle-secret")));
  assert.ok(!seen.some((r) => r.url.includes(d(2))));
  const entry = options.manifest.get(`panopto:${d(1)}`)!;
  assert.equal(entry.category, "Transcripts"); assert.equal(entry.categoryReason, "panopto captions");
  assert.equal(entry.sourceUrl, `${site}/Panopto/Pages/Viewer.aspx?id=${d(1)}`);
  const content = await readFile(join(options.root, entry.localPath), "utf8");
  assert.equal(content, `Lecture 1\n2026-09-25\nFrom the Panopto captions of this recording\n${entry.sourceUrl}\n\nWelcome back.\nToday: graphs\n`);
  assert.ok(!content.includes("secret"));
  assert.deepEqual(await readdir(join(options.root, ".crawler", "tmp")), []);
  const before = seen.length;
  const again = await syncTranscripts(options);
  assert.deepEqual(again.added, []);
  // Only the listing and the unviewable d4 are asked again; saved recordings are final.
  assert.ok(seen.slice(before).every((r) => !r.url.includes("GenerateSRT")));
});

test("Panopto failures are isolated and maxNew caps attempts", async (t) => {
  const { options } = await setup(t);
  const original = options.fetch!;
  options.fetch = async (input, init) => {
    if (String(input).endsWith("/GetSessions")) return new Response("busy", { status: 503 });
    return original(input, init);
  };
  const result = await syncTranscripts(options);
  assert.equal(result.failed, 1); assert.equal(result.error, "sessions: 503");
  assert.equal(result.added.length, 2); // d3 and d1, linked singly, still synced
  const capped = await setup(t);
  capped.options.maxNew = 1;
  assert.equal((await syncTranscripts(capped.options)).added.length, 1);
  const none = await setup(t);
  delete none.options.panopto;
  assert.deepEqual(await syncTranscripts(none.options), { added: [], skippedNoCaptions: 0, failed: 0 });
});
