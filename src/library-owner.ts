/** Account ownership shared by CLI sync and desktop sign-in. */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withSyncLock } from "./deadline-store.ts";
import type { Credentials, UniversityAdapter } from "./types.ts";

type Owner = { version: 2; university: string; site: string; account: string };
const guidance = "Use a separate empty library. For legacy data, back up the existing library and sync into a new empty folder; verified account adoption is not supported. Do not delete ownership metadata to adopt existing data.";
const invalid = () => new Error(`Library ownership metadata is invalid. Restore it from a trusted backup. ${guidance}`);
const legacy = () => new Error(`Library account ownership is unknown (legacy data). ${guidance}`);
const mismatch = () => new Error(`This library belongs to another university, site or account. Sign in with its original account. ${guidance}`);

/** Normalize site spelling without conflating distinct Moodle base paths. */
export function canonicalLibrarySite(site: string): string {
  try {
    const url = new URL(site);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid();
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { throw new Error("Cannot validate the sign-in site. Use the university's configured site."); }
}

/** Caller holds the full-sync lock. This read-only check is also used for selection. */
export async function checkLibraryOwnerUnlocked(root: string, university: string, site: string): Promise<Owner | null> {
  const canonical = canonicalLibrarySite(site);
  let text: string;
  try { text = await readFile(join(root, ".crawler", "university.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid();
    const content = await readdir(root);
    const metadata = await readdir(join(root, ".crawler"));
    if (content.some((name) => name !== ".crawler") || metadata.some((name) => !["sync.lock", "deadlines.lock", "schedule.json", "reminders.json"].includes(name))) throw legacy();
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const owner = parsed as Record<string, unknown>;
  // The old desktop marker establishes no account ownership, even for QMUL.
  if (owner.version === 1 && typeof owner.university === "string" &&
      Object.keys(owner).sort().join(",") === "university,version") throw legacy();
  try {
    if (owner.version !== 2 || typeof owner.university !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(owner.university) ||
        typeof owner.site !== "string" || canonicalLibrarySite(owner.site) !== owner.site ||
        typeof owner.account !== "string" || !/^[a-f0-9]{64}$/.test(owner.account) ||
        Object.keys(owner).sort().join(",") !== "account,site,university,version") throw invalid();
  } catch { throw invalid(); }
  if (owner.university !== university || owner.site !== canonical) throw mismatch();
  return owner as Owner;
}

/** Caller holds the full-sync lock, before any course data is touched. */
export async function enforceLibraryOwnerUnlocked(root: string, adapter: UniversityAdapter, credentials: Credentials): Promise<void> {
  if (typeof adapter.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(adapter.id)) throw new Error("Cannot validate the university identity.");
  const site = canonicalLibrarySite(adapter.site);
  if (canonicalLibrarySite(credentials.site) !== site) throw mismatch();
  const owner = await checkLibraryOwnerUnlocked(root, adapter.id, site);
  const identity = await adapter.whoAmI(credentials);
  if (!identity || !Number.isSafeInteger(identity.userId) || identity.userId <= 0) throw new Error("Cannot validate the signed-in account. Sign in again before using this library.");
  const account = createHash("sha256").update(JSON.stringify([adapter.id, site, identity.userId])).digest("hex");
  if (owner) {
    if (owner.account !== account) throw mismatch();
    return;
  }
  // Exclusive create is atomic; an interrupted write fails closed on the next run.
  await writeFile(join(root, ".crawler", "university.json"), `${JSON.stringify({ version: 2, university: adapter.id, site, account })}\n`, { flag: "wx" });
}

/** Keep credential replacement and ownership claims under the same lock as sync. */
export async function withLibraryOwner<T>(root: string, adapter: UniversityAdapter, credentials: Credentials, work: () => Promise<T>): Promise<T> {
  return withSyncLock(resolve(root), async () => {
    await enforceLibraryOwnerUnlocked(root, adapter, credentials);
    return work();
  });
}

/** Selection validates existing ownership without claiming an account. */
export async function checkLibraryOwner(root: string, university: string, site: string): Promise<void> {
  await withSyncLock(resolve(root), async () => { await checkLibraryOwnerUnlocked(root, university, site); });
}
