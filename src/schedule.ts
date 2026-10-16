/**
 * Sync schedule: when the next background sync is due, and the "last synced
 * N days ago" line the UI shows. Pure functions; the desktop shell owns the timer.
 * See docs/design/05 (Sync schedule).
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A sync found due within this long of its slot ran on schedule; later than
 * that, the slot was missed (laptop off, app closed) and it is a catch-up.
 */
const ON_TIME_MS = HOUR_MS;

export type SyncSchedule = { everyDays: 1 | 3 | 7 };

export type SyncDue = {
  due: boolean;
  reason: "never-synced" | "catch-up" | "scheduled" | "not-due";
  /** When the next sync should run: now when due, else last sync + everyDays. */
  nextAt: Date;
};

/**
 * Whether a sync is due. Never synced is due; otherwise due once the last
 * successful sync is `everyDays` old. An unreadable timestamp counts as never synced.
 */
export function syncDue(lastSuccessfulSyncAt: string | null, now: Date, schedule: SyncSchedule): SyncDue {
  const last = lastSuccessfulSyncAt === null ? NaN : Date.parse(lastSuccessfulSyncAt);
  if (Number.isNaN(last)) return { due: true, reason: "never-synced", nextAt: new Date(now.getTime()) };
  const slot = last + schedule.everyDays * DAY_MS;
  const late = now.getTime() - slot;
  if (late < 0) return { due: false, reason: "not-due", nextAt: new Date(slot) };
  return { due: true, reason: late <= ON_TIME_MS ? "scheduled" : "catch-up", nextAt: new Date(now.getTime()) };
}

function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** "last synced 2 days ago", "last synced just now", "never synced". */
export function describeFreshness(last: string | null, now: Date): string {
  const at = last === null ? NaN : Date.parse(last);
  if (Number.isNaN(at)) return "never synced";
  const elapsed = Math.max(0, now.getTime() - at);
  if (elapsed < MINUTE_MS) return "last synced just now";
  if (elapsed < HOUR_MS) return `last synced ${ago(Math.floor(elapsed / MINUTE_MS), "minute")}`;
  if (elapsed < DAY_MS) return `last synced ${ago(Math.floor(elapsed / HOUR_MS), "hour")}`;
  return `last synced ${ago(Math.floor(elapsed / DAY_MS), "day")}`;
}
