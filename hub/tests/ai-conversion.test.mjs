/**
 * Integration tests for the Pack Essentials generation call, using a fake
 * AiClient so no real provider or network access is needed. This exercises the
 * part `course-format.test.mjs` cannot: the positional mapping between the
 * model's response and the enumerated slots, the two-tier grounding decision,
 * and the fallback when the model gets a slot wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

const ai = await import("../lib/ai-conversion.ts");

/** Returns an AiClient whose `generate` always resolves with `cards`. */
function fakeClient(cards) {
  return {
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async probe() {
      return { ok: true, detail: "fake" };
    },
    async listModels() {
      return [];
    },
    async generate() {
      return {
        data: { cards },
        raw: JSON.stringify({ cards }),
        usage: { inputTokens: null, outputTokens: null },
        costUsd: null,
        model: "fake",
        transport: "apikey",
        repaired: false,
      };
    },
  };
}

const PACK = {
  plainEnglish: { question: "q", answer: "a" },
  whereItSits: [],
  framework: [],
  rules: [{ heading: "Recognition", blocks: [{ t: "para", text: "The Siboen recognised it." }] }],
  checklist: ["Was there a threat?"],
  moves: ["Name the fault-line."],
  worked: { facts: "", issue: "", rule: "", application: [], conclusion: "" },
  traps: ["Do not confuse void with voidable."],
  authorities: [],
  rejected: [],
  flagged: [],
};

const TOPIC = { number: 1, name: "Economic Duress", shortLabel: "Duress", sourceFiles: [], confidence: "high", note: null };

test("generatePackEssentials maps one model card onto each enumerated slot, in order", async () => {
  const client = fakeClient([
    { section: "B", prompt: "Explain the rule.", extra: null, sourceFile: null, evidence: null },
    { section: "C", prompt: "Checklist prompt.", extra: null, sourceFile: null, evidence: null },
    { section: "D", prompt: "Move prompt.", extra: null, sourceFile: null, evidence: null },
    { section: "F", prompt: "Trap prompt.", extra: null, sourceFile: null, evidence: null },
  ]);
  const draft = await ai.generatePackEssentials(client, {
    topic: TOPIC,
    pack: PACK,
    files: [],
    extracts: new Map(),
    allText: "",
  });

  assert.equal(draft.cards.length, 4, "one card per B/C/D/F slot");
  assert.deepEqual(draft.cards.map((c) => c.section), ["B", "C", "D", "F"]);
  assert.deepEqual(draft.brokenSlots, [], "nothing should be reported broken when every section matches");
  assert.equal(draft.cards[0].question, "Explain the rule.", "the model's own prompt is used when it matches");
  assert.ok(draft.cards.every((c) => !c.hasEnrichment), "no card is enriched when extra/sourceFile/evidence are null");
});

test("generatePackEssentials verifies enrichment against the source text before trusting it", async () => {
  const extracts = new Map([["lecture.txt", { path: "lecture.txt", text: "The Siboen recognised economic duress in shipping contracts.", reason: undefined }]]);
  const allText = "The Siboen recognised economic duress in shipping contracts.";

  const verified = fakeClient([
    {
      section: "B",
      prompt: "Explain the rule.",
      extra: "It originated in shipping contract disputes.",
      sourceFile: "lecture.txt",
      evidence: "recognised economic duress in shipping contracts",
    },
    { section: "C", prompt: "p", extra: null, sourceFile: null, evidence: null },
    { section: "D", prompt: "p", extra: null, sourceFile: null, evidence: null },
    { section: "F", prompt: "p", extra: null, sourceFile: null, evidence: null },
  ]);
  const draftVerified = await ai.generatePackEssentials(verified, {
    topic: TOPIC,
    pack: PACK,
    files: [],
    extracts,
    allText,
  });
  assert.equal(draftVerified.cards[0].hasEnrichment, true, "a quote that is actually in the source is trusted");
  assert.ok(draftVerified.cards[0].answer.includes("shipping contract disputes"), "the extra detail is appended");

  const fabricated = fakeClient([
    {
      section: "B",
      prompt: "Explain the rule.",
      extra: "It was decided by the House of Lords in 1999.",
      sourceFile: "lecture.txt",
      evidence: "this exact phrase never appears anywhere in the source text at all",
    },
    { section: "C", prompt: "p", extra: null, sourceFile: null, evidence: null },
    { section: "D", prompt: "p", extra: null, sourceFile: null, evidence: null },
    { section: "F", prompt: "p", extra: null, sourceFile: null, evidence: null },
  ]);
  const draftFabricated = await ai.generatePackEssentials(fabricated, {
    topic: TOPIC,
    pack: PACK,
    files: [],
    extracts,
    allText,
  });
  assert.equal(draftFabricated.cards[0].hasEnrichment, false, "an unverifiable quote must not be trusted");
  assert.equal(
    draftFabricated.cards[0].answer,
    "Recognition — The Siboen recognised it.",
    "the card falls back to the pack's own guaranteed text, not the fabricated claim",
  );
});

test("generatePackEssentials falls back to a guaranteed card when the model returns the wrong section", async () => {
  const client = fakeClient([
    { section: "C", prompt: "wrong section for slot 1", extra: null, sourceFile: null, evidence: null }, // slot 1 is B
    { section: "C", prompt: "p", extra: null, sourceFile: null, evidence: null },
    { section: "D", prompt: "p", extra: null, sourceFile: null, evidence: null },
    { section: "F", prompt: "p", extra: null, sourceFile: null, evidence: null },
  ]);
  const draft = await ai.generatePackEssentials(client, {
    topic: TOPIC,
    pack: PACK,
    files: [],
    extracts: new Map(),
    allText: "",
  });

  assert.deepEqual(draft.brokenSlots, ["B1"], "the mismatched slot must be reported");
  assert.equal(draft.cards[0].section, "B", "the fallback card still carries the correct section");
  assert.equal(draft.cards[0].hasEnrichment, false);
  assert.ok(draft.cards[0].question.length > 0 && draft.cards[0].answer.length > 0, "the fallback card is still usable");
});

test("generatePackEssentials returns nothing, without calling the model, for a pack with no enumerable items", async () => {
  let called = false;
  const client = fakeClient([]);
  const original = client.generate.bind(client);
  client.generate = async (...args) => {
    called = true;
    return original(...args);
  };
  const emptyPack = { ...PACK, rules: [], checklist: [], moves: [], traps: [] };
  const draft = await ai.generatePackEssentials(client, {
    topic: TOPIC,
    pack: emptyPack,
    files: [],
    extracts: new Map(),
    allText: "",
  });
  assert.deepEqual(draft, { cards: [], brokenSlots: [] });
  assert.equal(called, false, "an empty pack must not spend a request");
});
