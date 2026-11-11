/**
 * Work with no date at all is still work to do. A formative lab sheet or a
 * "weekly exercises" line on the course site never gets a day, so any list
 * that only shows dated items (the next 7 days, a module's next deadline)
 * silently drops it. These helpers find those items so the lists can show
 * them as to-dos instead.
 */

import type { Deadline } from "./library.ts";

/** Neither a due date nor a teaching week: it cannot be placed on a calendar. */
export const isUndated = (d: Pick<Deadline, "due" | "window">) => d.due === null && !d.window;

/**
 * Open undated to-dos for the given module codes: not done, not cancelled,
 * formative work first (it is the work most often forgotten), then by module
 * and title.
 */
export function undatedTodos(deadlines: Deadline[], codes: Iterable<string>): Deadline[] {
  const wanted = new Set(codes);
  return deadlines
    .filter((d) => wanted.has(d.module) && d.status !== "cancelled" && !d.done && isUndated(d))
    .sort((a, b) =>
      Number(Boolean(b.formative)) - Number(Boolean(a.formative)) ||
      a.module.localeCompare(b.module) ||
      a.title.localeCompare(b.title));
}
