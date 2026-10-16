/**
 * Minimal ZIP reader for Office files (PPTX, DOCX, XLSX): the central
 * directory, then stored or deflated members through node:zlib. Office files
 * are never spanned or encrypted, so that is all it needs.
 */

import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  method: number;
  offset: number;
  compressed: number;
  uncompressed: number;
};

/** No member is inflated past this, so a zip bomb cannot exhaust memory. */
export const MAX_MEMBER_BYTES = 64 * 1024 * 1024;

/** The archive's members, read from the central directory. Throws on a non-ZIP. */
export function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 64 KB (plus its 22 bytes).
  let eocd = -1;
  const from = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive.");

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    entries.set(name, {
      name,
      method: view.getUint16(pointer + 10, true),
      compressed: view.getUint32(pointer + 20, true),
      uncompressed: view.getUint32(pointer + 24, true),
      offset: view.getUint32(pointer + 42, true),
    });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One member's bytes. Throws on a bad header or an unsupported compression method. */
export function readZipMember(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50)
    throw new Error(`Bad local header for ${entry.name}.`);
  // A stored member is its own size; check it before slicing, as inflate cannot cap it.
  if (entry.method === 0 && entry.compressed > MAX_MEMBER_BYTES)
    throw new Error(`Member ${entry.name} is larger than ${MAX_MEMBER_BYTES} bytes.`);
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressed;
  if (end > bytes.length) throw new Error(`Truncated member ${entry.name}.`);
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_MEMBER_BYTES });
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

/** One member as UTF-8 text, or null when the archive has no such member. */
export function readZipText(bytes: Uint8Array, entries: Map<string, ZipEntry>, name: string): string | null {
  const entry = entries.get(name);
  return entry ? new TextDecoder().decode(readZipMember(bytes, entry)) : null;
}
