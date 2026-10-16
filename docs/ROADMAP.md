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
"Sync now" run Crawler inside the shell (Study Hub depends on `crawler` via
`link:../Crawler`; the sign-in window and token store come from
`crawler/electron`). Still to do: a real QMplus sign-in through the shell,
removing `bridge/` and `launcher/`, progress for every module side by side,
and macOS.

## M3 — Deadlines you can trust

- Text extraction in Node; rule-based candidates; AI extraction via the host's
  CLI runner; quote verification; week-number resolution.
- Conflict and TBC states end to end, including the resolve UI.
- Re-sync every 3 days (plus catch-up on launch and "Sync now"), change
  detection, `Changes.md`, native notifications on both platforms.

## M4 — Calendar sync

- Google Calendar: own secondary calendar, create/update/delete by id, manual
  edit detection.
- Friends added as OAuth test users.

## M5 — Transcripts and subject-neutral Study Hub

- Transcript download for QM (per the M0 spike).
- Subject profiles in Study Hub (law, STEM, humanities, general).

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
