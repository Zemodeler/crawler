import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeLines,
  deadlinesFromItems,
  detectConflict,
  isFormative,
  mergeDeadlines,
  parseWeight,
} from "../src/deadlines.ts";
import type { Course, Deadline, ModulePlacement, Source, VleItem } from "../src/types.ts";

const unix = (iso: string) => Date.parse(iso) / 1000;
const now = new Date("2026-10-15T17:00:00Z");
const later = new Date("2026-10-22T17:00:00Z");

const course: Course = {
  id: 77,
  shortname: "ECS505U 2026/27",
  fullname: "ECS505U Software Engineering 2026/27",
  startdate: unix("2026-09-21T00:00:00Z"),
  enddate: null,
  url: "https://vle.example/course/view.php?id=77",
};
const placement: ModulePlacement = {
  code: "ECS505U",
  title: "Software Engineering",
  folder: "ECS505U - Software Engineering",
  year: "2026-27",
  isModule: true,
};

function assignment(id: number, title: string, due: number | null): VleItem {
  return {
    kind: "assignment",
    id,
    activityId: id + 1000,
    title,
    due,
    cutoff: null,
    introHtml: "",
    briefFiles: [],
    url: `https://vle.example/mod/assign/view.php?id=${id + 1000}`,
    modified: null,
  };
}

function one(items: VleItem[], at = now): Deadline {
  const [d] = deadlinesFromItems(items, course, placement, at);
  assert.ok(d);
  return d;
}

test("weight is read from a percentage in the title", () => {
  assert.equal(parseWeight("mySkills Task 3 - Submission Link (3%)"), 3);
  assert.equal(parseWeight("Coursework 2 (12.5 %)"), 12.5);
  assert.equal(parseWeight("Coursework 2"), undefined);
  assert.equal(one([assignment(1, "mySkills Task 3 - Submission Link (3%)", null)]).weight, 3);
});

test("formative is detected, including the 'fomative' typo", () => {
  assert.ok(isFormative("Lab 1 (Formative)"));
  assert.ok(isFormative("Task 2 fomative submission"));
  assert.ok(!isFormative("Coursework 1"));
  assert.equal(one([assignment(1, "Task 2 (fomative)", null)]).formative, true);
  assert.equal(one([assignment(1, "Coursework 1", null)]).formative, undefined);
});

test("an assignment without a due date is tbc", () => {
  const d = one([assignment(5, "Coursework 1", null)]);
  assert.equal(d.status, "tbc");
  assert.equal(d.due, null);
  assert.equal(d.sources[0]?.date, null);
});

test("a valid December date is confirmed with a structured vle-field source", () => {
  const d = one([assignment(9921, "Coursework 2", unix("2026-12-14T10:00:00Z"))]);
  assert.equal(d.id, "moodle:ECS505U 2026/27:assign:9921");
  assert.equal(d.module, "ECS505U");
  assert.equal(d.year, "2026-27");
  assert.equal(d.kind, "coursework");
  assert.equal(d.status, "confirmed");
  assert.deepEqual(d.due, { iso: "2026-12-14T10:00:00.000Z", allDay: false, tz: "Europe/London" });
  assert.equal(d.submitUrl, "https://vle.example/mod/assign/view.php?id=10921");
  assert.deepEqual(d.history, []);
  assert.deepEqual(d.sources, [
    {
      type: "vle-field",
      strength: "structured",
      url: "https://vle.example/mod/assign/view.php?id=10921",
      quote: "Due: Mon 14 Dec 2026, 10:00",
      date: d.due,
      seenAt: now.toISOString(),
    },
  ]);
});

test("the quote is rendered in London time during BST", () => {
  const d = one([assignment(1, "Coursework 1", unix("2026-10-20T11:00:00Z"))]);
  assert.equal(d.sources[0]?.quote, "Due: Tue 20 Oct 2026, 12:00");
});

test("the ECS505U 2028 placeholder is needs-check with a reason", () => {
  const d = one([assignment(3, "mySkills Task 1 (fomative)", unix("2028-06-01T11:00:00Z"))]);
  assert.equal(d.status, "needs-check");
  assert.match(d.checkReason ?? "", /Thu 1 Jun 2028, 12:00/);
  assert.match(d.checkReason ?? "", /1 Aug 2026 to 30 Sep 2027/);
});

