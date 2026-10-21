import { withDeadlineLock, withSyncLock } from "../../src/deadline-store.ts";

const [root, kind] = process.argv.slice(2);
const lock = kind === "sync" ? withSyncLock : withDeadlineLock;
await lock(root, async () => {
  const release = new Promise((resolve) => process.once("message", resolve));
  process.send("locked");
  await release;
});
process.disconnect();
