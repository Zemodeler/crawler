/**
 * Contracts for M3 (text extraction, candidates, quote verification, AI
 * extraction). Shared by the extraction, rules and AI modules so they can be
 * built independently. See docs/design/04.
 *
 * Source files use only erasable TypeScript, so Node runs them directly.
 */

import type { Deadline, Instant } from "./types.ts";

/** One page of extracted text: a PDF page, a slide, a sheet, or 1 for flat text. */
export type PageText = { page: number; text: string };

export type ExtractedDocument = {
  sha256: string; // of the file bytes; the cache key
  format: "pdf" | "pptx" | "docx" | "xlsx" | "html" | "text";
  pages: PageText[];
};

/** Text the candidate finders read: a document, an announcement or a page. */
export type TextSource = {
  type: "document" | "announcement" | "page";
  title: string;
  url: string; // link back into the VLE
  localPath?: string; // relative to My Studies, forward slashes
  pages: PageText[];
};

/** A teaching-week calendar for one term; week 1 starts on `termStart`. */
export type TermWeekMap = {
  termStart: string; // ISO date (YYYY-MM-DD) of the Monday of teaching week 1
  readingWeeks: number[]; // teaching weeks skipped in the numbering, e.g. [7]
  source: { kind: "config" | "quote"; quote?: string; url?: string };
};

/**
 * A possible deadline found in text, before quote verification.
 * `date` is null when the text gives a week or nothing resolvable.
 */
export type DateCandidate = {
  origin: "rule" | "ai";
  title: string;
  kind: Deadline["kind"];
  date: Instant | null;
  weekNumber?: number; // "due week 9" -> 9, resolved through a TermWeekMap when known
  weekMapSource?: TermWeekMap["source"]; // set when `date` came from a week number
  weight?: number;
  formative?: boolean;
  quote: string; // verbatim from the text, 5-40 words
  sourceType: TextSource["type"];
  url: string;
  localPath?: string;
  page?: number;
  tbcReason?: string; // why no date, when `date` is null
};

export type RejectedCandidate = { candidate: DateCandidate; reason: string };

export type VerificationResult = {
  verified: DateCandidate[];
  rejected: RejectedCandidate[];
};
