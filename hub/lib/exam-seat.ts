/**
 * Where and when a student sits an exam, from what the course site already
 * published: a room list keyed by student ID (Queen Mary posts these as a PDF
 * or spreadsheet in the module), and the timing lines the deadline quotes.
 *
 * Pure functions only: the host reads the files, the assessments page shows
 * the result. Nothing here leaves the student's computer.
 */

/** A room found next to the student's ID in one module file. */
export type SeatMatch = {
  /** Library-relative path of the file the room came from. */
  path: string;
  /** 1-based page (or sheet) the ID is on. */
  page: number;
  /** The rest of the line after the ID, e.g. "TB-G02". */
  room: string;
  /** File modification time, ms since epoch. */
  modified: number;
};

/** Queen Mary student IDs are 9 digits; allow a little either side for other formats. */
export function validStudentId(value: string): boolean {
  return /^\d{6,12}$/.test(value.trim());
}

/** File names worth searching for a room list. */
export function isLocationFile(path: string): boolean {
  const name = path.split("/").pop() || "";
  return /\.(pdf|xlsx|xls|csv|docx|html?|txt)$/i.test(name) && /locat|room|seat|venue|arrang|allocat/i.test(name);
}

const SEPARATORS = /^[\s|,;:\t\-–]+|[\s|,;:\t\-–]+$/g;

/**
 * Rooms on the lines where `id` appears as a whole number (so 250658790 never
 * matches inside 1250658790). The room is what is left on the line.
 */
export function seatsInText(pages: { page: number; text: string }[], id: string): { page: number; room: string }[] {
  const wanted = id.trim();
  if (!validStudentId(wanted)) return [];
  const pattern = new RegExp(`(^|\\D)${wanted}(?!\\d)`);
  const found: { page: number; room: string }[] = [];
  for (const { page, text } of pages) {
    for (const line of text.split(/\r?\n/)) {
      if (!pattern.test(line)) continue;
      const room = line.replace(wanted, " ").replace(/\s+/g, " ").replace(SEPARATORS, "").slice(0, 80);
      if (room) found.push({ page, room });
    }
  }
  return found;
}

/** "mid" for in-term and mid-term tests, "end" for end-term and final ones. */
function termOf(text: string): "mid" | "end" | null {
  const t = text.toLowerCase();
  if (/\b(in|mid)[\s_-]?term\b|\bmidterm\b|\binterm\b/.test(t)) return "mid";
  if (/\bend[\s_-]?term\b|\bendterm\b|\bfinal\b/.test(t)) return "end";
  return null;
}

/**
 * The room for one exam. A file that names a different test (an end-term list
 * for an in-term test) is left out. A file that names no test belongs to the
 * next exam after it appeared, so one that arrived before `notBefore` (when the
 * module's previous exam ended) is left out too. The newest remaining file
 * wins, so this year's list beats last year's.
 */
export function seatFor(matches: SeatMatch[], examTitle: string, notBefore = -Infinity): SeatMatch | null {
  const exam = termOf(examTitle);
  const kept = matches.filter((m) => {
    const term = termOf(m.path.split("/").pop() || "");
    if (exam && term) return term === exam;
    return m.modified >= notBefore;
  });
  return kept.sort((a, b) => b.modified - a.modified)[0] ?? null;
}

/**
 * Quoted lines that add detail to the exam time ("open from 11:10, start at
 * 11:15 and close at 12:45"): undated quotes that mention a clock time, minus
 * any about a different test. At most two, without repeats.
 */
export function timingNotes(examTitle: string, sources: { quote: string; date: unknown }[]): string[] {
  const exam = termOf(examTitle);
  const notes: string[] = [];
  for (const s of sources) {
    const quote = s.quote?.replace(/\s+/g, " ").trim();
    if (!quote || s.date || !/\b\d{1,2}[:.]\d{2}\b/.test(quote)) continue;
    const term = termOf(quote);
    if (exam && term && term !== exam) continue;
    if (!notes.includes(quote)) notes.push(quote);
    if (notes.length === 2) break;
  }
  return notes;
}

/** Only Queen Mary publishes room lists this way; its deadline ids start with "qmul:". */
export const isQmDeadline = (d: { id: string }) => d.id.startsWith("qmul:");
