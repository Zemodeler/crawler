/**
 * The assistant's proposed changes, saved conversations, the essay
 * workspace's checks on what the model returns, and undated to-dos.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { actionDate, actionInstructions, actionsSummary, checkAction, extractActionLines } from "../lib/ai/chat-actions.ts";
import { deadlinesBlock } from "../lib/ai/chat-deadlines.ts";
import { chatTitle, MAX_SAVED_CHATS, parseChatFile, upsertChat } from "../lib/chat-store.ts";
import { locateQuote, markedSegments, newEssay, parseEssayFile, parseReadings, parseReview, wordCount } from "../lib/essay.ts";
import { isUndated, undatedTodos } from "../lib/todos.ts";

const deadline = (over = {}) => ({
  id: "qmul:ECS529U:text:abc",
  module: "ECS529U",
  year: "2026-27",
  title: "Lab sheet 1",
  kind: "lab",
  status: "tbc",
  due: null,
  sources: [],
  ...over,
});
const modules = [{ code: "ECS529U", year: "2026-27" }, { code: "ECS505U", year: "2026-27" }];

/* ------------------------------------------------------------------ actions */

test("ACTION lines are taken out of the answer; the rest of the prose is kept", () => {
  const { prose, lines } = extractActionLines(
    'I can add that for you.\n\nACTION: {"type":"mark_done","id":"x","done":true}\n`ACTION: {"type":"remove_deadline","id":"y"}`\nAnything else?',
  );
  assert.equal(prose, "I can add that for you.\n\nAnything else?");
  assert.deepEqual(lines, ['{"type":"mark_done","id":"x","done":true}', '{"type":"remove_deadline","id":"y"}']);
});

test("an add_deadline proposal is checked against the library's modules and gets a plain label", () => {
  const ok = checkAction('{"type":"add_deadline","module":"ECS529U","title":"Formative quiz","kind":"quiz","date":"2026-11-20","time":"16:00","formative":true}', [], modules);
  assert.equal(ok.state, "proposed");
  assert.equal(ok.label, 'Add "Formative quiz" to ECS529U, due Fri 20 Nov 2026, 16:00 (formative)');
  assert.equal(actionDate(ok.action), "2026-11-20T16:00");

  assert.equal(checkAction('{"type":"add_deadline","module":"XYZ999","title":"T","kind":"lab","date":"2026-11-20"}', [], modules).state, "refused");
  assert.equal(checkAction('{"type":"add_deadline","module":"ECS529U","title":"T","kind":"lab","date":"2026-02-30"}', [], modules).state, "refused");
  assert.equal(checkAction('{"type":"add_deadline","module":"ECS529U","title":"T","kind":"lab","date":"2026-11-20","time":"25:00"}', [], modules).state, "refused");
  assert.equal(checkAction('{"type":"add_deadline","module":"ECS529U","title":"T","kind":"essay","date":"2026-11-20"}', [], modules).state, "refused");
});

test("set_date, mark_done and remove only act on deadlines that exist; remove only on the student's own", () => {
  const list = [deadline(), deadline({ id: "user:ECS529U:1", title: "My task", status: "user-verified" })];
  const dated = checkAction('{"type":"set_date","id":"qmul:ECS529U:text:abc","date":"2026-11-27"}', list, modules);
  assert.equal(dated.state, "proposed");
  assert.equal(dated.label, 'Set "Lab sheet 1" (ECS529U) to Fri 27 Nov 2026');
  assert.equal(checkAction('{"type":"set_date","id":"nope","date":"2026-11-27"}', list, modules).state, "refused");
  assert.equal(checkAction('{"type":"mark_done","id":"qmul:ECS529U:text:abc","done":true}', list, modules).action.done, true);
  const sync = checkAction('{"type":"remove_deadline","id":"qmul:ECS529U:text:abc"}', list, modules);
  assert.equal(sync.state, "refused");
  assert.match(sync.error, /Mark it done instead/);
  assert.equal(checkAction('{"type":"remove_deadline","id":"user:ECS529U:1"}', list, modules).state, "proposed");
  assert.equal(checkAction("not json", list, modules).state, "refused");
  assert.equal(checkAction('{"type":"delete_everything"}', list, modules).state, "refused");
});

test("the model is told the modules it may add to and that nothing changes until Apply", () => {
  const text = actionInstructions(modules);
  assert.match(text, /ECS529U, ECS505U/);
  assert.match(text, /clicks Apply/);
});

