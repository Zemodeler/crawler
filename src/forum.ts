/**
 * Forum posts the sync keeps. The adapter reads every forum; most of it is
 * chatter, so only three kinds survive and the rest is thrown away:
 *
 *  - a staff post about an assessment or exam, or one that gives a date;
 *  - a staff post that explains something from the module (long enough to teach);
 *  - any post, from anyone, that is about a deadline or exam date. A student's
 *    is kept as unverified and never feeds the deadlines.
 *
 * Kept text is trimmed hard: storage is the cost of keeping a forum.
 */

import { htmlToText } from "./extract/index.ts";
import { parseDatesInText } from "./quotes.ts";
import type { VleItem } from "./types.ts";

export type ForumPost = Extract<VleItem, { kind: "forum-post" }>;

export type ForumReason = "exam" | "deadline" | "explanation";

export type ForumHighlight = {
  url: string;
  forum: string;
  subject: string;
  author: string;
  staff: boolean | null;
  /** False when a student or unknown author wrote it: a pointer to check, not a source. */
  verified: boolean;
  reason: ForumReason;
  posted: string; // ISO
  replyTo?: string;
  text: string;
};

const EXAM_RE = /\b(exams?|examination|mid-?terms?|in-?class tests?|class test|tests?|quiz(?:zes)?|resits?|re-?sits?|revision|past papers?|mock)\b/i;
const ASSESS_RE = /\b(deadline|due|submit(?:ted|ting)?|submission|extension|extended|coursework|assignments?|assessments?|presentation|viva|demo|hand-?in|cut-?off)\b/i;
const EXPLAIN_RE =
  /\b(because|for example|e\.g\.|in the lecture|lecture \d+|slides?|note that|to clarify|the reason|remember that|as (?:we|I) (?:said|discussed|covered)|in other words|the difference|formula|algorithm|proof|step \d|the answer)\b/i;

const MIN_STAFF = 90; // shorter staff posts ("Thanks!", "See you Monday") carry nothing
const MIN_EXPLANATION = 200;
const MAX_CHARS = { exam: 700, deadline: 700, explanation: 1400 } as const;
const MAX_PER_COURSE = 60;

/** Quoted lines, "On … wrote:" headers and sign-offs add nothing to a stored post. */
export function trimPostText(text: string, max: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(">") && !/^(on .+ wrote:|sent from my )/i.test(l));
  while (lines.length > 1 && /^(thanks|thank you|regards|best( wishes)?|kind regards|many thanks|cheers)[,.! ]*$/i.test(lines.at(-1)!)) lines.pop();
  const flat = lines.join("\n");
  return flat.length <= max ? flat : `${flat.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** Why a post is worth keeping, or null to throw it away. */
export function forumRelevance(post: ForumPost): { reason: ForumReason; verified: boolean } | null {
  const text = `${post.subject}\n${htmlToText(post.bodyHtml)}`;
  const body = htmlToText(post.bodyHtml).length;
  const dated = parseDatesInText(text).length > 0;
  const exam = EXAM_RE.test(text);
  const assessment = ASSESS_RE.test(text);
  const staff = post.staff === true;

  // Anyone's post about an exam or a deadline, when it also names a date or asks when.
  const aboutDates = (exam || assessment) && (dated || /\bwhen\b|\bwhat (?:day|date|time)\b/i.test(text));
  if (aboutDates) return { reason: exam ? "exam" : "deadline", verified: staff };
  if (!staff) return null;

  if (exam && body >= MIN_STAFF) return { reason: "exam", verified: true };
  if (assessment && dated) return { reason: "deadline", verified: true };
  if (body >= MIN_EXPLANATION && (EXPLAIN_RE.test(text) || post.replyTo !== "")) return { reason: "explanation", verified: true };
  return null;
}

export type ForumSelection = {
  /** The items with every forum post that is not kept removed. */
  items: VleItem[];
  highlights: ForumHighlight[];
};

/** Keeps the relevant forum posts (at most MAX_PER_COURSE: staff first, then newest) and drops the rest. */
export function selectForumPosts(items: VleItem[]): ForumSelection {
  const scored = items.flatMap((item) => {
    if (item.kind !== "forum-post") return [];
    const why = forumRelevance(item);
    return why ? [{ item, ...why }] : [];
  });
  scored.sort((a, b) => Number(b.verified) - Number(a.verified) || b.item.posted - a.item.posted);
  const kept = scored.slice(0, MAX_PER_COURSE);
  const keptUrls = new Set(kept.map((k) => k.item.url));

  const highlights: ForumHighlight[] = kept
    .map(({ item, reason, verified }) => ({
      url: item.url,
      forum: item.forum,
      subject: item.subject,
      author: item.author,
      staff: item.staff,
      verified,
      reason,
      posted: new Date(item.posted * 1000).toISOString(),
      ...(item.replyTo ? { replyTo: item.replyTo.slice(0, 120) } : {}),
      text: trimPostText(htmlToText(item.bodyHtml), MAX_CHARS[reason]),
    }))
    .sort((a, b) => a.posted.localeCompare(b.posted));

  return { items: items.filter((i) => i.kind !== "forum-post" || keptUrls.has(i.url)), highlights };
}
