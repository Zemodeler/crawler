# Roadmap

Each milestone ends in something a student can use. Spikes come first because
they decide whether a path works at all.

## M0 — Spikes (de-risk)

- [x] **QMplus token login** (2026-10-16): SAML + MFA in an Electron window,
      token captured and verified, stored with `safeStorage`; Moodle 4.5.15,
      all planned functions permitted. Details in design 02.
- [x] **One module end to end** (2026-10-16, `spikes/qmplus-module`): ECS505U.
      36 sections, 117 activities, 57 files (41.7 MB) downloaded and sorted
      into `My Studies/2026-27/…` in 14.5 s, with 8 API calls and 4 parallel
      downloads. 5 assignment deadlines, 4 of them placeholder dates in 2028
      (→ `needs-check` rule). Findings in design 02 and 03.
- [x] **Host same-origin AI — Windows** (2026-10-15, Study Hub branch
      `spike/host`): Electron shell + Node host, cookie auth, "Test connection"
      passes in the real UI for both `claude` and `codex` with no pairing.
- [ ] **Host same-origin AI — macOS**, launched from Finder (the `PATH`
      pitfall). Needs a Mac.
- [x] **Login window** (2026-10-16): QM's Microsoft SAML sign-in, including the
      passkey/MFA step, works in an Electron window; the `moodlemobile://`
      redirect is caught with `protocol.handle`.
- [ ] **Transcripts**: identify QM's lecture-capture system and whether
      captions can be fetched from the session.

## M1 — QM crawl to folder (Crawler CLI) — done 2026-10-16

- [x] Moodle adapter (login, courses, items, download), with synthetic fixtures.
- [x] Course naming and rule-based sorter; manifest with re-sync safety rules.
- [x] `Deadlines.json` from structured VLE fields with `needs-check`;
      `Deadlines.ics`; `Changes.md`.
- [x] `crawler login | sync | courses | doctor <url>`, run with
      `pnpm crawler <command>` (Electron supplies the sign-in window and the OS
      token encryption).
- [x] Run against real QMplus (2026-10-16): 4 current modules, 211 files
      (291 MB) in 77 s; a second sync took 4 s and changed nothing.
- 112 tests; the three engine branches were reviewed by helpers, and the sync
  and CLI by the lead only.

*Usable now:* `pnpm crawler login`, then `pnpm crawler sync`.

*Not in M1:* deadlines hidden in documents and announcements (M3); Study Hub
integration (M2); Google Calendar (M4).

## M2 — One app, no bridge (Study Hub)

- Electron desktop shell (Windows + macOS) replaces the C# launcher and the
  bridge; host runs inside it; pairing removed.
- Library backend; Study Hub opens `My Studies/` with no picker.
- Multi-module root and module switcher.
- Calendar view reading `Deadlines.json`, with sources.

*Usable:* double-click, sign in to QMplus, see modules and deadlines in
Study Hub.

*Progress (2026-10-16, Study Hub branch `m2-library`):* UI choices settled
(modules listed in the sidebar with a colour dot each, past years folded away,
calendar opening as a list with a month view, deadline details in a side panel,
"Next 7 days" on the overview, a three-step first launch). Done: the host
serves `My Studies/` (`/api/library/*`, files at `/library/<path>`) with no
picker; module sidebar; flashcards follow the chosen module; `/calendar` with
the side panel and "Use this date" / "Enter date" writing `user-verified`.
Checked on a sample library in Electron, plus 6 new host tests. First launch
(`/welcome`: university sign-in, then choosing the assistant, then the first sync) and a sidebar
"Sync now" run Crawler inside the shell; the overview shows every module of the year side by side (files opened, cards reviewed, next deadline) (Study Hub depends on `crawler` via
`link:../Crawler`; the sign-in window and token store come from
`crawler/electron`). The bridge and the Windows launcher are removed:
subscription mode runs only through the desktop app (its self-test connects
with both `claude` and `codex`). The Converter (`/generate`) now works on a
synced module: the host writes only Study Hub's own files (hub, Revision/,
Flashcards/, materials index, .study-hub/), checked with the same rules as the
page. The real QMplus sign-in and first sync ran through the app
(2026-10-16: 4 modules, 214 files). Still to do: installers, and macOS.

## M3 — Deadlines you can trust — engine done 2026-10-16

Engine on Crawler `master`; the desktop side on Study Hub branch `sh/m3-m5`
(built on `m2-library`, not yet merged into it).

- [x] **3.1 Text extraction** (`src/extract/`): PDF per page (`pdfjs-dist`),
      PPTX/DOCX/XLSX per slide/paragraph/sheet, HTML to text with links;
      cached in `.crawler/text/<sha256>.<format>.json`.
