import assert from "node:assert/strict";
import { test } from "node:test";

import { findCandidates, looksLikeAssessmentText } from "../src/candidates.ts";
import type { DateCandidate, TextSource } from "../src/extraction-types.ts";
import { weekMapFor } from "../src/weeks.ts";

const now = new Date("2026-10-16T09:00:00Z");
const ctx = { year: "2026-27", now };
const semA = weekMapFor("qmul", "2026-27 Semester A")!;

function source(text: string | string[], type: TextSource["type"] = "document"): TextSource {
  const pages = (Array.isArray(text) ? text : [text]).map((t, i) => ({ page: i + 1, text: t }));
  return {
    type,
    title: "ECS505U Module Handbook",
    url: "https://qmplus.qmul.ac.uk/mod/resource/view.php?id=4242",
    localPath: "2026-27/ECS505U - Software Engineering/Module Info/Handbook.pdf",
    pages,
  };
}

function only(text: string | string[], context: Parameters<typeof findCandidates>[1] = ctx): DateCandidate {
  const found = findCandidates(source(text), context);
  assert.equal(found.length, 1, `expected one candidate, got ${JSON.stringify(found, null, 2)}`);
  return found[0]!;
}

const wordCount = (s: string) => s.trim().split(/\s+/).length;

test("full date with weekday, time and weight", () => {
  const text = "Assessment\nCoursework 1 (20%) is due on Monday 14 December 2026 at 12:00 noon via QMplus.";
  const c = only(text);
  assert.deepEqual(c, {
    origin: "rule",
    title: "Coursework 1",
    kind: "coursework",
    date: { iso: "2026-12-14T12:00:00.000Z", allDay: false, tz: "Europe/London" },
    weight: 20,
    quote: "Coursework 1 (20%) is due on Monday 14 December 2026 at 12:00 noon via QMplus.",
    sourceType: "document",
    url: "https://qmplus.qmul.ac.uk/mod/resource/view.php?id=4242",
    localPath: "2026-27/ECS505U - Software Engineering/Module Info/Handbook.pdf",
    page: 1,
  });
});

test("'worth 30%' and a 4pm time under a heading", () => {
  const c = only("Coursework 2: Group Project\nThe report, worth 30% of the module, must be submitted by 4pm on 12 March 2027.");
  assert.equal(c.title, "Coursework 2: Group Project");
  assert.equal(c.weight, 30);
  assert.equal(c.kind, "coursework");
  assert.equal(c.date?.iso, "2027-03-12T16:00:00.000Z");
});

test("a date without a year takes the year from the academic year", () => {
  const c = only("The final exam will be held on 14th January in the Great Hall.");
  assert.equal(c.title, "Final exam");
  assert.equal(c.kind, "exam");
  assert.deepEqual(c.date, { iso: "2027-01-14T00:00:00.000Z", allDay: true, tz: "Europe/London" });
  const autumn = only("Submission deadline for the essay: Friday 4th December, 5pm.");
  assert.equal(autumn.date?.iso, "2026-12-04T17:00:00.000Z");
});

test("August and September without a year are ambiguous unless the weekday decides", () => {
  const c = only("The resit coursework deadline is 4 September at 12:00.");
  assert.equal(c.date, null);
  assert.match(c.tbcReason!, /2026 and 2027/);
  // Fri 4 Sep 2026, but 4 Sep 2027 is a Saturday.
  const decided = only("The resit coursework deadline is Friday 4 September at 12:00.");
  assert.equal(decided.date?.iso, "2026-09-04T11:00:00.000Z");
  assert.equal(decided.tbcReason, undefined);
});

test("no year is inferred when the academic year is unknown", () => {
  const c = only("Coursework 1 is due on 14 December.", { year: "Undated", now });
  assert.equal(c.date, null);
  assert.match(c.tbcReason!, /no year/);
});

test("an explicit year outside the academic year is kept as written", () => {
  const c = only("Formative task 4 submission due 1 January 2028.");
  assert.equal(c.date?.iso, "2028-01-01T00:00:00.000Z");
  assert.equal(c.formative, true);
});

test("numeric dates and midnight", () => {
  assert.equal(only("Please submit by 23:59 on 14/12/2026 through the QMplus link.").date?.iso, "2026-12-14T23:59:00.000Z");
  const lab = only("Hand in your lab report by midnight on Friday 11 December 2026.");
  assert.equal(lab.date?.iso, "2026-12-11T23:59:00.000Z");
  assert.equal(lab.kind, "lab");
  assert.equal(only("Assignment 3 is due 2027-02-05 at 10am sharp.").date?.iso, "2027-02-05T10:00:00.000Z");
  assert.equal(only("Online quiz closes 3 Nov 2026, 17:00 (GMT).").kind, "quiz");
});

test("formative flags", () => {
  const c = only("Quiz 2 (formative, does not count towards your mark) closes on 3 November 2026 at 17:00.");
  assert.equal(c.formative, true);
  assert.equal(c.kind, "quiz");
  assert.equal(c.date?.iso, "2026-11-03T17:00:00.000Z");
  assert.equal(only("Practice presentation, which does not count towards the module mark, is on 9 December 2026.").formative, true);
  assert.equal(only("Coursework 1 (20%) is due on 14 December 2026.").formative, undefined);
});

