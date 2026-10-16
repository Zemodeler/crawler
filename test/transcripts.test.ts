import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { syncTranscripts, vttToText } from "../src/transcripts.ts";
import type { TranscriptOptions } from "../src/transcripts.ts";
import type { UniversityAdapter, VleItem } from "../src/types.ts";

const section = "11111111-1111-1111-1111-111111111111";
const vtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n<v Teacher>Hello</v>\n\n2\n00:00:01.000 --> 00:00:02.000\nHello\nworld\n";
const item: VleItem = { kind: "external-tool", toolName: "Q-Review", instance: 42, activity: "Recordings", activityId: 7,
  activityType: "lti", activityUrl: "https://moodle.example/mod/lti/view.php?id=7&token=private", section: "Recordings", sectionIndex: 0 };

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "crawler-transcripts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captions: string[] = [];
  const options: TranscriptOptions = {
    root, now: new Date("2026-10-16T12:00:00Z"), manifest: new Map(), items: [item], pauseMs: 0,
    credentials: { site: "https://moodle.example", token: "synthetic", privateToken: null },
    course: { id: 1, shortname: "TST101", fullname: "Testing", startdate: null, enddate: null, url: "https://moodle.example/course/1" },
    placement: { code: "TST101", title: "Testing", folder: "TST101 - Testing", year: "2026-27", isModule: true },
    adapter: { ltiLaunch: async () => ({ endpoint: "https://echo.example/lti", fields: new URLSearchParams() }) } as unknown as UniversityAdapter,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/lti")) return new Response(`section/${section}`);
      if (url.endsWith("/syllabus")) return Response.json({ data: [1, 2, 3].map((n) => ({ lesson: {
        lesson: { id: `lesson${n}`, displayName: `Lecture: ${n}` }, startTimeUTC: "2026-10-01T09:00:00Z",
        medias: [{ id: `media${n}`, isAvailable: true }],
      } })) });
      captions.push(url);
      return new Response(vtt, { headers: { "content-type": "text/vtt" } });
    },
  };
  return { options, captions };
}

test("VTT conversion drops metadata, tags and repeated lines", () => {
  assert.equal(vttToText(`${vtt}\nNOTE private\nignored\n`), "Hello\nworld");
});

test("writes ordered transcripts and manifest; preserves edits and deletions without refetching", async (t) => {
  const { options, captions } = await setup(t);
  const result = await syncTranscripts(options);
  assert.equal(result.added.length, 3);
  assert.equal(result.failed, 0);
  assert.match(result.added[0]!, /Transcripts\/01 - Lecture 1 \(2026-10-01\)\.txt$/);
  const entry = options.manifest.get("echo360:media1")!;
  const content = await readFile(join(options.root, entry.localPath), "utf8");
  assert.match(content, /^Lecture: 1\n2026-10-01\nFrom the Echo360 captions of this recording\n/);
  assert.match(content, /view.php\?id=7\n\nHello\nworld\n$/);
  assert.ok(!content.includes("private"));
  assert.equal(entry.category, "Transcripts"); assert.equal(entry.categoryReason, "echo360 captions");
  assert.equal(entry.sha256.length, 64); assert.equal(entry.writtenAt, options.now.toISOString());
  await writeFile(join(options.root, entry.localPath), "student edit");
  await rm(join(options.root, options.manifest.get("echo360:media2")!.localPath));
  assert.deepEqual((await syncTranscripts(options)).added, []);
  assert.equal(captions.length, 3);
  assert.equal(await readFile(join(options.root, entry.localPath), "utf8"), "student edit");
  assert.deepEqual(await readdir(join(options.root, ".crawler", "tmp")), []);
});

test("maxNew caps caption attempts including absent captions", async (t) => {
  const { options, captions } = await setup(t);
  options.maxNew = 1;
  assert.equal((await syncTranscripts(options)).added.length, 1);
  assert.equal(captions.length, 1);
  assert.equal((await syncTranscripts(options)).added.length, 1);
  assert.equal(captions.length, 2);
});

test("isolates failed captions and launch failures, redacting underlying errors", async (t) => {
  const { options } = await setup(t);
  const original = options.fetch!;
  options.fetch = async (input, init) => {
    if (String(input).includes("/medias/media1/")) throw new Error("private cookie");
    if (String(input).includes("/medias/media2/")) return new Response(null, { status: 404 });
    return original(input, init);
  };
  const result = await syncTranscripts(options);
  assert.equal(result.failed, 1); assert.equal(result.skippedNoCaptions, 1); assert.equal(result.added.length, 1);
  assert.equal(result.error, "captions: 0");
  options.adapter.ltiLaunch = async () => { throw new Error("signed private"); };
  const failed = await syncTranscripts(options);
  assert.equal(failed.error, "launch: 0");
  const other = await setup(t);
  assert.equal((await syncTranscripts(other.options)).added.length, 3);
});

test("skips unsupported adapters, unmatched activities and unavailable or hidden media", async (t) => {
  const { options, captions } = await setup(t);
  const adapter = options.adapter;
  options.adapter = {} as UniversityAdapter;
  assert.equal((await syncTranscripts(options)).failed, 0);
  options.adapter = adapter;
  options.items = [{ ...item, toolName: "Other", activity: "Other" }, { ...item, instance: undefined }];
  assert.equal((await syncTranscripts(options)).added.length, 0);
  options.items = [item];
  const original = options.fetch!;
  options.fetch = async (input, init) => String(input).endsWith("/syllabus")
    ? Response.json({ data: [{ lesson: { lesson: { id: "lesson" }, medias: [
      { id: "unavailable", isAvailable: false }, { id: "hidden", isHiddenDueToCaptions: true },
    ] } }] }) : original(input, init);
  assert.equal((await syncTranscripts(options)).added.length, 0);
  assert.equal(captions.length, 0);
});
