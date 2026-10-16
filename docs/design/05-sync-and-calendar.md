# 05 — Sync and calendar

## Sync schedule

- **Every 3 days** (configurable: 1, 3 or 7 days), plus **on demand**
  ("Sync now" in the tray/menu bar and the UI). The first sign-in triggers a
  full sync straight away.
- **Catch-up on launch:** if the app starts and the last successful sync is
  more than 3 days old (laptop was off), it syncs once, then returns to the
  schedule. Opening the app does not otherwise trigger a sync.
- The app can start at login (opt-in during setup, Windows and macOS) so the
  schedule holds without the student opening anything.
- Incremental: each module keeps a cursor (last-modified timestamps per item
  type). A no-change re-sync is a handful of API calls per module.
- **Reminders don't wait for a sync.** "Due in 48h" notifications are computed
  locally from `Deadlines.json` on a timer, so they fire on time even between
  syncs.
- **Trade-off:** a date changed on the VLE can take up to 3 days to reach the
  student. "Sync now" is one click from the tray, and the UI always shows
  "last synced N days ago" so the student knows how fresh it is.

## Pipeline

```
for each enabled module (parallel, max 2):
  listItems(since cursor)
  → download new/changed files       (manifest rules, see 03)
  → extract text (cached by hash)
  → candidates: VLE fields + rules + AI (changed docs only)
  → verify quotes
  → merge into Deadlines.json        (status rules, see 03)
diff against previous Deadlines.json
→ Changes.md, notifications, calendar sync
```

A sync is atomic per module: results are staged in `.crawler/staging/` and
committed only when that module finishes, so a crash never leaves a half-written
deadline list.

## Notifications

Only for things that matter, never per file:

| Event | Notify |
| --- | --- |
| A deadline's date changed | Yes |
| New deadline found | Yes |
| New conflict | Yes |
| A new source disagrees with a date the student verified | Yes (the student's date is kept) |
| Deadline in the next 48h (once) | Yes (opt-out) |
| New files | Summary line only ("12 new files in 3 modules") |

Delivered as native notifications from the desktop shell (Windows toasts,
macOS Notification Center), and as a badge on Study Hub's calendar. Each links to the deadline and its source.

## Google Calendar (primary)

- OAuth 2.0 for installed apps: loopback redirect on `127.0.0.1`, PKCE, system
  browser. The refresh token goes in the OS credential store.
- Crawler creates **its own secondary calendar** ("University deadlines") and
  writes only there. It never reads or edits the student's other calendars.
  Prefer the `calendar.app.created` scope (access only to calendars the app
  created); fall back to the broader events scope only if that proves
  insufficient.
- Each deadline maps to one event, keyed by `extendedProperties.private.crawlerId`
  = `Deadline.id`. Create, update, and delete follow `Deadlines.json`.
- Event content: title `ECS401U · Coursework 2`, description with status,
  weight, the quote, and links to the VLE source and submission page.
  `conflict` events are prefixed `⚠` and list every source; `tbc` items
  are not placed on a date — they appear as an all-day event only once a
  window is known.
- Manual edits by the student in Google Calendar are detected (etag mismatch)
  and not overwritten; reported in the UI instead.

**Distribution constraint**: a Google OAuth app with a sensitive scope stays in
"testing" mode (max 100 named test users) until Google verifies it. For
"me and friends" that is fine — add each friend as a test user. A public
release needs verification or each developer registering their own client ID
(documented in `CONTRIBUTING.md`).

## Apple Calendar and others

- `My Studies/Deadlines.ics` is regenerated every sync with stable `UID`s
  equal to `Deadline.id` and an incrementing `SEQUENCE`, so re-importing
  updates instead of duplicating in clients that honour it.
- A live subscription would need a hosted URL, which breaks local-first; not in
  v1. Revisit if Mac friends find re-importing painful (an iCloud CalDAV write,
  like the Google path, is the likely answer).

## Study Hub calendar

Reads `Deadlines.json` directly (see 06). It is the only view that shows
everything: conflicts side by side, TBC items in a separate list, and the
change history per deadline.
