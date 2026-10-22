/**
 * Unit and integration tests for the chat orchestration module: the citation
 * footer parser, the grounding check applied to a live reply, the history
 * window, and the full `sendChatMessage` turn using a fake AiClient so no
 * real provider or network access is needed.
 */

import assert from "node:assert/strict";
import test from "node:test";

const chat = await import("../lib/ai/chat.ts");

/** Returns an AiClient whose `chat` always resolves with `text`. */
function fakeClient(text, { webSearch = true, usedWebSearch = false } = {}) {
  return {
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async probe() {
      return { ok: true, detail: "fake" };
    },
    async listModels() {
      return [];
    },
    async generate() {
      throw new Error("not used by chat tests");
    },
    async chat() {
      return {
        text,
        usage: { inputTokens: 10, outputTokens: 10 },
        costUsd: null,
        model: "fake",
        transport: "apikey",
        usedWebSearch,
      };
    },
    chatCapabilities() {
      return { webSearch };
    },
  };
}

test("parseChatReply splits prose from the citation footer", () => {
  const raw = [
    "Economic duress requires illegitimate pressure plus causation.",
    "---SOURCES---",
    "FILE: Week 8.txt | QUOTE: could not find another carrier",
    "SOURCE: web | URL: https://example.com | QUOTE: a general definition",
  ].join("\n");
  const { prose, rawCitations } = chat.parseChatReply(raw);
  assert.equal(prose, "Economic duress requires illegitimate pressure plus causation.");
  assert.equal(rawCitations.length, 2);
});

test("parseChatReply tolerates a reply with no footer at all", () => {
  const { prose, rawCitations } = chat.parseChatReply("Just an answer, no citations.");
  assert.equal(prose, "Just an answer, no citations.");
  assert.deepEqual(rawCitations, []);
});

test("checkChatGrounding verifies a file citation against the real source text", () => {
  const extracts = new Map([["a.txt", { path: "a.txt", text: "could not find another carrier at short notice" }]]);
  const { citations, ungrounded } = chat.checkChatGrounding(
    ["FILE: a.txt | QUOTE: could not find another carrier"],
    extracts,
    "could not find another carrier at short notice",
  );
  assert.equal(ungrounded, false);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].kind, "file");
  assert.equal(citations[0].verdict, "verified");
});

test("checkChatGrounding flags a fabricated quote and keeps a web citation distinct", () => {
  const extracts = new Map([["a.txt", { path: "a.txt", text: "the real sentence in the file" }]]);
  const { citations, ungrounded } = chat.checkChatGrounding(
    [
      "FILE: a.txt | QUOTE: this exact wording never appears anywhere in the source",
      "SOURCE: web | URL: https://example.com/page | QUOTE: some web fact",
    ],
    extracts,
    "the real sentence in the file",
  );
  assert.equal(ungrounded, false, "a web citation still counts as a citation");
  const file = citations.find((c) => c.kind === "file");
  const web = citations.find((c) => c.kind === "web");
  assert.equal(file.verdict, "rejected", "an unverifiable quote must not be verified");
  assert.equal(web.url, "https://example.com/page");
});

test("checkChatGrounding reports ungrounded when there are no citations at all", () => {
  const { ungrounded, citations } = chat.checkChatGrounding([], new Map(), "");
  assert.equal(ungrounded, true);
  assert.deepEqual(citations, []);
});

test("windowHistory keeps the most recent turns within the turn and character caps", () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn ${i}`,
  }));
  const windowed = chat.windowHistory(turns);
  assert.ok(windowed.length <= 8, "must not exceed the turn cap");
  assert.equal(windowed.at(-1).content, "turn 11", "the most recent turn must survive");
  assert.equal(windowed[0].content, "turn 4", "only the last 8 of 12 turns are kept");
});

test("windowHistory always keeps at least the single most recent turn, even if it alone exceeds budget", () => {
  const huge = "x".repeat(100_000);
  const windowed = chat.windowHistory([{ role: "user", content: huge }]);
  assert.equal(windowed.length, 1, "a single oversized turn must not be dropped entirely");
});

test("buildChatSystemPrompt names the scope, embeds the context, and adapts to the internet toggle", () => {
  const withWeb = chat.buildChatSystemPrompt("the topic pack for Economic Duress", "Economic Duress (Topic Pack).md", "The pack's own text.", true);
  assert.match(withWeb, /Economic Duress/);
  assert.match(withWeb, /The pack's own text\./);
  assert.match(withWeb, /You may search the web this turn/);
  assert.match(withWeb, /SOURCE: web \| URL:/);

  const withoutWeb = chat.buildChatSystemPrompt("the topic pack for Economic Duress", "Economic Duress (Topic Pack).md", "The pack's own text.", false);
  assert.match(withoutWeb, /You do not have internet access this turn/);
  assert.doesNotMatch(withoutWeb, /SOURCE: web \| URL:/);
});

test("sendChatMessage resends the scoped context in the system prompt on every turn, not just the first", async () => {
  const client = fakeClient("An answer.\n---SOURCES---\nFILE: pack.md | QUOTE: the pack's own guaranteed text");
  const extracts = new Map();
  const allText = "the pack's own guaranteed text";

  const first = await chat.sendChatMessage({
    client,
    scopeLabel: "the topic pack",
    contextLabel: "pack.md",
    contextBlock: "the pack's own guaranteed text",
    history: [],
    question: "What is the rule?",
    webSearch: false,
    extracts,
    allText,
  });
  assert.equal(first.turn.role, "assistant");
  assert.equal(first.turn.citations[0].verdict, "verified");

  // A long history, well past the turn window, must not stop later turns from
  // still having the context available — because it lives in the system
  // prompt (rebuilt fresh every call), not in a message that could scroll out.
  const longHistory = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${i}`,
  }));
  const later = await chat.sendChatMessage({
    client,
    scopeLabel: "the topic pack",
    contextLabel: "pack.md",
    contextBlock: "the pack's own guaranteed text",
    history: longHistory,
    question: "And what about this other rule?",
    webSearch: false,
    extracts,
    allText,
  });
  assert.equal(later.turn.citations[0].verdict, "verified", "grounding still works deep into a long conversation");
});

