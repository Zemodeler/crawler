/**
 * Turning the user's real course files into text the model can be grounded on.
 *
 * The app previously indexed `.pptx`, `.docx` and `.pdf` without being able to
 * read a word of them, which meant a whole term of lecture slides contributed
 * nothing. Fixing that is the single highest-value part of the conversion
 * feature: the difference between generating packs from filenames and generating
 * them from the actual lectures.
 *
 * Office formats are ZIP archives of XML, and the browser can already inflate
 * and parse both — `DecompressionStream("deflate-raw")` plus `DOMParser` — so
 * they cost no dependency at all. PDFs are the exception and use pdfjs, loaded
 * lazily so its ~1 MB never lands on someone who only ever reads Markdown.
 */

import { fnv1a } from "./course-format.ts";
import { idbGet, idbPut, type LocalFile } from "./course-fs.ts";

export type Extract = {
  path: string;
  text: string;
  chunks: string[];
  /** Why a file has no text, when it has none. */
  reason?: "unsupported" | "empty" | "failed" | "too-large";
  detail?: string;
};

const MAX_BYTES = 40 * 1024 * 1024;
const CHUNK_CHARS = 36_000; // ~10k tokens
const CHUNK_OVERLAP = 1_500;

/* ------------------------------------------------------------- ZIP reading */

type ZipEntry = { name: string; method: number; offset: number; compressed: number; uncompressed: number };

/**
 * Minimal ZIP central-directory reader. Enough for Office files, which are
 * always stored or deflated and never spanned or encrypted.
 */
function readCentralDirectory(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // The end-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  const from = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record).");

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressed = view.getUint32(pointer + 20, true);
    const uncompressed = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const offset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    entries.push({ name, method, offset, compressed, uncompressed });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(data: Uint8Array, method: number): Promise<string> {
  if (method === 0) return new TextDecoder().decode(data);
  if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/** Reads one member of the archive as text. */
async function readZipMember(buffer: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const view = new DataView(buffer);
  if (view.getUint32(entry.offset, true) !== 0x04034b50)
    throw new Error(`Bad local header for ${entry.name}.`);
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const data = new Uint8Array(buffer, start, entry.compressed);
  return inflate(data, entry.method);
}

/* ------------------------------------------------------- Office XML parsing */

function textFromXml(xml: string, tagNames: string[], breakTags: string[] = []): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return "";
  const pieces: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 1) {
      const element = node as Element;
      const local = element.localName;
      if (tagNames.includes(local)) {
        pieces.push(element.textContent || "");
        return;
      }
      for (const child of Array.from(element.childNodes)) walk(child);
      if (breakTags.includes(local)) pieces.push("\n");
    }
  };
  walk(doc.documentElement);
  return pieces.join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Numeric-prefix aware sort, so slide10 comes after slide9. */
function bySlideNumber(a: string, b: string): number {
  const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] || 0);
  return num(a) - num(b);
}

async function extractPptx(buffer: ArrayBuffer): Promise<string> {
  const entries = readCentralDirectory(buffer);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => bySlideNumber(a.name, b.name));
  const notes = new Map(
    entries
      .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.name))
      .map((entry) => [Number(entry.name.match(/(\d+)\.xml$/)![1]), entry]),
  );
  const out: string[] = [];
  for (const [index, slide] of slides.entries()) {
    const number = Number(slide.name.match(/(\d+)\.xml$/)![1]) || index + 1;
    const body = textFromXml(await readZipMember(buffer, slide), ["t"], ["p", "br"]);
    out.push(`--- Slide ${number} ---`, body);
    const note = notes.get(number);
    if (note) {
      const noteText = textFromXml(await readZipMember(buffer, note), ["t"], ["p"]);
      // Speaker notes are usually the lecturer's actual words — worth keeping.
      if (noteText.trim()) out.push(`[Speaker notes] ${noteText}`);
    }
  }
  return out.join("\n").trim();
}

async function extractDocx(buffer: ArrayBuffer): Promise<string> {
  const entries = readCentralDirectory(buffer);
  const main = entries.find((entry) => entry.name === "word/document.xml");
  if (!main) throw new Error("No word/document.xml in this file.");
  return textFromXml(await readZipMember(buffer, main), ["t"], ["p", "br", "tr"]);
}

async function extractXlsx(buffer: ArrayBuffer): Promise<string> {
  const entries = readCentralDirectory(buffer);
  const sharedEntry = entries.find((entry) => entry.name === "xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedEntry) {
    const doc = new DOMParser().parseFromString(await readZipMember(buffer, sharedEntry), "application/xml");
    for (const item of Array.from(doc.getElementsByTagName("si"))) shared.push(item.textContent || "");
  }
  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => bySlideNumber(a.name, b.name));
  const out: string[] = [];
  for (const sheet of sheets) {
    const doc = new DOMParser().parseFromString(await readZipMember(buffer, sheet), "application/xml");
    for (const row of Array.from(doc.getElementsByTagName("row"))) {
      const cells = Array.from(row.getElementsByTagName("c")).map((cell) => {
        const value = cell.getElementsByTagName("v")[0]?.textContent || "";
        // t="s" means the value is an index into the shared-strings table.
        if (cell.getAttribute("t") === "s") return shared[Number(value)] || "";
        return cell.getElementsByTagName("t")[0]?.textContent || value;
      });
      if (cells.some((cell) => cell.trim())) out.push(cells.join("\t"));
    }
  }
  return out.join("\n").trim();
}

