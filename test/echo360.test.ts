import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createEcho360Client, Echo360Error } from "../src/adapters/echo360.ts";

const section = "11111111-1111-1111-1111-111111111111";
const host = "https://echo.example";
const fixture = JSON.parse(readFileSync(new URL("../spikes/echo360/fixtures/syllabus.json", import.meta.url), "utf8"));

test("launch follows same-origin redirects with cookies, parses URL section and syllabus", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createEcho360Client({ pauseMs: 0, fetch: async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (calls.length === 1) {
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: `/section/${section}/home`, "set-cookie": "session=private; Path=/; HttpOnly" } });
    }
    assert.equal(new Headers(init?.headers).get("cookie"), "session=private");
    return url.endsWith("syllabus") ? Response.json(fixture) : new Response("landing");
  } });
  assert.deepEqual(await client.launch(`${host}/lti`, new URLSearchParams({ signed: "private" })), { host, sectionId: section });
  const lessons = await client.syllabus(section);
  assert.equal(lessons.length, 2);
  assert.equal(lessons[0]?.title, "Week 1 Lecture");
  assert.equal(lessons[0]?.medias[0]?.isAvailable, true);
  assert.equal(lessons[1]?.lessonId, "22222222-2222-2222-2222-222222222222");
});

test("HTML section fallback, VTT content type, absent captions, and pacing of concurrent callers", async () => {
  const starts: number[] = [];
  const responses = [new Response(`section: '${section}'`),
    new Response("WEBVTT\n", { headers: { "content-type": "text/vtt; charset=utf-8" } }),
    new Response("login html"), new Response(null, { status: 403 }), new Response(null, { status: 404 }),
    new Response("", { headers: { "content-type": "text/vtt" } })];
  const client = createEcho360Client({ pauseMs: 20, fetch: async () => {
    starts.push(Date.now()); return responses.shift()!;
  } });
  assert.equal((await client.launch(`${host}/lti`, new URLSearchParams())).sectionId, section);
  const captions = await Promise.all(Array.from({ length: 5 }, () => client.captionsVtt("lesson", "media")));
  assert.deepEqual(captions, ["WEBVTT\n", null, null, null, null]);
  for (let n = 1; n < starts.length; n++) assert.ok(starts[n]! - starts[n - 1]! >= 15);
});

test("cross-origin redirects and network/body errors expose only stage and status", async () => {
  let calls = 0;
  const client = createEcho360Client({ pauseMs: 0, fetch: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "https://other.example/?token=private" } });
  } });
  await assert.rejects(client.launch(`${host}/?token=private`, new URLSearchParams()), (error: unknown) => {
    assert.ok(error instanceof Echo360Error); assert.equal(error.message, "launch: 302"); return true;
  });
  assert.equal(calls, 1);
  const broken = createEcho360Client({ fetch: async () => { throw new Error("private signed cookies body"); } });
  await assert.rejects(broken.launch(`${host}/lti`, new URLSearchParams()), { message: "launch: 0" });
});

test("redirect loops stop after five hops and invalid syllabus is redacted", async () => {
  let calls = 0;
  const client = createEcho360Client({ pauseMs: 0, fetch: async () => {
    calls++; return new Response(null, { status: 307, headers: { location: "/again?secret=private" } });
  } });
  await assert.rejects(client.launch(`${host}/lti`, new URLSearchParams()), { message: "launch: 307" });
  assert.equal(calls, 6);
  const invalid = createEcho360Client({ pauseMs: 0, fetch: async () => new Response(`section/${section}`) });
  await invalid.launch(`${host}/lti`, new URLSearchParams());
  await assert.rejects(invalid.syllabus(section), { message: "syllabus: 200" });
});