test("week references resolve through the week map", () => {
  const c = only("The in-class test takes place in week 9 (Friday) at 10:00.", { ...ctx, weekMap: semA });
  assert.equal(c.weekNumber, 9);
  assert.deepEqual(c.weekMapSource, { kind: "config" });
  assert.equal(c.date?.iso, "2026-11-20T10:00:00.000Z");
  assert.equal(c.kind, "exam");
  const noDay = only("Coursework 2 is due in week 11.", { ...ctx, weekMap: semA });
  assert.equal(noDay.date, null, "a week without a day is not a date");
  assert.equal(noDay.weekNumber, 11);
  assert.match(noDay.tbcReason ?? "", /week 11 \(the week of 30 Nov\) but not which day/);
});

test("week references without a week map stay TBC with the week kept", () => {
  const c = only("Lab test 2 will be held in week 10.");
  assert.equal(c.date, null);
  assert.equal(c.weekNumber, 10);
  assert.equal(c.weekMapSource, undefined);
  assert.match(c.tbcReason!, /week 10/);
  assert.equal(c.kind, "lab");
});

test("several deadlines in one sentence get their own titles", () => {
  const found = findCandidates(
    source("Coursework 1 is due 14 December 2026 and Coursework 2 is due 12 March 2027."),
    ctx,
  );
  assert.deepEqual(
    found.map((c) => [c.title, c.date?.iso]),
    [
      ["Coursework 1", "2026-12-14T00:00:00.000Z"],
      ["Coursework 2", "2027-03-12T00:00:00.000Z"],
    ],
  );
});

test("false positives: lectures, revision sessions and teaching weeks", () => {
  const text = [
    "Week 3 lecture: introduction to the coursework brief.",
    "Week 5 seminar on assignment planning.",
    "Lecture 8 on 14 December 2026 covers exam revision.",
    "The revision tutorial on Monday 7 December 2026 will go through past exam papers.",
    "We will write unit tests in the lab on 2 November 2026.",
    "Reading week runs from 2 November 2026; there are no lectures.",
  ].join("\n");
  assert.deepEqual(findCandidates(source(text), { ...ctx, weekMap: semA }), []);
});

test("false positives: references and citations", () => {
  const text = [
    "Coursework 1 is due on 14 December 2026.",
    "References",
    "Myers, G. (2011) The Art of Software Testing. Wiley.",
    "Beck, K. Test-driven development, accessed 14 December 2025.",
    "QM Assessment Handbook, exam regulations, 1 September 2026.",
  ].join("\n");
  const found = findCandidates(source(text), ctx);
  assert.deepEqual(found.map((c) => c.date?.iso), ["2026-12-14T00:00:00.000Z"]);
  const inline = "As Smith et al. showed in a test on 3 March 2020, students learn by doing.";
  assert.deepEqual(findCandidates(source(inline), ctx), []);
});

test("references end at the next plain heading", () => {
  const text = ["Bibliography", "Jones, A. (2019) Exams. 3 May 2019.", "Assessment Schedule", "Exam: 9 Jan 2027", "Room: Great Hall"].join("\n");
  const c = only(text);
  assert.equal(c.date?.iso, "2027-01-09T00:00:00.000Z");
});

test("quotes are verbatim, 5-40 words, widened or cut around the date", () => {
  const short = "Assessment Schedule\nExam: 9 Jan 2027\nRoom: Great Hall";
  const c = only(short);
  assert.ok(short.includes(c.quote));
  assert.ok(wordCount(c.quote) >= 5, c.quote);
  assert.match(c.quote, /9 Jan 2027/);

  const filler = "This module is assessed through a combination of practical work, written reports and peer feedback, and students are expected to engage with all of the weekly activities and readings";
  const long = `${filler}, and the final project submission deadline is Friday 15 January 2027 at 16:00, after which late penalties apply as described in the school policy on late submission.`;
  const l = only(long);
  assert.ok(long.includes(l.quote));
  assert.ok(wordCount(l.quote) <= 40 && wordCount(l.quote) >= 5, l.quote);
  assert.match(l.quote, /15 January 2027/);
  assert.equal(l.date?.iso, "2027-01-15T16:00:00.000Z");
});

test("the quote stays inside its sentence when the sentence is long enough", () => {
  const text = "Welcome to the module. Coursework 1 is due on 14 December 2026 at 10:00. Good luck with it.";
  assert.equal(only(text).quote, "Coursework 1 is due on 14 December 2026 at 10:00.");
});

test("pages and source type are carried through", () => {
  const found = findCandidates(source(["Introduction to the module.", "The midterm test is on 5 November 2026 at 14:00."], "announcement"), ctx);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.page, 2);
  assert.equal(found[0]!.sourceType, "announcement");
  assert.equal(found[0]!.title, "Midterm test");
});

