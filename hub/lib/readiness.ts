/**
 * How ready a student is, per topic, from everything Practice records:
 * flashcard reviews, practice-paper attempts and tutorial exercises.
 *
 * The three kinds of evidence stay separate. A topic reports its own card,
 * exercise and paper figures and the screens show them as separate bars;
 * nothing here combines them into one percentage to display. The module's
 * subject only decides how much each kind counts when topics are ordered and
 * when the best next thing to practise is chosen (cards matter most in law,
 * exercises in STEM).
 *
 * Everything is pure and computed on read from the three stores, so there is no
 * fourth copy of progress that can drift from them.
 *
 * Topics come from the module's study packs and numbered deck folders, joined on
 * `canonicalTopicKey` exactly as the rest of the hub does. Papers and tutorial
 * exercises name their topic in free text, so those are matched to a topic by
 * the words they share; one that matches nothing, or matches two topics equally
 * well, is kept under "Other" rather than guessed.
 */

import { canonicalTopicKey, inferCategory, topicLabel, topicName } from "./course-format.ts";
import { keywords, overlap, type PracticeView } from "./exam-focus.ts";
import { awarded, type Attempt } from "./practice.ts";
import type { SubjectId } from "./subject-profiles.ts";
import { exerciseKey, type TutorialProgress, type TutorialSheet } from "./tutorial.ts";

export type Kind = "cards" | "exercises" | "papers";

/** A card rated this or lower counts as weak. */
export const WEAK_AT_OR_BELOW = 2;

/** How much a card is worth by its last confidence rating (1 to 5); an unreviewed card is worth nothing. */
const CARD_VALUE = [0, 0, 0.25, 0.5, 0.75, 1];

/** Papers look at the latest few attempts that touched a topic, so improving shows up. */
const RECENT_ATTEMPTS = 3;

export const OTHER_KEY = "other";

/** How much each kind of evidence counts when ordering topics, by subject. Each row sums to 1. */
export const KIND_WEIGHTS: Readonly<Record<SubjectId, Readonly<Record<Kind, number>>>> = {
  law: { cards: 0.5, exercises: 0.15, papers: 0.35 },
  stem: { cards: 0.2, exercises: 0.45, papers: 0.35 },
  humanities: { cards: 0.3, exercises: 0.15, papers: 0.55 },
  general: { cards: 0.34, exercises: 0.33, papers: 0.33 },
};

/* ----------------------------------------------------------------- evidence */

export type CardEvidence = {
  total: number;
  reviewed: number;
  weak: number;
  mastered: number;
  /** Sum of every card's worth; `strength` is this over `total`. */
  points: number;
  /** 0 to 1: how well the topic's cards are known, counting unreviewed cards as unknown. */
  strength: number;
};

export type ExerciseEvidence = {
  total: number;
  /** Marked right, partly or wrong. */
  done: number;
  right: number;
  partly: number;
  wrong: number;
  points: number;
  strength: number;
};

export type PaperEvidence = {
  /** Attempts counted: the latest few that included this topic. */
  attempts: number;
  got: number;
  total: number;
  strength: number;
  /** When the latest counted attempt was made. */
  latest: number;
};

export type Level = "none" | "new" | "weak" | "building" | "strong";

export const LEVEL_LABEL: Record<Level, string> = {
  none: "Nothing to practise",
  new: "Not started",
  weak: "Needs work",
  building: "Getting there",
  strong: "On track",
};

export type TopicReadiness = {
  key: string;
  name: string;
  /** Leading number of the topic's folder, for ordering; large when it has none. */
  number: number;
  /** True for the bucket of exercises and questions that matched no topic. */
  other: boolean;
  cards: CardEvidence | null;
  exercises: ExerciseEvidence | null;
  papers: PaperEvidence | null;
  /** Module-relative paths of the topic's flashcard decks. */
  decks: string[];
  /** `exerciseKey`s of the topic's tutorial exercises. */
  exerciseKeys: string[];
  /** 0 (nothing left to do) to 1 (all of it still to do), by subject weights. Only for ordering. */
  priority: number;
  level: Level;
};

/* ------------------------------------------------------------------- topics */

type Registered = { key: string; name: string; number: number };

