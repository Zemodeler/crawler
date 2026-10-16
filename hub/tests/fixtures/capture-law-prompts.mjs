// Regenerates tests/fixtures/law-prompts.json. Run against the law-only
// ai-conversion.ts from sh/subject-profiles-a: save it next to the current one as
// lib/_old-ai-conversion.ts, then: node tests/fixtures/capture-law-prompts.mjs ../../lib/_old-ai-conversion.ts
import { writeFileSync } from "node:fs";
import { PROFILE_FIXTURE } from "./law-inputs.mjs";
const ai = await import(process.argv[2]);
const { calls, results, run } = PROFILE_FIXTURE(ai);
await run();
writeFileSync(new URL("./law-prompts.json", import.meta.url), JSON.stringify({
  system: ai.buildSystemPrompt(),
  schemas: { plan: ai.PLAN_SCHEMA, pack: ai.PACK_SCHEMA, foundations: ai.FOUNDATIONS_SCHEMA, scenarios: ai.SCENARIOS_SCHEMA },
  calls, results,
}, null, 1));
