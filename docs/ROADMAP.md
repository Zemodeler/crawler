# Roadmap

Each milestone ends in something a student can use. Spikes come first because
they decide whether a path works at all.

## Repair plan (2026-10-21)

### Status and scope

This is the active repair backlog. The milestone notes below are historical
records, including old branch names and past test results; their checkboxes
do not establish the current checkout's release readiness.

Baseline fixes are committed at `f74584b`. The combined repair candidate is
`f8c2b14`, containing all six implementation branches, sync wiring and two
validation follow-ups. It is awaiting final review and merge into master.

The lead validated a fresh, detached checkout with separate frozen installs:
421 crawler tests passed at `f0e060d` (crawler source/tests are unchanged through
`f8c2b14`); at `f8c2b14`, all 132 Hub tests passed with no skips, both typechecks
passed, lint had no errors and one existing `openModule` hook warning, and the
production build passed. The optional packaged smoke was enabled using a locally
built unsigned Windows executable from `a5ddbda`; runtime source is unchanged
in the later staging-tool fix. Its four packaging/update checks passed, including
page serving and PDF extraction. No installer GUI or macOS validation is claimed.

Ignored local evidence logs include `out/combined-f0e060d-check.log`,
`out/combined-f8c2b14-hub-check.log`, `out/combined-a5ddbda-package.log` and
`out/combined-a5ddbda-package-tests.log`. Initial combined validation found
two incomplete/corrupt-state test boundary assumptions and generated staging
files leaking into lint; dedicated follow-ups fixed these without weakening
production validation. Independent review is still outstanding. Harbor has no
configured checks; the full checks above were run directly by the lead.

Live QMUL validation also passed on Windows using the existing saved sign-in
and a new ignored test library: 21 deadlines and 18 lecture transcripts were
saved. A second sync exited successfully with the same 18 transcripts and zero
changed transcript hashes. Four deadlines remained `needs-check`. No AI was
requested and the student's normal library was not used. Private output stays
under ignored `out/live-qmul-f8c2b14*` paths.

Work in the order below. Each stage needs its acceptance checks and review
before it is considered complete. A blocked live integration does not block
independent local fixes. Do not merge, publish, or choose a license merely to
clear a checklist.

### 1. Establish a runnable baseline (P0, local checks passing)

- In a permitted Node 22.18+ environment, install the root and `hub/`
  dependencies from their lockfiles. Run the existing root and Hub checks,
  recording the exact checkout and commands. Where practical, compare failures
  against clean `master` to separate existing failures from working-tree
  regressions; preserve current edits.
- Run the new storage tests first for quick feedback. Run `pnpm check` once
  for the integrated batch; repeat only the checks affected by later changes.
- Record each failure with its cause or an explicit unresolved status. Do not
  suppress errors, filter diagnostics, or change expectations to obtain green
  output. Earlier project notes about failures are leads to verify, not waivers.

**Done when:** tests, both typechecks, Hub lint and build have recorded results,
and regressions from the current changes are resolved. A denied executable is
recorded as blocked verification, never a passing check.

### 2. Finish deadline storage safety (P0, implemented and validated; review pending)

**Scope:** `src/deadline-store.ts`, `src/sync.ts`, `hub/host/library.mjs`,
and their storage, sync and host tests.

Implemented so far: shared deadline transactions, commit-time re-read, strict
deadline/assessment reads, and a separate root-level lock that rejects
overlapping full syncs before they touch temporary files or manifests. Tests
cover edits during sync, corrupt data, failure cleanup and independent-process
exclusion. Locks left by a crash require manual recovery after closing all
writers; live locks are never stolen by age. Failure-injection coverage for
all filesystem errors and consistency across JSON/ICS/state writes still needs
review; passing current tests does not close every acceptance item below.

- Review the shared filesystem lock, commit-time re-read and strict reads
  already added. All UI deadline mutations must hold the same lock as sync
  across the complete read/modify/write operation.
- Check independent CLI/desktop processes, not only concurrent promises.
  Separately check overlapping full syncs: deadline locking alone does not
  protect shared manifests, temporary files, assessment files or sync state.
  Add a root-level sync exclusion mechanism if these can race.
- Test missing files separately from malformed JSON, invalid record shapes,
  permission errors, write/rename failures, lock contention and process exit.
  Define recovery for abandoned locks without stealing a live writer's lock.