test("looksLikeAssessmentText", () => {
  assert.equal(looksLikeAssessmentText([{ page: 1, text: "Assessment: coursework 40%, exam 60%." }]), true);
  assert.equal(looksLikeAssessmentText([{ page: 1, text: "Lab test 1 is in week 6." }]), true);
  assert.equal(looksLikeAssessmentText([{ page: 3, text: "Hand in by 5pm on 1 December 2026." }]), true);
  assert.equal(
    looksLikeAssessmentText([
      { page: 1, text: "Week 3 lecture: sorting algorithms." },
      { page: 2, text: "References\nKnuth, D. (1998) Sorting and Searching. Exam edition, 3 May 1998." },
    ]),
    false,
  );
  assert.equal(looksLikeAssessmentText([]), false);
});

/* Cases seen on real QMplus modules (2026-10-16). */

test("a 'week commencing' date is when something starts, not its deadline", () => {
  const found = findCandidates(source("Practice quiz in week 6 (w/c 26 October): the week-11 test is based on it."), { ...ctx, weekMap: semA });
  assert.ok(found.length > 0);
  for (const c of found.filter((x) => x.quote.includes("26 October"))) {
    if (c.date) assert.notEqual(c.date.iso.slice(0, 10), "2026-10-26", "w/c 26 October must not become a due date");
  }
  const released = only("CW part 1: Released on 5 November, QMplus submission, duration 6 days.");
  assert.equal(released.date, null);
  assert.match(released.tbcReason ?? "", /starts or opens/);
});

test("'exam period' in a schedule row is not an exam", () => {
  assert.deepEqual(findCandidates(source("Week 12 Tuesday, 8 December 2026 Revision and Preparation for CW in Jan Exam period"), ctx), []);
});

test("a deadline sentence without a named assessment is titled by its kind, never by a fragment", () => {
  const found = findCandidates(source("You can submit from week 12. The deadline is Thursday 14 January."), ctx);
  const dated = found.find((c) => c.date)!;
  assert.ok(dated, JSON.stringify(found));
  assert.ok(!/You can submit/.test(dated.title), dated.title);
  assert.ok(dated.title.length <= 40, dated.title);
});

test("the real in-term test announcement keeps its date and time", () => {
  const c = only("Please note that the in-term test has now been scheduled for Tuesday, 3 November, from 11:00 to 13:00.", ctx);
  assert.equal(c.date?.iso, "2026-11-03T11:00:00.000Z");
});

test("an assessment table row: its description is the title and only the submission date is a deadline", () => {
  const rows = [
    "Seq Type Description Weight Submission Deadline Feedback Deadline",
    "001 EXN Term Test: Main DB Concepts 40% Monday 30/11/2026 Monday 14/12/2026",
    "002 EXN In-term test 40% Week 7 (TBC) 1 week after",
  ].join("\n");
  const found = findCandidates(source(rows, "page"), ctx);
  const dated = found.filter((c) => c.date);
  assert.deepEqual(dated.map((c) => [c.title, c.date!.iso, c.weight]), [["Term Test: Main DB Concepts", "2026-11-30T00:00:00.000Z", 40]]);
  // A row is never the heading of the row below it.
  assert.ok(found.every((c) => c.title !== "Term Test: Main DB Concepts" || c.date), JSON.stringify(found.map((c) => c.title)));
  assert.ok(found.some((c) => c.title === "In-term test" && !c.date));
});

test("'CW (Part) 1' and 'CW part 2' are Coursework 1 and Coursework 2", () => {
  const one = findCandidates(source("CW (Part) 1\nThis Assessment is Worth 15% of your final grade.\nSubmission Deadline: 11.11.2026", "page"), ctx);
  assert.deepEqual(one.map((c) => [c.title, c.date?.iso]), [["Coursework 1", "2026-11-11T00:00:00.000Z"]]);
  const two = findCandidates(source("CW part 2: released on week 10, QMplus submission, due 2 December 2026."), ctx);
  assert.equal(two[0]?.title, "Coursework 2");
});

test("a list item above is not the heading of the next one, and 'rules' headings name nothing", () => {
  const list = findCandidates(source("Week 6: SQL Practice quiz: formative feedback in week 8\nWeek 11: DB Concepts quiz: summative feedback in week 13", "page"), { ...ctx, weekMap: semA });
  const week11 = list.find((c) => c.weekNumber === 11);
  assert.ok(week11, JSON.stringify(list));
  assert.notEqual(week11.title, "Week 6: SQL Practice quiz: formative feedback in week 8");
  const rules = findCandidates(source("Exam/assessment rules:\nThe practice quiz closes on 30 October 2026."), ctx);
  assert.equal(rules[0]?.title, "Practice quiz");
});

test("'examination period' and 'exam board' neither title nor classify coursework", () => {
  const c = only("Coursework\nSubmission Deadline: Thursday 14/01/2027 (first week of Jan examination period), EECS exam board.");
  assert.equal(c.title, "Coursework");
  assert.equal(c.kind, "coursework");
});