- [x] **3.2 Rule candidates and week map** (`src/candidates.ts`, `src/weeks.ts`).
      QM 2026-27: teaching week 1 is Mon 21 Sep 2026 (Semester A) and Mon 25 Jan
      2027 (Semester B); QM numbers its reading week as week 7 (checked against
      ECS519U's "Assessment 1 - Week 11: Monday 30/11/2026"). Year-long modules
      get no week map, so "week N" stays TBC. QMplus dates every module
      1 Sep to 31 Aug, so the term then comes from the module's text
      ("January exam", "Semester A") or, failing that, from when its
      announcements were posted (2026-10-17). A "week N" deadline with no day
      keeps its date TBC but gets that teaching week (Mon-Fri) as `window`,
      shown in Study Hub as "w/c 30 Nov"; quotes of one assessment in the same
      week merge into one deadline.
- [x] **3.3 Quote verification and AI extraction** (`src/quotes.ts`,
      `src/ai-extract.ts`): a date must parse from its own quote; "week N" only
      through the week map; a weekday alone never dates anything; a time must
      match the quote or the date becomes all-day. Known limit: injected text
      that contains its own date and is quoted verbatim passes, because the
      page really says it.
- [x] **3.4 Schedule and notification events** (`src/schedule.ts`,
      `src/notifications.ts`), including a notification when a new source
      disagrees with a date the student verified.
- [x] **3.5 Pipeline** (`src/pipeline.ts`, `src/sync.ts`): documents,
      announcements, pages and assignment briefs; AI only on changed documents
      that rules flag, asked first above 20; quoted dates fill undated VLE
      deadlines and are kept across syncs; ambiguous titles fill nothing;
      rejected candidates in `.crawler/rejected.json`. `crawler sync --ai`,
      `crawler schedule [--every 1|3|7]` (`src/ai-runner.ts` runs the local
      `claude`/`codex` with the host's guards).
- [x] **3.6 Study Hub side** (`shell/background.mjs`, `shell/setup.mjs`):
      sync every 1/3/7 days and once on launch when overdue; tray with "Sync
      now", "Start at login" and Quit (closing the window keeps it in the
      tray); native notifications (at most 4, then a summary); 48h reminders on
      a timer; the sync reads documents with the student's chosen assistant and
      never asks from a background sync. Checked: tests, build, Electron
      self-test. Not yet checked: a real scheduled sync over days, macOS.

## M4 — Calendar sync — engine and UI done 2026-10-16

- [x] **4.1 OAuth and API client** (`src/gcal/oauth.ts`, `src/gcal/client.ts`).
- [x] **4.2 Event mapping and sync** (`src/gcal/events.ts`, `src/gcal/sync.ts`):
      never touches events without a `crawlerId`, never overwrites a student's
      edit, reconciles duplicate copies, strips credentials from event text.
- [x] **4.3 Wiring**: `crawler calendar connect | sync | disconnect | status`,
      automatic update after `crawler sync`, encrypted token
      (`createCalendarTokenStore`).
- [x] **4.4 Study Hub side**: "Syncing" and "Google Calendar" on the calendar
      page (connect, update now, disconnect, events the student edited).
- 4.5 (the Google OAuth client for friends) moved to M6 on 2026-10-17.

## M5 — Transcripts and subject-neutral Study Hub — done 2026-10-16

- [x] **5.1 Transcript spike**, run live on ECS505U: LTI 1.0 form post,
      syllabus JSON, WebVTT captions (design 02, "Verified on QMplus").
- [x] **5.2 Transcript download** (`src/adapters/echo360.ts`,
      `src/transcripts.ts`): captions saved as text in
      `Course Materials/Transcripts/NN - <lecture> (<date>).txt`, once per
      recording, at most 40 new per sync, paced; transcripts are not read for
      deadlines. `crawler sync --no-transcripts` skips them. Not yet run
      against QMplus end to end (the spike was).
- [x] **5.3 Subject profiles in Study Hub** (`lib/subject-profiles.ts`): law,
      STEM, humanities, general; chosen per module in `.study-hub/profile.json`,
      suggested from the module code and title; existing law modules stay law
      and produce byte-identical files and prompts.

## M6 — Public release

- README, LICENSE, CONTRIBUTING ("add your university"), CI on Windows and
  macOS runners, tagged releases with the `.exe` and `.dmg`, auto-update.
- QM acceptable-use check done.
- Google Calendar OAuth client (from M4.5, deferred 2026-10-17): create the
  Google Cloud desktop client (`calendar.app.created` scope), ship it via
  `google-oauth.json` or `CRAWLER_GOOGLE_CLIENT_ID`/`_SECRET`, add test users
  (or verify the app), and run the calendar sync against real Google once.
- Code signing: Windows (removes the SmartScreen warning) and Apple Developer ID
  plus notarization for macOS (deferred until here; earlier Mac builds are
  unsigned and update manually).

## M7 — Surrey (Brightspace)

- Spike: session-auth JSON endpoints and CSRF handling.
- Brightspace adapter on the same interface; Surrey config.
