/**
 * A hand-written JSON Schema validator, and the provider-portability rules.
 *
 * Zero dependencies, matching the rest of this codebase — the Markdown renderer
 * and CSV parser are hand-written too, and a schema validator for the subset we
 * actually use is about 150 lines.
 *
 * Two jobs:
 *
 *  1. `stripForProvider` removes the keywords that structured-output modes
 *     reject. Both Anthropic and OpenAI refuse `maxLength`, `minItems`,
 *     `minimum`, `pattern`, `multipleOf`, and optional properties. We keep them
 *     in our own schemas anyway, because...
 *  2. `validate` enforces the full schema locally, including those keywords.
 *
 * So the provider guarantees the shape and we guarantee the constraints. A card
 * whose `evidence` is one character long is caught here rather than in the file.
 */

import type { JsonSchema } from "./types.ts";

/** Keywords the providers' structured-output modes reject outright. */
const UNSUPPORTED_KEYWORDS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "patternProperties",
  "minProperties",
  "maxProperties",
  "default",
  "examples",
] as const;

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produce the schema to send to the provider: our schema minus the keywords it
 * would reject, with every property marked required (a provider-side rule —
 * optionality is expressed as a nullable type instead).
 */
export function stripForProvider(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(stripForProvider);
  if (!isPlainObject(schema)) return schema;

  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = stripForProvider(value);
  }
  if (out.type === "object" && isPlainObject(out.properties)) {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

/** Throws in development if a schema would misbehave on one of the providers. */
export function assertProviderPortable(schema: JsonSchema, name: string): void {
  const problems: string[] = [];
  const walk = (node: Json, path: string) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
    if (!isPlainObject(node)) return;
    if (node.type === "object") {
      if (!isPlainObject(node.properties)) problems.push(`${path}: object without properties`);
      if (node.additionalProperties !== false)
        problems.push(`${path}: object must set additionalProperties:false`);
      const required = Array.isArray(node.required) ? node.required : [];
      const declared = isPlainObject(node.properties) ? Object.keys(node.properties) : [];
      const optional = declared.filter((key) => !required.includes(key));
      if (optional.length)
        problems.push(
          `${path}: every property must be required (optional: ${optional.join(", ")}). ` +
            `Express optionality as type: ["string", "null"].`,
        );
    }
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#/$defs/"))
      problems.push(`${path}: only #/$defs/ refs are portable`);
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };
  walk(schema, name);
  if (problems.length) throw new Error(`Schema "${name}" is not provider-portable:\n- ${problems.join("\n- ")}`);
}

/* -------------------------------------------------------------- validation */

export type Violation = string;

/** Validates `value` against `schema`, returning human-readable violations. */
export function validate(value: Json, schema: JsonSchema): Violation[] {
  const violations: Violation[] = [];
  check(value, schema, "$", schema.$defs || {}, violations);
  return violations;
}

function typeName(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: Json, expected: string): boolean {
  switch (expected) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function check(
  value: Json,
  schema: Json,
  path: string,
  defs: Record<string, Json>,
  out: Violation[],
): void {
  if (!isPlainObject(schema)) return;

  if (typeof schema.$ref === "string") {
    const key = schema.$ref.replace("#/$defs/", "");
    const target = defs[key];
    if (!target) out.push(`${path}: schema references unknown $defs/${key}`);
    else check(value, target, path, defs, out);
    return;
  }

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const options = (schema.oneOf || schema.anyOf) as Json[];
    const passed = options.some((option) => {
      const nested: Violation[] = [];
      check(value, option, path, defs, nested);
      return nested.length === 0;
    });
    if (!passed) out.push(`${path}: does not match any allowed variant`);
    return;
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never))
      out.push(`${path}: must be one of ${schema.enum.map(String).join(", ")} (got ${JSON.stringify(value)})`);
    return;
  }

  const expected = schema.type;
  const allowed = Array.isArray(expected) ? (expected as string[]) : typeof expected === "string" ? [expected] : [];
  if (allowed.length && !allowed.some((option) => matchesType(value, option))) {
    out.push(`${path}: expected ${allowed.join(" or ")}, got ${typeName(value)}`);
    return;
  }
  if (value === null) return;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.trim().length < schema.minLength)
      out.push(`${path}: needs at least ${schema.minLength} characters (has ${value.trim().length})`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      out.push(`${path}: must be at most ${schema.maxLength} characters (has ${value.length})`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      out.push(`${path}: does not match the required pattern`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      out.push(`${path}: must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      out.push(`${path}: must be at most ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      out.push(`${path}: needs at least ${schema.minItems} items (has ${value.length})`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      out.push(`${path}: must have at most ${schema.maxItems} items (has ${value.length})`);
    if (schema.items) value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, defs, out));
    return;
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required)
      if (!(key in value) || value[key] === undefined) out.push(`${path}.${key}: missing`);
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) check(child, properties[key], `${path}.${key}`, defs, out);
      else if (schema.additionalProperties === false) out.push(`${path}.${key}: unexpected property`);
    }
  }
}

/**
 * Extract the first balanced JSON object from model output.
 *
 * The API paths return clean JSON, but the CLI paths have no structured-output
 * mode, so the model may wrap it in a fence or add a sentence either side.
 * Quote- and escape-aware, so a `}` inside a string does not end the scan.
 */
export function extractJsonObject(text: string): string | null {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}
