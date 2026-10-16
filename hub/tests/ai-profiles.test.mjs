/**
 * Profile-aware AI side: law prompts stay byte-identical to what
 * sh/subject-profiles-a sent, other subjects carry no law wording, and a run
 * records its profile. A fake AiClient stands in for the provider.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROFILE_FIXTURE } from "./fixtures/law-inputs.mjs";

const ai = await import("../lib/ai-conversion.ts");
const { PROFILES } = await import("../lib/subject-profiles.ts");
const { ConversionRun } = await import("../lib/conversion-run.ts");
const { SPEC, guidePath, packPath } = await import("../lib/course-format.ts");

const snapshot = JSON.parse(readFileSync(new URL("./fixtures/law-prompts.json", import.meta.url), "utf8"));

/** What the model is shown: the system prompt and the user message of every call. */
function promptText(calls) {
  return Object.values(calls).flat().map((call) => `${call.system}\n${call.user}`).join("\n\n");
}

const LAW_WORDING = [/\bcases?\b/i, /authorit/i, /statute/i, /\bIRAC\b/, /problem question/i];

/* ----------------------------------------------------------------- law, unchanged */

for (const explicit of [false, true]) {
  test(`law prompts are byte-identical to the law-only code (${explicit ? "explicit" : "default"} profile)`, async () => {
    const { calls, results, run } = PROFILE_FIXTURE(ai, explicit ? PROFILES.law : undefined);
    await run();
    assert.equal(ai.buildSystemPrompt(explicit ? PROFILES.law : undefined), snapshot.system);
    assert.deepEqual(Object.keys(calls), Object.keys(snapshot.calls));
    for (const [name, recorded] of Object.entries(snapshot.calls)) {
      assert.equal(calls[name].length, recorded.length, name);
      calls[name].forEach((call, i) => {
        assert.equal(call.system, recorded[i].system, `${name} system`);
        assert.equal(call.user, recorded[i].user, `${name} user message`);
        assert.equal(call.schemaName, recorded[i].schemaName, `${name} schema name`);
        assert.deepEqual(call.schema, recorded[i].schema, `${name} schema`);
      });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(results)), snapshot.results);
  });
}

test("law schemas are the original constants, byte for byte", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ai.PLAN_SCHEMA)), snapshot.schemas.plan);
  assert.deepEqual(JSON.parse(JSON.stringify(ai.PACK_SCHEMA)), snapshot.schemas.pack);
  assert.deepEqual(JSON.parse(JSON.stringify(ai.FOUNDATIONS_SCHEMA)), snapshot.schemas.foundations);
  assert.deepEqual(JSON.parse(JSON.stringify(ai.SCENARIOS_SCHEMA)), snapshot.schemas.scenarios);
  assert.equal(ai.buildPlanSchema(PROFILES.law), ai.PLAN_SCHEMA);
  assert.equal(ai.buildPackSchema(PROFILES.law), ai.PACK_SCHEMA);
});

/* ------------------------------------------------------------- other subjects */