test("what became of proposals is read back to the model on later turns", () => {
  const summary = actionsSummary([{ label: "Add X", state: "applied" }, { label: "Remove Y", state: "refused", error: "Only yours" }]);
  assert.match(summary, /Add X: applied by the student/);
  assert.match(summary, /Remove Y: refused by Study Hub \(Only yours\)/);
  assert.equal(actionsSummary([]), "");
});

test("the assistant's deadline list can carry ids so an action can name one", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  assert.doesNotMatch(deadlinesBlock([deadline()], now), /id:/);
  assert.match(deadlinesBlock([deadline()], now, { ids: true }), /id: qmul:ECS529U:text:abc/);
});

/* ------------------------------------------------------------ conversations */

test("a saved conversation becomes the open one, newest first, capped", () => {
  let file = parseChatFile(null);
  const turns = [{ role: "user", content: "What is due next week?" }, { role: "assistant", content: "Lab sheet 5." }];
  for (let i = 0; i < MAX_SAVED_CHATS + 3; i++) file = upsertChat(file, `c${i}`, turns, new Date(2026, 10, 11, 10, i));
  assert.equal(file.chats.length, MAX_SAVED_CHATS);
  assert.equal(file.current, `c${MAX_SAVED_CHATS + 2}`);
  assert.equal(file.chats[0].id, file.current);
  // An empty conversation only clears which one is open.
  assert.equal(upsertChat(file, "new", []).current, null);
  assert.equal(upsertChat(file, "new", []).chats.length, MAX_SAVED_CHATS);
});

test("a damaged chats file keeps every conversation that still parses, with its proposals", () => {
  const file = parseChatFile({
    current: "a",
    chats: [
      { id: "a", title: "", turns: [{ role: "user", content: "Add the quiz" }, { role: "assistant", content: "OK", actions: [{ label: "Add quiz", state: "applied", action: { type: "mark_done", id: "x", done: true } }, { label: 3 }] }] },
      { id: "b", turns: [{ role: "robot", content: 1 }] },
      "junk",
    ],
  });
  assert.equal(file.chats.length, 1);
  assert.equal(file.current, "a");
  assert.equal(file.chats[0].title, "Add the quiz");
  assert.equal(file.chats[0].turns[1].actions.length, 1);
  assert.equal(parseChatFile({ current: "gone", chats: [] }).current, null);
});

test("a conversation's title is its first question, cut at a word", () => {
  assert.equal(chatTitle([{ role: "user", content: "Short one" }]), "Short one");
  const long = chatTitle([{ role: "user", content: "Please take the formative lab sheet that is not in my assessments and give it a deadline" }]);
  assert.ok(long.length <= 61 && long.endsWith("…"));
});

/* ------------------------------------------------------------------- essays */

const DRAFT = "Design patterns make code easier to change.\n\nThe  observer pattern is “always” the best choice for every system. It decouples objects.";

test("a quote is found in the draft whatever its spacing, case or curly quotes", () => {
  assert.ok(locateQuote(DRAFT, 'the observer pattern is "always" the best choice'));
  assert.equal(locateQuote(DRAFT, "the singleton pattern is the best"), null);
  assert.equal(locateQuote(DRAFT, "short"), null);
});

test("review marks that quote words not in the draft are dropped and counted", () => {
  const reply = [
    "Heading for a 2:2. Support your claims.",
    'MARK: major | "The observer pattern is always the best choice for every system" | Unsupported absolute claim; qualify it and cite the lecture.',
    "MARK: minor | Words the student never wrote anywhere at all | Something",
    "MARK: strength | It decouples objects. | Clear point.",
    "MARK: urgent | It decouples objects. | Bad severity",
  ].join("\n");
  const { summary, marks, dropped } = parseReview(reply, DRAFT);
  assert.equal(summary, "Heading for a 2:2. Support your claims.");
  assert.deepEqual(marks.map((m) => m.severity), ["major", "strength"]);
  assert.equal(dropped, 2);
  const pieces = markedSegments(DRAFT, marks);
  assert.equal(pieces.map((p) => p.text).join(""), DRAFT);
  assert.equal(pieces.filter((p) => p.mark).length, 2);
});