- Check how storage errors reach the UI and CLI. Keep earlier files intact
  and explain partial completion if JSON, ICS or state writes fail separately.

**Done when:** manual additions and deletions, confirmed dates, notes and done
flags survive interleaved UI/sync writes; unreadable data is never replaced
with defaults; competing writers fail safely or serialize. Regression tests
and review cover these guarantees and document any remaining limitations.

### 3. Fix assessment identity and week inference (P1, local regression checks passing)

**Scope:** `src/pipeline.ts`, `src/candidates.ts`, `src/deadlines.ts`, the
sync wiring and focused deadline/pipeline tests.

Implemented and locally tested: distinct numbered assessments no longer merge
solely by date; same-week merging requires a specific shared title and compatible
weights, formative status and assessment numbers. Ambiguous matches remain
separate. Identical titles with conflicting metadata receive distinct stable
IDs, including when source order changes. Completion flags and student notes
prevent automatic deduplication from dropping records. Specific VLE titles can
still identify presentations mislabeled as coursework by the platform.
Week references now distinguish due weeks from releases, feedback and source
pointers in rules and AI week-only candidates. Automatic undated text windows
are recomputed from current quotes; student choices and VLE windows are left
alone. A release-duration window needs both facts in the same quote, and London
calendar-day arithmetic handles clock changes. Tests cover these cases and
conflicting evidence. Existing dated records are not a wholesale migration:
previously accepted AI dates may require a source refresh or student review.

The combined candidate adds a narrower unique-identity fold for old dateless
duplicates, plus quote-based repair of conclusively disproved automatic week
dates before merging. Student-confirmed dates are protected. The broad heuristics
from `8e5e417` were not copied wholesale. All 421 crawler tests pass; uncertain
legacy evidence remains conservative and independent review is outstanding.

- Compare commit `8e5e417` on
  `harbor/session-there-s-so-many-dates-to-b99848` with the current checkout.
  Reuse only reviewed missing behavior; do not apply the branch wholesale.
- Require assessment identity evidence beyond a shared kind/day/week. Keep
  ambiguous candidates separate, preserve all provenance, and protect records
  carrying student choices from deduplication.
- Distinguish due weeks from release, feedback and announcement weeks;
  recompute stale inferred windows when their evidence changes. A release
  week alone must not become a confirmed due date.

**Done when:** negative tests keep distinct same-day/same-week assessments
separate, while positive tests combine repeated evidence for one assessment.
Cover numbering, conflicting weights, formative versus summative work,
ambiguous titles, release durations, stale windows and repeat-sync stability.

### 4. Make extraction coverage visible (P1, implemented; local checks passing)

**Scope:** extraction/pipeline counts and reports, CLI output, desktop sync
summary and their tests.

Implemented: per-file unsupported-format, size-limit, empty-extraction and
read-failure diagnostics in course reports, CLI output and desktop summaries.
First launch and the sidebar sync control expose the incomplete checks in a
disclosure. Parser failures and blank/scanned documents can both yield empty
text; the message explicitly avoids claiming which caused it. Empty cache
results are retried. Tests verify prior evidence survives a failed read,
diagnostics omit authenticated source URLs, and desktop summaries retain
the issues. Typechecks, tests, lint and build pass; a visual desktop smoke
check remains outstanding.

- Report unreadable, oversized, unsupported and failed documents with useful
  reasons. Separate incomplete coverage from a successful read with no dates.
- Preserve earlier evidence for failed reads and retry transient failures.
  Use local filenames in diagnostics; do not expose credentials or signed URLs.

**Done when:** a broken document is visible in both CLI and desktop summaries,
other courses continue, and tests prove failed reads retain prior evidence.

### 5. Complete desktop university selection (P1, implemented and locally validated)

**Scope:** setup preferences/API, welcome UI, adapter selection and setup tests.

The combined candidate persists QMUL/Surrey selection, scopes credentials by
site, rejects switching during sign-in/sync, and protects library ownership.
Legacy unmarked QMUL libraries are preserved; ambiguous Surrey/mixed evidence
is refused rather than silently adopted. Surrey is labeled experimental.
Focused regressions and the integrated Hub suite pass. Live Surrey sign-in
and visual desktop validation remain outstanding.

- Persist the selected university, defaulting existing installations to QMUL.
  Use that selection for sign-in, status, manual and scheduled syncs.