test("academic-year window edges use London time", () => {
  // 30 Sep 2027 23:30 BST is still inside; 1 Oct 2027 00:30 BST is outside.
  assert.equal(one([assignment(1, "A", unix("2027-09-30T22:30:00Z"))]).status, "confirmed");
  assert.equal(one([assignment(1, "A", unix("2027-09-30T23:30:00Z"))]).status, "needs-check");
  // 1 Aug 2026 00:30 BST is inside the window but far before the course starts.
  const early = one([assignment(1, "A", unix("2026-07-31T23:30:00Z"))]);
  assert.equal(early.status, "needs-check");
  assert.match(early.checkReason ?? "", /more than 30 days before the module starts/);
});

test("quizzes use the close date and window; assign and quiz events are deduplicated", () => {
  const items: VleItem[] = [
    {
      kind: "quiz",
      id: 40,
      activityId: 400,
      title: "Week 3 quiz",
      opens: unix("2026-10-12T09:00:00Z"),
      closes: unix("2026-10-19T09:00:00Z"),
      url: "https://vle.example/mod/quiz/view.php?id=400",
    },
    { kind: "event", id: 1, title: "Week 3 quiz closes", start: unix("2026-10-19T09:00:00Z"), activityType: "quiz", url: "u1" },
    { kind: "event", id: 2, title: "Coursework 1 is due", start: unix("2026-11-02T12:00:00Z"), activityType: "assign", url: "u2" },
    { kind: "event", id: 3, title: "Mid-term test", start: unix("2026-11-09T14:00:00Z"), activityType: null, url: "u3" },
  ];
  const ds = deadlinesFromItems(items, course, placement, now);
  assert.deepEqual(
    ds.map((d) => [d.id, d.kind]),
    [
      ["moodle:ECS505U 2026/27:quiz:40", "quiz"],
      ["moodle:ECS505U 2026/27:event:3", "other"],
    ],
  );
  const quiz = ds[0]!;
  assert.equal(quiz.due?.iso, "2026-10-19T09:00:00.000Z");
  assert.equal(quiz.window?.from.iso, "2026-10-12T09:00:00.000Z");
  assert.equal(quiz.window?.to.iso, "2026-10-19T09:00:00.000Z");
  assert.equal(quiz.submitUrl, undefined);
});

test("module falls back to the course shortname", () => {
  const [d] = deadlinesFromItems([assignment(1, "A", null)], course, { ...placement, code: null }, now);
  assert.equal(d?.module, "ECS505U 2026/27");
});

