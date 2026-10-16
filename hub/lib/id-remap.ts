/**
 * Keeping a student's review history when files are rewritten.
 *
 * Two identifiers in this app are derived from file content, which means
 * regenerating a file silently destroys the progress attached to it:
 *
 *   card id       = `${path}:${fnv1a(`${path}:${index}:${question}`)}`
 *   checkbox key  = `${path}:${lineIndex}`
 *
 * So a deck whose rows are reordered, or a pack with a line inserted near the
 * top, would lose weeks of spaced repetition and every ticked checklist item.
 *
 * The writer avoids the problem for decks by merging append-only (see
 * `mergeDeck`). This module handles the cases it cannot: a deliberate deck
 * regeneration, and any pack rewrite. It matches old to new by *text* — the
 * question, or the checklist item — and rewrites the stored keys in place.
 */

import { stableCardId } from "./course-format.ts";

export type CardMove = { path: string; oldIndex: number; oldQuestion: string; newIndex: number; newQuestion: string };
export type CheckMove = { path: string; oldLine: number; newLine: number };

export type RemapReport = {
  cardsMoved: number;
  cardsOrphaned: number;
  checksMoved: number;
  checksOrphaned: number;
};

type CardRecord = Record<string, unknown>;
type Progress = { cards?: Record<string, CardRecord>; checks?: Record<string, boolean> };
type FlashcardStats = { reviews?: Record<string, unknown>; starred?: Record<string, unknown> };

/** Text comparison that survives whitespace and smart-quote differences. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Work out how rows moved between two versions of a deck.
 *
 * Exact text match first, then normalised, so a row that only changed its
 * punctuation still carries its history across.
 */
export function planCardMoves(path: string, oldRows: string[][], newRows: string[][]): CardMove[] {
  const oldCards = oldRows.slice(1).map((row, index) => ({ index, question: (row[0] || "").trim() }));
  const newCards = newRows.slice(1).map((row, index) => ({ index, question: (row[0] || "").trim() }));
  const takenNew = new Set<number>();
  const moves: CardMove[] = [];

  const claim = (old: { index: number; question: string }, match: { index: number; question: string }) => {
    takenNew.add(match.index);
    if (old.index !== match.index || old.question !== match.question)
      moves.push({
        path,
        oldIndex: old.index,
        oldQuestion: old.question,
        newIndex: match.index,
        newQuestion: match.question,
      });
  };

  const unmatched: typeof oldCards = [];
  for (const old of oldCards) {
    const exact = newCards.find((card) => !takenNew.has(card.index) && card.question === old.question);
    if (exact) claim(old, exact);
    else unmatched.push(old);
  }
  for (const old of unmatched) {
    const needle = normalise(old.question);
    const loose = newCards.find((card) => !takenNew.has(card.index) && normalise(card.question) === needle);
    if (loose) claim(old, loose);
  }
  return moves;
}

/** Checklist lines move whenever a pack is rewritten; match them by their text. */
export function planCheckMoves(path: string, oldText: string, newText: string): CheckMove[] {
  const checkboxes = (text: string) => {
    const found: { line: number; label: string }[] = [];
    text.replace(/\r/g, "").split("\n").forEach((line, index) => {
      const match = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.*)/);
      if (match) found.push({ line: index, label: normalise(match[1]) });
    });
    return found;
  };
  const before = checkboxes(oldText);
  const after = checkboxes(newText);
  const taken = new Set<number>();
  const moves: CheckMove[] = [];
  for (const old of before) {
    const match = after.find((entry) => !taken.has(entry.line) && entry.label === old.label);
    if (!match) continue;
    taken.add(match.line);
    if (match.line !== old.line) moves.push({ path, oldLine: old.line, newLine: match.line });
  }
  return moves;
}

/**
 * Apply the moves to everything stored in localStorage for this course.
 *
 * Both stores are rewritten together — the home page keeps `cards` and `checks`
 * under `studyhub:<course>`, and the flashcard app keeps `reviews` and
 * `starred` under `studyhub:flashcards:<course>`. Missing one of them would
 * leave the dashboard and the flashcard app disagreeing about the same card.
 */
export function applyMoves(course: string, cardMoves: CardMove[], checkMoves: CheckMove[]): RemapReport {
  const report: RemapReport = { cardsMoved: 0, cardsOrphaned: 0, checksMoved: 0, checksOrphaned: 0 };
  if (typeof window === "undefined" || (!cardMoves.length && !checkMoves.length)) return report;

  const cardRenames = new Map<string, string>();
  for (const move of cardMoves) {
    const from = stableCardId(move.path, move.oldIndex, move.oldQuestion);
    const to = stableCardId(move.path, move.newIndex, move.newQuestion);
    if (from !== to) cardRenames.set(from, to);
  }
  const checkRenames = new Map<string, string>();
  for (const move of checkMoves) checkRenames.set(`${move.path}:${move.oldLine}`, `${move.path}:${move.newLine}`);

  /** Renames keys in place; an unmatched key is left alone rather than dropped. */
  const rekey = <T,>(record: Record<string, T> | undefined, renames: Map<string, string>) => {
    if (!record) return { next: record, moved: 0, orphaned: 0 };
    const next: Record<string, T> = {};
    let moved = 0;
    let orphaned = 0;
    for (const [key, value] of Object.entries(record)) {
      const target = renames.get(key);
      if (target) {
        next[target] = value;
        moved++;
      } else {
        next[key] = value;
        // Only count keys that belonged to a file we rewrote.
        if ([...renames.keys()].some((from) => from.split(":")[0] === key.split(":")[0])) orphaned++;
      }
    }
    return { next, moved, orphaned };
  };

  try {
    const progressKey = `studyhub:${course}`;
    const progress = JSON.parse(localStorage.getItem(progressKey) || "{}") as Progress;
    const cards = rekey(progress.cards, cardRenames);
    const checks = rekey(progress.checks, checkRenames);
    report.cardsMoved += cards.moved;
    report.cardsOrphaned += cards.orphaned;
    report.checksMoved += checks.moved;
    report.checksOrphaned += checks.orphaned;
    localStorage.setItem(
      progressKey,
      JSON.stringify({ ...progress, cards: cards.next, checks: checks.next }),
    );

    const statsKey = `studyhub:flashcards:${course}`;
    const stats = JSON.parse(localStorage.getItem(statsKey) || "{}") as FlashcardStats;
    const reviews = rekey(stats.reviews, cardRenames);
    const starred = rekey(stats.starred, cardRenames);
    report.cardsMoved += reviews.moved;
    localStorage.setItem(
      statsKey,
      JSON.stringify({ ...stats, reviews: reviews.next, starred: starred.next }),
    );
  } catch {
    // Corrupt saved progress must not take the whole write down with it.
  }
  return report;
}

export function describeRemap(report: RemapReport): string {
  if (!report.cardsMoved && !report.checksMoved && !report.cardsOrphaned) return "";
  const parts: string[] = [];
  if (report.cardsMoved) parts.push(`${report.cardsMoved} cards kept their review history`);
  if (report.checksMoved) parts.push(`${report.checksMoved} ticked items were carried over`);
  if (report.cardsOrphaned)
    parts.push(`${report.cardsOrphaned} cards' history could not be matched and was left in place`);
  return `${parts.join(", ")}.`;
}
