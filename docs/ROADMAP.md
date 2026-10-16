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

## M3 — Deadlines you can trust

Contracts: `src/extraction-types.ts`. Engine work lives in this repo; the
notification toasts, the resolve UI polish and the launch-time catch-up live in
Study Hub's shell (`m2-library` branch).

- [ ] **3.1 Text extraction** (`src/extract/`): PDF per page (`pdfjs-dist`),
      PPTX/DOCX/XLSX per slide/paragraph/sheet, HTML to text with links; cache
      in `.crawler/text/` by file hash.
- [ ] **3.2 Rule candidates and week map** (`src/candidates.ts`, `src/weeks.ts`):
      date patterns near assessment words ("due", "deadline", "submit by",
      "exam", "test", "presentation", "week N"), weights, formative flag;
      per-term week map from adapter config (QM semester dates), overridden by
      a verified "Week 1 starts …" quote; reading weeks from config.
- [ ] **3.3 Quote verification and AI extraction** (`src/quotes.ts`,
      `src/ai-extract.ts`): whitespace/quote-mark-normalised quote search; the
      date must parse from the quote itself; JSON-schema prompt with fenced
      material; queue of at most 2 through `AiRunner`; only changed documents
      that rules flagged; run count and duration reported; confirm before more
      than 20 documents on a term's first sync.
- [ ] **3.4 Schedule, change detection, notification events**
      (`src/schedule.ts`, `src/notifications.ts`): next-sync-due and catch-up
      rule (1/3/7 days), local "due in 48h" reminders from `Deadlines.json`,
      notification events from the diff of two deadline lists (date changed,
      new deadline, new conflict; new files as one summary line).
- [ ] **3.5 Pipeline integration** (`src/sync.ts`, `src/deadlines.ts`,
      `src/cli.ts`): extract, candidates, AI, verify, merge into
      `Deadlines.json` with the status rules; per-module staging in
      `.crawler/staging/`, committed when the module finishes; `lastSyncAt` in
      state; `crawler sync --ai` and a `crawler schedule` command. Done by the
      lead after 3.1-3.4 land.
- [ ] **3.6 Study Hub side** (`m2-library`): native notifications from the
      shell, timer for 48h reminders, start-at-login option, tray "Sync now",
      badge on the calendar; conflict and TBC lists already exist (resolve
      writes `user-verified`).

*Usable:* deadlines hidden in documents and announcements show up with their
quote, conflicts are shown not chosen, and the app syncs every 3 days.

## M4 — Calendar sync

Contracts: `src/calendar-types.ts`; no new dependencies (`fetch`, `node:crypto`).

- [ ] **4.1 OAuth and API client** (`src/gcal/oauth.ts`, `src/gcal/client.ts`):
      installed-app flow, loopback `127.0.0.1` redirect, PKCE, system browser,
      `calendar.app.created` scope first; refresh-token store behind
      `CalendarTokenStore`; `CalendarClient` over the REST API with etags.
- [ ] **4.2 Event mapping and sync** (`src/gcal/events.ts`, `src/gcal/sync.ts`):
      one event per deadline keyed by `crawlerId`; content hash; create /
      update / delete from `Deadlines.json`; `conflict` prefixed with ⚠ and
      listing every source; `needs-check` and `tbc` without a window never
      placed; etag mismatch means the student edited it, so report it and do
      not overwrite. Tested with a fake `CalendarClient`.
- [ ] **4.3 Wiring** (lead): `crawler calendar connect | sync | disconnect`,
      run after each sync, token in the OS credential store via the Electron
      env, `.ics` stays as the Apple/other path.
- [ ] **4.4 Study Hub side**: "Connect Google Calendar" in settings, status
      line, list of events edited by the student.
- [ ] **4.5 Friends**: Google Cloud project in testing mode; add each friend as
      a test user (up to 100). Needs the user to create the OAuth client ID.

*Usable:* a "University deadlines" calendar in Google Calendar that follows
`Deadlines.json`.

## M5 — Transcripts and subject-neutral Study Hub

- [ ] **5.1 Transcript spike** (research first, then live check): how QM's
      Echo360 ("EchoVideo (Q-Review)") exposes captions to a signed-in session
      (LTI launch, then Echo360 session cookies, then caption/VTT endpoints);
      what the Moodle side gives (`external-tool` items); legal/acceptable-use
      note. Output: a section in design 02 and a runnable
      `spikes/echo360` script to try with the real session.
- [ ] **5.2 Transcript download** (after 5.1): adapter support, saved as plain
      text in `Transcripts/` beside the lecture, manifest entries, sorter
      category already exists.
- [ ] **5.3 Subject profiles in Study Hub** (planned by a read-only helper
      against the Study Hub repo): law, STEM, humanities and general profiles
      that change the prompts, card styles and revision structure; chosen per
      module, default general.

## M6 — Public release

- README, LICENSE, CONTRIBUTING ("add your university"), CI on Windows and
  macOS runners, tagged releases with the `.exe` and `.dmg`, auto-update.
- QM acceptable-use check done.
- Code signing: Windows (removes the SmartScreen warning) and Apple Developer ID
  plus notarization for macOS (deferred until here; earlier Mac builds are
  unsigned and update manually).

## M7 — Surrey (Brightspace)

- Spike: session-auth JSON endpoints and CSRF handling.
- Brightspace adapter on the same interface; Surrey config.
