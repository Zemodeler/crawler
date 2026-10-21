import assert from "node:assert/strict";
import test from "node:test";
import { MANUAL_UPDATE, showUpdateInstructions } from "../shell/updates.mjs";

test("unconfigured updates only show manual instructions without network or download actions", async () => {
  const messages = [];
  await showUpdateInstructions({ version: "1.0.0", dialog: { showMessageBox: async (message) => messages.push(message) } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, "Study Hub 1.0.0");
  assert.deepEqual(messages[0].buttons, ["OK"]);
  assert.equal(messages[0].detail, MANUAL_UPDATE);
  assert.match(MANUAL_UPDATE, /no trusted release target/);
  assert.match(MANUAL_UPDATE, /previous installer for recovery/);
  assert.match(MANUAL_UPDATE, /library and Study Hub application data must be preserved/);
});
