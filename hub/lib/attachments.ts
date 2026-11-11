/**
 * Files the student gives the assistant that are not in their library: an
 * assignment brief someone emailed, a rubric, a reading from elsewhere. The
 * text is read on this computer (same extractors as course files) and kept
 * with the conversation or essay, so it is still there on the next page; the
 * file itself is only copied into the library when the student asks.
 */

import { fenceUntrusted } from "./ai/structured.ts";
import { inferCategory, topicLabel } from "./course-format.ts";
import type { Extract } from "./source-extract.ts";

export type Attachment = {
  name: string;
  text: string;
  /** The text was cut to MAX_ATTACHMENT_CHARS. */
  truncated: boolean;
  /** Where it was saved in the module, when the student chose to keep a copy. */
  savedPath?: string;
};

export const ATTACH_EXTS = ["pdf", "docx", "pptx", "md", "txt", "csv"];
export const ATTACH_ACCEPT = ATTACH_EXTS.map((e) => `.${e}`).join(",");
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_CHARS = 60_000;
/** Larger files are refused before reading: they stall the page and are rarely one brief. */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

/** Reads one picked file's text. Throws a message fit to show when it cannot. */
export async function readAttachment(file: File): Promise<Attachment> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (!ATTACH_EXTS.includes(ext)) throw new Error(`${file.name}: choose a PDF, Word, PowerPoint, Markdown or text file.`);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 30 MB.`);
  let text: string;
  if (ext === "md" || ext === "txt" || ext === "csv") text = await file.text();
  else {
    // Loaded on demand: the PDF and Office extractors are large.
    const { extractFile } = await import("./source-extract.ts");
    text = (await extractFile({ path: file.name, name: file.name, ext, file, category: inferCategory(file.name, ext), topic: topicLabel(file.name) })).text;
  }
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error(`No text could be read from ${file.name}. A scanned PDF may need to go through your library sync instead.`);
  const truncated = text.length > MAX_ATTACHMENT_CHARS;
  return { name: file.name, text: truncated ? text.slice(0, MAX_ATTACHMENT_CHARS) : text, truncated };
}

/** Keeps the latest copy of each file name, at most MAX_ATTACHMENTS. */
export function mergeAttachments(existing: Attachment[], added: Attachment[]): Attachment[] {
  const byName = new Map<string, Attachment>();
  for (const a of [...existing, ...added]) {
    byName.delete(a.name);
    byName.set(a.name, a);
  }
  return [...byName.values()].slice(-MAX_ATTACHMENTS);
}

/**
 * The attachments as SOURCE MATERIAL blocks and as extracts, so the
 * assistant can cite them and the citation check can verify the quote.
 */
export function attachmentContext(attachments: Attachment[]): { block: string; extracts: [string, Extract][]; text: string } {
  const blocks: string[] = [];
  const extracts: [string, Extract][] = [];
  for (const a of attachments) {
    blocks.push(
      `### FILE: ${a.name} (attached by the student; not in their library)`,
      fenceUntrusted(a.name, a.truncated ? `${a.text}\n[...truncated...]` : a.text),
    );
    extracts.push([a.name, { path: a.name, text: a.text, chunks: [] }]);
  }
  return { block: blocks.join("\n\n"), extracts, text: attachments.map((a) => a.text).join("\n\n") };
}

export function parseAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (typeof a.name !== "string" || !a.name || typeof a.text !== "string") return null;
  return {
    name: a.name,
    text: a.text.slice(0, MAX_ATTACHMENT_CHARS),
    truncated: a.truncated === true || a.text.length > MAX_ATTACHMENT_CHARS,
    ...(typeof a.savedPath === "string" ? { savedPath: a.savedPath } : {}),
  };
}
