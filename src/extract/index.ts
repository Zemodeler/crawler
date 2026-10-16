/**
 * Local text extraction (docs/design/04, "Text extraction"): file bytes ->
 * text per page, slide or sheet, for the candidate finders and the AI.
 *
 * PDFs go through pdfjs-dist's legacy build (plain Node, no worker or canvas);
 * PPTX, DOCX and XLSX are ZIPs of XML read with ./zip.ts; HTML is stripped to
 * text with its link targets kept. A corrupt or unreadable file never throws:
 * it comes back with its format and no pages.
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { ExtractedDocument, PageText } from "../extraction-types.ts";
import { attr, decodeEntities, elements, runText, tidy } from "./xml.ts";
import { readZipEntries, readZipText, type ZipEntry } from "./zip.ts";

type Format = ExtractedDocument["format"];

const BY_EXTENSION: Record<string, Format> = {
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
};

const TEXT_EXTENSIONS = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".ics", ".tex"]);

const BY_MIMETYPE: Record<string, Format> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "application/xhtml+xml": "html",
};

/**
 * The format, by extension first and then mimetype. `readable` is false for
 * files with no text in them (images, videos, archives, legacy .doc/.ppt):
 * they come back as "text" with no pages.
 */
export function detectFormat(filename: string, mimetype?: string | null): { format: Format; readable: boolean } {
  const extension = extname(filename).toLowerCase();
  const known = BY_EXTENSION[extension];
  if (known) return { format: known, readable: true };
  if (TEXT_EXTENSIONS.has(extension)) return { format: "text", readable: true };
  const mime = (mimetype ?? "").split(";")[0]!.trim().toLowerCase();
  const byMime = BY_MIMETYPE[mime];
  if (byMime) return { format: byMime, readable: true };
  return { format: "text", readable: mime.startsWith("text/") };
}

export async function extractText(bytes: Uint8Array, filename: string, mimetype?: string | null): Promise<ExtractedDocument> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { format, readable } = detectFormat(filename, mimetype);
  let pages: PageText[] = [];
  if (readable) {
    try {
      pages = await EXTRACTORS[format](bytes);
    } catch {
      pages = [];
    }
  }
  // Pages with no text (a scanned page, a blank slide) are dropped; the rest keep their numbers.
  return { sha256, format, pages: pages.filter((page) => page.text.length > 0) };
}

const EXTRACTORS: Record<Format, (bytes: Uint8Array) => PageText[] | Promise<PageText[]>> = {
  pdf: extractPdf,
  pptx: extractPptx,
  docx: extractDocx,
  xlsx: extractXlsx,
  html: (bytes) => [{ page: 1, text: htmlToText(decodeUtf8(bytes)) }],
  text: (bytes) => [{ page: 1, text: decodeUtf8(bytes).replace(/\r\n?/g, "\n").trim() }],
};

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/* ---------------------------------------------------------------------- PDF */

async function extractPdf(bytes: Uint8Array): Promise<PageText[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs takes ownership of (and may detach) the buffer it is given.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const pages: PageText[] = [];
  try {
    const document = await task.promise;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push({ page: number, text: tidy(text) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
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
