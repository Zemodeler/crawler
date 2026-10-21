# Crawler

Log in to your university once. Crawler finds every deadline, exam and lecture
file across your modules, sorts them into one folder, keeps your calendar
right, and hands everything to [Universal Study Hub](https://github.com/Zemodeler/universal-study-hub)
for revision.

- **Your login stays yours**: you sign in on the university's own page, and
  Crawler never sees your password.
- **Every date shows its source**: file, page, line and a verbatim quote.
- **Conflicts are shown, not hidden**: if two sources disagree, you see both.
- **Local-first**: no server and no account. Your files stay on your machine.
- **Optional AI** runs through the `claude` or `codex` CLI you already have.
- **Windows and macOS**: one desktop app that re-syncs every 3 days.

Status: **early, not release-ready**. QMplus sync, the Study Hub desktop app
in `hub/`, calendar integration, document deadline extraction and transcript
sync are implemented. SurreyLearn has a CLI adapter and login probe; live
verification and desktop university selection remain unfinished. See the
[repair plan and roadmap](docs/ROADMAP.md) for validation and release gaps.

## Try it (Windows, Node 22.18+)

```
pnpm install
node node_modules/electron/install.js   # only if Electron's binary is missing
pnpm crawler doctor <your-moodle-site>  # does the site work with Crawler?
pnpm crawler login                      # sign in on the university's own page
pnpm crawler courses                    # what will sync (this year's modules)
pnpm crawler sync                       # download files, refresh deadlines
```

Files go to `Documents/My Studies/<year>/<module>/…` (change it with
`--root <folder>`), with `Deadlines.json`, `Deadlines.ics` (import into any
calendar) and `Changes.md` beside them. Files you edit or move are never
overwritten. Run `pnpm test` for the test suite (synthetic data, no network).

After each sync, Study Hub creates or refreshes a materials index inside each
module. It leaves hand-edited indexes alone. Topic packs and flashcards are
built separately in Study Hub after you review the proposed topics.

## Docs

Run `corepack pnpm check` from this folder to typecheck and test Crawler, then typecheck,
lint, test and build Study Hub. Both projects need their dependencies installed
(`pnpm install` here and `pnpm --dir hub install`). This command does not run
live university, Google Calendar, or desktop subscription self-tests.

Deadline updates use a shared `.crawler/deadlines.lock` directory, and sync
re-reads the saved deadlines before committing. A separate `.crawler/sync.lock`
rejects overlapping full syncs before they touch manifests or temporary files.
Invalid or unreadable deadline
data blocks writes rather than being replaced with an empty list. If an app
crashes while holding the lock, close all Crawler and Study Hub processes before
removing the affected lock directory; never remove it while a writer is running.

- [Vision](docs/VISION.md)
- [Roadmap](docs/ROADMAP.md)
- Design
  1. [Architecture: one local app, no bridge](docs/design/01-architecture.md)
  2. [University adapters (Moodle, Brightspace)](docs/design/02-university-adapters.md)
  3. [Folder and data model](docs/design/03-folder-and-data-model.md)
  4. [Extraction and AI](docs/design/04-extraction-and-ai.md)
  5. [Sync and calendar](docs/design/05-sync-and-calendar.md)
  6. [Study Hub changes](docs/design/06-study-hub-changes.md)
