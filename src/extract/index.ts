/**
 * Local text extraction (docs/design/04, "Text extraction"): file bytes ->
 * text per page, slide or sheet, for the candidate finders and the AI.
 *
 * PDFs go through pdfjs-dist's legacy build (plain Node, no worker or canvas),
 * and a page with almost no text layer (a scan, a slide saved as a picture) is
 * read with OCR from the images drawn on it; PPTX, DOCX and XLSX are ZIPs of
 * XML read with ./zip.ts; HTML is stripped to text with its link targets kept;
 * Jupyter notebooks come out one cell per page; images go through OCR. Any
 * other file is sniffed: SQLite databases (such as Visual Paradigm .vpp
 * projects) give the text in their tables, ZIP archives give the text of their
 * members, UTF-8 files are read as text and other binaries give their
 * printable strings. Only audio and video are not read. A corrupt or
 * unreadable file never throws: it comes back with its format and no pages.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ExtractedDocument, PageText } from "../extraction-types.ts";
import { OcrSession, type RawImage } from "./ocr.ts";
import { attr, decodeEntities, elements, runText, tidy } from "./xml.ts";
import { readZipEntries, readZipMember, readZipText, type ZipEntry } from "./zip.ts";

type Format = ExtractedDocument["format"];

const BY_EXTENSION: Record<string, Format> = {
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".ipynb": "notebook",
};

const TEXT_EXTENSIONS = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".ics", ".tex", ".svg"]);

const IMAGE_EXTENSIONS = new Set([".png", ".apng", ".jpg", ".jpeg", ".jfif", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".pbm", ".pgm", ".ppm"]);

/** Recordings have no text to read; their transcripts are fetched separately where the VLE has them. */
const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp",
  ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".oga", ".flac", ".wma", ".opus",
]);

const BY_MIMETYPE: Record<string, Format> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/x-ipynb+json": "notebook",
};

/**
 * The format, by extension first and then mimetype. Everything is readable
 * except audio and video; a file of no known format is "other" and is sniffed
 * when it is read.
 */
export function detectFormat(filename: string, mimetype?: string | null): { format: Format; readable: boolean } {
  const extension = extname(filename).toLowerCase();
  const known = BY_EXTENSION[extension];
  if (known) return { format: known, readable: true };
  if (TEXT_EXTENSIONS.has(extension)) return { format: "text", readable: true };
  if (IMAGE_EXTENSIONS.has(extension)) return { format: "image", readable: true };
  if (MEDIA_EXTENSIONS.has(extension)) return { format: "other", readable: false };
  const mime = (mimetype ?? "").split(";")[0]!.trim().toLowerCase();
  const byMime = BY_MIMETYPE[mime];
  if (byMime) return { format: byMime, readable: true };
  if (mime === "image/svg+xml" || mime.startsWith("text/")) return { format: "text", readable: true };
  if (mime.startsWith("image/")) return { format: "image", readable: true };
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return { format: "other", readable: false };
  return { format: "other", readable: true };
}

/** What an extractor may use: one OCR session per file, and how deep inside archives it is. */
type Context = { ocr: () => OcrSession; depth: number };

export async function extractText(bytes: Uint8Array, filename: string, mimetype?: string | null): Promise<ExtractedDocument> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { format, readable } = detectFormat(filename, mimetype);
  let pages: PageText[] = [];
  if (readable) {
    let session: OcrSession | undefined;
    const context: Context = { ocr: () => (session ??= new OcrSession()), depth: 0 };
    try {
      pages = await EXTRACTORS[format](bytes, context);
    } catch {
      pages = [];
    } finally {
      await session?.close();
    }
  }
  // Pages with no text (a blank slide, a picture with no words) are dropped; the rest keep their numbers.
  return { sha256, format, pages: pages.filter((page) => page.text.length > 0) };
}

const EXTRACTORS: Record<Format, (bytes: Uint8Array, context: Context) => PageText[] | Promise<PageText[]>> = {
  pdf: extractPdf,
  pptx: extractPptx,
  docx: extractDocx,
  xlsx: extractXlsx,
  html: (bytes) => [{ page: 1, text: htmlToText(decodeUtf8(bytes)) }],
  text: (bytes) => [{ page: 1, text: plainText(decodeUtf8(bytes)) }],
  notebook: extractNotebook,
  image: async (bytes, context) => [{ page: 1, text: tidy(await context.ocr().recognize(bytes)) }],
  other: extractOther,
};

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

