/**
 * Practice quizzes as Markdown: the questions of a demo or practice quiz on
 * the course site, kept with the past papers so Study Hub's practice papers
 * can copy how the real quiz asks its questions.
 *
 * The questions come from an attempt the student already has (the course site
 * renders a quiz only inside an attempt); none is ever started here. That HTML
 * also carries the student's saved answers, a session key and checksums; none
 * of it is kept. Each answer box becomes a numbered blank ([1], [2], …),
 * choices become a list, tables stay tables.
 */

import { decodeEntities } from "./extract/xml.ts";

/** One question as the quiz web service renders it. */
export type QuizQuestionHtml = { slot: number; type: string; number?: string | number | null; maxmark?: number | null; html: string };

/** The folder under Past Papers that holds practice quizzes read from the course site. */
export const PRACTICE_QUIZZES = "Practice quizzes";

/**
 * Quizzes made for practice. A real test is never one of these: it has an
 * ordinary name ("In-term test") and usually needs Safe Exam Browser.
 */
export function isPracticeQuiz(quiz: { name: string; browsersecurity?: string | null }): boolean {
  if (quiz.browsersecurity && quiz.browsersecurity !== "-") return false;
  return /\b(demo|practi[cs]e|mock|sample|example|formative|revision|trial|self[\s-]?(test|check|assessment))\b/i.test(quiz.name);
}

/** Removes every `<tag …>…</tag>` whose opening tag matches `open` (non-nested elements only). */
const dropElements = (html: string, tag: string, open: RegExp) =>
  html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), (element) => (open.test(element.slice(0, element.indexOf(">") + 1)) ? "" : element));

/** The text of one question's HTML, with its answer boxes as numbered blanks and its choices as a list. */
export function questionText(html: string): string {
  // Everything after the question is the page's script boilerplate.
  let body = html.split(/<script\b/i)[0] ?? "";
  // The info box (number, state, marks, flag) is replaced by the heading.
  const content = body.search(/<div class="content">/i);
  if (content >= 0) body = body.slice(content);
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|noscript)\b[\s\S]*?<\/\1>/gi, "")
    // Line breaks in the source are just spaces; only the tags break lines.
    .replace(/\s+/g, " ")
    // A table cell is one line, whatever paragraphs it holds.
    .replace(/(<t[dh]\b[^>]*>)([\s\S]*?)(<\/t[dh]>)/gi, (_m, open: string, inner: string, close: string) =>
      open + inner.replace(/<\/?(p|div|br)\b[^>]*>/gi, " ") + close);
  // Screen-reader-only labels ("Answer 1 Question 2"), legends and the "answer all parts" warning.
  body = dropElements(body, "label", /accesshide|sr-only/);
  body = dropElements(body, "legend", /./);
  body = dropElements(body, "h4", /accesshide|sr-only/);
  body = dropElements(body, "div", /validationerror|im-feedback|specificfeedback|rightanswer|outcome|generalfeedback/);
  body = dropElements(body, "span", /accesshide|sr-only/);
  // Every answer box is numbered in page order, whatever the student typed into it:
  // a text box is [n], a dropdown lists its choices, a text area is a written answer.
  let blank = 0;
  body = body.replace(/<select\b[^>]*>([\s\S]*?)<\/select>|<input\b[^>]*type="text"[^>]*>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, (box, options?: string) => {
    blank++;
    if (/^<textarea/i.test(box)) return `\n\n[${blank}: written answer]\n\n`;
    if (options === undefined) return ` [${blank}] `;
    const labels = [...options.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)]
      .map((o) => decodeEntities((o[1] ?? "").replace(/<[^>]+>/g, "")).trim())
      .filter((label) => label && !/^(choose|select)\b/i.test(label));
    return ` [${blank}: ${labels.join(" / ")}] `;
  });
  body = body
    // A choice: one list line per radio button or tick box.
    .replace(/<div\b[^>]*class="[^"]*\bform-check\b[^"]*"[^>]*>/gi, "\n- ( ) ")
    .replace(/<div\b[^>]*class="[^"]*\b(r0|r1)\b[^"]*"[^>]*>/gi, "\n- ( ) ")
    .replace(/<input\b[^>]*>/gi, "")
    .replace(/<img\b[^>]*alt="([^"]+)"[^>]*>/gi, " [image: $1] ")
    .replace(/<img\b[^>]*>/gi, " [image] ")
    .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, "^$1")
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, "_$1")
    // Bold keeps its surrounding spaces outside the markers ("**5** questions").
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "");
      const core = text.replace(/^(\s|&nbsp;)+|(\s|&nbsp;)+$/g, "");
      if (!core) return text;
      return `${/^(\s|&nbsp;)/.test(text) ? " " : ""}**${core}**${/(\s|&nbsp;)$/.test(text) ? " " : ""}`;
    })
    // Table cells side by side, rows on their own lines.
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/tr>/gi, " |")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h\d|table|thead|tbody|ul|ol|fieldset|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(body)
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .map((line) => line.replace(/\*\*\s*\*\*/g, "").replace(/^\|\s*\|$/, ""))
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // A list, and a table, stay together.
    .replace(/^(- .*)\n\n(?=- )/gm, "$1\n")
    .replace(/^(- .*)\n\n(?=- )/gm, "$1\n")
    .replace(/^(\|.*\|)\n+(?=\|)/gm, "$1\n")
    // The first row of each table is its header.
    .replace(/(^|\n\n)(\|.*\|)\n(?=\|)/g, (_m, before: string, head: string) =>
      `${before}${head}\n|${" --- |".repeat(head.split("|").length - 2)}\n`)
    .trim();
}

const marks = (value: number | null | undefined) => {
  if (!value) return "";
  const n = Number(value);
  return ` (${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "")} ${n === 1 ? "mark" : "marks"})`;
};

/** The quiz as one Markdown file, questions in quiz order. Null when no question has any text. */
export function quizMarkdown(title: string, url: string, questions: QuizQuestionHtml[]): string | null {
  const sections: string[] = [];
  for (const q of [...questions].sort((a, b) => a.slot - b.slot)) {
    const text = questionText(q.html);
    if (!text) continue;
    const info = q.type === "description" || q.number === undefined || q.number === null || q.number === "";
    sections.push(`## ${info ? "Information" : `Question ${q.number}${marks(q.maxmark)}`}\n\n${text}`);
  }
  if (!sections.some((s) => s.startsWith("## Question"))) return null;
  return [
    `# ${title}`,
    `A practice quiz from the course site: ${url}`,
    "Questions only, without answers. [1], [2], … mark the answer boxes in the order they appear; ( ) marks one choice of a multiple-choice part.",
    ...sections,
  ].join("\n\n") + "\n";
}
