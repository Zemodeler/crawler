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

Status: **design phase**. First target: Queen Mary (QMplus). Next: Surrey
(SurreyLearn).

## Docs

- [Vision](docs/VISION.md)
- [Roadmap](docs/ROADMAP.md)
- Design
  1. [Architecture: one local app, no bridge](docs/design/01-architecture.md)
  2. [University adapters (Moodle, Brightspace)](docs/design/02-university-adapters.md)
  3. [Folder and data model](docs/design/03-folder-and-data-model.md)
  4. [Extraction and AI](docs/design/04-extraction-and-ai.md)
  5. [Sync and calendar](docs/design/05-sync-and-calendar.md)
  6. [Study Hub changes](docs/design/06-study-hub-changes.md)
