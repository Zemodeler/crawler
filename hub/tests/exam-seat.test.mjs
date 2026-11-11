import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isLocationFile, isQmDeadline, seatFor, seatsInText, timingNotes, validStudentId } from "../lib/exam-seat.ts";
import { findSeats } from "../host/library.mjs";

const LIST = "ID number Room\n250652949 ENG352/356\n250658790 TB-G02\n250662960 TB-102\n1250658790 Bancroft 1.23";

test("a room is the rest of the line holding the whole student ID", () => {
  assert.deepEqual(seatsInText([{ page: 6, text: LIST }], "250658790"), [{ page: 6, room: "TB-G02" }]);
  assert.deepEqual(seatsInText([{ page: 1, text: "250658790 | Bancroft 1.15A |" }], " 250658790 "), [{ page: 1, room: "Bancroft 1.15A" }]);
  assert.deepEqual(seatsInText([{ page: 1, text: LIST }], "999999999"), []);
  assert.deepEqual(seatsInText([{ page: 1, text: LIST }], "25065879x"), []);
});

test("student IDs are digits and room lists are found by file name", () => {
  assert.ok(validStudentId("250658790"));
  assert.ok(!validStudentId("2506-58790"));
  assert.ok(!validStudentId(""));
  assert.ok(isLocationFile("2026-27/ECS509U/Lectures/21 - Student test location.pdf"));
  assert.ok(isLocationFile("x/[Release]-ECS509U_202425_midterm_test_arrangement.xlsx"));
  assert.ok(!isLocationFile("x/ecs509u-week6-handouts.pdf"));
  assert.ok(isQmDeadline({ id: "qmul:ECS509U:text:abc" }));
  assert.ok(!isQmDeadline({ id: "surrey:COM1001:x" }));
});

test("the room for an exam skips lists for a different test and prefers the newest", () => {
  const m = (path, modified, room = "R") => ({ path, page: 1, room, modified });
  const old = m("a/ECS509U mid-term test location V1030.pdf", 1, "V1030");
  const latest = m("a/21 - Student test location.pdf", 3, "TB-G02");
  const end = m("a/ECS509U end-term test location V2102.pdf", 5, "V2102");
  assert.equal(seatFor([old, latest, end], "In-term test").room, "TB-G02");
  assert.equal(seatFor([old, latest, end], "End-term test").room, "V2102");
  // An unnamed list from before the previous exam belongs to that exam.
  assert.equal(seatFor([old, latest], "End-term test", 4), null);
  assert.equal(seatFor([old, latest], "Final exam", 2).room, "TB-G02");
  assert.equal(seatFor([], "In-term test"), null);
});

test("timing notes are undated quotes with a clock time about this test", () => {
  const sources = [
    { quote: "The in-term test will take place on Tuesday 3rd November (Week 7), 11:00-13:00.", date: { iso: "2026-11-03T11:00:00Z" } },
    { quote: "Test will be open from 11:10, start at 11:15 and close at 12:45.", date: null },
    { quote: "Test will be open from 11:10, start at  11:15 and close at 12:45.", date: null },
    { quote: "The end-term test will take place on Monday 8th December, 14:00.", date: null },
    { quote: "002 EXN In-term test 40% Week 7 (TBC)", date: null },
  ];
  assert.deepEqual(timingNotes("In-term test", sources), ["Test will be open from 11:10, start at 11:15 and close at 12:45."]);
});

test("the host finds the room through the extracted-text cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "studyhub-seat-"));
  const moduleKey = "2026-27/ECS509U - Probability and Matrices";
  mkdirSync(join(root, moduleKey, "Lectures"), { recursive: true });
  writeFileSync(join(root, moduleKey, "Lectures", "Student test location.csv"), "ID number,Room\n250658790,TB-G02\n");
  writeFileSync(join(root, moduleKey, "Lectures", "handouts.csv"), "250658790,Not a room list\n");
  const { matches } = await findSeats(root, moduleKey, "250658790");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].room, "TB-G02");
  assert.equal(matches[0].path, `${moduleKey}/Lectures/Student test location.csv`);
  assert.ok((await findSeats(root, "../outside", "250658790")).error);
  assert.ok((await findSeats(root, moduleKey, "abc")).error);
});