const NEUTRAL_FILES = [
  { path: "Course Materials/Lecture 1 slides.pdf", name: "Lecture 1 slides.pdf", ext: "pdf", size: 1, category: "Source materials" },
  { path: "Course Materials/Formula sheet.pdf", name: "Formula sheet.pdf", ext: "pdf", size: 1, category: "Source materials" },
  { path: "Course Materials/Past paper 2023.pdf", name: "Past paper 2023.pdf", ext: "pdf", size: 1, category: "Past papers" },
];
const NEUTRAL_TOPIC = { number: 1, name: "Fourier Transform", shortLabel: "Fourier", sourceFiles: NEUTRAL_FILES.map((f) => f.name), confidence: "high", note: null };
const NEUTRAL_PLAN = {
  subject: "Signals", level: "undergraduate", examFormat: "worked-problem", examTarget: ["Solve well."],
  topics: [NEUTRAL_TOPIC, { ...NEUTRAL_TOPIC, number: 2, name: "Laplace Transform" }], excluded: [], unreadable: [],
};
const NEUTRAL_AUTH = {
  name: "Parseval identity", citation: null, principle: "Energy is preserved.", deploy: "Use it to check energy.",
  sourceFile: "Lecture 1 slides.pdf", evidence: "the transform preserves total energy",
};
const NEUTRAL_PACK = {
  plainEnglish: { question: "q", answer: "a" }, whereItSits: ["x"], framework: [{ t: "para", text: "f" }],
  rules: [{ heading: "R", blocks: [{ t: "para", text: "p" }] }], checklist: ["What is given?"], moves: ["Check units."],
  worked: { facts: "f", issue: "i", rule: "r", application: ["a", "b"], conclusion: "c" }, traps: ["Sign errors."],
  authorities: [NEUTRAL_AUTH, { ...NEUTRAL_AUTH, name: "Plancherel theorem", evidence: "words that appear nowhere" }],
  rejected: [], flagged: [],
};
const NEUTRAL_FOUND = [{ kind: "result", prompt: "p", authority: "Parseval identity", citation: null, principle: "pr", deploy: null, sourceFile: "Lecture 1 slides.pdf", evidence: "the transform preserves total energy" }];
const neutralInputs = () => ({
  files: NEUTRAL_FILES,
  extracts: new Map(NEUTRAL_FILES.map((f) => [f.path, { path: f.path, text: `${f.name}: the transform preserves total energy. Plancherel theorem is stated.` }])),
  topic: NEUTRAL_TOPIC, plan: NEUTRAL_PLAN, pack: NEUTRAL_PACK, found: NEUTRAL_FOUND,
});

for (const id of ["stem", "humanities", "general"]) {
  test(`${id} prompts contain no law wording`, async () => {
    const { calls, results, run } = PROFILE_FIXTURE(ai, PROFILES[id], neutralInputs());
    await run();
    const text = promptText(calls);
    assert.ok(text.length > 1000);
    for (const pattern of LAW_WORDING) assert.doesNotMatch(text, pattern, `${id}: ${pattern}`);
    // The pack's degraded note is shown to the student, so it is subject-neutral too.
    assert.match(results.pack.degradedNote ?? "", /1 item could not be matched/);
    for (const pattern of LAW_WORDING.slice(1)) assert.doesNotMatch(results.pack.degradedNote ?? "", pattern);
  });
}

test("a profile's own wording replaces law's rules 3, 4 and 6 and keeps the grounding contract", () => {
  const stem = ai.buildSystemPrompt(PROFILES.stem);
  assert.ok(stem.includes(PROFILES.stem.prompts.ruleFor3));
  assert.ok(stem.includes(PROFILES.stem.prompts.ruleFor4));
  assert.ok(stem.includes(PROFILES.stem.prompts.ruleFor6));
  assert.notEqual(stem, snapshot.system);
  for (const id of Object.keys(PROFILES)) {
    const prompt = ai.buildSystemPrompt(PROFILES[id]);
    assert.match(prompt, /"sourceFile"/, id);
    assert.match(prompt, /"evidence"/, id);
    assert.match(prompt, /VERBATIM/, id);
  }
});

test("stem prompts name the stem terms, decks and checklist", async () => {
  const run = PROFILE_FIXTURE(ai, PROFILES.stem, neutralInputs());
  await run.run();
  const c = run.calls;
  assert.match(c.foundations[0].user, /^Write the Foundations and key results flashcards/m);
  assert.match(c.foundations[0].user, /KEY RESULTS, THEOREMS AND ALGORITHMS ALREADY ACCEPTED FOR THIS TOPIC/);
  assert.match(c.scenarios[0].user, /Write the Problem to method flashcards/);
  assert.match(c.scenarios[0].user, /THE PLANNING CHECKLIST FOR THIS TOPIC/);
  assert.match(c.guide0[0].user, /How to answer a problem in this subject/);
  assert.match(c.guide4[0].user, /Model Worked Problems a student can imitate.*Given, Find, Method, Working, Answer/);
  assert.match(c.plan[0].system, /the syllabus, the reference list./);
});

