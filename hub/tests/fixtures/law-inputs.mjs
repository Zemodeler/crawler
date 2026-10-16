// Shared deterministic inputs: every generate* call recorded through a fake client.
export const FILES = [
  { path: "Course Materials/Lecture 1 slides.pdf", name: "Lecture 1 slides.pdf", ext: "pdf", size: 1, category: "Source materials" },
  { path: "Course Materials/Case list.pdf", name: "Case list.pdf", ext: "pdf", size: 1, category: "Source materials" },
  { path: "Course Materials/Seminar 2 worksheet.pdf", name: "Seminar 2 worksheet.pdf", ext: "pdf", size: 1, category: "Seminars" },
  { path: "Course Materials/Past paper 2023.pdf", name: "Past paper 2023.pdf", ext: "pdf", size: 1, category: "Past papers" },
  { path: "Course Materials/Lecture 1 transcript.txt", name: "Lecture 1 transcript.txt", ext: "txt", size: 1, category: "Source materials" },
  { path: "Course Materials/Module guide.pdf", name: "Module guide.pdf", ext: "pdf", size: 1, category: "Course materials" },
  { path: "Course Materials/Other notes.pdf", name: "Other notes.pdf", ext: "pdf", size: 1, category: "Course materials" },
];
export const EXTRACTS = () => new Map(FILES.map((f) => [f.path, { path: f.path, text: `Content of ${f.name}. Duress requires illegitimate pressure. Williams v Roffey is discussed.` }]));
export const TOPIC = { number: 1, name: "Economic Duress", shortLabel: "Duress", sourceFiles: FILES.map((f) => f.name), confidence: "high", note: null };
export const TOPIC2 = { number: 2, name: "Undue Influence", shortLabel: "UI", sourceFiles: [FILES[0].name], confidence: "medium", note: null };
export const PLAN = { subject: "Contract Law", level: "undergraduate", examFormat: "mixed", examTarget: ["Answer well."], topics: [TOPIC, TOPIC2], excluded: [], unreadable: [] };
const AUTH = (name) => ({ name, citation: "[2000] 1 AC 1", principle: "A principle.", deploy: "Deploy it.", sourceFile: FILES[0].name, evidence: "Duress requires illegitimate pressure" });
export const PACK = {
  plainEnglish: { question: "q", answer: "a" }, whereItSits: ["x"], framework: [{ t: "para", text: "f" }],
  rules: [{ heading: "R", blocks: [{ t: "para", text: "p" }] }], checklist: ["Was there a threat?"], moves: ["Move."],
  worked: { facts: "f", issue: "i", rule: "r", application: ["a", "b"], conclusion: "c" }, traps: ["Trap."],
  authorities: [AUTH("Siboen"), AUTH("Pao On"), { ...AUTH("Williams v Roffey"), evidence: "words that appear nowhere in the materials" }, { ...AUTH("Invented v Case"), evidence: "words that appear nowhere in the materials" }], rejected: [], flagged: [],
};
export const FOUND = [{ kind: "authority", prompt: "p", authority: "Siboen", citation: null, principle: "pr", deploy: null, sourceFile: FILES[0].name, evidence: "Duress requires illegitimate pressure" }];

/** Returns { calls, results, run }: run() drives every AI-calling function, recording each request. */
export function PROFILE_FIXTURE(ai, profile, inputs = {}) {
  const { files = FILES, extracts = EXTRACTS(), topic = TOPIC, plan = PLAN, pack = PACK, found = FOUND } = inputs;
  const calls = {};
  const results = {};
  let current = "";
  const client = {
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async probe() { return { ok: true, detail: "fake" }; },
    async listModels() { return []; },
    async generate(req) {
      (calls[current] ||= []).push({ system: req.system, user: req.messages.map((m) => m.content).join("\n---\n"), schemaName: req.schemaName, schema: req.schema });
      const data = current === "plan" ? plan : current === "pack" ? pack : { cards: [], intro: "i", blocks: [{ t: "para", text: "t" }] };
      return { data, raw: "", usage: { inputTokens: null, outputTokens: null }, costUsd: null, model: "fake", transport: "apikey", repaired: false };
    },
  };
  const extra = profile ? { profile } : {};
  return {
    calls,
    results,
    async run() {
      const allText = [...extracts.values()].map((e) => e.text).join("\n");
      current = "plan"; results.plan = await ai.planCourse(client, { courseName: "Contract", files, extracts, pastedSyllabus: "Syllabus text", ...extra });
      current = "pack"; results.pack = await ai.generatePack(client, { topic, allTopics: plan.topics, plan, files, extracts, allText, ...extra });
      current = "foundations"; results.foundations = await ai.generateFoundations(client, { topic, pack, files, extracts, allText, ...extra });
      current = "scenarios"; results.scenarios = await ai.generateScenarios(client, { topic, pack, foundations: found, ...extra });
      current = "essentials"; results.essentials = await ai.generatePackEssentials(client, { topic, pack, files, extracts, allText, ...extra });
      for (const n of [0, 1, 2, 4]) { current = `guide${n}`; results[`guide${n}`] = await ai.generateGuide(client, { n, title: `Guide ${n}`, plan, packs: [{ topic, pack }], ...extra }); }
    },
  };
}
