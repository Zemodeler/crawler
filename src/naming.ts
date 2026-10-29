/**
 * Course naming: where a course lands in My Studies/<year>/<module>/, and the
 * path-segment sanitiser everything else uses. See docs/design/03 (Layout).
 */

import type { Course, ModulePlacement } from "./types.ts";

const MAX_SEGMENT = 120;

/** First module code in a name: "ECS505U", "ECS401A" (QMUL), "COM1025" (Surrey). */
const CODE = /(?<![A-Za-z0-9])[A-Z]{3}\d{3,4}[A-Z]?(?![A-Za-z0-9])/;
/** A code plus any "/ECS401A"-style siblings right after it. */
const CODE_RUN = (code: string) => new RegExp(`${code}(?:\\s*/\\s*[A-Z]{3}\\d{3,4}[A-Z]?(?![A-Za-z0-9]))*`);
/** "2026/27", "2026-27", "2026/2027". */
const YEAR = /(?<!\d)(20\d{2})\s*[/\-–]\s*(?:20)?(\d{2})(?!\d)/;
const YEAR_ALL = new RegExp(YEAR.source, "g");

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

/** Decodes HTML entities in VLE names ("Domain &amp; Requirements"), in one pass. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** One file or folder name, safe on Windows and macOS. Never empty. */
export function sanitizeSegment(name: string): string {
  const trim = (s: string) => s.replace(/^[\s.]+|[\s.]+$/g, "");
  let clean = trim(
    name
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " "),
  );
  const chars = Array.from(clean);
  if (chars.length > MAX_SEGMENT) {
    // Keep a short extension so a truncated file still opens.
    const ext = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? "";
    clean = trim(chars.slice(0, MAX_SEGMENT - ext.length).join("")) + ext;
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(clean)) clean = `_${clean}`;
  return clean || "Untitled";
}

type CourseNames = Pick<Course, "fullname" | "shortname" | "startdate">;

/** "2026-27" from the course name, else the start date (years start 1 August), else "Undated". */
export function academicYear(course: CourseNames): string {
  const match = YEAR.exec(course.fullname ?? "") ?? YEAR.exec(course.shortname ?? "");
  if (match) return `${match[1]}-${match[2]}`;
  if (course.startdate) {
    // Moodle start dates are London midnight, which is 23:00 UTC in summer.
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric" }).formatToParts(
      new Date(course.startdate * 1000),
    );
    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value);
    const start = month >= 8 ? year : year - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  }
  return "Undated";
}

/** Module code, title and folder name for a course. */
export function placeCourse(course: CourseNames): ModulePlacement {
  const full = decodeEntities(course.fullname || course.shortname || "");
  const short = decodeEntities(course.shortname || "");
  const code = CODE.exec(full)?.[0] ?? CODE.exec(short)?.[0] ?? null;

  let title = full.replace(YEAR_ALL, " ");
  if (code) title = title.replace(CODE_RUN(code), " ");
  title = title
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+[-–—|:]\s+(?:[-–—|:]\s+)+/g, " - ")
    .replace(/^[\s\-–—:|/,]+|[\s\-–—:|/,]+$/g, "")
    .replace(/\s+/g, " ");
  if (!title && code) title = code;

  return {
    code,
    title,
    folder: sanitizeSegment(code && title !== code ? `${code} - ${title}` : title),
    year: academicYear(course),
    isModule: code !== null,
  };
}
