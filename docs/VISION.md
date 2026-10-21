# Crawler — Vision

> Log in once. Crawler finds every deadline, exam and lecture file across your
> modules, sorts them into one folder, keeps your calendar right, and hands the
> lot to Study Hub so you can revise from it.

Status: draft, 2026-10-15. Decisions recorded here were settled in the design
conversation; open questions are listed at the end.

---

## The problem

A university VLE (QMplus, SurreyLearn, …) is where everything lives and where
nothing is easy to find. A typical term means 4–8 modules, each with its own
layout, its own conventions, and its important dates scattered across:

- assignment pages (the only place dates are *structured*),
- module handbooks and assessment briefs (PDF/Word),
- lecture slides ("CW2 due end of week 9"),
- forum announcements ("the deadline has moved to…").

The VLE's own calendar only shows the first of these. Students build their own
spreadsheet, miss the date that moved, and spend the first week of revision
downloading files one by one.

## The pitch

**Crawler surfaces what the VLE doesn't structure.** Its value is not "another
calendar" — QMplus already has one — it is the deadline buried on page 7 of a
handbook, the weighting table in a brief, the announcement that changed a date,
and every lecture file and transcript in one tidy place.

## What Crawler is

A **local desktop app** for Windows and macOS, on the student's own computer.
It:

1. **Logs in as you, in a real browser window.** You sign in through the
   university's normal page, MFA included. Crawler never sees or stores your
   password — it keeps only the session token the university hands back.
2. **Downloads the real files** for every module and sorts them into a
   Study Hub–shaped folder per module: lectures, transcripts, labs/seminars,
   past papers, assessment guidance.
3. **Finds every deadline and exam**, from structured VLE data first and from
   documents second, and records each one with **the exact file, page, line
   and a verbatim quote** it came from.
4. **Keeps watching.** It re-syncs every 3 days (or whenever you click
   "Sync now"), notices when a date moves or a new item appears, and tells you what changed and where it saw it.
5. **Puts dates where you already look** — Google Calendar (kept in sync) and an
   `.ics` export for Apple Calendar — and in Study Hub.

**Study Hub** then opens that folder and turns it into a reader, a revision
dashboard with a calendar, and spaced-repetition flashcards.

```
University VLE ──login in your browser──▶ Crawler ──writes──▶ My Studies/
                                             │                    │
                                             ├──▶ Google / Apple  │
                                             │    Calendar        ▼
                                             └──────────────▶ Study Hub
```

The **folder is the contract**. Crawler writes it; Study Hub reads it. Either
works without the other: a hand-built folder still opens in Study Hub, and
Crawler's folder is useful in plain Explorer.

## Principles

1. **A wrong deadline is worse than no deadline.** Every date carries its
   source. Nothing is shown as certain unless a structured VLE field or a
   verified quote backs it.
2. **Conflicts are shown, never resolved silently.** If the handbook says
   14 March and the assignment page says 21 March, the student sees both, with
   both quotes, and decides. "TBC" is a legitimate answer.
3. **Local-first, no server.** Course files, tokens and deadlines stay on the
   student's machine. The only things that leave it: calendar events the
   student chose to sync, and document text sent to *their own* AI CLI when AI
   extraction is needed.
4. **Your login stays yours.** SSO and MFA happen in the university's own page.
   No password is ever typed into Crawler or stored by it.
5. **AI is a fallback, not a foundation.** Structured data and rules come first.
   When AI is needed, it runs through the `claude` or `codex` CLI already
   installed and signed in on the machine — no API keys, no per-use billing.
6. **Zero linking for the user.** One install, one double-click. No pairing
   codes, no "start the bridge" window, no picking folders the app already
   knows about.
7. **Never destroy the student's work.** Files the student edited or added are
   never overwritten; Study Hub progress survives every re-sync.
8. **One university is an adapter, not a fork.** QM first, built so that adding
   another Moodle university is configuration and adding a new platform
   (Brightspace, Canvas, Blackboard) is one well-defined module.

## Who it is for

1. **Me and friends at QM** — the first users. It has to work on a normal
   student laptop with no terminal.
2. **Surrey students** — the second university.
3. **Anyone else, via GitHub** — it must look and behave like a good open-source
   project: clear README, one-click release for Windows and macOS, tests that run without a real
   student account, and a documented "add your university" path.

## Scope

### In
- QMplus (Moodle) adapter: courses, contents, files, assignments, quizzes,
  calendar events, announcements.
- Sorting files into Study Hub course folders, one per module, under one root.
- Deadline/exam extraction with provenance; conflict and TBC states.
- Re-sync every 3 days with change detection and a "what changed" view.
- Windows and macOS desktop app (one codebase), with tray/menu-bar icon,
  notifications and start at login.
- Google Calendar sync and `.ics` export.
- Lecture **transcripts** (captions), not videos.
- Study Hub changes: no bridge, multi-module root, calendar view, conflict
  view, genuinely subject-neutral (not law-specific).
- SurreyLearn (Brightspace) adapter, after QM is solid.

### Out (for now)
- Lecture video downloads.
- Fetching the central exam timetable (exams show as **TBC** until a module
  page states a date).
- Grades, submissions, posting to forums — Crawler is read-only towards the VLE.
- Any hosted service, account system or shared storage.
- Mobile apps.

## What success looks like

- A QM student installs it, signs in once, and within minutes has every module
  folder populated and every structured deadline in their Google Calendar.
- When a lecturer moves a deadline in an announcement, the student hears about
  it from Crawler the same day, with a link to the post.
- Every date in the calendar can be clicked back to the exact place it came
  from.
- A developer at another Moodle university can add theirs in an afternoon by
  following `CONTRIBUTING.md`.

## Decided

- **Desktop shell: Electron** (2026-10-15), one codebase for Windows and macOS,
  replacing Study Hub's C# launcher and the bridge.
- **macOS signing: later** (2026-10-15). Until the public release, Mac builds
  are unsigned and friends right-click → Open the first time. The Apple
  Developer Program ($99/year) and notarization come with M6.

## Open questions

- **Freshness near deadlines.** Re-sync is every 3 days, so a moved date can
  take up to 3 days to show up. Consider syncing daily in the week before a
  known deadline.
- **Exam timetable.** Accepted as TBC for v1; revisit whether QM's central exam
  timetable can be read from the student's session.
- **Transcripts at QM.** Which lecture-capture system each module uses and
  whether captions are reachable from the student's session (spike).
- **Acceptable use.** Crawler signs in the same way the official Moodle app does.
  Fine for personal use; check QM's IT acceptable-use policy before a public
  release.
- **Name** for the public GitHub repo. Licence: MIT (chosen 2026-10-21).
