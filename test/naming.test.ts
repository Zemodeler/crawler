import assert from "node:assert/strict";
import { test } from "node:test";

import { academicYear, decodeEntities, placeCourse, sanitizeSegment } from "../src/naming.ts";

const course = (fullname: string, shortname = fullname, startdate: number | null = null) => ({ fullname, shortname, startdate });
const london = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("'CODE - Title - year' names", () => {
  assert.deepEqual(placeCourse(course("ECS401U - Procedural Programming - 2025/26")), {
    code: "ECS401U",
    title: "Procedural Programming",
    folder: "ECS401U - Procedural Programming",
    year: "2025-26",
    isModule: true,
  });
});

test("Surrey four-digit module codes", () => {
  const placed = placeCourse(course("COM1025 Foundations of Computing I", "COM1025", london("2025-09-22T00:00:00Z")));
  assert.equal(placed.code, "COM1025");
  assert.equal(placed.title, "Foundations of Computing I");
  assert.equal(placed.year, "2025-26");
  assert.equal(placed.isModule, true);
});

test("'CODE Title year' names without separators", () => {
  assert.deepEqual(placeCourse(course("ECS505U Software Engineering 2026/27", "ECS505U 2026/27")), {
    code: "ECS505U",
    title: "Software Engineering",
    folder: "ECS505U - Software Engineering",
    year: "2026-27",
    isModule: true,
  });
});

test("a shortname with two codes gives the first code and the year", () => {
  const placement = placeCourse(course("ECS401U - Procedural Programming", "ECS401U/ECS401A - 2025/26"));
  assert.equal(placement.code, "ECS401U");
  assert.equal(placement.year, "2025-26");
  assert.equal(placement.folder, "ECS401U - Procedural Programming");

  const fromShort = placeCourse(course("", "ECS401U/ECS401A - 2025/26"));
  assert.equal(fromShort.code, "ECS401U");
  assert.equal(fromShort.folder, "ECS401U");
});

test("inner hyphens in the title are kept", () => {
  const placement = placeCourse(course("ECS414U - Object-Oriented Programming - 2025/26"));
  assert.equal(placement.title, "Object-Oriented Programming");
  assert.equal(placement.folder, "ECS414U - Object-Oriented Programming");
});

test("non-module sites keep their name minus the year", () => {
  assert.deepEqual(placeCourse(course("Academic Integrity at Queen Mary Year 2 - 2026/27")), {
    code: null,
    title: "Academic Integrity at Queen Mary Year 2",
    folder: "Academic Integrity at Queen Mary Year 2",
    year: "2026-27",
    isModule: false,
  });
  const ai = placeCourse(course("AI for Student Learning and Research - Year 2 - 2026/27"));
  assert.equal(ai.isModule, false);
  assert.equal(ai.folder, "AI for Student Learning and Research - Year 2");
  assert.equal(ai.year, "2026-27");
});

test("academic year falls back to the start date, starting 1 August", () => {
  assert.equal(academicYear(course("Study Skills", "SKILLS", london("2026-07-31T12:00:00+01:00"))), "2025-26");
  assert.equal(academicYear(course("Study Skills", "SKILLS", london("2026-08-01T00:00:00+01:00"))), "2026-27");
  assert.equal(academicYear(course("Study Skills", "SKILLS", london("2027-01-10T09:00:00Z"))), "2026-27");
  assert.equal(academicYear(course("Study Skills", "SKILLS", 0)), "Undated");
  assert.equal(academicYear(course("Study Skills")), "Undated");
  assert.equal(placeCourse(course("Study Skills", "SKILLS", london("2026-09-20T00:00:00Z"))).year, "2026-27");
});

test("academic year accepts 2026-27 and the shortname", () => {
  assert.equal(academicYear(course("ECS505U Software Engineering", "ECS505U 2026-27")), "2026-27");
  assert.equal(academicYear(course("Maths 2026/2027")), "2026-27");
});

test("entities in names are decoded", () => {
  assert.equal(decodeEntities("Domain &amp; Requirements"), "Domain & Requirements");
  assert.equal(decodeEntities("&lt;b&gt; &quot;x&quot; &#39;y&#39; &#x2013; &amp;amp;"), "<b> \"x\" 'y' – &amp;");
  assert.equal(decodeEntities("&bogus; & AT&T"), "&bogus; & AT&T");
  assert.equal(placeCourse(course("ECS999U Domain &amp; Requirements 2026/27")).folder, "ECS999U - Domain & Requirements");
});

test("sanitizeSegment makes names safe on Windows and macOS", () => {
  assert.equal(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j'), "a b c d e f g h i j");
  assert.equal(sanitizeSegment("tab\there\x01"), "tab here");
  assert.equal(sanitizeSegment("  ..hidden name..  "), "hidden name");
  assert.equal(sanitizeSegment("a    b"), "a b");
  assert.equal(sanitizeSegment("CON"), "_CON");
  assert.equal(sanitizeSegment("com1"), "_com1");
  assert.equal(sanitizeSegment("LPT9.txt"), "_LPT9.txt");
  assert.equal(sanitizeSegment("Console"), "Console");
  assert.equal(sanitizeSegment(""), "Untitled");
  assert.equal(sanitizeSegment(" ./. "), "Untitled");
  const long = sanitizeSegment(`${"x".repeat(200)}.pdf`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".pdf"));
  assert.equal(sanitizeSegment("y".repeat(300)).length, 120);
});

test("default selection keeps undated modules at the newest study level only", async () => {
  const { defaultSelection } = await import("../src/sync.ts");
  const make = (fullname: string, enddate: number | null = null) => ({ id: 1, shortname: fullname, fullname, startdate: null, enddate, url: "" });
  const courses = [make("COM1025 Foundations"), make("COM2001 Systems"), make("COM2002 Databases"), make("COM2003 Old", 1), make("Library Skills")];
  const select = defaultSelection(new Date("2026-10-30T00:00:00Z"), courses);
  const picked = courses.filter((c) => select(c, placeCourse(c))).map((c) => c.fullname);
  assert.deepEqual(picked, ["COM2001 Systems", "COM2002 Databases"]);
});
