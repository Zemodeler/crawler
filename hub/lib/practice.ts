/**
 * Practice papers: generated MCQ quizzes, simple exercises and mixed exam
 * papers, with marking, grades, a study pack of what was missed, and the
 * attempt history.
 *
 * Everything here is deterministic and browser-free apart from the two storage
 * functions at the bottom. The model only writes questions (see
 * practice-generate.ts); the score, the grade and the study pack are computed
 * here, so a grade never depends on a model's opinion of an answer. Written
 * answers are marked by the student against the model answer.
 */

export type PracticeKind = "exam" | "mcq" | "exercise";

export const KIND_LABELS: Record<PracticeKind, string> = {
  exam: "Exam paper",
  mcq: "MCQ quiz",
  exercise: "Simple exercises",
};

/**
 * One answer box of a fill-in question, in the style of the course site's
 * online quizzes: a number marked within a tolerance, a short text answer, or
 * a choice between options.
 */
export type Blank =
  | { kind: "number"; answer: number; tolerance: number }
  | { kind: "text"; answer: string; accept: string[] }
  | { kind: "choice"; options: string[]; correctIndex: number };

export type Question = {
  id: string;
  /** "cloze" is a fill-in question: its prompt holds [1], [2], … where each of `blanks` goes. */
  type: "mcq" | "short" | "cloze";
  topic: string;
  prompt: string;
  /** The answer boxes of a fill-in question, in the order their markers appear; absent otherwise. */
  blanks?: Blank[];
  /** The choices of an MCQ, already shuffled; empty for a written question. */
  options: string[];
  /** Index into `options`; -1 for a written question. */
  correctIndex: number;
  /** The worked or model answer of a written question; empty for an MCQ. */
  modelAnswer: string;
  explanation: string;
  marks: number;
};

export type Paper = {
  id: string;
  title: string;
  kind: PracticeKind;
  /** What the student asked for, kept so a paper is understandable later. */
  brief: string;
  createdAt: number;
  /** Paths of the files the questions were written from. */
  sources: string[];
  questions: Question[];
  /** Present only while a batched run is unfinished: how many questions the paper is meant to have. */
  draft?: { target: number };
};

export type SelfMark = "right" | "partly" | "wrong";
/** `blanks` holds a fill-in question's boxes in order: the typed text, or a choice's index as text. */
export type Answer = { choice?: number; text?: string; self?: SelfMark; blanks?: string[] };

export type Attempt = {
  id: string;
  paperId: string;
  title: string;
  kind: PracticeKind;
  createdAt: number;
  seconds: number;
  /** A copy of the questions, so the attempt outlives its paper being deleted. */
  questions: Question[];
  answers: Record<string, Answer>;
  score: number;
  total: number;
  percent: number;
  /** True when it was built from the missed questions of an earlier attempt. */
  retry?: boolean;
};

export type PracticeStore = { papers: Paper[]; attempts: Attempt[] };

export const EMPTY_STORE: PracticeStore = { papers: [], attempts: [] };

/* ---------------------------------------------------------------- marking */

export type Status = "correct" | "partial" | "wrong" | "skipped";

/**
 * A typed number: decimals with a point or a comma, an optional sign, a
 * fraction ("1/3") or a percentage ("33%" is 0.33). Null for anything else.
 */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/\s+/g, "").replace(/^\+/, "");
  if (!t) return null;
  const plain = (s: string) => (/^-?(\d+([.,]\d*)?|[.,]\d+)(e-?\d+)?$/i.test(s) ? Number(s.replace(",", ".")) : NaN);
  let value: number;
  const fraction = t.match(/^(-?[\d.,]+)\/(-?[\d.,]+)$/);
  if (fraction) value = plain(fraction[1]) / plain(fraction[2]);
  else if (t.endsWith("%")) value = plain(t.slice(0, -1)) / 100;
  else value = plain(t);
  return Number.isFinite(value) ? value : null;
}

const normalText = (text: string) => text.toLowerCase().replace(/\s+/g, "").replace(/[.]$/, "");

/** Whether one box was answered right. */
export function blankCorrect(blank: Blank, given: string | undefined): boolean {
  if (given === undefined || !given.trim()) return false;
  if (blank.kind === "choice") return Number(given) === blank.correctIndex;
  if (blank.kind === "text") return [blank.answer, ...blank.accept].some((a) => normalText(a) === normalText(given));
  const value = parseNumber(given);
  // A tiny allowance absorbs floating-point noise in answers like 0.1 + 0.2.
  return value !== null && Math.abs(value - blank.answer) <= blank.tolerance + Math.abs(blank.answer) * 1e-9 + 1e-12;
}

/** The right answer of one box, as the review shows it. */
export function blankAnswerText(blank: Blank): string {
  if (blank.kind === "choice") return blank.options[blank.correctIndex] ?? "";
  if (blank.kind === "text") return blank.answer;
  // As many decimal places as the margin needs, so 2/9 with ±0.005 reads 0.222, not 0.2222222222222222.
  const places = blank.tolerance > 0 ? Math.min(8, Math.max(0, Math.ceil(-Math.log10(blank.tolerance)))) : 8;
  const value = String(Number(blank.answer.toFixed(places)));
  return blank.tolerance > 0 ? `${value} (±${blank.tolerance})` : value;
}

