import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchForm, launchParameterNames, lessonsFromSyllabus, redactUrl, sectionFromUrl, vttToText } from "./parse.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("launchForm turns launch data into a form post", () => {
  const { endpoint, fields } = launchForm(JSON.parse(fixture("launch_data.json")));
  assert.equal(endpoint, "https://echo360.example/lti/00000000-0000-0000-0000-000000000000");
  assert.equal(fields.get("lti_message_type"), "basic-lti-launch-request");
  assert.throws(() => launchForm({}));
});

test("launchParameterNames keeps names only", () => {
  const names = launchParameterNames(JSON.parse(fixture("launch_data.json")));
  assert.ok(names.includes("oauth_signature"));
  assert.ok(!names.some((n) => n.includes("synthetic")));
});

test("sectionFromUrl finds the section uuid", () => {
  const s = sectionFromUrl("https://echo360.org.uk/section/BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb/home");
  assert.deepEqual(s, { host: "https://echo360.org.uk", sectionId: "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
  assert.equal(sectionFromUrl("https://echo360.org.uk/login").sectionId, null);
});

test("lessonsFromSyllabus reads flat and grouped rows", () => {
  const lessons = lessonsFromSyllabus(JSON.parse(fixture("syllabus.json")));
  assert.equal(lessons.length, 2);
  assert.equal(lessons[0].name, "Week 1 Lecture");
  assert.deepEqual(lessons[0].medias, [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", type: "Video", hasTranscript: true }]);
  assert.equal(lessons[1].hasVideo, false);
  assert.deepEqual(lessonsFromSyllabus({ nope: 1 }), []);
});

test("vttToText strips cues, tags and repeats", () => {
  assert.equal(vttToText(fixture("sample.vtt")), "Welcome to week one.\nToday: procedural programming.");
});

test("redactUrl keeps the origin and allowlisted route shapes only", () => {
  const id = "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  assert.equal(redactUrl(`https://echo360.org.uk/section/${id}/home?token=abc#x`), "https://echo360.org.uk/section/:id/home");
  assert.equal(redactUrl(`https://echo360.org.uk/section/opaque-secret/syllabus`), "https://echo360.org.uk/section/:id/syllabus");
  assert.equal(
    redactUrl("https://echo360.org.uk/api/ui/echoplayer/lessons/L1/medias/M1/transcript-file?format=vtt"),
    "https://echo360.org.uk/api/ui/echoplayer/lessons/:id/medias/:id/transcript-file",
  );
  assert.equal(redactUrl("https://echo360.org.uk/auth/sEcReTtOkEn/callback"), "https://echo360.org.uk/<path>");
  assert.equal(redactUrl("https://echo360.org.uk/section/x/sEcReT"), "https://echo360.org.uk/<path>");
  assert.equal(redactUrl("not a url sEcReT"), "<invalid-url>");
  for (const out of [redactUrl("https://h.example/a/sEcReT/b"), redactUrl("https://h.example/lti/sEcReT?x=sEcReT")]) {
    assert.ok(!out.includes("sEcReT"));
  }
});
