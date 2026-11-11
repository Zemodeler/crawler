/** Files attached to the assistant or an essay that are not in the library. */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS, attachmentContext, mergeAttachments, parseAttachment, readAttachment } from "../lib/attachments.ts";
import { conversationAttachments, parseChatFile } from "../lib/chat-store.ts";
import { essayBlock, newEssay, parseEssayFile } from "../lib/essay.ts";

const brief = { name: "CW2 brief.pdf", text: "Submit the report by 4 December 2026 at 17:00 on QMplus.", truncated: false };

test("a text attachment is read on this computer; unsupported or empty files say why", async () => {
  const read = await readAttachment(new File(["Deadline: 4 December 2026\r\nWeight 20%"], "brief.txt"));
  assert.deepEqual(read, { name: "brief.txt", text: "Deadline: 4 December 2026\nWeight 20%", truncated: false });
  await assert.rejects(readAttachment(new File(["x"], "virus.exe")), /choose a PDF, Word/);
  await assert.rejects(readAttachment(new File(["   "], "empty.md")), /No text could be read/);
  const long = await readAttachment(new File(["a".repeat(MAX_ATTACHMENT_CHARS + 10)], "long.md"));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, MAX_ATTACHMENT_CHARS);
});

test("attaching the same file again keeps the newest copy, and only the last few", () => {
  const files = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => ({ name: `f${i}.md`, text: String(i), truncated: false }));
  const merged = mergeAttachments([], files);
  assert.equal(merged.length, MAX_ATTACHMENTS);
  assert.equal(merged.at(-1).name, `f${MAX_ATTACHMENTS + 1}.md`);
  const again = mergeAttachments([brief], [{ ...brief, text: "new text" }]);
  assert.deepEqual(again.map((a) => a.text), ["new text"]);
});

test("attachments become citable source material marked as not in the library", () => {
  const { block, extracts, text } = attachmentContext([brief]);
  assert.match(block, /### FILE: CW2 brief\.pdf \(attached by the student; not in their library\)/);
  assert.match(block, /<untrusted_course_content/);
  assert.equal(extracts[0][0], "CW2 brief.pdf");
  assert.equal(text, brief.text);
  assert.equal(attachmentContext([]).block, "");
});

test("a conversation keeps its attachments when saved and reopened", () => {
  const file = parseChatFile({
    current: "a",
    chats: [{ id: "a", turns: [
      { role: "user", content: "Add this deadline", attachments: [brief, { name: 5 }] },
      { role: "assistant", content: "Here it is" },
      { role: "user", content: "And the rubric", attachments: [{ name: "rubric.md", text: "Criteria", savedPath: "Course Materials/My Files/rubric.md" }] },
    ] }],
  });
  const turns = file.chats[0].turns;
  assert.equal(turns[0].attachments.length, 1);
  assert.deepEqual(conversationAttachments(turns).map((a) => a.name), ["CW2 brief.pdf", "rubric.md"]);
  assert.equal(parseAttachment({ name: "x", text: 1 }), null);
});

test("an essay's attachments are saved with it and named in what the assistant reads", () => {
  const essay = newEssay({ title: "CW2", question: "Q", brief: "", wordLimit: null, due: null, hours: null, attachments: [brief] });
  assert.match(essayBlock(essay), /Files the student attached for this essay .*CW2 brief\.pdf/);
  const back = parseEssayFile(JSON.parse(JSON.stringify({ essays: [essay, { ...essay, id: "old", attachments: undefined }] })));
  assert.equal(back.essays[0].attachments[0].name, "CW2 brief.pdf");
  assert.deepEqual(back.essays[1].attachments, []);
});