/* ---------------------------------------------------------------- PDF text */

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfjs() {
  if (!pdfjsPromise)
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
      return pdfjs;
    })();
  return pdfjsPromise;
}

async function extractPdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await loadPdfjs();
  // `destroy` lives on the loading task, not the document, and tears the worker
  // down with it — skipping it leaks a worker per PDF across a long run.
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pages: string[] = [];
  try {
    const document_ = await task.promise;
    for (let page = 1; page <= document_.numPages; page++) {
      const content = await (await document_.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push(`--- Page ${page} ---\n${text}`);
    }
  } finally {
    await task.destroy();
  }
  return pages.join("\n\n").trim();
}

/* ------------------------------------------------------------------ chunking */

/**
 * Split on paragraph, then sentence boundaries, with overlap so a rule split
 * across a boundary is still intelligible in at least one chunk. Whole-lecture
 * caption files are the reason this exists.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= size) return text.trim() ? [text] : [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + size);
    if (end < text.length) {
      const window = text.slice(cursor, end);
      const breakAt =
        window.lastIndexOf("\n\n") > size * 0.5
          ? window.lastIndexOf("\n\n")
          : window.lastIndexOf(". ") > size * 0.5
            ? window.lastIndexOf(". ") + 1
            : -1;
      if (breakAt > 0) end = cursor + breakAt;
    }
    chunks.push(text.slice(cursor, end).trim());
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks.filter(Boolean);
}

/* ------------------------------------------------------------- entry point */

const EXTRACTORS: Record<string, (buffer: ArrayBuffer) => Promise<string>> = {
  pptx: extractPptx,
  docx: extractDocx,
  xlsx: extractXlsx,
  pdf: extractPdf,
};

/** Legacy binary Office formats have no practical in-browser reader. */
const UNREADABLE = new Set(["doc", "ppt", "xls"]);

function cacheKey(file: LocalFile): string {
  return fnv1a(`${file.path}:${file.file.size}:${file.file.lastModified}`);
}

/**
 * Text for one file, from cache when possible. Extraction is the slow part of a
 * conversion run, and a resumed run must not pay for it twice.
 */
export async function extractFile(file: LocalFile): Promise<Extract> {
  if (file.text !== undefined) {
    const text = file.text;
    return { path: file.path, text, chunks: chunkText(text), reason: text.trim() ? undefined : "empty" };
  }
  if (UNREADABLE.has(file.ext))
    return {
      path: file.path,
      text: "",
      chunks: [],
      reason: "unsupported",
      detail: `.${file.ext} is an old binary format Study Hub cannot read. Re-save it as .${file.ext}x.`,
    };
  const extractor = EXTRACTORS[file.ext];
  if (!extractor) return { path: file.path, text: "", chunks: [], reason: "unsupported" };
  if (file.file.size > MAX_BYTES)
    return {
      path: file.path,
      text: "",
      chunks: [],
      reason: "too-large",
      detail: `${Math.round(file.file.size / 1024 / 1024)} MB is too large to read in the browser.`,
    };

  const key = cacheKey(file);
  const cached = await idbGet<Extract>("extracts", key).catch(() => undefined);
  if (cached) return cached;

  let extract: Extract;
  try {
    const text = await extractor(await file.file.arrayBuffer());
    extract = {
      path: file.path,
      text,
      chunks: chunkText(text),
      reason: text.trim() ? undefined : "empty",
    };
  } catch (error) {
    extract = {
      path: file.path,
      text: "",
      chunks: [],
      reason: "failed",
      detail: (error as Error).message,
    };
  }
  await idbPut("extracts", key, extract).catch(() => {});
  return extract;
}

export async function extractAll(
  files: LocalFile[],
  onProgress?: (done: number, total: number, path: string) => void,
): Promise<Map<string, Extract>> {
  const out = new Map<string, Extract>();
  for (const [index, file] of files.entries()) {
    onProgress?.(index, files.length, file.path);
    out.set(file.path, await extractFile(file));
  }
  onProgress?.(files.length, files.length, "");
  return out;
}

/** A short preview used when the plan call needs breadth rather than depth. */
export function preview(extract: Extract | undefined, chars = 600): string {
  if (!extract?.text) return "";
  return extract.text.slice(0, chars).replace(/\s+/g, " ").trim();
}
