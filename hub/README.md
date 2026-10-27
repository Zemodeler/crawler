# Universal Study Hub

A local-first revision workspace for university courses. You point it at a folder
of your own course materials and it becomes a reader, a dashboard and a
spaced-repetition flashcard app for them. It can also read your lectures and
transcripts and build the revision material itself — topic packs and flashcard
decks — using Claude or ChatGPT, and answer questions about whatever you're
currently reading.

Your notes, your progress and your review history stay in your browser. There is
no Study Hub account, and no server ever sees your course.

---

## Get started

Study Hub is a desktop app (Windows now; macOS is next). It works with
Crawler, which fetches your modules
from your university's course site into a `My Studies` folder in Documents.

Until signed installers are published on the releases page, run it from a
checkout, from this repository's `hub/` folder (Crawler is linked from `..`):

```bash
pnpm install
pnpm build
pnpm app
```

To make an installer instead, run this from `hub/` on the OS you are building for:

```bash
pnpm install
pnpm installer
```

It prints the folder holding `Study-Hub-<version>-win-x64.exe` (or the `.dmg` on
macOS), under `hub/outputs/desktop-release-*/artifacts`. The installer is
unsigned, so Windows SmartScreen asks once: **More info → Run anyway**.

On first launch Study Hub asks you to:

1. **Sign in to your university.** Its own sign-in page opens in a separate
   window. Study Hub never sees your password; it keeps only a sign-in token,
   encrypted by your operating system.
2. **Choose your assistant**, Claude or ChatGPT. Study Hub uses the app you are
   already signed in to on this computer, so a subscription you already pay for
   works. You can skip this and add an API key later.
3. **Fetch your modules.** The first sync downloads this year's files and
   deadlines. After that, **Sync now** in the sidebar fetches what is new.

Then every module is in the sidebar, deadlines are in the **Calendar**, and
nothing is uploaded anywhere: your files stay on your computer.

The same site still runs in Chrome or Edge on its own (`pnpm dev`), reading a
folder you choose. There you can connect Claude or ChatGPT with an API key;
using a subscription needs the desktop app.

---

## Contents

