import assert from "node:assert/strict";
import { test } from "node:test";

import { flagLegacyAiDate, repairAutomaticWeekDates } from "../src/revalidate-week-dates.ts";
import type { Deadline, Instant, Source } from "../src/types.ts";
import { weekMapFor } from "../src/weeks.ts";

const map = weekMapFor("qmul", "2026-27 Semester A")!;
const day = (date: string): Instant => ({ iso: `${date}T00:00:00.000Z`, allDay: true, tz: "Europe/London" });
const wrong = day("2026-11-02");
const right = day("2026-11-30");

function source(quote: string, date: Instant | null = wrong, origin?: Source["origin"]): Source {
  return {
    type: "document", strength: "quoted", url: "https://example.edu/brief", quote, date,
    seenAt: "2026-10-20T00:00:00.000Z", ...(origin ? { origin } : {}),
  };
}

function deadline(sources: Source[], due: Instant | null = wrong): Deadline {
  return {
    id: "qmul:text:1", module: "ECS505U", year: "2026-27", title: "Coursework",
    kind: "coursework", status: "confirmed", due, sources, history: [],
    userNote: "Check the brief", done: true,
  };
}

test("repairs legacy AI release and feedback weeks without losing provenance or student fields", () => {
  const old = deadline([
    source("Coursework is released in week 7; the deadline will be announced later.", wrong, "ai"),
    source("Week 7 feedback for the coursework will appear in the module materials."),
    source("Week 7 lecture notes for the coursework are available on the VLE."),
  ]);
  const fixed = repairAutomaticWeekDates(old, map);
  assert.equal(fixed.due, null);
  assert.equal(fixed.status, "tbc");
  assert.deepEqual(fixed.sources.map((s) => s.date), [null, null, null]);
  assert.equal(fixed.sources[0]!.origin, "ai");
  assert.equal(fixed.sources[0]!.quote, old.sources[0]!.quote);
  assert.equal(fixed.userNote, "Check the brief");
  assert.equal(fixed.done, true);
  assert.equal(old.sources[0]!.date, wrong);
  assert.strictEqual(repairAutomaticWeekDates(fixed, map), fixed);
});

test("keeps valid due weeks and explicit calendar dates", () => {
  const dueWeek = deadline([source("Coursework is due in week 7; submit it through the portal.")]);
  assert.strictEqual(repairAutomaticWeekDates(dueWeek, map), dueWeek);
  const calendar = deadline([source("The coursework is due on 2 November 2026; submit it online.")]);
  assert.strictEqual(repairAutomaticWeekDates(calendar, map), calendar);
});

test("clears a due week date contradicted by the map, but preserves it without a map", () => {
  const old = deadline([source("The coursework is due in week 11; submit it online.")]);
  assert.strictEqual(repairAutomaticWeekDates(old, null), old);
  const fixed = repairAutomaticWeekDates(old, map);
  assert.equal(fixed.sources[0]!.date, null);
  assert.equal(fixed.due, null);
});

test("keeps uncertain due-week evidence when no map is available", () => {
  const old = deadline([source("The coursework is released in week 7 and due in week 11.")]);
  assert.strictEqual(repairAutomaticWeekDates(old, null), old);
  const releaseOnly = deadline([source("The coursework is released in week 7; the due date will follow.")]);
  assert.equal(repairAutomaticWeekDates(releaseOnly, null).due, null);
  const duration = deadline([source("The coursework opens in week 7 for a duration of 7 days.")]);
  assert.strictEqual(repairAutomaticWeekDates(duration, map), duration);
});

test("recomputes due from remaining structured or quoted evidence", () => {
  const structured: Source = {
    type: "vle-field", strength: "structured", url: "https://example.edu/assignment",
    quote: "", date: right, seenAt: "2026-10-20T00:00:00.000Z",
  };
  const old = deadline([source("Coursework released in week 7, with a deadline to follow.", wrong, "rule"), structured]);
  const fixed = repairAutomaticWeekDates(old, map);
  assert.equal(fixed.due, right);
  assert.equal(fixed.status, "confirmed");
  assert.equal(fixed.sources[0]!.date, null);
  assert.strictEqual(fixed.sources[1], structured);
});

test("retains conflicting valid evidence and leaves user choices untouched", () => {
  const other = day("2026-12-01");
  const old = deadline([
    source("Coursework released in week 7, with a deadline to follow."),
    source("Coursework is due on 30 November 2026.", right),
    source("Coursework is due on 1 December 2026.", other),
  ]);
  const fixed = repairAutomaticWeekDates(old, map);
  assert.equal(fixed.status, "conflict");
  assert.equal(fixed.due, right);
  const verified = { ...old, status: "user-verified" as const };
  assert.strictEqual(repairAutomaticWeekDates(verified, map), verified);
});

test("flags confirmed dates resting only on pre-fix AI quotes for review", () => {
  const quote = "Submit the report by 30 November 2026.";
  const old = deadline([source(quote, right, "ai")], right);
  const flagged = flagLegacyAiDate(old);
  assert.equal(flagged.status, "needs-check");
  assert.match(flagged.checkReason ?? "", /older AI reading/);
  assert.equal(flagged.due, right);
  assert.equal(flagged.userNote, "Check the brief");

  const reread = deadline([{ ...source(quote, right, "ai"), seenAt: "2026-10-22T00:00:00.000Z" }], right);
  assert.equal(flagLegacyAiDate(reread), reread);
  const ruleBacked = deadline([source(quote, right, "ai"), source(quote, right, "rule")], right);
  assert.equal(flagLegacyAiDate(ruleBacked), ruleBacked);
  const verified = { ...old, status: "user-verified" as const };
  assert.equal(flagLegacyAiDate(verified), verified);
});
