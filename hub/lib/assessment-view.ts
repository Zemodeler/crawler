/**
 * What the Assessments page draws, as plain data: where deadlines sit on the
 * eight-week timeline, the segments of a module's weight bar, and the words
 * beside each readiness bar.
 *
 * Everything here is pure so it can be tested without a browser. The three
 * readiness bars are kept apart on purpose: nothing in this file combines
 * cards, exercises and papers into one score.
 */

import type { PracticeView } from "./exam-focus.ts";
import type { CardEvidence, ExerciseEvidence, Kind, PaperEvidence, TopicReadiness } from "./readiness.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Midnight (UTC-based) of the London calendar day, so two instants subtract to whole days. */
export function londonDayStart(at: number): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return Date.parse(`${day}T00:00:00Z`);
}

/* ----------------------------------------------------------------- timeline */

export const TIMELINE_WEEKS = 8;

/** Two dots closer than this share of the strip's width go on separate rows. */
const DOT_GAP = 0.03;
const MAX_LANES = 4;

export type TimelineEntry = {
  id: string;
  /** When it falls (a week-only deadline: the first day of its week); null when it has no date. */
  at: number | null;
};

export type TimelineDot = {
  id: string;
  /** Whole London days from today; 0 for today and for anything already under way. */
  day: number;
  /** 0 to 1 across the strip. */
  pos: number;
  /** Row, from 0, so close dots do not sit on top of each other. */
  lane: number;
};

export type TimelineTick = { week: number; pos: number; label: string };

export type Timeline = {
  ticks: TimelineTick[];
  dots: TimelineDot[];
  lanes: number;
  /** Ids further away than the strip reaches, soonest first. */
  later: string[];
  /** Ids with no date. */
  undated: string[];
};

/** The next `weeks` weeks from `now`, with each dated entry placed by its London day. */
export function buildTimeline(entries: TimelineEntry[], now: number, weeks = TIMELINE_WEEKS): Timeline {
  const today = londonDayStart(now);
  const span = weeks * 7;
  const ticks: TimelineTick[] = [];
  for (let week = 0; week <= weeks; week++) {
    const label = week === 0
      ? "Today"
      : new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(today + week * 7 * DAY);
    ticks.push({ week, pos: (week * 7) / span, label });
  }

  const dated = entries
    .filter((e): e is { id: string; at: number } => e.at !== null && Number.isFinite(e.at))
    .map((e) => ({ id: e.id, at: e.at, day: Math.max(0, Math.round((londonDayStart(e.at) - today) / DAY)) }))
    .sort((a, b) => a.day - b.day || a.at - b.at || a.id.localeCompare(b.id));

  const dots: TimelineDot[] = [];
  const lastInLane: number[] = [];
  for (const e of dated.filter((d) => d.day < span)) {
    const pos = (e.day + 0.5) / span;
    let lane = lastInLane.findIndex((last) => pos - last >= DOT_GAP);
    if (lane < 0) lane = Math.min(lastInLane.length, MAX_LANES - 1);
    lastInLane[lane] = pos;
    dots.push({ id: e.id, day: e.day, pos, lane });
  }
  return {
    ticks,
    dots,
    lanes: Math.max(1, lastInLane.length),
    later: dated.filter((d) => d.day >= span).map((d) => d.id),
    undated: entries.filter((e) => e.at === null || !Number.isFinite(e.at)).map((e) => e.id),
  };
}