- Prevent switching during active sign-in/sync. Keep credentials scoped to
  their site and define how an existing library behaves when switching; do
  not silently overwrite another university's module data.
- Label Surrey support experimental until its live login/API probe succeeds.

**Done when:** synthetic tests cover QMUL and Surrey selection, restart
persistence, expired credentials, busy-state rejection and account isolation.
Existing QMUL setup continues working. Live Surrey acceptance is tracked below.

### 6. Add repeatable project validation (P1, CI authored; remote runs pending)

`.github/workflows/check.yml` now runs frozen installs and the full check
command on Windows and macOS for pushes, pull requests and manual runs. Node is
pinned to 22.23.3; both package manifests pin pnpm 12.11.2 and their lockfiles
include its package-manager dependencies. Both frozen installs pass locally.
The workflow has not run on GitHub, and macOS remains unverified. Nothing was
pushed or published; Harbor checks remain unconfigured.

- After local failures are understood, add Windows and macOS CI using pinned
  Node/package-manager versions and frozen lockfile installs for both projects.
- Run the same project checks as local development. Configure Harbor checks
  separately if its environment supports them; CI does not configure Harbor.
- Update README commands and roadmap status to match actual evidence. Keep
  build/test results distinct from authenticated desktop smoke tests.

**Done when:** the integrated checkout passes the full check command and CI
on both platforms, with one review of the final batch and recorded limitations.
Any accepted baseline exception needs a specific reason and tracked follow-up.

### 7. Verify live integrations and calendar configuration (P1, external access needed)

| Work | Required environment | Acceptance evidence |
| --- | --- | --- |
| Surrey login and download | Authorized SurreyLearn account | Probe succeeds; sync and repeat sync return correct courses, files and deadlines; expired sessions recover |
| Teaching calendars | Official university term calendars | Verify provisional QMUL Semester B and add sourced Surrey rows; missing/provisional dates remain explicit |
| Google Calendar | Configured desktop OAuth client and authorized test account | Connect, create, update, preserve a student edit, disconnect and reconnect without touching unrelated events |
| Echo360 | Existing authorized QMUL sign-in | Lead live sync saved 18 transcripts; repeat sync kept all 18 byte-identical. Broader no-caption/expired-session behavior has synthetic coverage only |
| Scheduling and reminders | Desktop running across scheduled intervals | Due sync, reminder deduplication, sleep/wake and relaunch behave as documented |
| macOS desktop | Mac launched from Finder | Sign-in, assistant discovery, tray/login behavior and sync pass outside a terminal environment |

Do not treat synthetic fixtures or historical spike results as these checks.
Credentials and OAuth configuration stay outside the repository. These checks
do not authorize publishing or redistributing course material.

### 8. Prepare a distributable release (P2, unsigned Windows runtime verified)

The combined candidate adds isolated Windows/macOS packaging commands,
frozen-input build staging, no-publish defaults, contributor guidance and a
manual update dialog. Generated release folders are excluded from source lint.
The lead built an unsigned Windows unpacked app and verified pages/PDF parsing.
NSIS install/upgrade/uninstall, macOS, signing/notarization, a trusted automatic
update target are not verified or configured (license: MIT, chosen 2026-10-21).
Manual updates are deliberately offered until a release authority exists.

- Add installer configuration and verify clean installation, upgrade and
  uninstall paths. Implement an update mechanism and test failure recovery.
- Draft contribution guidance. Obtain signing
  identities, OAuth distribution configuration and intended release target.
- Sign/notarize artifacts when credentials are available. Publishing, pushing
  and release uploads require explicit authorization.

**Done when:** release artifacts pass clean-machine smoke tests, documented
features match supported platforms, and known limitations are recorded. Keep
unsigned test artifacts distinct from a signed public release.

### Applying changes

Historical Harbor branches are evidence to inspect, not an apply queue. Compare
actual diffs against master and review the final integrated change. Keep current
working-tree work separate from reviewed, committed, applied and published
states; none implies the next. Record check results against the exact revision
being reviewed, and never label an untested branch ready to Apply.

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
      QM 2026-27: teaching week 1 is Mon 21 Sep 2026 (Semester A; teaching
      began Tue 22 Sep, confirmed) and Mon 25 Jan 2027 (Semester B,
      provisional); each term has 12 numbered weeks, and Study Hub shows the
      current one (`teachingWeekAt`) on the overview and calendar. QM numbers its reading week as week 7 (checked against
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
