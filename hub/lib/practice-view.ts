/**
 * The pure parts of the Practice section: tab names, the address it writes
 * back, how a topic's three kinds of evidence read as text, and the mapping
 * between a flashcard topic and the tutorial exercises on the same topic.
 *
 * The screens in app/practice only draw what these functions return. Nothing
 * here combines cards, exercises and papers into one percentage; each bar is
 * one kind of evidence on its own.
 */

import { canonicalTopicKey, parseCSV } from "./course-format.ts";
import { PRACTICE_VIEWS, type PracticeView } from "./exam-focus.ts";
import {
  OTHER_KEY,
  buildReadiness,
  matchTopic,
  nextActionFor,
  type CardEvidence,
  type ExerciseEvidence,
  type Kind,
  type NextAction,
  type PaperEvidence,
  type TopicReadiness,
} from "./readiness.ts";
import type { SubjectId } from "./subject-profiles.ts";
import type { TutorialProgress, TutorialSheet } from "./tutorial.ts";

/* --------------------------------------------------------------------- tabs */

/** The tab row of the Practice section, in plain words. */
export const VIEW_LABEL: Record<PracticeView, string> = {
  dashboard: "Dashboard",
  cards: "Cards",
  papers: "Papers",
  tutorials: "Tutorial sheets",
  essays: "Essays",
};

export const VIEW_ORDER: readonly PracticeView[] = PRACTICE_VIEWS;

/** The flashcard app's own screens, inside the Cards view. */
export type CardTab = "home" | "study" | "browse" | "stats";

export const CARD_TABS: readonly { id: CardTab; label: string }[] = [
  { id: "home", label: "Overview" },
  { id: "study", label: "Study" },
  { id: "browse", label: "Browse" },
  { id: "stats", label: "Stats" },
];

export const CARD_MODES = ["smart", "random", "progressive", "due", "weak", "unseen", "starred"] as const;
export type CardMode = (typeof CARD_MODES)[number];

export const isCardMode = (value: string): value is CardMode => (CARD_MODES as readonly string[]).includes(value);

/**
 * The query string `/practice` keeps in the address bar for a view. The module
 * stays; the rest of the old address (sources, exam, an earlier topic) belongs
 * to the way the student arrived and is dropped, so a reload shows the same tab
 * without re-applying it. A topic or card mode the student just chose is kept.
 */
export function practiceSearch(search: string, next: { view: PracticeView; topic?: string; mode?: string }): string {
  const old = new URLSearchParams(search);
  const query = new URLSearchParams();
  query.set("view", next.view);
  if (next.view === "cards" && next.mode) query.set("mode", next.mode);
  if (next.topic) query.set("topic", next.topic);
  const moduleKey = old.get("module");
  if (moduleKey) query.set("module", moduleKey);
  return `?${query.toString()}`;
}

/** What the New paper brief starts with when a topic sent the student here. */
export const focusBrief = (topic: string): string => (topic ? `Focus on ${topic}` : "");

/* -------------------------------------------------------------------- cards */

/** Cards per deck, counted the way the cards page reads a deck: rows with a question and an answer. */
export function countCards(files: { path: string; ext: string; text?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (f.ext !== "csv" || !f.text) continue;
    const rows = parseCSV(f.text.charCodeAt(0) === 0xfeff ? f.text.slice(1) : f.text);
    const heads = rows[0]?.map((h) => h.trim().toLowerCase()) || [];
    const q = heads.indexOf("question");
    const a = heads.indexOf("answer");
    if (q < 0 || a < 0) continue;
    counts[f.path] = rows.slice(1).filter((r) => r[q]?.trim() && r[a]?.trim()).length;
  }
  return counts;
}

/** The reviews the cards page saved, from its localStorage text; anything unreadable is no reviews. */
export function parseReviews(raw: string | null): Record<string, { confidence: number }> {
  try {
    const reviews = (JSON.parse(raw || "null") as { reviews?: Record<string, { confidence?: unknown }> } | null)?.reviews;
    if (!reviews || typeof reviews !== "object") return {};
    const out: Record<string, { confidence: number }> = {};
    for (const [id, review] of Object.entries(reviews))
      if (review && typeof review.confidence === "number" && Number.isFinite(review.confidence)) out[id] = { confidence: review.confidence };
    return out;
  } catch {
    return {};
  }
}

/** The card categories (folder names) that are this topic. Empty when the topic has no cards. */
export function topicCategories(categories: string[], topic: string): string[] {
  const wanted = canonicalTopicKey(topic);
  return categories.filter((c) => canonicalTopicKey(c) === wanted);
}

/* ---------------------------------------------------------------- the bars */

export type Bar = {
  /** 0 to 100 for the fill, or null when there is nothing of this kind (draw a dash). */
  percent: number | null;
  /** The figure beside the bar: "12 of 40 reviewed, 5 weak". "–" when there is no material. */
  text: string;
  /** What a screen reader hears when there is no material. */
  empty: string;
};

