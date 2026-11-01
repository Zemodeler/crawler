/**
 * Asking the model about tutorial sheets: converting one sheet and its
 * official solutions into exercises linked to lecture slides, and writing a
 * beginner walkthrough of one part on request.
 *
 * STUB: the signatures are fixed; the bodies are written separately.
 */

import { AiError, type AiClient, type Progress } from "./ai/types.ts";
import type { LocalFile } from "./course-fs.ts";
import type { Exercise, SheetPair, TutorialPart, TutorialSheet } from "./tutorial.ts";

export type ConvertOptions = {
  client: AiClient;
  /** The module's display name, e.g. "ECS509U - Probability and Matrices". */
  module: string;
  pair: SheetPair;
  /** Every file of the module, to read the pair's files and list study packs. */
  files: LocalFile[];
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
};

export type ConvertResult = {
  sheet: TutorialSheet;
  /** Exercises left out because they broke a rule (no parts, no answer). */
  dropped: number;
  /** Slide links removed because the page did not exist or did not match. */
  droppedRefs: number;
  /** Files that could not be read. */
  unread: string[];
};

export async function convertSheet(options: ConvertOptions): Promise<ConvertResult> {
  void options;
  throw new AiError("unknown", "Converting tutorial sheets is not available yet.");
}

export type ExplainOptions = {
  client: AiClient;
  module: string;
  sheet: TutorialSheet;
  exercise: Exercise;
  part: TutorialPart;
  files: LocalFile[];
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
};

/** A beginner walkthrough of one part, in the reader's Markdown subset plus [[a b; c d]] matrices. */
export async function explainPart(options: ExplainOptions): Promise<string> {
  void options;
  throw new AiError("unknown", "Explanations are not available yet.");
}