const plainText = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/* ---------------------------------------------------------------------- PDF */

/** A page with fewer visible characters than this in its text layer is read with OCR too. */
const OCR_BELOW_CHARS = 40;
/** Distinct images one PDF may send to OCR; a cap so a pathological file cannot run for hours. */
const MAX_OCR_IMAGES = 1000;
/** Images queued for OCR at once: each is a full-size bitmap in memory. */
const OCR_IN_FLIGHT = 4;

type PdfPage = {
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(id: string, callback: (data: unknown) => void): void };
  commonObjs: { get(id: string, callback: (data: unknown) => void): void };
  cleanup(): void;
};

async function extractPdf(bytes: Uint8Array, context: Context): Promise<PageText[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs takes ownership of (and may detach) the buffer it is given.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    // Decode images to raw pixels in plain JavaScript, for OCR.
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  const imageOps = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObject]);
  const pages: PageText[] = [];
  // OCR runs behind the page loop; each page collects the text of its own images at the end.
  const scans = new Map<number, Promise<string>[]>();
  const byContent = new Map<string, Promise<string>>();
  const inFlight: Promise<string>[] = [];
  try {
    const document = await task.promise;
    for (let number = 1; number <= document.numPages; number++) {
      const page = (await document.getPage(number)) as unknown as PdfPage;
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as { str?: unknown; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push({ page: number, text: tidy(text) });
      if (text.replace(/\s/g, "").length < OCR_BELOW_CHARS) {
        const found: Promise<string>[] = [];
        for (const image of await pageImages(page, imageOps)) {
          // The same picture is often drawn on many pages: read it once.
          const key = createHash("sha1").update(image.data).digest("hex");
          let scan = byContent.get(key);
          if (!scan) {
            if (byContent.size >= MAX_OCR_IMAGES) continue;
            scan = context.ocr().recognizeRaw(image);
            byContent.set(key, scan);
            inFlight.push(scan);
            if (inFlight.length >= OCR_IN_FLIGHT) await inFlight.shift();
          }
          if (!found.includes(scan)) found.push(scan);
        }
        if (found.length > 0) scans.set(number, found);
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  for (const page of pages) {
    const found = scans.get(page.page);
    if (!found) continue;
    const scanned = tidy((await Promise.all(found)).filter(Boolean).join("\n\n"));
    if (scanned) page.text = page.text ? `${page.text}\n${scanned}` : scanned;
  }
  return pages;
}

/** The decoded images a page draws, in drawing order. */
async function pageImages(page: PdfPage, imageOps: Set<number>): Promise<RawImage[]> {
  const list = await page.getOperatorList();
  const images: RawImage[] = [];
  for (let index = 0; index < list.fnArray.length; index++) {
    if (!imageOps.has(list.fnArray[index]!)) continue;
    const reference = list.argsArray[index]?.[0];
    const image = typeof reference === "string" ? await resolveObject(page, reference) : reference;
    if (isRawImage(image)) images.push(image);
  }
  return images;
}

/** A decoded object of the page, or null when pdfjs never delivers it. */
function resolveObject(page: PdfPage, id: string): Promise<unknown> {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    try {
      store.get(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function isRawImage(value: unknown): value is RawImage {
  const image = value as RawImage | null;
  return (
    typeof image === "object" &&
    image !== null &&
    typeof image.width === "number" &&
    typeof image.height === "number" &&
    typeof image.kind === "number" &&
    ArrayBuffer.isView(image.data)
  );
}

/* ----------------------------------------------------------------- Notebook */

/** One page per cell: its source, then any text it printed. */
function extractNotebook(bytes: Uint8Array): PageText[] {
  type Cell = { source?: unknown; input?: unknown; outputs?: unknown };
  type Output = { text?: unknown; data?: Record<string, unknown> };
  const notebook = JSON.parse(decodeUtf8(bytes)) as { cells?: unknown; worksheets?: { cells?: unknown }[] };
  const cells = (Array.isArray(notebook.cells) ? notebook.cells : (notebook.worksheets?.[0]?.cells ?? [])) as Cell[];
  if (!Array.isArray(cells)) return [];
  const lines = (value: unknown) => (Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "");
  return cells.map((cell, index) => {
    let text = lines(cell?.source ?? cell?.input);
    const outputs = (Array.isArray(cell?.outputs) ? (cell.outputs as Output[]) : [])
      .map((output) => lines(output?.text) || lines(output?.data?.["text/markdown"]) || lines(output?.data?.["text/plain"]))
      .filter((output) => output.trim().length > 0);
    if (outputs.length > 0) text += `\n\nOutput:\n${outputs.join("\n")}`;
    return { page: index + 1, text: tidy(plainText(text)) };
  });
}

/* -------------------------------------------------------------------- Other */

/** Text kept from one database, archive or binary, so a huge file cannot fill memory with strings. */
const MAX_OTHER_CHARS = 4_000_000;
/** Archives inside archives are read this deep. */
const MAX_ARCHIVE_DEPTH = 2;

const startsWith = (bytes: Uint8Array, signature: string | number[]) => {
  const expected = typeof signature === "string" ? [...signature].map((char) => char.charCodeAt(0)) : signature;
  return bytes.length >= expected.length && expected.every((byte, index) => bytes[index] === byte);
};

const IMAGE_SIGNATURES: (string | number[])[] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG and APNG
  [0xff, 0xd8, 0xff], // JPEG
  "GIF8",
  [0x49, 0x49, 0x2a, 0x00], // TIFF, little-endian
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF, big-endian
];

/** A file of no known format, read by what its bytes turn out to be. */
async function extractOther(bytes: Uint8Array, context: Context): Promise<PageText[]> {
  if (startsWith(bytes, "SQLite format 3\0")) return extractSqlite(bytes);
  if (startsWith(bytes, "%PDF-")) return extractPdf(bytes, context);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && context.depth < MAX_ARCHIVE_DEPTH) return extractArchive(bytes, context);
  if (IMAGE_SIGNATURES.some((signature) => startsWith(bytes, signature))) return EXTRACTORS.image(bytes, context);
  return [{ page: 1, text: binaryText(bytes) }];
}

/** UTF-8 text as it is, or else the printable strings in it. */
function binaryText(bytes: Uint8Array): string {
  const text = asText(bytes);
  return text !== null ? plainText(text).slice(0, MAX_OTHER_CHARS) : printableStrings(bytes);
}

/** The bytes as text when they are valid UTF-8 with no NUL bytes, otherwise null. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Runs of printable ASCII, single-byte or UTF-16LE (old Word and PowerPoint files), like the Unix `strings` tool. */
export function printableStrings(bytes: Uint8Array, minLength = 6): string {
  const out: string[] = [];
  let total = 0;
  const keep = (run: string) => {
    const trimmed = run.trim();
    if (trimmed.length < minLength || total >= MAX_OTHER_CHARS) return;
    out.push(trimmed);
    total += trimmed.length;
  };
  const printable = (byte: number) => byte === 9 || (byte >= 0x20 && byte < 0x7f);
  let run = "";
  for (const byte of bytes) {
    if (printable(byte)) run += String.fromCharCode(byte);
    else {
      keep(run);
      run = "";
    }
  }
  keep(run);
  for (const start of [0, 1]) {
    run = "";
    for (let index = start; index + 1 < bytes.length; index += 2) {
      if (bytes[index + 1] === 0 && printable(bytes[index]!)) run += String.fromCharCode(bytes[index]!);
      else {
        keep(run);
        run = "";
      }
    }
    keep(run);
  }
  return out.join("\n");
}

/** The text in every table of a SQLite database: one page per table, one line per value. */
async function extractSqlite(bytes: Uint8Array): Promise<PageText[]> {
  const { DatabaseSync } = await loadSqlite();
  const dir = await mkdtemp(join(tmpdir(), "crawler-sqlite-"));
  const path = join(dir, "file.sqlite");
  try {
    await writeFile(path, bytes);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      let total = 0;
      return tables.map(({ name }, index) => {
        const lines: string[] = [];
        const rows = database.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).iterate() as Iterable<Record<string, unknown>>;
        for (const row of rows) {
          if (total >= MAX_OTHER_CHARS) break;
          for (const value of Object.values(row)) {
            const text = sqliteValueText(value);
            if (!text) continue;
            lines.push(text);
            total += text.length;
          }
        }
        return { page: index + 1, text: tidy(lines.join("\n")) };
      });
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** node:sqlite, without the one-off "experimental feature" warning it prints on load in some Node versions. */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (/SQLite/i.test(typeof warning === "string" ? warning : warning.message)) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** A table value as text; blobs count when they are text, gunzipped first when compressed (pictures and other binary blobs are skipped). */
function sqliteValueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!(value instanceof Uint8Array) || value.length === 0) return "";
  let blob = value;
  if (startsWith(blob, [0x1f, 0x8b])) {
    try {
      blob = new Uint8Array(gunzipSync(blob, { maxOutputLength: 64 * 1024 * 1024 }));
    } catch {
      // Not really gzip: read the bytes as they are.
    }
  }
  const text = asText(blob);
  return text === null ? "" : plainText(text);
}

/** The members of a ZIP archive, each read by its own format; every page is headed by the member's name. */
async function extractArchive(bytes: Uint8Array, context: Context): Promise<PageText[]> {
  const pages: PageText[] = [];
  let total = 0;
  for (const [name, entry] of readZipEntries(bytes)) {
    if (name.endsWith("/") || total >= MAX_OTHER_CHARS) continue;
    const { format, readable } = detectFormat(name);
    if (!readable) continue;
    let inner: PageText[];
    try {
      inner = await EXTRACTORS[format](readZipMember(bytes, entry), { ...context, depth: context.depth + 1 });
    } catch {
      continue;
    }
    for (const page of inner) {
      if (!page.text) continue;
      pages.push({ page: pages.length + 1, text: `${name}\n${page.text}` });
      total += page.text.length;
    }
  }
  return pages;
}

/* ------------------------------------------------------------ Office shared */

/** Resolves a relationship target against the part that holds the relationships. */
function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

type Relationship = { type: string; target: string };

/** A part's internal relationships: id -> type and the target's part path. */
function relationships(bytes: Uint8Array, entries: Map<string, ZipEntry>, part: string): Map<string, Relationship> {
  const slash = part.lastIndexOf("/");
  const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const out = new Map<string, Relationship>();
  for (const { attrs } of elements(readZipText(bytes, entries, relsPath) ?? "", "Relationship")) {
    const id = attr(attrs, "Id");
    const target = attr(attrs, "Target");
    if (id && target && attr(attrs, "TargetMode") !== "External")
      out.set(id, { type: attr(attrs, "Type") ?? "", target: resolvePart(part, target) });
  }
  return out;
}

/**
 * Parts in document order: the <itemElement r:id> list in `part`, through its
 * relationships. Falls back to the parts matching `pattern` in numeric order
 * when that list is missing.
 */
function orderedParts(bytes: Uint8Array, entries: Map<string, ZipEntry>, part: string, itemElement: string, pattern: RegExp): string[] {
  const rels = relationships(bytes, entries, part);
  const ordered: string[] = [];
  for (const { attrs } of elements(readZipText(bytes, entries, part) ?? "", itemElement)) {
    // The relationship id is the prefixed r:id; a bare id="256" is the slide's own number.
    const id = /(?:^|\s)\w+:id\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    const target = id ? rels.get(id)?.target : undefined;
    if (target && entries.has(target) && !ordered.includes(target)) ordered.push(target);
  }
  if (ordered.length > 0) return ordered;
  const number = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  return [...entries.keys()].filter((name) => pattern.test(name)).sort((a, b) => number(a) - number(b));
}

/** Paragraphs (<a:p> or <w:p>), one per line. */
function paragraphs(xml: string): string {
  return elements(xml, "p")
    .map(({ body }) => runText(body))
    .join("\n");
}

/* --------------------------------------------------------------------- PPTX */

function extractPptx(bytes: Uint8Array): PageText[] {
  const entries = readZipEntries(bytes);
  const slides = orderedParts(bytes, entries, "ppt/presentation.xml", "sldId", /^ppt\/slides\/slide\d+\.xml$/);
  return slides.map((slide, index) => {
    let text = tidy(paragraphs(readZipText(bytes, entries, slide) ?? ""));
    const notesPart = [...relationships(bytes, entries, slide).values()].find((rel) => rel.type.endsWith("/notesSlide"));
    if (notesPart) {
      // Fields are the slide-number and date placeholders, not the lecturer's words.
      const notesXml = (readZipText(bytes, entries, notesPart.target) ?? "").replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "");
      const notes = tidy(paragraphs(notesXml));
      if (notes) text = text ? `${text}\n\nNotes:\n${notes}` : `Notes:\n${notes}`;
    }
    return { page: index + 1, text };
  });
}

/* --------------------------------------------------------------------- DOCX */

const PAGE_BREAK = "\f";

/** Paragraphs, split into pages at explicit page breaks (Word's own pagination is not in the file). */
function extractDocx(bytes: Uint8Array): PageText[] {
  const entries = readZipEntries(bytes);
  const xml = readZipText(bytes, entries, "word/document.xml");
  if (xml === null) return [];
  const marker = `<w:t>${PAGE_BREAK}</w:t>`;
  const body = xml
    .replace(/<w:br\b[^>]*?\bw:type\s*=\s*["']page["'][^>]*?\/>/g, marker)
    .replace(/<w:pageBreakBefore(?:\s+w:val\s*=\s*["'](?:1|true|on)["'])?\s*\/>/g, marker);
  return paragraphs(body)
    .split(PAGE_BREAK)
    .map((text, index) => ({ page: index + 1, text: tidy(text) }));
}

/* --------------------------------------------------------------------- XLSX */

/** Built-in number formats that show a date or time (ECMA-376 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** The cell style indexes whose number format shows a date. */
function dateStyles(xml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const { attrs } of elements(xml, "numFmt")) custom.set(Number(attr(attrs, "numFmtId")), attr(attrs, "formatCode") ?? "");
  const isDate = (id: number) => {
    if (BUILTIN_DATE_FORMATS.has(id)) return true;
    const code = custom.get(id);
    // Quoted literals, escapes and [colour]/[locale] sections are not date parts.
    return code !== undefined && /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
  };
  const out = new Set<number>();
  const cellXfs = elements(xml, "cellXfs")[0]?.body ?? "";
  elements(cellXfs, "xf").forEach(({ attrs }, index) => {
    if (isDate(Number(attr(attrs, "numFmtId") ?? 0))) out.add(index);
  });
  return out;
}

/** An Excel serial date (1900 date system) as YYYY-MM-DD, plus HH:MM when it has a time. */
function serialToIso(serial: number): string {
  const iso = new Date(Math.round((serial - 25569) * 86_400_000)).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** One line per non-empty row, cells separated by tabs; shared strings resolved and dates shown as dates. */
function extractXlsx(bytes: Uint8Array): PageText[] {
  const entries = readZipEntries(bytes);
  const shared = elements(readZipText(bytes, entries, "xl/sharedStrings.xml") ?? "", "si").map(({ body }) =>
    // <rPh> runs are phonetic readings, not part of the cell's text.
    runText(body.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "")),
  );
  const dates = dateStyles(readZipText(bytes, entries, "xl/styles.xml") ?? "");
  const sheets = orderedParts(bytes, entries, "xl/workbook.xml", "sheet", /^xl\/worksheets\/sheet\d+\.xml$/);
  return sheets.map((sheet, index) => {
    const lines: string[] = [];
    for (const row of elements(readZipText(bytes, entries, sheet) ?? "", "row")) {
      const cells = elements(row.body, "c").map(({ attrs, body }) => {
        const type = attr(attrs, "t");
        const value = decodeEntities(elements(body, "v")[0]?.body ?? "");
        let text = value;
        if (type === "s") text = shared[Number(value)] ?? "";
        else if (type === "inlineStr") text = runText(elements(body, "is")[0]?.body ?? "");
        else if (type === "b") text = value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
        else if ((type === null || type === "n") && value !== "" && Number.isFinite(Number(value)) && dates.has(Number(attr(attrs, "s") ?? 0)))
          text = serialToIso(Number(value));
        return text.replace(/\s+/g, " ").trim();
      });
      while (cells.length > 0 && cells.at(-1) === "") cells.pop();
      if (cells.length > 0) lines.push(cells.join("\t"));
    }
    return { page: index + 1, text: lines.join("\n") };
  });
}

/* --------------------------------------------------------------------- HTML */

const BLOCK_TAGS =
  "p|div|br|li|ul|ol|h[1-6]|tr|table|thead|tbody|tfoot|caption|section|article|header|footer|nav|aside|main|blockquote|pre|hr|dl|dt|dd|figure|figcaption|form|fieldset|address";

/** HTML to plain text, a line per block, links kept as "text (url)". */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    // Source line breaks are only whitespace in HTML; lines come from block elements.
    .replace(/\s+/g, " ")
    .replace(/<(script|style|noscript|template|head|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) => {
      const label = decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
      const href = attr(attrs, "href")?.trim() ?? "";
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return label;
      if (!label || label === href) return ` ${href} `;
      return `${label} (${href})`;
    })
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
      const alt = attr(attrs, "alt")?.trim();
      return alt ? ` ${alt} ` : " ";
    })
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return tidy(decodeEntities(text)).replace(/\n+/g, "\n");
}
