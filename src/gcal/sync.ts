/**
 * Google Calendar sync: makes Crawler's own calendar follow Deadlines.json
 * through the injected CalendarClient. Events are matched by
 * extendedProperties.private.crawlerId; events the student edited (content no
 * longer matching the stored crawlerHash, or an etag precondition failure) are
 * left alone and reported. Events without a crawlerId are never touched.
 * Several events can share a crawlerId (a retried insert, a copied event):
 * the first is the deadline's own event, untouched extra copies are deleted
 * and edited extra copies are left alone and reported.
 * See docs/design/05 (Google Calendar).
 */

import type { CalendarClient, CalendarSyncReport, RemoteEvent } from "../calendar-types.ts";
import type { Deadline } from "../types.ts";
import { contentHash, deadlineToEvent } from "./events.ts";

const DEFAULT_CALENDAR = "University deadlines";

export async function syncCalendar(
  client: CalendarClient,
  deadlines: Deadline[],
  opts: { calendarName?: string; vleLabel?: string } = {},
): Promise<CalendarSyncReport> {
  const report: CalendarSyncReport = {
    created: [],
    updated: [],
    deleted: [],
    unchanged: 0,
    editedByUser: [],
    skipped: [],
  };
  const calendarId = await client.ensureCalendar(opts.calendarName ?? DEFAULT_CALENDAR);

  const remote = new Map<string, RemoteEvent[]>();
  for (const event of await client.listEvents(calendarId)) {
    if (event.status === "cancelled") continue;
    const crawlerId = event.extendedProperties?.private?.crawlerId;
    if (!crawlerId) continue;
    const copies = remote.get(crawlerId);
    if (copies) copies.push(event);
    else remote.set(crawlerId, [event]);
  }

  const deleteAll = async (crawlerId: string, copies: RemoteEvent[]): Promise<void> => {
    for (const event of copies) await client.delete(calendarId, event.id);
    report.deleted.push(crawlerId);
  };

  const wanted = new Set<string>();
  for (const deadline of deadlines) {
    if (wanted.has(deadline.id)) continue;
    wanted.add(deadline.id);
    const copies = remote.get(deadline.id) ?? [];
    const [existing, ...extras] = copies;
    const desired = deadlineToEvent(deadline, opts.vleLabel ? { vleLabel: opts.vleLabel } : {});

    if ("skip" in desired) {
      report.skipped.push({ crawlerId: deadline.id, reason: desired.skip });
      if (deadline.status === "cancelled" && copies.length > 0) await deleteAll(deadline.id, copies);
      continue;
    }

    let removedExtra = false;
    for (const extra of extras) {
      if (contentHash(extra) === extra.extendedProperties?.private?.crawlerHash) {
        await client.delete(calendarId, extra.id);
        removedExtra = true;
      } else {
        report.editedByUser.push({ crawlerId: deadline.id, summary: extra.summary });
      }
    }
    if (removedExtra) report.deleted.push(deadline.id);

    if (!existing) {
      await client.insert(calendarId, desired);
      report.created.push(deadline.id);
      continue;
    }

    const want = desired.extendedProperties.private.crawlerHash;
    const stored = existing.extendedProperties?.private?.crawlerHash;
    const actual = contentHash(existing);
    if (actual === want) {
      report.unchanged++;
      continue;
    }
    if (actual !== stored) {
      report.editedByUser.push({ crawlerId: deadline.id, summary: existing.summary });
      continue;
    }
    const result = await client.update(calendarId, existing.id, desired, existing.etag);
    if (result === "precondition-failed") {
      report.editedByUser.push({ crawlerId: deadline.id, summary: existing.summary });
    } else {
      report.updated.push(deadline.id);
    }
  }

  for (const [crawlerId, copies] of remote) {
    if (!wanted.has(crawlerId)) await deleteAll(crawlerId, copies);
  }
  return report;
}
