/**
 * Contracts for M4 (Google Calendar sync). The OAuth/API client and the
 * deadline-to-event sync are built against this interface, so the sync is
 * tested with a fake client and no network. See docs/design/05.
 *
 * Source files use only erasable TypeScript, so Node runs them directly.
 */

export type CalendarEventTime = { date?: string; dateTime?: string; timeZone?: string };

/** What Crawler writes. `crawlerId` is Deadline.id; `crawlerHash` fingerprints the content written. */
export type CalendarEventInput = {
  summary: string;
  description: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  extendedProperties: { private: { crawlerId: string; crawlerHash: string } };
};

export type RemoteEvent = CalendarEventInput & {
  id: string;
  etag: string;
  status?: "confirmed" | "tentative" | "cancelled";
};

/** The only calendar operations the sync needs. All act on Crawler's own calendar. */
export interface CalendarClient {
  /** Finds or creates the secondary calendar named `name`; returns its id. */
  ensureCalendar(name: string): Promise<string>;
  listEvents(calendarId: string): Promise<RemoteEvent[]>;
  insert(calendarId: string, event: CalendarEventInput): Promise<RemoteEvent>;
  /** Sends If-Match with `etag`; returns "precondition-failed" when the event changed since. */
  update(
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
    etag: string,
  ): Promise<RemoteEvent | "precondition-failed">;
  delete(calendarId: string, eventId: string): Promise<void>;
}

/** Persists the OAuth refresh token (OS credential store in the app). */
export interface CalendarTokenStore {
  load(): Promise<{ refreshToken: string } | null>;
  save(token: { refreshToken: string }): Promise<void>;
  clear(): Promise<void>;
}

export type CalendarSyncReport = {
  created: string[]; // Deadline ids
  updated: string[];
  deleted: string[];
  unchanged: number;
  /** Events the student edited in Google Calendar; left alone and reported. */
  editedByUser: { crawlerId: string; summary: string }[];
  skipped: { crawlerId: string; reason: string }[]; // e.g. needs-check, tbc without a window
};
