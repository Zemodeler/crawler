/**
 * Getting a schema-valid object out of a model, on any of the four cells.
 *
 * The API cells have native structured output, so the schema is enforced by the
 * provider. The CLI cells have no such mode, so the schema is described in the
 * prompt and enforced here. Either way the result passes through the same local
 * validator, and either way a failure gets exactly one repair round-trip —
 * never a loop, and never a silent coercion.
 */

import { extractJsonObject, schemaLimitLines, stripForProvider, validate, type Violation } from "./schema.ts";
import { AiError, type GenerateRequest, type JsonSchema } from "./types.ts";

export const MAX_REPAIRS = 1;

/** Appended for transports with no native schema enforcement. */
export function schemaPromptHint(schema: JsonSchema, schemaName: string): string {
  return [
    "",
    `Return exactly one JSON object named ${schemaName} matching this JSON Schema.`,
    "No prose before or after it. No markdown code fence.",
    "",
    JSON.stringify(stripForProvider(schema)),
    ...(schemaLimitLines(schema).length ? ["", ...schemaLimitLines(schema)] : []),
  ].join("\n");
}

export function repairPrompt(violations: Violation[]): string {
  return [
    "Your last response was rejected. Fix exactly these problems and return the full corrected JSON object:",
    ...violations.slice(0, 25).map((violation) => `- ${violation}`),
    violations.length > 25 ? `- (and ${violations.length - 25} more of the same kind)` : "",
    "Change nothing else. Do not add explanations.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type Attempt = {
  /** Raw model text for this attempt. */
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

/** Parse and validate one attempt's text, returning either data or violations. */
export function parseAttempt<T>(
  text: string,
  schema: JsonSchema,
): { data: T; violations: [] } | { data: null; violations: Violation[] } {
  const json = extractJsonObject(text);
  if (!json) return { data: null, violations: ["Response contained no JSON object."] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { data: null, violations: [`Response was not valid JSON: ${(error as Error).message}`] };
  }
  const violations = validate(parsed, schema);
  if (violations.length) return { data: null, violations };
  return { data: parsed as T, violations: [] };
}

/**
 * Run `attempt` until the result validates, with at most one repair.
 *
 * `attempt` receives the messages to send and returns the model's raw text; the
 * caller supplies it, so this function is transport-agnostic.
 */
export async function withRepair<T>(
  request: GenerateRequest,
  attempt: (messages: GenerateRequest["messages"]) => Promise<Attempt>,
): Promise<{ data: T; raw: string; usage: { inputTokens: number | null; outputTokens: number | null }; repaired: boolean }> {
  let messages = [...request.messages];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastViolations: Violation[] = [];

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    if (round > 0) request.onProgress?.({ phase: "repairing", attempt: round });
    const result = await attempt(messages);
    inputTokens += result.inputTokens || 0;
    outputTokens += result.outputTokens || 0;

    request.onProgress?.({ phase: "validating" });
    const parsed = parseAttempt<T>(result.text, request.schema);
    if (parsed.data !== null)
      return {
        data: parsed.data,
        raw: result.text,
        usage: { inputTokens: inputTokens || null, outputTokens: outputTokens || null },
        repaired: round > 0,
      };

    lastViolations = parsed.violations;
    messages = [
      ...messages,
      { role: "assistant", content: result.text },
      { role: "user", content: repairPrompt(parsed.violations) },
    ];
  }

  throw new AiError(
    "schema_invalid_after_repair",
    "The model's answer did not match the expected shape, even after one correction.",
    { detail: lastViolations.slice(0, 10).join("\n") },
  );
}

/** Wraps course text so the model can tell operator instructions from content. */
export function fenceUntrusted(label: string, body: string): string {
  return [
    `<untrusted_course_content source="${label.replace(/"/g, "'")}">`,
    body,
    "</untrusted_course_content>",
  ].join("\n");
}