/** A DOM id safe to put in an attribute and look up again from a deadline id. */
export const anchorId = (id: string) => `dl-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/* ------------------------------------------------------------------ countdown */

/** "In 3 days" as a big "3" over a small "days"; one-word labels ("Tomorrow") are all big. */
export function bigCountdown(label: string): { big: string; small: string } {
  const match = label.match(/^In (\d+) (days?|weeks?|hours?)$/);
  return match ? { big: match[1], small: match[2] } : { big: label, small: "" };
}

/* -------------------------------------------------------------- weight stack */

/** Segments narrower than this share of the bar show only their percent. */
const COMPACT_BELOW = 14;

export type StackInput = { label: string; weight: number | null };

export type StackSegment = {
  label: string;
  /** The weight as listed, for the text. */
  percent: number;
  /** The segment's width as a share of the whole bar (0 to 100). */
  share: number;
  /** Too narrow for the description: show the percent only. */
  compact: boolean;
  /** False for the part of the module no listed component accounts for. */
  listed: boolean;
};

export type Stack = {
  segments: StackSegment[];
  /** Components with no weight, shown as text beside the bar. */
  unweighted: string[];
  total: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A module's assessment components as one bar across the module. Weights that
 * add up to less than 100 leave a "Not listed" remainder; more than 100 (a
 * data error) is scaled down to fit while the text keeps the listed figures.
 */
export function stackSegments(components: StackInput[]): Stack {
  const weighted = components.filter((c) => c.weight !== null && Number.isFinite(c.weight) && c.weight > 0);
  const total = weighted.reduce((sum, c) => sum + (c.weight as number), 0);
  const whole = Math.max(total, 100);
  const make = (label: string, weight: number, listed: boolean): StackSegment => {
    const share = round1((weight / whole) * 100);
    return { label, percent: round1(weight), share, compact: share < COMPACT_BELOW, listed };
  };
  const segments = weighted.map((c) => make(c.label, c.weight as number, true));
  if (total > 0 && 100 - total >= 0.5) segments.push(make("Not listed", 100 - total, false));
  return {
    segments,
    unweighted: components.filter((c) => c.weight === null || !Number.isFinite(c.weight)).map((c) => c.label),
    total: round1(total),
  };
}

/* ---------------------------------------------------------------- readiness */

export const NO_MATERIAL = "—";

export type BarView = {
  /** Fill, 0 to 100; null when there is nothing of this kind to measure. */
  value: number | null;
  text: string;
};

const percentOf = (strength: number) => Math.round(Math.min(1, Math.max(0, strength)) * 100);

export function cardsBar(c: CardEvidence | null): BarView {
  if (!c) return { value: null, text: NO_MATERIAL };
  return { value: percentOf(c.strength), text: `${c.reviewed} of ${c.total} reviewed${c.weak ? `, ${c.weak} weak` : ""}` };
}

export function exercisesBar(e: ExerciseEvidence | null): BarView {
  if (!e) return { value: null, text: NO_MATERIAL };
  return { value: percentOf(e.strength), text: `${e.done} of ${e.total} done` };
}

export function papersBar(p: PaperEvidence | null): BarView {
  if (!p) return { value: null, text: NO_MATERIAL };
  const value = percentOf(p.strength);
  return { value, text: `${value}% on last ${p.attempts === 1 ? "paper" : "papers"}` };
}

export const KIND_TITLE: Record<Kind, string> = { cards: "Cards", exercises: "Exercises", papers: "Papers" };

/** The two (or `count`) topics that most need work: real topics with something to practise, weakest first. */
export function weakestTopics(topics: TopicReadiness[], count = 2): TopicReadiness[] {
  return topics
    .filter((t) => !t.other && t.level !== "none")
    .sort((a, b) => b.priority - a.priority || a.number - b.number || a.name.localeCompare(b.name))
    .slice(0, count);
}

/**
 * Where a topic's link goes: its cards when it has any (weak ones first, then
 * unseen ones), else its tutorial exercises, else a paper on it.
 */
export function topicTarget(topic: Pick<TopicReadiness, "cards" | "exercises">): { view: PracticeView; mode?: string } {
  if (topic.cards) {
    const c = topic.cards;
    return { view: "cards", mode: c.weak ? "weak" : c.reviewed < c.total ? "unseen" : "smart" };
  }
  if (topic.exercises) return { view: "tutorials" };
  return { view: "papers" };
}
