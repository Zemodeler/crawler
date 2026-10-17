/**
 * The providers' structured-output modes reject length and count limits, so
 * they are stripped from the schema the model sees. These tests check the
 * limits still reach the prompt; without them a model could not know that an
 * exam target over 240 characters gets the whole plan rejected.
 */

import assert from "node:assert/strict";
import test from "node:test";

const { PLAN_SCHEMA } = await import("../lib/ai-conversion.ts");
const { schemaLimits, withSchemaLimits } = await import("../lib/ai/schema.ts");
const { schemaPromptHint } = await import("../lib/ai/structured.ts");

test("schemaLimits lists every limit by path", () => {
  const limits = schemaLimits(PLAN_SCHEMA);
  assert.ok(limits.includes("examTarget: at least 1 item, at most 6 items"), limits.join("\n"));
  assert.ok(limits.includes("examTarget[]: at most 240 characters"));
  assert.ok(limits.includes("subject: at most 90 characters"));
  assert.ok(limits.some((l) => l.startsWith("topics[].")), "nested object limits are listed");
});

test("schemaLimits follows $defs references once", () => {
  const schema = {
    type: "object",
    $defs: { node: { type: "object", properties: { name: { type: "string", maxLength: 20 }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
    properties: { root: { $ref: "#/$defs/node" } },
  };
  assert.deepEqual(schemaLimits(schema), ["root.name: at most 20 characters"]);
});

test("the CLI prompt and the API system prompt both carry the limits", () => {
  assert.match(schemaPromptHint(PLAN_SCHEMA, "plan"), /examTarget\[\]: at most 240 characters/);
  assert.match(withSchemaLimits("Plan the course.", PLAN_SCHEMA), /^Plan the course\.\n\nHard limits[^\n]*\n- /);
  assert.equal(withSchemaLimits("Free text.", { type: "string" }), "Free text.");
});