- [Get started](#get-started)
- [Features](#features)
- [The folder format](#the-folder-format)
- [How generation works](#how-generation-works)
- [Privacy and safety](#privacy-and-safety)
- [Advanced / manual setup](#advanced--manual-setup)
- [Project layout](#project-layout)
- [Deploying](#deploying)

---

## Features

### The workspace

- **Folder picker with memory.** Recently used folders appear as
  one-click **Reconnect** buttons. The folder is opened read-only.
- **Overview dashboard.** Overall pack progress, and tiles for packs, topics,
  cards and weak cards. Each tile is a link into the relevant view.
- **Per-pack progress bars.** A pack's progress blends three signals: whether you
  have opened it, how many of its checklist items you have ticked, and how many
  of its flashcards you have reviewed.
- **Recommended now.** Picks your next action — review weak cards if you have
  any, otherwise start the foundations.
- **Recent files.** What you last had open, so you can pick up where you left off.
- **Search.** Across filenames, note text and flashcard content, from the top bar.
- **Topics sidebar.** Every topic in the course, jumping straight to its pack.

### The reader

- Renders Markdown: headings, pipe tables, bullet and numbered lists,
  blockquotes, horizontal rules, and inline **bold**, *italic*, `code` and links.
- **Checkboxes that persist.** `- [ ]` items in your notes become real
  checkboxes, and stay ticked between sessions.
- **Links that work.** Clicking a link to another file in the folder opens it.
  Absolute Windows paths, root-relative and directory-relative links all resolve.
- **Everything else opens too.** Clicking a PDF, PowerPoint or Word file opens it
  in a new tab; clicking a CSV jumps into the flashcards.
- **All files view.** Every file grouped by what it is: guides, topic packs,
  flashcards, past papers, seminars, source materials.
- **Study assistant.** In the desktop app, the round button in the bottom-right
  corner of every page opens a chat docked along the right edge. It answers
  from the module you have open (its study packs and notes first, then up to a
  dozen slide decks and PDFs) and from your saved deadlines, so "what's due next
  week?" works. It runs through your AI connection, normally the Claude or
  Codex command line on this computer, and never has internet access. Answers
  cite the file they came from, and each quote is checked against your files.

### Flashcards

A full spaced-repetition app over the CSV files in your folder.

- **Seven study modes** — smart (weakest and most overdue first), due, weak,
  unseen, starred, progressive (in course order) and random.
- **Five-point confidence rating** rather than right/wrong, so "I knew it but
  slowly" is a distinct answer from "I knew it cold".
- **A scheduler that adapts** to how many reviews a card has had, whether your
  confidence in it is trending up or down, and how much of the deck is weak.
- **Undo** the last rating.
- **10-card checkpoints** with a short summary, so a long session has structure.
- **Daily goals** and a study streak.
- **Confidence distribution** and per-topic statistics.
- **Star** any card to build your own list.
- **Filter** by topic and by deck.

### Format check and generation

When you open a folder, Study Hub checks it against the expected format and, if
something is off, offers to fix it. See below.

---

## The folder format

Study Hub works best with a folder shaped like this. You can build it by hand —
nothing here is magic — or let Study Hub build it for you.

```
Your Course/
├─ 0 - START HERE.md                        the hub: exam target, topic table, links
├─ Course Materials/
│  ├─ 00 - COURSE MATERIALS INDEX.md        an index of everything below
│  ├─ Lectures/        …your slides
│  ├─ Transcripts/     …your lecture transcripts
│  ├─ Seminars/        …seminar worksheets
│  ├─ Past Papers/     …past exams
│  ├─ Reference/       …case lists, textbook extracts
│  └─ Assessment Guidance/
├─ Revision/
│  ├─ Guides/
│  │  ├─ 00 - Problem Question Technique + Issue-Spotting Map.md
│  │  ├─ 01 - How to Learn From Scratch.md
│  │  ├─ 02 - Five-Day First-Class Checklist.md
│  │  ├─ 03 - Master Issue-Spotting Checklist.md
│  │  ├─ 04 - Model Problem-Question Paragraphs.md
│  │  └─ 05 - Case Coverage Index.md
│  └─ Topic Packs/
│     └─ 01 - Your Topic (Topic Pack).md
└─ Flashcards/
   └─ 01 - Your Topic/
      ├─ Foundations and Cases.csv
      ├─ Scenario to Case.csv
      └─ Pack Essentials.csv
```

### The rules that matter

**The topic pack filename and the flashcard folder name must match.**
`Revision/Topic Packs/01 - Economic Duress (Topic Pack).md` pairs with
`Flashcards/01 - Economic Duress/`. This is how progress is joined, so a pack
whose name does not match its deck folder shows zero cards. Study Hub is
forgiving about `&` versus `and` and about smart quotes, but not about anything
else.

**Flashcard CSVs need a `Question` and an `Answer` column.** Any case, any order,
extra columns fine. Rows with either cell empty are skipped. Standard CSV
quoting, and both `,`-separated and quoted-with-embedded-commas work.

**Links should be relative and in angle brackets.**
`[Open pack](<Revision/Topic Packs/01 - Foo (Topic Pack).md>)`. The angle brackets
matter because pack filenames contain parentheses. Absolute `C:/…` links still
work in the reader, but they break the moment the folder moves, so Study Hub
flags them.

**Markdown is a deliberate subset.** Headings, pipe tables, `- [ ]` checkboxes,
flat bullet and numbered lists, blockquotes, `---`, and inline `**bold**`,
`*italic*`, `` `code` `` and links. Fenced code blocks, images, raw HTML,
frontmatter and nested lists are not rendered.

### What the format check tells you

On opening a folder Study Hub reports one of four levels:

| Level | Meaning |
| --- | --- |
| **valid** | Everything present, every topic joined, no dead links. |
| **partial** | Usable, but something is wrong — a dead link, a topic with no flashcards, two spellings of one topic. |
| **unformatted** | The three core pieces (guides, topic packs, flashcards) are not all there. |
| **empty** | Nothing readable in the folder at all. |

If it is not `valid`, a dialog lists exactly what is missing and offers:

- **Keep as-is** — dismisses, and remembers. It will not ask again until the
  folder materially changes.
- **Fix structure and links only** — creates the hub, the materials index and the
  derived guides, and rewrites links as relative paths. No AI, no cost.
- **Build packs and flashcards** — the full generation run.

The dialog only interrupts when you actively picked the folder. If Study Hub
reopened it for you, you get a dismissible banner instead.

---

## How generation works

The design goal is that a generated folder is correct every time, not usually.
That comes from a split: **code owns the format, the model only writes prose.**

The model never emits a filename, a path, a heading, a link, or a table. It fills
named slots in a schema. Every filename is derived from one function, which is
why a topic pack and its flashcard folder cannot drift apart. Markdown is
assembled by the same renderer the reader uses, so a preview is exactly what you
will see.

### The run

1. **Read your materials.** PowerPoint, Word and Excel files are unzipped and
   parsed in the browser; PDFs are read with pdf.js. Files it cannot read are
   listed rather than silently skipped.
2. **Propose a topic list** — and stop. You review it, rename anything, untick
   what your exam does not cover. Nothing is generated until you approve it,
   because each topic costs four requests.
3. **Per topic:** a topic pack, then a Foundations and Cases deck seeded from
   that pack's authorities, then a Scenario to Case deck seeded from those
   cards, then a Pack Essentials deck covering every rule, checklist item, move
   and trap in the pack itself — one card per item, guaranteed, so revising
   never means flipping back to re-read the pack for something the decks
   missed.
4. **The guides.** Two of the six are computed from the packs and decks with no
   AI at all — the Case Coverage Index and the Master Issue-Spotting Checklist.
5. **Assemble and check.** The hub is built last, so it can only link files that
   exist. The whole staged tree is re-validated before you see it.
6. **Review and write.** You get the complete list of files with a preview of
   each, then approve.

### How invention is prevented

Every authority and every card must carry a **verbatim quote of 5–25 words** from
a named source file. Study Hub then checks that quote against the file.

- Found → the card is kept.
- Not found, but the case name appears elsewhere in your materials → kept, and
  flagged in the pack for you to check.
- Neither → **dropped**, and the reason is written to the run log.

The run log is on screen while it works, so you can watch cards being rejected
and see why. This is the difference between telling a model not to invent case
law and being able to prove it did not.

The **Pack Essentials deck** works differently on purpose: every rule, checklist
item, move and trap in a pack is enumerated in code first, so a card for each one
is guaranteed regardless of what the model returns. The model can add extra
detail pulled from your lectures if it finds and can verify any, but a card
never goes missing just because the model didn't mention it.

### What it will not do to your folder

- **Nothing is written until you approve the file list.** The whole run is staged
  in browser storage. Cancelling leaves the folder byte-identical.
- **Nothing existing is modified, moved, renamed or deleted.** Your lectures,
  transcripts, seminars and past papers are never touched.
- **Files you edited are never overwritten.** Study Hub records what it wrote; if
  a file no longer matches, it is left alone and reported as pinned.
- **Your review history survives.** Flashcard decks are merged append-only so
  existing card identities are unchanged. Where a rewrite is unavoidable, ratings
  and ticked checkboxes are matched by text and carried across.
- **One topic failing does not fail the run.** It is marked for review and the
  rest continues.

### Cost

Before it starts, you see the number of files being sent, a rough token count,
the number of requests and an estimated price for your chosen model. Runs above
$1 are called out. On subscription mode there is no price to show — it uses your
quota — so it tells you how many CLI runs and roughly how long instead.

---

## Privacy and safety

**Without an AI connection, nothing leaves your device.** Reading, flashcards and
progress are all local. There is no account, no telemetry and no server-side
storage — the app deploys as a static site with no database.

**With one, exactly one thing leaves:** when you ask Study Hub to generate, the
text of the source files it needs is sent to your chosen provider. You see the
file count and the estimate first, and you can cancel at any point. The "ask
about this" assistant works the same way, scoped to just what you're currently
reading — and it never reaches the internet at all unless you explicitly turn
that on for that conversation.

Other specifics:

- Your API key goes only to the provider. No route in this app accepts it.
- The key is kept for the current tab by default, or on the device for 30 days if
  you ask. It is **not encrypted** — anything running in your browser profile
  could read it. That is inherent to a browser-side key and the UI says so.
- Course text is wrapped in a fence in the prompt and the model is told to treat
  it as material, not instructions. Model output is parsed as data, never
  executed, and is schema-validated before use.
- Writes are restricted to the hub, `Revision/`, `Flashcards/` and the materials
  index. Paths are checked against directory traversal, absolute paths, reserved
  Windows names and unexpected extensions. The browser's own sandbox confines
  everything to the folder you picked.
- The site sends a strict Content-Security-Policy. `connect-src` is limited to
  this app and the two provider APIs, so even injected script could not ship your
  key anywhere else. `script-src` keeps `'unsafe-inline'` because React Server
  Components hydrate through an inline bootstrap script and there is no hook to
  put a nonce on it.

---

## Advanced / manual setup

Everything below is for anyone who'd rather run the site themselves, or
understand exactly what each piece does. None of it is required just to use Study Hub — see
[Get started](#get-started) for that.

### Requirements to run the site yourself

- **Chrome or Edge.** Study Hub reads your folder through the File System Access
  API, which Firefox and Safari do not implement. There is no workaround; the
  whole local-first design depends on it.
- **Node 22.13 or newer.**
- **Nothing else.** No account, no sign-up, no database.

### Install and run

```bash
pnpm install
pnpm dev
```

That serves the site at `http://localhost:5173`. Other scripts:

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server with hot reload. |
| `pnpm build` | Production build into `dist/`. |
| `pnpm start` | Serve the production build. |
| `pnpm test` | Unit tests plus the source-level guards. |
| `pnpm test:build` | The above, after a full build. |
| `pnpm lint` | ESLint across the project. |
| `pnpm app` | Open the desktop app (after `pnpm build`). |
| `pnpm app:selftest` | Drive the desktop app's AI settings page and report whether the subscription connection works. |
| `pnpm host` | Serve the build and the AI and library API without a window (`STUDYHUB_LIBRARY` picks the folder). |

npm and yarn work too, but the lockfile is pnpm's.

### Connecting Claude or ChatGPT by hand

Generation and the "ask about this" assistant are the only features that need
an AI connection. Everything else works without one.

Go to **AI settings** (top right) and pick one box from each row:

|  | **API key** | **My subscription** |
| --- | --- | --- |
| **Claude** | Paste an Anthropic key. Pay per use. Nothing to install. | Uses the `claude` CLI you are already signed in to. Desktop app only. |
| **ChatGPT** | Paste an OpenAI key. Pay per use. Nothing to install. | Uses the `codex` CLI you are already signed in to. Desktop app only. |

Then press **Test connection**. It makes one tiny request and tells you plainly
whether it worked.

#### API key

Create a key at [Anthropic Console](https://console.anthropic.com/settings/keys)
or [OpenAI platform](https://platform.openai.com/api-keys), and paste it in.

The browser calls the provider directly. The key is never sent to a Study Hub
server — there is no route on this app that would accept it. By default it is
kept for the current tab only and vanishes when you close it. Tick **Remember
this key on this device** and it is stored in your browser instead, unencrypted,
and deleted automatically after 30 days unused. On a shared computer, leave that
unticked.

For Claude, the model defaults to Opus 5; Sonnet 5 and Haiku 4.5 are cheaper
options. For ChatGPT the model list is read from your own account when you save
the key, so it is never out of date.

#### Subscription, in the desktop app

No public interface lets a website spend a Claude Pro/Max or ChatGPT Plus
subscription. There is no OAuth flow for it and no API. The only honest route
is the first-party command-line tool you are already signed in to, so the
desktop app runs it for you on your own computer. There is no separate helper,
nothing to pair and no local-network prompt: the app serves the page itself,
from `127.0.0.1`, and runs the CLI from the same place.

It finds `claude` and `codex` on your `PATH` and inside the Claude and Codex
desktop apps, and searches again when you press **Check again**. When it runs
the CLI, it:

- answers only on `127.0.0.1`, only to its own page (a per-launch `HttpOnly`
  session cookie, a custom header, and `Host` and `Origin` checks), so no other
  site or machine can drive it;
- turns the CLI's file and shell tools off, so it can answer prompts but
  cannot read or change your files. Study Hub writes packs and flashcards
  itself, into the allowed folders only;
- lets the CLI reach the internet only when you explicitly opt into it for one
  chat conversation, never for generation;
- hides your `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the CLI, so
  subscription mode can never quietly bill an API key instead.

---

## Project layout

```
app/                 the site
  page.tsx           workspace: dashboard, reader, all-files
  chat/              the "ask about this" assistant: panel + context scoping
  flashcards/        the spaced-repetition app
  connect/           AI settings — the only login
  generate/          the conversion workspace
  markdown.tsx       the Markdown renderer, shared by reader and preview
  format-check-dialog.tsx
lib/
  course-format.ts   THE FORMAT SPEC — paths, validator, inference, CSV codecs
  course-render.ts   deterministic file assembly from structured content
  course-fs.ts       File System Access, IndexedDB, the create-only writer
  source-extract.ts  pptx/docx/xlsx/pdf text extraction, in-browser
  ai-conversion.ts   prompts, schemas, grounding checks
  conversion-run.ts  the run: stages, staging, diff, commit, resume
  id-remap.ts        keeps review history across regenerations
  ai/                provider layer: anthropic, openai, host, chat, schema, settings
  library.ts         the My Studies library, read through the desktop app
host/                the desktop app's local server: the site, AI and library API
shell/               the Electron desktop app: window, first launch, sync via Crawler
worker/              Cloudflare Worker entry: static assets, images, CSP
tests/               unit tests, plus source-level guards
```

`lib/course-format.ts` is the file to read first. It is the single source of
truth for what a course folder looks like, and both the reader and the generator
import from it — which is why the generator can only write what the reader can
read.

---

## Deploying

**Not required to use Study Hub.** [Get started](#get-started) runs everything
on your own machine — no hosting, no deployment, nothing to keep online. This
section is only for anyone who specifically wants a copy reachable at a URL,
for example to share with other students.

The app builds to a Cloudflare Worker that serves static assets and handles
image optimisation. It needs no database and no bindings beyond Cloudflare
Images.

```bash
pnpm build     # -> dist/
```

Any static host that can run a Cloudflare Worker will do, and for a purely
static deployment `dist/client` is self-contained apart from the image route.
`.openai/hosting.json` is left over from an earlier deployment on the OpenAI
Sites platform under an account this project no longer has publishing access
to — it is not wired to anything active, and a fresh deployment on a host you
control (Cloudflare, Vercel, or similar) needs its own setup from scratch,
independent of that file.
