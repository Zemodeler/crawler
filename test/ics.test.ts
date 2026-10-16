import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeText, foldLine, toIcs } from "../src/ics.ts";
import type { Deadline, DeadlineStatus } from "../src/types.ts";

const now = new Date("2026-10-15T17:00:00Z");

function deadline(id: string, status: DeadlineStatus, overrides: Partial<Deadline> = {}): Deadline {
  return {
    id,
    module: "ECS401U",
    year: "2026-27",
    title: "Coursework 2",
    kind: "coursework",
    status,
    due: { iso: "2026-12-14T10:00:00.000Z", allDay: false, tz: "Europe/London" },
    sources: [
      {
        type: "vle-field",
        strength: "structured",
        url: `https://vle.example/mod/assign/view.php?id=${id.length}`,
        quote: "Due: Mon 14 Dec 2026, 10:00",
        date: { iso: "2026-12-14T10:00:00.000Z", allDay: false, tz: "Europe/London" },
        seenAt: now.toISOString(),
      },
    ],
    history: [],
    ...overrides,
  };
}

/** Unfolds per RFC 5545 and splits into logical lines. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

test("calendar header, CRLF endings and a confirmed event", () => {
  const ics = toIcs(
    [deadline("moodle:ECS401U:assign:1", "confirmed", { weight: 20, submitUrl: "https://vle.example/submit", history: [
      { at: now.toISOString(), field: "added", from: null, to: null },
      { at: now.toISOString(), field: "due", from: null, to: null },
    ] })],
    now,
  );
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every newline is CRLF");
  const lines = unfold(ics);
  assert.deepEqual(lines.slice(0, 5), [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crawler//Deadlines//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:University deadlines",
  ]);
  assert.ok(lines.includes("UID:moodle:ECS401U:assign:1@crawler"));
  assert.ok(lines.includes("SEQUENCE:2"));
  assert.ok(lines.includes("DTSTAMP:20261015T170000Z"));
  assert.ok(lines.includes("DTSTART:20261214T100000Z"));
  assert.ok(lines.includes("DTEND:20261214T100000Z"));
  assert.ok(lines.includes("SUMMARY:ECS401U · Coursework 2"));
  assert.ok(lines.includes("URL:https://vle.example/submit"));
  assert.ok(
    lines.includes(
      "DESCRIPTION:Status: confirmed\\nWeight: 20%\\nDue: Mon 14 Dec 2026\\, 10:00 (https://vle.example/mod/assign/view.php?id=23)",
    ),
  );
});

test("tbc, needs-check, cancelled and undated deadlines are skipped", () => {
  const ics = toIcs(
    [
      deadline("a", "tbc"),
      deadline("b", "needs-check"),
      deadline("c", "cancelled"),
      deadline("d", "confirmed", { due: null }),
      deadline("e", "user-verified"),
      deadline("f", "conflict"),
    ],
    now,
  );
  const uids = unfold(ics).filter((l) => l.startsWith("UID:"));
  assert.deepEqual(uids, ["UID:e@crawler", "UID:f@crawler"]);
});

test("conflicts carry a warning sign; URL falls back to the first source", () => {
  const lines = unfold(toIcs([deadline("x", "conflict")], now));
  assert.ok(lines.includes("SUMMARY:⚠ ECS401U · Coursework 2"));
  assert.ok(lines.includes("URL:https://vle.example/mod/assign/view.php?id=1"));
});

test("TEXT values escape backslash, semicolon, comma and newlines", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf"), "a\\\\b\\;c\\,d\\ne\\nf");
  const lines = unfold(toIcs([deadline("x", "confirmed", { title: "Lab 1; part A, B\\C" })], now));
  assert.ok(lines.includes("SUMMARY:ECS401U · Lab 1\\; part A\\, B\\\\C"));
});

test("long UTF-8 lines fold at 75 octets without splitting characters", () => {
  const title = "Évaluation — 小论文 " + "数据结构与算法".repeat(8) + " ✓";
  const ics = toIcs([deadline("x", "confirmed", { title })], now);
  for (const physical of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(physical, "utf8") <= 75, `too long: ${physical}`);
    assert.ok(!physical.includes("�"));
  }
  const raw = ics.split("\r\n");
  const start = raw.findIndex((l) => l.startsWith("SUMMARY:"));
  assert.ok(raw[start + 1]?.startsWith(" "), "summary was folded onto a continuation line");
  assert.ok(unfold(ics).includes(`SUMMARY:ECS401U · ${title}`));

  // Folding round-trips byte for byte.
  const line = "X:" + "é".repeat(100);
  assert.equal(foldLine(line).replace(/\r\n /g, ""), line);
  assert.equal(foldLine("short"), "short");
});

test("UIDs are stable across runs", () => {
  const d = deadline("moodle:ECS505U 2026/27:assign:9921", "confirmed");
  const uid = (ics: string) => unfold(ics).find((l) => l.startsWith("UID:"));
  assert.equal(uid(toIcs([d], now)), uid(toIcs([d], new Date("2027-01-01T00:00:00Z"))));
  assert.equal(uid(toIcs([d], now)), "UID:moodle:ECS505U 2026/27:assign:9921@crawler");
});