/** What the student put in one box, as the review shows it. */
export function blankGivenText(blank: Blank, given: string | undefined): string {
  if (given === undefined || !given.trim()) return "No answer";
  return blank.kind === "choice" ? blank.options[Number(given)] ?? "No answer" : given.trim();
}

/** A fill-in prompt split into its text and its boxes ([1] is blank index 0). */
export function clozeParts(text: string): (string | { blank: number })[] {
  const parts: (string | { blank: number })[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ blank: Number(match[1]) - 1 });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function awarded(question: Question, answer: Answer | undefined): number {
  if (!answer) return 0;
  if (question.type === "mcq") return answer.choice === question.correctIndex ? question.marks : 0;
  if (question.type === "cloze") {
    const blanks = question.blanks ?? [];
    if (!blanks.length) return 0;
    const right = blanks.filter((b, i) => blankCorrect(b, answer.blanks?.[i])).length;
    // Each box is an equal share of the marks, to two decimals, as the course site marks it.
    return Math.round((question.marks * right * 100) / blanks.length) / 100;
  }
  if (answer.self === "right") return question.marks;
  if (answer.self === "partly") return question.marks / 2;
  return 0;
}

/** Whether a question has an answer, for the "unanswered" count and the skipped status. */
export function hasAnswer(question: Question, answer: Answer | undefined): boolean {
  if (question.type === "mcq") return answer?.choice !== undefined;
  if (question.type === "cloze") return Boolean(answer?.blanks?.some((b) => b?.trim()));
  return Boolean(answer?.text?.trim() || answer?.self);
}

export function statusOf(question: Question, answer: Answer | undefined): Status {
  const given = hasAnswer(question, answer);
  if (!given) return "skipped";
  const got = awarded(question, answer);
  if (got >= question.marks) return "correct";
  return got > 0 ? "partial" : "wrong";
}

export function scoreOf(questions: Question[], answers: Record<string, Answer>) {
  const total = questions.reduce((sum, q) => sum + q.marks, 0);
  const score = questions.reduce((sum, q) => sum + awarded(q, answers[q.id]), 0);
  return { score, total, percent: total ? Math.round((score / total) * 100) : 0 };
}

/** The written questions, which the student marks against the model answer. */
export function needsSelfMarking(paper: Pick<Paper, "questions">): Question[] {
  return paper.questions.filter((q) => q.type === "short");
}

/** UK degree classification, the scale the course papers are marked on. */
export function gradeBand(percent: number): { label: string; short: string } {
  if (percent >= 70) return { label: "First", short: "1st" };
  if (percent >= 60) return { label: "Upper second (2:1)", short: "2:1" };
  if (percent >= 50) return { label: "Lower second (2:2)", short: "2:2" };
  if (percent >= 40) return { label: "Third", short: "3rd" };
  return { label: "Fail", short: "Fail" };
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildAttempt(
  paper: Pick<Paper, "id" | "title" | "kind" | "questions">,
  answers: Record<string, Answer>,
  seconds: number,
  now = Date.now(),
  retry = false,
): Attempt {
  return {
    id: newId("attempt"),
    paperId: paper.id,
    title: paper.title,
    kind: paper.kind,
    createdAt: now,
    seconds: Math.max(0, Math.round(seconds)),
    questions: paper.questions,
    answers,
    ...scoreOf(paper.questions, answers),
    ...(retry ? { retry: true } : {}),
  };
}

/** A new paper made only of the questions the student did not get fully right. */
export function retryPaper(attempt: Attempt, now = Date.now()): Paper | null {
  const missed = attempt.questions.filter((q) => statusOf(q, attempt.answers[q.id]) !== "correct");
  if (!missed.length) return null;
  const kinds = new Set(missed.map((q) => q.type));
  const only = kinds.size === 1 ? [...kinds][0] : null;
  return {
    id: newId("paper"),
    title: `Missed questions from ${attempt.title}`,
    kind: only === "mcq" ? "mcq" : only === "short" ? "exercise" : "exam",
    brief: "The questions missed in an earlier attempt.",
    createdAt: now,
    sources: [],
    questions: missed,
  };
}

/* ------------------------------------------------------------- breakdowns */

export type TopicScore = { topic: string; got: number; total: number; percent: number };

/** Marks per topic across the given attempts, weakest first. */
export function topicScores(attempts: Attempt[]): TopicScore[] {
  const byTopic = new Map<string, { got: number; total: number }>();
  for (const attempt of attempts)
    for (const q of attempt.questions) {
      const entry = byTopic.get(q.topic) || { got: 0, total: 0 };
      entry.got += awarded(q, attempt.answers[q.id]);
      entry.total += q.marks;
      byTopic.set(q.topic, entry);
    }
  return [...byTopic.entries()]
    .map(([topic, { got, total }]) => ({ topic, got, total, percent: total ? Math.round((got / total) * 100) : 0 }))
    .sort((a, b) => a.percent - b.percent || b.total - a.total || a.topic.localeCompare(b.topic));
}

export type Progression = {
  count: number;
  average: number;
  best: number;
  latest: number;
  /** Latest minus the one before it; null with a single attempt. */
  sinceLast: number | null;
  /** Average of the most recent three minus the average of the first three; null under four attempts. */
  overall: number | null;
};

export function progression(attempts: Attempt[]): Progression | null {
  if (!attempts.length) return null;
  const ordered = [...attempts].sort((a, b) => a.createdAt - b.createdAt);
  const percents = ordered.map((a) => a.percent);
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    count: ordered.length,
    average: Math.round(mean(percents)),
    best: Math.max(...percents),
    latest: percents.at(-1)!,
    sinceLast: percents.length > 1 ? percents.at(-1)! - percents.at(-2)! : null,
    overall: percents.length >= 4 ? Math.round(mean(percents.slice(-3)) - mean(percents.slice(0, 3))) : null,
  };
}