test("non-law file heuristics label reference material and send it whole", async () => {
  const run = PROFILE_FIXTURE(ai, PROFILES.stem, neutralInputs());
  await run.run();
  const plan = run.calls.plan[0].user;
  assert.match(plan, /- reference list: Formula sheet\.pdf/);
  assert.match(plan, /### FILE: Formula sheet\.pdf \(reference list\)/);
  const law = PROFILE_FIXTURE(ai, undefined, neutralInputs());
  await law.run();
  assert.match(law.calls.plan[0].user, /- course document: Formula sheet\.pdf/);
});

test("schemas keep their JSON field names; only the vocabulary changes", () => {
  const lawKeys = (schema) => JSON.stringify(schema, (key, value) => (key === "description" ? undefined : value));
  for (const id of ["stem", "humanities", "general"]) {
    const profile = PROFILES[id];
    assert.deepEqual(ai.buildPlanSchema(profile).properties.examFormat.enum, profile.prompts.examFormat);
    assert.ok(!ai.buildPlanSchema(profile).properties.examFormat.enum.includes("problem-question"), id);
    const pack = ai.buildPackSchema(profile);
    assert.deepEqual(Object.keys(pack.properties.worked.properties), ["facts", "issue", "rule", "application", "conclusion"]);
    assert.deepEqual(Object.keys(pack.properties.authorities.items.properties), Object.keys(ai.PACK_SCHEMA.properties.authorities.items.properties));
    assert.match(pack.properties.worked.properties.facts.description, new RegExp(`^${profile.workedLabels[0]}`));
    assert.equal(lawKeys(pack.properties.worked.properties).replace(/\s/g, ""), lawKeys(ai.PACK_SCHEMA.properties.worked.properties).replace(/\s/g, ""));
    const kinds = ai.buildFoundationsSchema(profile).properties.cards.items.properties.kind.enum;
    assert.ok(!kinds.includes("statute"), id);
    assert.deepEqual(
      Object.keys(ai.buildScenariosSchema(profile).properties.cards.items.properties),
      Object.keys(ai.SCENARIOS_SCHEMA.properties.cards.items.properties),
    );
  }
  assert.deepEqual(ai.buildFoundationsSchema(PROFILES.stem).properties.cards.items.properties.kind.enum,
    ["concept", "rule", "method", "result", "theorem", "algorithm"]);
  assert.deepEqual(ai.buildFoundationsSchema(PROFILES.humanities).properties.cards.items.properties.kind.enum,
    ["concept", "argument", "rule", "source", "thinker"]);
  assert.ok(ai.buildFoundationsSchema(PROFILES.general).properties.cards.items.properties.kind.enum.includes("authority"));
  assert.doesNotThrow(() => ai.checkSchemas());
});

/* ----------------------------------------------------------- the conversion run */

function memoryDir(name = "course") {
  const files = new Map();
  const dirs = new Map();
  return {
    kind: "directory", name, files, dirs,
    async getDirectoryHandle(child, { create } = {}) {
      if (!dirs.has(child)) {
        if (!create) throw new Error("NotFoundError");
        dirs.set(child, memoryDir(child));
      }
      return dirs.get(child);
    },
    async getFileHandle(child, { create } = {}) {
      if (!files.has(child)) {
        if (!create) throw new Error("NotFoundError");
        files.set(child, { text: "" });
      }
      const entry = files.get(child);
      return {
        kind: "file", name: child,
        async getFile() { return { text: async () => entry.text, size: entry.text.length }; },
        async createWritable() {
          let buffer = "";
          return { async write(data) { buffer += data; }, async close() { entry.text = buffer; } };
        },
      };
    },
    async queryPermission() { return "granted"; },
    async *values() {},
  };
}

function runClient(plan, pack) {
  return {
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async probe() { return { ok: true, detail: "fake" }; },
    async listModels() { return []; },
    async generate(req) {
      const data =
        req.schemaName === "plan" ? plan
        : req.schemaName === "topic_pack" ? pack
        : req.schemaName === "guide" ? { intro: "Intro.", blocks: [{ t: "para", text: "Body." }] }
        : { cards: [] };
      return { data, raw: "", usage: { inputTokens: null, outputTokens: null }, costUsd: null, model: "fake", transport: "apikey", repaired: false };
    },
  };
}

async function fullRun(options, plan, pack, texts) {
  const run = ConversionRun.create("Course", "generate", { onChange() {} }, options);
  const client = runClient(plan, pack);
  const extracts = new Map(Object.entries(texts).map(([path, text]) => [path, { path, text }]));
  const staged = await run.generate({ client, plan, files: [], extracts, existing: new Map() });
  const handle = memoryDir();
  await run.commit({ handle, files: [], manifest: null, allowUpdate: false });
  const manifest = JSON.parse(handle.dirs.get(SPEC.internalDir).files.get("manifest.json").text);
  return { run, staged, manifest, handle };
}

const LAW_RUN_PLAN = { subject: "Contract", level: "undergraduate", examFormat: "mixed", examTarget: ["x"], topics: [{ number: 1, name: "Duress", shortLabel: "Duress", sourceFiles: [], confidence: "high", note: null }], excluded: [], unreadable: [] };
const LAW_RUN_PACK = { ...NEUTRAL_PACK, authorities: [{ ...NEUTRAL_AUTH, name: "Siboen", evidence: "words that appear nowhere" }] };

test("the run entry point takes a profile option and defaults to law", () => {
  const noop = { onChange() {} };
  assert.equal(ConversionRun.create("C", "generate", noop).state.profile, "law");
  assert.equal(ConversionRun.create("C", "generate", noop, {}).state.profile, "law");
  assert.equal(ConversionRun.create("C", "generate", noop, { profile: "stem" }).state.profile, "stem");
  assert.equal(ConversionRun.create("C", "generate", noop, { profile: "nonsense" }).state.profile, "law");
});

test("resuming a run saved before profiles treats it as law", () => {
  const old = ConversionRun.create("C", "generate", { onChange() {} }).state;
  delete old.profile;
  assert.equal(ConversionRun.resume(old, { onChange() {} }).state.profile, "law");
});

test("a stem run stages stem-named files and records the profile in snapshot and manifest", async () => {
  const stemPlan = { ...NEUTRAL_PLAN, topics: [NEUTRAL_PLAN.topics[0]] };
  const { run, staged, manifest } = await fullRun({ profile: "stem" }, stemPlan, NEUTRAL_PACK, { "Lecture 1 slides.pdf": "Parseval identity is stated here." });
  assert.equal(run.state.profile, "stem");
  assert.equal(manifest.profile, "stem");
  const paths = staged.map((f) => f.path);
  assert.ok(paths.includes(guidePath(0, undefined, PROFILES.stem)));
  assert.ok(paths.some((p) => p.endsWith("Problem-Solving Technique + Method Map.md")));
  assert.ok(paths.some((p) => p.endsWith("Key Results Coverage Index.md")));
  assert.ok(!paths.some((p) => /Problem Question|Case Coverage/.test(p)));
  assert.ok(paths.includes(packPath({ number: 1, name: "Fourier Transform" })));
  assert.ok(run.state.log.some((l) => l.text.endsWith("1 key results, theorems and algorithms flagged for you to check.")));
});

test("a law run keeps law's files and log wording, and records law", async () => {
  const { run, staged, manifest } = await fullRun({}, LAW_RUN_PLAN, LAW_RUN_PACK, { "Lecture.pdf": "Siboen is a case about duress." });
  assert.equal(manifest.profile, "law");
  assert.equal(run.state.profile, "law");
  const paths = staged.map((f) => f.path);
  assert.ok(paths.some((p) => p.endsWith("Problem Question Technique + Issue-Spotting Map.md")));
  assert.ok(paths.some((p) => p.endsWith("Case Coverage Index.md")));
  assert.ok(run.state.log.some((l) => l.text === "Duress: 1 authorities flagged for you to check."));
});