const NONE = "–";
const pct = (strength: number) => Math.round(Math.min(1, Math.max(0, strength)) * 100);

export function cardsBar(c: CardEvidence | null): Bar {
  if (!c) return { percent: null, text: NONE, empty: "No cards on this topic" };
  return {
    percent: pct(c.strength),
    text: `${c.reviewed} of ${c.total} reviewed${c.weak ? `, ${c.weak} weak` : ""}`,
    empty: "",
  };
}

export function exercisesBar(e: ExerciseEvidence | null): Bar {
  if (!e) return { percent: null, text: NONE, empty: "No tutorial exercises on this topic" };
  return {
    percent: pct(e.strength),
    text: `${e.done} of ${e.total} done${e.wrong ? `, ${e.wrong} missed` : ""}`,
    empty: "",
  };
}

export function papersBar(p: PaperEvidence | null): Bar {
  if (!p) return { percent: null, text: NONE, empty: "No papers on this topic yet" };
  return { percent: pct(p.strength), text: `${pct(p.strength)}% on last ${p.attempts === 1 ? "paper" : "papers"}`, empty: "" };
}

export const BAR_LABEL: Record<Kind, string> = { cards: "Cards", exercises: "Exercises", papers: "Papers" };

export function barFor(topic: TopicReadiness, kind: Kind): Bar {
  return kind === "cards" ? cardsBar(topic.cards) : kind === "exercises" ? exercisesBar(topic.exercises) : papersBar(topic.papers);
}

/* ---------------------------------------------------------------- dashboard */

/** The topics to list (weakest first, as buildReadiness orders them) and the Other bucket, which is shown last. */
export function splitTopics(list: TopicReadiness[]): { topics: TopicReadiness[]; other: TopicReadiness | null } {
  return { topics: list.filter((t) => !t.other), other: list.find((t) => t.other || t.key === OTHER_KEY) || null };
}

/** The "Do next" action: the first real topic, weakest first, that has something worth doing. */
export function doNext(list: TopicReadiness[], subject: SubjectId = "general"): NextAction | null {
  for (const topic of list) {
    if (topic.other) continue;
    const action = nextActionFor(topic, subject);
    if (action) return action;
  }
  return null;
}

/** True when there is nothing at all to practise from yet: no cards, exercises or papers anywhere. */
export function hasNoMaterial(list: TopicReadiness[]): boolean {
  return !list.some((t) => t.cards || t.exercises || t.papers);
}

/* -------------------------------------------------------------- cross-links */

/**
 * Readiness from the module's files and converted sheets alone, with no card
 * reviews or papers. Enough to say which topic an exercise belongs to and
 * whether that topic has cards or exercises, which is all the cross-links need.
 */
export function topicsForSheets(
  files: { path: string; ext: string; text?: string }[],
  sheets: TutorialSheet[],
  progress: Pick<TutorialProgress, "marks"> = { marks: {} },
  subject: SubjectId = "general",
): TopicReadiness[] {
  return buildReadiness({ files, cardCounts: countCards(files), reviews: {}, sheets, progress, attempts: [], subject });
}

/** The exercises (`exerciseKey`s) of the topic with this name, or null when the module has no such topic. */
export function exerciseKeysFor(topics: TopicReadiness[], topicName: string): string[] | null {
  const key = canonicalTopicKey(topicName);
  const topic = topics.find((t) => !t.other && t.key === key);
  return topic ? topic.exerciseKeys : null;
}

/** The topic an exercise belongs to, or null when it is under Other. */
export function topicOfExercise(topics: TopicReadiness[], exerciseKey: string): TopicReadiness | null {
  return topics.find((t) => !t.other && t.exerciseKeys.includes(exerciseKey)) || null;
}

/** The name to open the Cards view filtered to for this exercise, or null when its topic has no cards. */
export function reviseTarget(topics: TopicReadiness[], exerciseKey: string): string | null {
  const topic = topicOfExercise(topics, exerciseKey);
  return topic && topic.cards ? topic.name : null;
}

/**
 * How many tutorial exercises each card category has, matched the way the
 * readiness screen does: the exercise's own topic text against the category
 * name. Used on a study card, where only the categories are at hand.
 */
export function exercisesByCategory(categories: string[], sheets: TutorialSheet[]): Record<string, number> {
  const topics = categories.map((name) => ({ key: canonicalTopicKey(name), name }));
  const counts: Record<string, number> = {};
  for (const sheet of sheets)
    for (const exercise of sheet.exercises) {
      const key = matchTopic(exercise.topic, topics);
      if (!key) continue;
      for (const t of topics) if (t.key === key) counts[t.name] = (counts[t.name] || 0) + 1;
    }
  return counts;
}
