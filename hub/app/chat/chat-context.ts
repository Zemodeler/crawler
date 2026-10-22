/**
 * Deterministic context scoping for the chat assistant.
 *
 * There is no vector store or search index anywhere in this app, and this
 * module does not add one: the scope is a lookup, not a search, built from the
 * open module's own files and the saved deadline list.
 */

import { deadlinesBlock, describeToday } from "../../lib/ai/chat-deadlines.ts";
import { fenceUntrusted } from "../../lib/ai/structured.ts";
import type { Deadline } from "../../lib/library.ts";
import { extractFile, type Extract } from "../../lib/source-extract.ts";
import type { LocalFile } from "../../lib/course-fs.ts";

export type ChatScope = {
  /** Named in the system prompt, e.g. `their module "ECS505U - Software Engineering"`. */
  scopeLabel: string;
  contextLabel: string;
  contextBlock: string;
  /** Every file whose text was actually included, for the "in scope" count. */
  linkedFiles: string[];
  /** The extracts + concatenated text actually in scope — checkChatGrounding
   *  verifies a citation against exactly this, never the whole course, so a
   *  citation can never "verify" against material the model was never given. */
  extracts: Map<string, Extract>;
  allText: string;
};

const MODULE_TEXT_BUDGET = 130_000;
const FILE_CAP = 26_000;
/** Slides and PDFs are fetched and read on demand, so they are bounded harder than text. */
const MAX_BINARY_FILES = 12;
const MAX_BINARY_BYTES = 15 * 1024 * 1024;

/** Hand-written study material first, then raw course documents. */
function readingOrder(file: LocalFile): number {
  if (file.category === "Study packs") return 0;
  if (file.ext === "md") return 1;
  if (file.ext === "txt" || file.ext === "csv") return 2;
  return 3;
}

/**
 * The scope for the always-available assistant: the whole module the student
 * has open, plus their saved deadline list. Deadlines are exposed to the model
 * as a pseudo-file named "Deadlines" so an answer can cite them exactly like a
 * course file and go through the same verbatim-quote check.
 */
export async function buildModuleScope(
  module: string,
  files: LocalFile[],
  deadlines: Deadline[],
  now: Date,
): Promise<ChatScope> {
  const deadlineText = [`Today is ${describeToday(now)}.`, "", deadlinesBlock(deadlines, now)].join("\n");
  const extracts = new Map<string, Extract>([["Deadlines", { path: "Deadlines", text: deadlineText, chunks: [] }]]);
  const linkedFiles: string[] = [];
  const blocks: string[] = [
    "### FILE: Deadlines (the student's saved deadline list across all their modules)",
    fenceUntrusted("Deadlines", deadlineText),
  ];

  let left = MODULE_TEXT_BUDGET;
  let binaries = 0;
  const unread: string[] = [];
  const ordered = [...files].sort(
    (a, b) => readingOrder(a) - readingOrder(b) || a.path.localeCompare(b.path, undefined, { numeric: true }),
  );
  for (const file of ordered) {
    const binary = file.text === undefined;
    if (left < 2_000 || (binary && (binaries >= MAX_BINARY_FILES || file.file.size > MAX_BINARY_BYTES))) {
      unread.push(file.path);
      continue;
    }
    if (binary) binaries++;
    const extract = await extractFile(file).catch(() => null);
    if (!extract?.text.trim()) {
      unread.push(file.path);
      continue;
    }
    // Citations are checked against exactly what the model was shown.
    const cap = Math.min(FILE_CAP, left);
    const text = extract.text.length > cap ? extract.text.slice(0, cap) : extract.text;
    extracts.set(file.path, { ...extract, text });
    linkedFiles.push(file.path);
    const shown = text.length < extract.text.length ? `${text}\n[...truncated...]` : text;
    blocks.push(`### FILE: ${file.name}`, fenceUntrusted(file.path, shown));
    left -= text.length;
  }
  if (unread.length)
    blocks.push(
      `### Course files not read into this chat (too many, too large, or no text):\n${unread.slice(0, 80).join("\n")}`,
    );

  return {
    scopeLabel: `their module "${module}" and their saved deadline list`,
    contextLabel: module,
    contextBlock: blocks.join("\n\n"),
    linkedFiles,
    extracts,
    allText: [...extracts.values()].map((e) => e.text).join("\n\n"),
  };
}