test("merge records added, moved and removed deadlines and keeps notes", () => {
  const first = mergeDeadlines(
    [],
    deadlinesFromItems(
      [assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z")), assignment(2, "Lab report", unix("2026-11-20T12:00:00Z"))],
      course,
      placement,
      now,
    ),
    now,
  );
  assert.deepEqual(
    first.map((d) => [d.title, d.history.map((h) => h.field)]),
    [
      ["Lab report", ["added"]],
      ["Coursework 2", ["added"]],
    ],
  );
  const withNote = first.map((d) => (d.title === "Coursework 2" ? { ...d, userNote: "ask about groups" } : d));

  const second = mergeDeadlines(
    withNote,
    deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-10T12:00:00Z"))], course, placement, later),
    later,
  );
  const cw2 = second.find((d) => d.title === "Coursework 2")!;
  assert.equal(cw2.due?.iso, "2027-03-10T12:00:00.000Z");
  assert.equal(cw2.status, "confirmed");
  assert.equal(cw2.userNote, "ask about groups");
  assert.equal(cw2.sources.length, 1, "the same VLE field replaces its old source");
  const moved = cw2.history.at(-1)!;
  assert.equal(moved.field, "due");
  assert.equal(moved.from, "2027-03-03T12:00:00.000Z");
  assert.equal(moved.to, "2027-03-10T12:00:00.000Z");
  assert.equal(moved.source?.quote, "Due: Wed 10 Mar 2027, 12:00");

  const lab = second.find((d) => d.title === "Lab report")!;
  assert.equal(lab.status, "cancelled");
  assert.deepEqual(
    lab.history.map((h) => h.field),
    ["added", "removed"],
  );

  // Removed is recorded once.
  const third = mergeDeadlines(second, deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-10T12:00:00Z"))], course, placement, later), later);
  assert.deepEqual(
    third.find((d) => d.title === "Lab report")!.history.map((h) => h.field),
    ["added", "removed"],
  );
  assert.equal(third.find((d) => d.title === "Coursework 2")!.history.length, cw2.history.length);

  assert.deepEqual(changeLines(withNote, second), [
    "ECS505U · Lab report — removed from QMplus",
    "ECS505U · Coursework 2 — due moved 3 Mar 12:00 → 10 Mar 12:00",
  ]);
  assert.deepEqual(changeLines(second, third), []);
});

test("a user-verified deadline keeps the student's date but records the new source", () => {
  const [base] = mergeDeadlines([], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, now), now);
  const verified: Deadline = {
    ...base!,
    status: "user-verified",
    due: { iso: "2027-03-05T12:00:00.000Z", allDay: false, tz: "Europe/London" },
    userNote: "agreed with lecturer",
  };
  const fresh = deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-10T12:00:00Z"))], course, placement, later);
  const [merged] = mergeDeadlines([verified], fresh, later);
  assert.equal(merged?.status, "user-verified");
  assert.equal(merged?.due?.iso, "2027-03-05T12:00:00.000Z");
  assert.equal(merged?.userNote, "agreed with lecturer");
  assert.equal(merged?.sources[0]?.date?.iso, "2027-03-10T12:00:00.000Z");
  const last = merged!.history.at(-1)!;
  assert.deepEqual([last.field, last.from, last.to], ["due", "2027-03-05T12:00:00.000Z", "2027-03-10T12:00:00.000Z"]);
  assert.deepEqual(changeLines([verified], [merged!]), [
    "ECS505U · Coursework 2 — a source now says 10 Mar 12:00; keeping your date 5 Mar 12:00",
  ]);

  // The same disagreeing source next sync is not reported again.
  const [again] = mergeDeadlines([merged!], fresh, later);
  assert.equal(again?.history.length, merged!.history.length);
});

test("sources that disagree on the date make a conflict", () => {
  const [base] = mergeDeadlines([], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, now), now);
  const announcement: Source = {
    type: "announcement",
    strength: "quoted",
    url: "https://vle.example/mod/forum/discuss.php?d=5",
    quote: "CW2 is now due on 10 March at noon",
    date: { iso: "2027-03-10T12:00:00.000Z", allDay: false, tz: "Europe/London" },
    seenAt: now.toISOString(),
    origin: "ai", // the AI does not re-read an unchanged announcement, so its source stands
  };
  const previous: Deadline = { ...base!, sources: [...base!.sources, announcement] };
  assert.equal(detectConflict(previous).status, "conflict");
  assert.equal(detectConflict({ ...previous, status: "user-verified" }).status, "user-verified");

  const [merged] = mergeDeadlines([previous], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, later), later);
  assert.equal(merged?.status, "conflict");
  assert.equal(merged?.sources.length, 2);
  assert.deepEqual(changeLines([previous], [merged!]), ["ECS505U · Coursework 2 — conflict: sources disagree (3 Mar 12:00 vs 10 Mar 12:00)"]);

  // A rule source is found again on every sync; one that is not found again no longer stands.
  const ruleFound: Deadline = { ...base!, sources: [...base!.sources, { ...announcement, origin: "rule" }] };
  const [cleared] = mergeDeadlines([ruleFound], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, later), later);
  assert.equal(cleared?.status, "confirmed");
  assert.equal(cleared?.sources.length, 1);
});

test("a text-found deadline that is not found again is cancelled unless the AI still stands for it", () => {
  const quoted = (origin: "rule" | "ai"): Deadline => ({
    id: "qmul:ECS505U:text:abc",
    module: "ECS505U",
    year: "2026-27",
    title: "Exam",
    kind: "exam",
    status: "confirmed",
    due: { iso: "2026-12-08T00:00:00.000Z", allDay: true, tz: "Europe/London" },
    sources: [{ type: "page", strength: "quoted", url: "https://vle.example/p", quote: "the exam is on 8 December 2026", date: { iso: "2026-12-08T00:00:00.000Z", allDay: true, tz: "Europe/London" }, seenAt: now.toISOString(), origin }],
    history: [],
  });
  const [gone] = mergeDeadlines([quoted("rule")], [], later);
  assert.equal(gone?.status, "cancelled");
  const [kept] = mergeDeadlines([quoted("ai")], [], later);
  assert.equal(kept?.status, "confirmed");
});

