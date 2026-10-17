import assert from "node:assert/strict";
import { test } from "node:test";

import { createMoodleAdapter } from "../src/adapters/moodle.ts";
import { forumRelevance, selectForumPosts, trimPostText } from "../src/forum.ts";
import type { ForumPost } from "../src/forum.ts";
import type { Course, Credentials, VleItem } from "../src/index.ts";

const post = (over: Partial<ForumPost> = {}): ForumPost => ({
  kind: "forum-post",
  id: 1,
  discussion: 1,
  forum: "Q&A",
  subject: "Hello",
  bodyHtml: "<p>Thanks!</p>",
  posted: 1791000000,
  author: "Someone",
  staff: false,
  replyTo: "",
  url: "https://vle.example/mod/forum/discuss.php?d=1",
  ...over,
});

const LONG =
  "The reason the loop is O(n log n) is that each pass halves the range, so for example with 8 items you need 3 passes. " +
  "In the lecture we drew this as a tree; the slides show the same idea with the depth labelled at each level.";

test("a staff explanation is kept, a staff thank-you is not", () => {
  assert.equal(forumRelevance(post({ staff: true, bodyHtml: `<p>${LONG}</p>` }))?.reason, "explanation");
  assert.equal(forumRelevance(post({ staff: true, bodyHtml: "<p>Thanks, see you Monday.</p>" })), null);
});

test("a student's explanation is thrown away, however long", () => {
  assert.equal(forumRelevance(post({ staff: false, bodyHtml: `<p>${LONG}</p>` })), null);
  assert.equal(forumRelevance(post({ staff: null, bodyHtml: `<p>${LONG}</p>` })), null);
});

test("an exam date is kept from anyone, verified only when staff wrote it", () => {
  const body = "<p>The final exam is on 12 January 2027 at 10:00.</p>";
  assert.deepEqual(forumRelevance(post({ staff: true, bodyHtml: body })), { reason: "exam", verified: true });
  assert.deepEqual(forumRelevance(post({ staff: false, bodyHtml: body })), { reason: "exam", verified: false });
  assert.deepEqual(forumRelevance(post({ staff: false, bodyHtml: "<p>When is the exam?</p>" })), { reason: "exam", verified: false });
});

test("a coursework deadline from staff is kept as a deadline", () => {
  const r = forumRelevance(post({ staff: true, bodyHtml: "<p>Coursework 2 is due on 3 December 2026.</p>" }));
  assert.deepEqual(r, { reason: "deadline", verified: true });
});

test("a staff reply to a question counts as an explanation", () => {
  const r = forumRelevance(post({ staff: true, replyTo: "Why does it fail?", bodyHtml: `<p>${"It fails because the input is not sorted first. ".repeat(5)}</p>` }));
  assert.equal(r?.reason, "explanation");
});

test("trimPostText drops quotes, sign-offs and overlong text", () => {
  assert.equal(trimPostText("Answer here.\n> old quoted line\nThanks,", 100), "Answer here.");
  const out = trimPostText("word ".repeat(100), 50);
  assert.ok(out.length <= 51 && out.endsWith("…"));
});

test("selectForumPosts drops irrelevant posts and keeps staff first", () => {
  const keep = post({ id: 2, url: "u2", staff: true, bodyHtml: `<p>${LONG}</p>` });
  const student = post({ id: 3, url: "u3", staff: false, subject: "exam date?", bodyHtml: "<p>When is the exam?</p>" });
  const chatter = post({ id: 4, url: "u4" });
  const announcement: VleItem = { kind: "announcement", id: 9, subject: "x", bodyHtml: "", posted: 1, url: "u9" };
  const { items, highlights } = selectForumPosts([chatter, student, announcement, keep]);
  assert.deepEqual(items.map((i) => i.kind === "forum-post" ? i.url : i.kind), ["u3", "announcement", "u2"]);
  assert.deepEqual(highlights.map((h) => h.url).sort(), ["u2", "u3"]);
  assert.equal(highlights.find((h) => h.url === "u3")?.verified, false);
});

/* ------------------------------------------------------------- adapter */

const SITE = "https://moodle.example.ac.uk";
const CREDENTIALS: Credentials = { site: SITE, token: "fake-test-token", privateToken: null };
const COURSE: Course = { id: 101, shortname: "TST101U", fullname: "TST101U Testing", startdate: null, enddate: null, url: `${SITE}/course/view.php?id=101` };
const reply = (body: unknown) => new Response(JSON.stringify(body));

test("the adapter reads every forum and its replies, and marks staff", async () => {
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = init?.body as URLSearchParams;
    switch (params.get("wsfunction")) {
      case "core_course_get_contents": return reply([]);
      case "mod_forum_get_forums_by_courses":
        return reply([{ id: 1, type: "news", name: "Announcements" }, { id: 2, type: "general", name: "Q&A" }]);
      case "mod_forum_get_forum_discussions":
        return reply({
          discussions: params.get("forumid") === "1"
            ? [{ id: 10, discussion: 100, subject: "News", message: "<p>hi</p>", created: 1, userid: 11 }]
            : [{ id: 20, discussion: 200, subject: "Help", message: "<p>I am stuck</p>", created: 2, userid: 12, userfullname: "Sam", numreplies: 1 }],
        });
      case "core_enrol_get_enrolled_users":
        return reply([{ id: 11, roles: [{ shortname: "editingteacher" }] }, { id: 12, roles: [{ shortname: "student" }] }]);
      case "mod_forum_get_discussion_posts":
        return reply({
          posts: [
            { id: 20, parentid: 0, message: "<p>I am stuck</p>", timecreated: 2, author: { id: 12, fullname: "Sam" } },
            { id: 21, parentid: 20, subject: "Re: Help", message: "<p>Sort it first.</p>", timecreated: 3, author: { id: 11, fullname: "Dr T" } },
          ],
        });
      default: return reply([]);
    }
  }) as typeof globalThis.fetch;
  const adapter = createMoodleAdapter({ id: "tst", displayName: "Test", site: SITE }, { fetch });
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  assert.equal(items.filter((i) => i.kind === "announcement").length, 1);
  const posts = items.filter((i): i is ForumPost => i.kind === "forum-post");
  assert.deepEqual(posts.map((p) => [p.id, p.staff, p.replyTo]), [[20, false, ""], [21, true, "I am stuck"]]);
  assert.equal(posts[1]!.url, `${SITE}/mod/forum/discuss.php?d=200&parent=21`);
});
