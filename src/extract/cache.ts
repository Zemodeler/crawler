/**
 * The extracted-text cache: <stateDir>/text/<sha256>.<format>[.<version>].json, so a
 * re-sync does not re-parse files whose bytes have not changed (docs/design/04).
 * The format is in the key because the same bytes read differently as, say,
 * text and HTML. A format whose reader learns to read more gets a version,
 * so files read before are read again once.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractedDocument } from "../extraction-types.ts";
import { detectFormat, extractText } from "./index.ts";

/** Bump a format's version when its extractor starts finding text it used to miss. */
const READER_VERSION: Partial<Record<ExtractedDocument["format"], number>> = { pdf: 2 };

function isDocument(value: unknown, sha256: string, format: string): value is ExtractedDocument {
  const doc = value as ExtractedDocument | null;
  return typeof doc === "object" && doc !== null && doc.sha256 === sha256 && doc.format === format && Array.isArray(doc.pages) && doc.pages.some((p) => typeof p?.text === "string" && p.text.trim().length > 0);
}

/** Text for `bytes`: from the cache on a hash hit, otherwise extracted and stored. */
export async function cachedExtract(
  stateDir: string,
  bytes: Uint8Array,
  filename: string,
  mimetype?: string | null,
): Promise<ExtractedDocument> {
  const { format, readable } = detectFormat(filename, mimetype);
  // Nothing to parse in an unreadable file, so nothing worth caching.
  if (!readable) return extractText(bytes, filename, mimetype);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = join(stateDir, "text");
  const version = READER_VERSION[format];
  const path = join(dir, `${sha256}.${format}${version ? `.v${version}` : ""}.json`);
  try {
    const cached: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isDocument(cached, sha256, format)) return cached;
  } catch {
    // No entry or an unreadable one: extract again and overwrite it.
  }
  const document = await extractText(bytes, filename, mimetype);
  // Empty output can represent a transient parser failure, not just a blank
  // document. Retry it next sync instead of caching a permanent blind spot.
  if (!document.pages.some((page) => page.text.trim().length > 0)) return document;
  // Write then rename, so a crash never leaves half a JSON file under the real
  // name; the temporary name is unique, so concurrent writes never share one.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temporary, JSON.stringify(document));
    await rename(temporary, path);
  } catch {
    // The cache is an optimisation; failing to write it must not fail the sync.
    await rm(temporary, { force: true }).catch(() => {});
  }
  return document;
}