/** The module's topics: those with a study pack, and the numbered deck folders. A loose deck belongs to none. */
function registerTopics(files: { path: string }[], deckPaths: string[]): Registered[] {
  const topics = new Map<string, Registered>();
  const add = (path: string) => {
    const key = canonicalTopicKey(path);
    if (topics.has(key)) return;
    const number = Number(topicLabel(path).match(/^(\d{1,2})\s*[-–.]/)?.[1] ?? 99);
    topics.set(key, { key, name: topicName(path), number });
  };
  for (const f of files) {
    const ext = f.path.split(".").pop()?.toLowerCase();
    if (ext === "md" && inferCategory(f.path, ext) === "Study packs") add(f.path);
  }
  for (const path of deckPaths) if (topics.has(canonicalTopicKey(path)) || /^\d{1,2}\s*[-–.]/.test(topicLabel(path))) add(path);
  return [...topics.values()];
}

/**
 * The topic a free-text topic name belongs to: an exact match on the canonical
 * key first, then the topic sharing the most words. A tie, or no shared word,
 * is null.
 */
export function matchTopic(text: string, topics: { key: string; name: string }[]): string | null {
  const exact = topics.find((t) => t.key === canonicalTopicKey(text));
  if (exact) return exact.key;
  const wanted = keywords(text);
  if (!wanted.length) return null;
  const scored = topics
    .map((t) => ({ key: t.key, score: overlap(wanted, t.name) + overlap(keywords(t.name), text) }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].key;
}

/* -------------------------------------------------------------------- build */

export type ReadinessInput = {
  /** The module's files (module-relative paths), to find the study-pack topics. */
  files: { path: string }[];
  /** Module-relative CSV path -> number of cards in it. */
  cardCounts: Record<string, number>;
  /** Card id (`<csv path>:<hash>`) -> review. */
  reviews: Record<string, { confidence: number }>;
  sheets: TutorialSheet[];
  progress: Pick<TutorialProgress, "marks">;
  attempts: Attempt[];
  subject?: SubjectId;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function priorityOf(t: Pick<TopicReadiness, "cards" | "exercises" | "papers">, subject: SubjectId): number {
  const weights = KIND_WEIGHTS[subject];
  let sum = 0;
  let weight = 0;
  for (const kind of ["cards", "exercises", "papers"] as const) {
    const evidence = t[kind];
    if (!evidence) continue;
    sum += weights[kind] * (1 - evidence.strength);
    weight += weights[kind];
  }
  return weight ? sum / weight : 0;
}

function levelOf(t: Pick<TopicReadiness, "cards" | "exercises" | "papers" | "priority">): Level {
  if (!t.cards && !t.exercises && !t.papers) return "none";
  const touched = (t.cards?.reviewed ?? 0) > 0 || (t.exercises?.done ?? 0) > 0 || (t.papers?.attempts ?? 0) > 0;
  if (!touched) return "new";
  const ready = 1 - t.priority;
  return ready < 0.4 ? "weak" : ready < 0.7 ? "building" : "strong";
}

/** Every topic of the module with its evidence, the ones needing most work first. */
export function buildReadiness(input: ReadinessInput): TopicReadiness[] {
  const subject = input.subject ?? "general";
  const topics = registerTopics(input.files, Object.keys(input.cardCounts));

  type Build = {
    t: Registered;
    other: boolean;
    cards: { total: number; reviewed: number; weak: number; mastered: number; points: number } | null;
    exercises: { total: number; right: number; partly: number; wrong: number } | null;
    questions: Map<string, { got: number; total: number; at: number }>;
    decks: string[];
    exerciseKeys: string[];
  };
  const builds = new Map<string, Build>();
  const build = (t: Registered, other = false) => {
    let b = builds.get(t.key);
    if (!b) builds.set(t.key, (b = { t, other, cards: null, exercises: null, questions: new Map(), decks: [], exerciseKeys: [] }));
    return b;
  };
  for (const t of topics) build(t);
  const other = (): Build => build({ key: OTHER_KEY, name: "Other", number: 100 }, true);
  const bucket = (text: string): Build => {
    const key = matchTopic(text, topics);
    return key ? build(topics.find((t) => t.key === key)!) : other();
  };

  // Cards: a deck belongs to its folder's topic; reviews belong to a deck by their id's path.
  const perDeck = new Map<string, { reviewed: number; weak: number; mastered: number; points: number }>();
  for (const [id, review] of Object.entries(input.reviews)) {
    const deck = id.slice(0, id.lastIndexOf(":"));
    const entry = perDeck.get(deck) || { reviewed: 0, weak: 0, mastered: 0, points: 0 };
    const confidence = Math.min(5, Math.max(1, Math.round(review.confidence)));
    entry.reviewed++;
    entry.points += CARD_VALUE[confidence];
    if (confidence <= WEAK_AT_OR_BELOW) entry.weak++;
    if (confidence === 5) entry.mastered++;
    perDeck.set(deck, entry);
  }
  for (const [path, total] of Object.entries(input.cardCounts)) {
    if (total <= 0) continue;
    const key = canonicalTopicKey(path);
    const registered = topics.find((t) => t.key === key);
    if (!registered) continue;
    const b = build(registered);
    const seen = perDeck.get(path) || { reviewed: 0, weak: 0, mastered: 0, points: 0 };
    // Reviews of cards that have since left the deck cannot count for more than the deck holds.
    const scale = seen.reviewed > total ? total / seen.reviewed : 1;
    const c = (b.cards ||= { total: 0, reviewed: 0, weak: 0, mastered: 0, points: 0 });
    c.total += total;
    c.reviewed += Math.min(seen.reviewed, total);
    c.weak += Math.round(seen.weak * scale);
    c.mastered += Math.round(seen.mastered * scale);
    c.points += seen.points * scale;
    b.decks.push(path);
  }

  // Tutorial exercises.
  for (const sheet of input.sheets)
    for (const exercise of sheet.exercises) {
      const b = bucket(exercise.topic);
      const e = (b.exercises ||= { total: 0, right: 0, partly: 0, wrong: 0 });
      e.total++;
      const key = exerciseKey(sheet, exercise);
      b.exerciseKeys.push(key);
      const mark = input.progress.marks[key];
      if (mark) e[mark]++;
    }

  // Papers: per topic, the latest few attempts that included it.
  const recent = [...input.attempts].sort((a, b) => b.createdAt - a.createdAt);
  const used = new Map<string, number>();
  for (const attempt of recent) {
    const seen = new Map<string, { b: Build; got: number; total: number }>();
    for (const q of attempt.questions) {
      const b = bucket(q.topic);
      const entry = seen.get(b.t.key) || { b, got: 0, total: 0 };
      entry.got += awarded(q, attempt.answers[q.id]);
      entry.total += q.marks;
      seen.set(b.t.key, entry);
    }
    for (const [key, { b, got, total }] of seen) {
      if ((used.get(key) || 0) >= RECENT_ATTEMPTS || total <= 0) continue;
      used.set(key, (used.get(key) || 0) + 1);
      b.questions.set(attempt.id, { got, total, at: attempt.createdAt });
    }
  }

  const result: TopicReadiness[] = [];
  for (const b of builds.values()) {
    const cards: CardEvidence | null = b.cards && {
      ...b.cards,
      strength: clamp01(b.cards.points / b.cards.total),
    };
    const exercises: ExerciseEvidence | null = b.exercises && {
      ...b.exercises,
      done: b.exercises.right + b.exercises.partly + b.exercises.wrong,
      points: b.exercises.right + b.exercises.partly * 0.5,
      strength: clamp01((b.exercises.right + b.exercises.partly * 0.5) / b.exercises.total),
    };
    let papers: PaperEvidence | null = null;
    if (b.questions.size) {
      const all = [...b.questions.values()];
      const got = all.reduce((s, q) => s + q.got, 0);
      const total = all.reduce((s, q) => s + q.total, 0);
      papers = { attempts: all.length, got, total, strength: clamp01(got / total), latest: Math.max(...all.map((q) => q.at)) };
    }
    if (b.other && !exercises && !papers) continue;
    const partial = { cards, exercises, papers };
    const priority = priorityOf(partial, subject);
    result.push({
      key: b.t.key,
      name: b.t.name,
      number: b.t.number,
      other: b.other,
      ...partial,
      decks: b.decks,
      exerciseKeys: b.exerciseKeys,
      priority,
      level: levelOf({ ...partial, priority }),
    });
  }
  return result.sort(
    (a, b) =>
      Number(a.other) - Number(b.other) ||
      b.priority - a.priority ||
      a.number - b.number ||
      a.name.localeCompare(b.name),
  );
}

/* --------------------------------------------------------------------- exam */

export type NextAction = {
  kind: Kind;
  topic: string;
  topicKey: string;
  label: string;
  detail: string;
  /** Where to send the student: pass to `practiceHref("practice", { view, topic, mode })`. */
  view: PracticeView;
  mode?: string;
};

export type ExamReadiness = {
  /** The topics the exam is about, the ones needing most work first. */
  topics: TopicReadiness[];
  /** True when the exam's own wording picked the topics; false when it names none and all are used. */
  named: boolean;
  cards: CardEvidence | null;
  exercises: ExerciseEvidence | null;
  papers: PaperEvidence | null;
  next: NextAction | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The most useful single thing to do for one topic, or null when it has nothing to practise from. */
export function nextActionFor(topic: TopicReadiness, subject: SubjectId = "general"): NextAction | null {
  if (topic.other) return null;
  const w = KIND_WEIGHTS[subject];
  const gaps: { kind: Kind; gap: number }[] = [];
  if (topic.cards) gaps.push({ kind: "cards", gap: w.cards * (1 - topic.cards.strength) });
  if (topic.exercises && (topic.exercises.done < topic.exercises.total || topic.exercises.strength < 1))
    gaps.push({ kind: "exercises", gap: w.exercises * (1 - topic.exercises.strength) });
  if (topic.papers) gaps.push({ kind: "papers", gap: w.papers * (1 - topic.papers.strength) });
  // A topic with a study pack but no cards or exercises can still be tested with a paper.
  if (!topic.cards && !topic.exercises && !topic.papers) gaps.push({ kind: "papers", gap: 1 });
  const best = gaps.sort((a, b) => b.gap - a.gap)[0];
  if (!best || best.gap <= 0) return null;
  const base = { kind: best.kind, topic: topic.name, topicKey: topic.key };
  if (best.kind === "cards" && topic.cards) {
    const c = topic.cards;
    const fresh = c.total - c.reviewed;
    return {
      ...base,
      label: c.weak ? `Revisit ${plural(c.weak, "weak card")} on ${topic.name}` : fresh ? `Learn ${plural(fresh, "new card")} on ${topic.name}` : `Review ${topic.name} cards`,
      detail: [c.weak ? plural(c.weak, "weak card") : "", fresh ? `${fresh} not reviewed yet` : ""].filter(Boolean).join(" · ") || `${c.total} cards`,
      view: "cards",
      mode: c.weak ? "weak" : fresh ? "unseen" : "smart",
    };
  }
  if (best.kind === "exercises" && topic.exercises) {
    const e = topic.exercises;
    return {
      ...base,
      label: `Do the ${topic.name} exercises`,
      detail: [e.total - e.done ? `${e.total - e.done} not tried yet` : "", e.wrong ? `${e.wrong} marked wrong` : ""].filter(Boolean).join(" · ") || `${e.total} exercises`,
      view: "tutorials",
    };
  }
  return {
    ...base,
    label: `Take a ${topic.name} paper`,
    detail: topic.papers ? `${Math.round(topic.papers.strength * 100)}% on your last papers` : "No papers on this topic yet",
    view: "papers",
  };
}

/**
 * Readiness for one exam or test: the evidence summed over the topics its
 * title and component name mention (all topics when they name none), and the
 * one thing to do next.
 */
export function examReadiness(topics: TopicReadiness[], examText: string, subject: SubjectId = "general"): ExamReadiness {
  const real = topics.filter((t) => !t.other);
  const wanted = keywords(examText);
  const named = real.filter((t) => overlap(wanted, t.name) > 0);
  const chosen = (named.length ? named : real).sort((a, b) => b.priority - a.priority || a.number - b.number || a.name.localeCompare(b.name));

  let cards: CardEvidence | null = null;
  let exercises: ExerciseEvidence | null = null;
  const marks = { got: 0, total: 0, attempts: 0, latest: 0, any: false };
  for (const t of chosen) {
    if (t.cards) {
      cards ||= { total: 0, reviewed: 0, weak: 0, mastered: 0, points: 0, strength: 0 };
      cards.total += t.cards.total;
      cards.reviewed += t.cards.reviewed;
      cards.weak += t.cards.weak;
      cards.mastered += t.cards.mastered;
      cards.points += t.cards.points;
    }
    if (t.exercises) {
      exercises ||= { total: 0, done: 0, right: 0, partly: 0, wrong: 0, points: 0, strength: 0 };
      exercises.total += t.exercises.total;
      exercises.done += t.exercises.done;
      exercises.right += t.exercises.right;
      exercises.partly += t.exercises.partly;
      exercises.wrong += t.exercises.wrong;
      exercises.points += t.exercises.points;
    }
    if (t.papers) {
      marks.any = true;
      marks.got += t.papers.got;
      marks.total += t.papers.total;
      marks.attempts += t.papers.attempts;
      marks.latest = Math.max(marks.latest, t.papers.latest);
    }
  }
  if (cards) cards.strength = clamp01(cards.points / cards.total);
  if (exercises) exercises.strength = clamp01(exercises.points / exercises.total);
  const papers: PaperEvidence | null = marks.any
    ? { attempts: marks.attempts, got: marks.got, total: marks.total, strength: clamp01(marks.got / marks.total), latest: marks.latest }
    : null;

  let next: NextAction | null = null;
  for (const t of chosen) {
    next = nextActionFor(t, subject);
    if (next) break;
  }
  return { topics: chosen, named: named.length > 0, cards, exercises, papers, next };
}