test("changeLines reports new and needs-check deadlines", () => {
  const fresh = deadlinesFromItems(
    [assignment(1, "Coursework 1", unix("2026-12-14T10:00:00Z")), assignment(3, "Task 1 (fomative)", unix("2028-06-01T11:00:00Z")), assignment(4, "Essay", null)],
    course,
    placement,
    now,
  );
  const merged = mergeDeadlines([], fresh, now);
  assert.deepEqual(
    merged.map((d) => d.title),
    ["Coursework 1", "Task 1 (fomative)", "Essay"],
    "sorted by due, undated last",
  );
  const lines = changeLines([], merged);
  assert.deepEqual(lines.slice(0, 2), ["ECS505U · Coursework 1 — new deadline, due 14 Dec 10:00", "ECS505U · Task 1 (fomative) — new deadline, due 1 Jun 12:00"]);
  assert.match(lines[2] ?? "", /^ECS505U · Task 1 \(fomative\) — needs check: The date Thu 1 Jun 2028, 12:00 is outside/);
  assert.equal(lines[3], "ECS505U · Essay — new deadline, date TBC");
  assert.equal(lines.length, 4);
});

function event(id: number, title: string, start: number): VleItem {
  // The adapter's event url embeds the timestamp, so it changes when the event moves.
  return { kind: "event", id, title, start, activityType: null, url: `https://vle.example/calendar/view.php?view=day&time=${start}` };
}

test("a moved VLE event replaces its vle-field source instead of becoming a conflict", () => {
  const first = mergeDeadlines([], deadlinesFromItems([event(3, "Mid-term test", unix("2026-11-09T14:00:00Z"))], course, placement, now), now);
  const second = mergeDeadlines(first, deadlinesFromItems([event(3, "Mid-term test", unix("2026-11-16T14:00:00Z"))], course, placement, later), later);
  const [moved] = second;
  assert.equal(moved?.status, "confirmed");
  assert.equal(moved?.due?.iso, "2026-11-16T14:00:00.000Z");
  assert.equal(moved?.sources.length, 1);
  assert.equal(moved?.sources[0]?.type, "vle-field");
  assert.equal(moved?.sources[0]?.date?.iso, "2026-11-16T14:00:00.000Z");
  const last = moved!.history.at(-1)!;
  assert.deepEqual([last.field, last.from, last.to], ["due", "2026-11-09T14:00:00.000Z", "2026-11-16T14:00:00.000Z"]);
  assert.deepEqual(changeLines(first, second), ["ECS505U · Mid-term test — due moved 9 Nov 14:00 → 16 Nov 14:00"]);

  // A later unchanged sync adds nothing.
  const third = mergeDeadlines(second, deadlinesFromItems([event(3, "Mid-term test", unix("2026-11-16T14:00:00Z"))], course, placement, later), later);
  assert.equal(third[0]?.history.length, moved!.history.length);
  assert.equal(third[0]?.sources.length, 1);
  assert.equal(third[0]?.status, "confirmed");
  assert.deepEqual(changeLines(second, third), []);
});

test("a moved event on a user-verified deadline is reported once and keeps one vle-field source", () => {
  const [base] = mergeDeadlines([], deadlinesFromItems([event(3, "Mid-term test", unix("2026-11-09T14:00:00Z"))], course, placement, now), now);
  const verified: Deadline = { ...base!, status: "user-verified" };
  const fresh = deadlinesFromItems([event(3, "Mid-term test", unix("2026-11-16T14:00:00Z"))], course, placement, later);
  const [merged] = mergeDeadlines([verified], fresh, later);
  assert.equal(merged?.status, "user-verified");
  assert.equal(merged?.due?.iso, "2026-11-09T14:00:00.000Z");
  assert.equal(merged?.sources.length, 1);
  assert.equal(merged?.history.at(-1)?.field, "due");
  const [again] = mergeDeadlines([merged!], fresh, later);
  assert.equal(again?.history.length, merged!.history.length);
  assert.equal(again?.sources.length, 1);
});

test("a user-verified deadline removed from QMplus is kept and reported once", () => {
  const [base] = mergeDeadlines([], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, now), now);
  const verified: Deadline = { ...base!, status: "user-verified", userNote: "agreed with lecturer" };
  const [kept] = mergeDeadlines([verified], [], later);
  assert.equal(kept?.status, "user-verified");
  assert.equal(kept?.due?.iso, "2027-03-03T12:00:00.000Z");
  assert.equal(kept?.userNote, "agreed with lecturer");
  assert.deepEqual(
    kept!.history.map((h) => [h.field, h.from, h.to]),
    [
      ["added", null, "2027-03-03T12:00:00.000Z"],
      ["removed", "user-verified", "user-verified"],
    ],
  );
  assert.deepEqual(changeLines([verified], [kept!]), ["ECS505U · Coursework 2 — removed from QMplus, but kept because you confirmed it"]);

  const [again] = mergeDeadlines([kept!], [], later);
  assert.equal(again?.status, "user-verified");
  assert.equal(again?.history.length, kept!.history.length, "removed is recorded once");
  assert.deepEqual(changeLines([kept!], [again!]), []);
});

