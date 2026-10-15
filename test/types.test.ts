import assert from "node:assert/strict";
import { test } from "node:test";

import { CATEGORIES, VleError } from "../src/index.ts";

test("categories match the Study Hub folder contract", () => {
  assert.deepEqual(
    [...CATEGORIES],
    ["Lectures", "Transcripts", "Labs and Seminars", "Past Papers", "Reference", "Assessment Guidance", "Other"],
  );
});

test("VleError carries a code", () => {
  const error = new VleError("invalid_token", "expired");
  assert.equal(error.code, "invalid_token");
  assert.ok(error instanceof Error);
});