test("sendChatMessage never requests web search from a client whose chatCapabilities forbid it", async () => {
  let requestedWebSearch = null;
  const client = fakeClient("An answer with no citations.", { webSearch: false });
  client.chat = async (request) => {
    requestedWebSearch = request.webSearch;
    return {
      text: "An answer with no citations.",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: null,
      model: "fake",
      transport: "apikey",
      usedWebSearch: false,
    };
  };

  const result = await chat.sendChatMessage({
    client,
    scopeLabel: "a file",
    contextLabel: "file.txt",
    contextBlock: "text",
    history: [],
    question: "q",
    webSearch: true, // the user asked, but this client cannot do it
    extracts: new Map(),
    allText: "",
  });

  assert.equal(requestedWebSearch, false, "the client's own capability must win, not the caller's toggle");
  assert.equal(result.turn.ungrounded, true, "a reply with no citation footer must be flagged");
});

const deadlinesText = await import("../lib/ai/chat-deadlines.ts");

const deadline = (overrides) => ({
  id: "qmul:x",
  module: "ECS505U",
  year: "2026-27",
  title: "Coursework 1",
  kind: "coursework",
  status: "confirmed",
  due: { iso: "2026-10-29T12:00:00.000Z", allDay: false, tz: "Europe/London" },
  sources: [],
  ...overrides,
});

test("deadlinesBlock lists live deadlines in date order with London times and flags", () => {
  const now = new Date("2026-10-22T09:00:00.000Z");
  const text = deadlinesText.deadlinesBlock(
    [
      deadline({ id: "b", title: "Lab report", kind: "lab", weight: 15 }),
      deadline({ id: "a", title: "Quiz 2", kind: "quiz", due: { iso: "2026-10-20T00:00:00.000Z", allDay: true, tz: "Europe/London" } }),
      deadline({ id: "c", title: "Dropped", status: "cancelled" }),
      deadline({ id: "d", title: "Essay", due: null, status: "tbc" }),
      deadline({ id: "e", title: "Week task", due: null, status: "tbc",
        window: { from: { iso: "2026-11-02T00:00:00.000Z", allDay: true, tz: "Europe/London" }, to: { iso: "2026-11-06T00:00:00.000Z", allDay: true, tz: "Europe/London" } } }),
    ],
    now,
  );
  const lines = text.split("\n");
  assert.deepEqual(lines.map((l) => l.match(/\] (.+?) \|/)[1]), ["Quiz 2", "Lab report", "Week task", "Essay"]);
  assert.match(lines[0], /Tue,? 20 Oct 2026 \| date has passed/);
  assert.match(lines[1], /Thu,? 29 Oct 2026, 12:00 \| 15% of the module/);
  assert.match(lines[2], /day not stated/);
  assert.doesNotMatch(lines[2], /date uncertain/, "a week-only date is not flagged as uncertain");
  assert.match(lines[3], /date not confirmed .*date uncertain \(tbc\)/);
  assert.doesNotMatch(text, /Dropped/);
});

test("deadlinesBlock says so when nothing is saved, and describeToday names the London date", () => {
  assert.equal(deadlinesText.deadlinesBlock([], new Date()), "No deadlines are saved yet.");
  assert.match(deadlinesText.describeToday(new Date("2026-10-22T23:30:00.000Z")), /^Friday,? 23 October 2026 \(Europe\/London\)$/);
});

test("the no-internet prompt forbids filling gaps from general knowledge", () => {
  const prompt = chat.buildChatSystemPrompt("their module", "ECS505U", "Today is Thursday.", false);
  assert.match(prompt, /Answer only from the material below/);
  assert.doesNotMatch(prompt, /your own general knowledge/);
});