test("a user-verified deadline that is removed, restored and removed again is reported both times", () => {
  const items = [assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))];
  const [base] = mergeDeadlines([], deadlinesFromItems(items, course, placement, now), now);
  const verified: Deadline = { ...base!, status: "user-verified" };
  const [removed] = mergeDeadlines([verified], [], later);
  const evenLater = new Date(later.getTime() + 86_400_000);
  const [restored] = mergeDeadlines([removed!], deadlinesFromItems(items, course, placement, evenLater), evenLater);
  assert.equal(restored?.status, "user-verified");
  assert.deepEqual(
    restored!.history.map((h) => h.field),
    ["added", "removed", "added"],
  );
  assert.deepEqual(changeLines([removed!], [restored!]), ["ECS505U · Coursework 2 — back on QMplus"]);
  const muchLater = new Date(evenLater.getTime() + 86_400_000);
  const [removedAgain] = mergeDeadlines([restored!], [], muchLater);
  assert.deepEqual(
    removedAgain!.history.map((h) => h.field),
    ["added", "removed", "added", "removed"],
  );
  assert.deepEqual(changeLines([restored!], [removedAgain!]), ["ECS505U · Coursework 2 — removed from QMplus, but kept because you confirmed it"]);
});

test("a fresh deadline with two vle-field sources keeps only one, so it cannot conflict with itself", () => {
  const [base] = mergeDeadlines([], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, now), now);
  const first = base!.sources[0]!;
  const other = { ...first, url: `${first.url}&other=1`, date: { ...first.date!, iso: "2027-03-10T12:00:00.000Z" }, quote: "Cut-off: 10 Mar" };
  const fresh: Deadline = { ...base!, sources: [first, other] };
  const [merged] = mergeDeadlines([], [fresh], now);
  assert.equal(merged?.sources.filter((s) => s.type === "vle-field").length, 1);
  assert.equal(merged?.status, "confirmed");
  const [again] = mergeDeadlines([base!], [fresh], later);
  assert.equal(again?.sources.filter((s) => s.type === "vle-field").length, 1);
  assert.equal(again?.status, "confirmed");
});

test("a deadline that a document, announcement or page also backs is not cancelled by the VLE", () => {
  const [base] = mergeDeadlines([], deadlinesFromItems([assignment(1, "Coursework 2", unix("2027-03-03T12:00:00Z"))], course, placement, now), now);
  for (const type of ["document", "announcement", "page"] as const) {
    const other: Source = {
      type,
      strength: "quoted",
      url: "https://vle.example/pluginfile.php/1/brief.pdf",
      quote: "Coursework 2 is due on 3 March at noon",
      date: { iso: "2027-03-03T12:00:00.000Z", allDay: false, tz: "Europe/London" },
      seenAt: now.toISOString(),
    };
    const previous: Deadline = { ...base!, sources: [...base!.sources, other] };
    const [kept] = mergeDeadlines([previous], [], later);
    assert.deepEqual(kept, previous, `${type} source keeps the deadline unchanged`);
    assert.deepEqual(changeLines([previous], [kept!]), []);
  }
});

test("deadlines not born on the VLE are never cancelled by a sync", () => {
  const manual: Deadline = {
    id: "doc:ECS505U:exam",
    module: "ECS505U",
    year: "2026-27",
    title: "Final exam",
    kind: "exam",
    status: "confirmed",
    due: { iso: "2027-05-12T09:00:00.000Z", allDay: false, tz: "Europe/London" },
    sources: [
      {
        type: "vle-field",
        strength: "structured",
        url: "https://vle.example/exam-timetable",
        quote: "Exam: Wed 12 May 2027, 10:00",
        date: { iso: "2027-05-12T09:00:00.000Z", allDay: false, tz: "Europe/London" },
        seenAt: now.toISOString(),
      },
    ],
    history: [],
  };
  const [kept] = mergeDeadlines([manual], [], later);
  assert.deepEqual(kept, manual);
});