test("a reading is only marked verified when a citation backs it", () => {
  const cited = [
    { kind: "file", sourceFile: "Reading list.pdf", evidence: "x", verdict: "verified" },
    { kind: "web", url: "https://example.org/gof", evidence: "y" },
  ];
  const reply = [
    "These will help.",
    'READING: {"title":"Lecture 4 reading","why":"Core","source":"course","file":"Reading list.pdf"}',
    'READING: {"title":"Design Patterns","author":"Gamma et al.","why":"The original","source":"web","url":"https://example.org/gof/"}',
    'READING: {"title":"Clean Architecture","why":"Wider view","source":"knowledge"}',
    'READING: {"title":"Ghost paper","why":"?","source":"web","url":"https://nowhere.example"}',
    "READING: not json",
  ].join("\n");
  const { intro, items } = parseReadings(reply, cited, true);
  assert.equal(intro, "These will help.");
  assert.deepEqual(items.map((r) => [r.title, r.verified]), [
    ["Lecture 4 reading", true],
    ["Design Patterns", true],
    ["Clean Architecture", false],
    ["Ghost paper", false],
  ]);
  // Without a real web search this turn, a web link is not confirmed.
  assert.equal(parseReadings(reply, cited, false).items[1].verified, false);
});

test("essays survive a round trip through the saved file and junk is dropped", () => {
  const essay = { ...newEssay({ title: " CW2 ", question: "Q", brief: "", wordLimit: 1500, due: "2026-12-02", hours: 12 }), text: DRAFT };
  essay.review = { summary: "s", marks: [{ quote: "It decouples objects.", comment: "c", severity: "strength" }, { quote: 1 }], dropped: 0, at: "", citations: [] };
  const file = parseEssayFile(JSON.parse(JSON.stringify({ version: 1, essays: [essay, { id: 5 }, null] })));
  assert.equal(file.essays.length, 1);
  assert.equal(file.essays[0].title, "CW2");
  assert.equal(file.essays[0].wordLimit, 1500);
  assert.equal(file.essays[0].review.marks.length, 1);
  assert.equal(wordCount(DRAFT), 21);
  assert.equal(wordCount("  "), 0);
});

/* ------------------------------------------------------------------- to-dos */

test("undated formatives are to-dos: open ones only, formative first", () => {
  const list = [
    deadline({ id: "a", title: "Formative labs", module: "ECS505U", formative: true }),
    deadline({ id: "b", title: "Coursework draft", module: "ECS505U" }),
    deadline({ id: "c", title: "Lab sheet 1", formative: true }),
    deadline({ id: "d", title: "Week 6 quiz", window: { from: { iso: "2026-11-02T00:00:00Z", allDay: true, tz: "Europe/London" }, to: { iso: "2026-11-06T00:00:00Z", allDay: true, tz: "Europe/London" } } }),
    deadline({ id: "e", title: "Done formative", formative: true, done: true }),
    deadline({ id: "f", title: "Cancelled", status: "cancelled" }),
    deadline({ id: "g", title: "Other module", module: "ECS999U" }),
    deadline({ id: "h", title: "Dated", due: { iso: "2026-11-20T16:00:00Z", allDay: false, tz: "Europe/London" } }),
  ];
  assert.deepEqual(undatedTodos(list, ["ECS505U", "ECS529U"]).map((d) => d.id), ["a", "c", "b"]);
  assert.equal(isUndated(list[3]), false);
});

/* --------------------------------------------------------------- web search */

test("the host counts a web search only when the tool returned a result", async () => {
  const { claudeStream, CLI_SETTINGS, WEB_SEARCHED_MARKER } = await import("../host/cli.mjs");
  const run = (...events) => {
    const stream = claudeStream();
    stream.push(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    stream.end();
    return stream.searched;
  };
  const call = (name, id) => ({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id, name } } });
  const result = (id, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "..." }] } });

  assert.equal(run({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }), false);
  assert.equal(run(call("WebSearch", "t1"), result("t1")), true);
  // Refused in --print mode: tried, but nothing came back.
  assert.equal(run(call("WebSearch", "t1"), result("t1", true)), false);
  assert.equal(run(call("WebSearch", "t1")), false);
  assert.equal(run({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "WebFetch" }] } }, result("t2")), true);
  assert.equal(run(call("Read", "t3"), result("t3")), false);
  assert.equal(run({ type: "assistant", message: { content: [{ type: "web_search_tool_result", content: [{ url: "https://x" }] }] } }), true);
  // Web-enabled runs allow the web tools up front; normal runs forbid them.
  assert.ok(CLI_SETTINGS.claude.webArgs.join(" ").includes("--allowed-tools WebSearch,WebFetch"));
  assert.ok(CLI_SETTINGS.claude.args.join(" ").includes("WebFetch,WebSearch"));
  assert.equal(WEB_SEARCHED_MARKER, "[[studyhub:web-searched]]");
});