/* ------------------------------------------------------------- study pack */

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One line of Markdown, so a model answer or a pasted block can never break the layout. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function yourAnswer(question: Question, answer: Answer | undefined): string {
  if (question.type === "mcq")
    return answer?.choice === undefined ? "No answer" : oneLine(question.options[answer.choice] ?? "No answer");
  if (question.type === "cloze")
    return (question.blanks ?? []).map((b, i) => `[${i + 1}] ${oneLine(blankGivenText(b, answer?.blanks?.[i]))}`).join("; ");
  return oneLine(answer?.text || "") || "No answer";
}

/** The right answer, as the study pack shows it. */
function correctAnswer(question: Question): string {
  if (question.type === "mcq") return question.options[question.correctIndex] ?? "";
  if (question.type === "cloze") return (question.blanks ?? []).map((b, i) => `[${i + 1}] ${blankAnswerText(b)}`).join("; ");
  return question.modelAnswer;
}

/**
 * The study pack: what was missed, why, and what to revise first. Plain
 * Markdown in the subset the reader renders, so it can be shown in the app,
 * downloaded, or saved into the module's notes unchanged.
 */
export function studyPackMarkdown(attempt: Attempt, date = new Date(attempt.createdAt)): string {
  const band = gradeBand(attempt.percent);
  const missed = attempt.questions.filter((q) => statusOf(q, attempt.answers[q.id]) !== "correct");
  const out: string[] = [
    `# Study pack: ${attempt.title}`,
    "",
    `Attempted ${date.toISOString().slice(0, 10)}. Score ${attempt.score}/${attempt.total} (${attempt.percent}%), grade ${band.short}. Time ${clock(attempt.seconds)}.`,
    "",
  ];
  if (!missed.length) {
    out.push("You got every question right. Nothing to revise from this paper; try a harder one or a new set.", "");
    return out.join("\n");
  }

  const weak = topicScores([attempt]).filter((t) => t.percent < 100);
  out.push("## Revise first", "");
  out.push("| Topic | Marks | Score |", "| --- | --- | --- |");
  for (const t of weak) out.push(`| ${oneLine(t.topic)} | ${t.got}/${t.total} | ${t.percent}% |`);
  out.push("");

  out.push(`## What you missed (${missed.length})`, "");
  missed.forEach((q, i) => {
    const status = statusOf(q, attempt.answers[q.id]);
    const correct = oneLine(correctAnswer(q));
    out.push(
      `### ${i + 1}. ${oneLine(q.topic)}${status === "partial" ? " (partly right)" : status === "skipped" ? " (skipped)" : ""}`,
      "",
      oneLine(q.prompt),
      "",
      `- **Your answer:** ${yourAnswer(q, attempt.answers[q.id])}`,
      `- **Correct answer:** ${correct}`,
      `- **Why:** ${oneLine(q.explanation)}`,
      "",
    );
  });

  out.push("## Recall list", "", "Cover the right-hand side and say each answer out loud.", "");
  out.push("| Question | Answer |", "| --- | --- |");
  for (const q of missed) {
    const correct = correctAnswer(q);
    out.push(`| ${oneLine(q.prompt).replace(/\|/g, "/")} | ${oneLine(correct).replace(/\|/g, "/")} |`);
  }
  out.push("");
  return out.join("\n");
}

/** A file name for the study pack that is safe on every OS. */
export function studyPackName(attempt: Attempt): string {
  const base = `Study pack - ${attempt.title}`.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base} (${new Date(attempt.createdAt).toISOString().slice(0, 10)})`;
}

/* ------------------------------------------------------------ persistence */

const storeKey = (course: string) => `studyhub:practice:${course}`;

export function loadStore(course: string): PracticeStore {
  try {
    const raw = localStorage.getItem(storeKey(course));
    if (!raw) return { papers: [], attempts: [] };
    const parsed = JSON.parse(raw) as Partial<PracticeStore>;
    return {
      papers: Array.isArray(parsed.papers) ? parsed.papers : [],
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
    };
  } catch {
    return { papers: [], attempts: [] };
  }
}

/** Returns false when the browser refused the write (storage full or blocked). */
export function saveStore(course: string, store: PracticeStore): boolean {
  try {
    localStorage.setItem(storeKey(course), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}
