# 03 — Folder and data model

The folder is the contract between Crawler and Study Hub. Crawler writes it;
Study Hub reads it; a human can browse it in Explorer.

## Layout

```
My Studies/
├─ Deadlines.json                       every dated item, all modules
├─ Deadlines.ics                        same, for Apple Calendar / import
├─ Changes.md                           human-readable "what changed" log
├─ 2026-27/                             one folder per academic year
│  ├─ ECS505U - Software Engineering/   a normal Study Hub course folder
│  │  ├─ Course Materials/
│  │  │  ├─ Lectures/
│  │  │  ├─ Transcripts/
│  │  │  ├─ Labs and Seminars/
│  │  │  ├─ Past Papers/
│  │  │  ├─ Reference/
│  │  │  ├─ Assessment Guidance/
│  │  │  └─ Other/                      anything the sorter wasn't sure about
│  │  ├─ Revision/                      Study Hub's (generated or hand-made)
│  │  └─ Flashcards/                    Study Hub's
│  └─ ECS519U - Database Systems/
├─ 2025-26/                             last year, kept for revision
│  └─ ECS414U - Object-Oriented Programming/
└─ .crawler/
   ├─ manifest.json                     what was downloaded, from where, hash
   ├─ state.json                        last sync, per-module cursors
   └─ log/                              sync logs, tokens redacted
```

- **Module folder name**: `<module code> - <module title>`, parsed from the
  VLE's course name. QMplus names vary (`ECS401U - Procedural Programming -
  2025/26`, `ECS505U Software Engineering 2026/27`), so the parser takes the
  first code matching `[A-Z]{3}\d{3}[A-Z]?`, drops the academic-year suffix
  and separators, and keeps the rest as the title. No code (e.g. "Academic
  Integrity at Queen Mary") → the course name minus the year. Sanitised for
  Windows and macOS (reserved names, trailing dots, leading dots,
  `<>:"/\|?*`).
- **Which courses sync.** A student is enrolled in far more than their
  modules: past years and non-module sites. Default: sync only courses for the
  **current academic year** (year in the name, else course start date), with
  non-module sites listed but off. The student can switch any course on or off;
  past-year modules can be added for revision.
- **Academic years (decided 2026-10-16).** Modules are grouped by academic
  year: `My Studies/2026-27/ECS505U - Software Engineering/`. The year comes
  from the course name (`2026/27` → `2026-27`), else from the course start
  date (a year starts 1 August). Non-module sites with no year go in the year
  they were first seen. Each year stays separate, and past years can be
  archived or ignored as a whole. `Deadlines.json` stays at the root and covers
  every year.
- **`Labs and Seminars`** replaces Study Hub's `Seminars` as the canonical name;
  Study Hub accepts both (see 06).
- Crawler writes only inside `Course Materials/`, the three root files, and
  `.crawler/`. It never touches `Revision/` or `Flashcards/`.

## Sorting files

Rules first, AI second, "Other" last.

0. **Activity type** from the VLE, when it decides the answer by itself: files
   attached to an assignment (`assign`) → `Assessment Guidance`. A `page`
   activity is saved as **one** readable file (its HTML converted to text,
   with images kept beside it), never as loose `index.html` and image files.
1. **Section and activity names** from the VLE ("Week 3 – Lecture",
   "Coursework", "Past exam papers", "Lab 4").
2. **Filename and title patterns** (`lecture|slides|week \d+`,
   `past paper|exam \d{4}`, `brief|specification|marking|rubric`,
   `lab|tutorial|seminar|worksheet|exercise|EX\d`). The file's own name
   is checked before the activity's, then the section's: the most specific
   evidence wins.
3. **AI classification** (only if the CLI is available) for what is still
   ambiguous, given title, section and first page of text, choosing from the
   fixed category list. Never invents a category.
4. Otherwise → `Other/`. Listed in the UI so the student can move it.

Original filenames are kept; collisions get ` (2)`. The VLE's own section order
is preserved as a numeric prefix only in `Lectures/` (`03 - Pointers.pdf`) so
lectures sort in teaching order.

**Measured on one real module (ECS505U, 2026-10-16), rules only:** 57 files.
All 12 past papers and their solutions, 17 of 19 "Lectures" and all 11 "Labs
and Seminars" were right. Wrong: two `Week4_EX*` exercises filed as lectures,
and 12 files in `Other`. 11 of those were the HTML and images of `page`
activities; one was an assignment brief. Rule 0 and the `EX\d` pattern above
fix both.

## Manifest and re-sync safety

`manifest.json` has one entry per downloaded file:

```json
{
  "vleId": "qmul:file:58213",
  "module": "ECS401U",
  "sourceUrl": "https://qmplus.qmul.ac.uk/…/Lecture03.pdf",
  "localPath": "ECS401U - Procedural Programming/Course Materials/Lectures/03 - Lecture03.pdf",
  "category": "Lectures",
  "categoryReason": "section:\"Week 3 – Lecture\"",
  "vleModified": "2026-10-02T09:14:00Z",
  "sha256": "…",
  "writtenAt": "2026-10-15T20:01:12Z"
}
```

- **Unchanged upstream** → skipped (modified timestamp, then hash).
- **Changed upstream, local file untouched** (hash matches what we wrote) →
  replaced, logged in `Changes.md`.
- **Changed upstream, local file edited by the student** → left alone; the new
  version is saved beside it as `name (updated 2026-10-15).pdf` and flagged.
- **Removed upstream** → kept locally, marked "no longer on QMplus". Never
  deleted.
- **Student moved a file** to another category → the manifest follows the move
  (matched by hash) and future syncs respect it.

## Deadline model

`Deadlines.json` is the single source for the calendar, Study Hub's calendar
view, and Google sync.

```ts
type Deadline = {
  id: string;                    // stable: "qmul:ECS401U:assign:9921" or content hash for document-derived
  module: string;                // "ECS401U"
  title: string;                 // "Coursework 2 – Linked lists"
  kind: "coursework" | "exam" | "quiz" | "presentation" | "lab" | "other";
  status: "confirmed" | "conflict" | "tbc" | "needs-check" | "user-verified" | "cancelled";
  formative?: boolean;           // "(formative)" in the title or settings: shown, but quieter
  checkReason?: string;          // why a date is "needs-check"
  due: Instant | null;           // null when TBC
  window?: { from: Instant; to: Instant };   // "exam period: May"
  weight?: number;               // % of module, if stated
  submitUrl?: string;
  sources: Source[];             // ≥1; first is the strongest
  history: Change[];             // every change Crawler observed
  userNote?: string;
};

type Source = {
  type: "vle-field" | "document" | "announcement" | "page";
  strength: "structured" | "quoted";
  url: string;                   // link back into the VLE
  localPath?: string;            // the downloaded file
  page?: number;                 // PDF page / slide number
  line?: number;
  quote: string;                 // verbatim, 5–40 words; for vle-field, the field rendered as text
  date: Instant | null;          // what this source claims
  seenAt: Instant;
};

type Instant = { iso: string; allDay: boolean; tz: "Europe/London" };
```

### Status rules

| Situation | Status |
| --- | --- |
| A VLE due-date field exists and no other source disagrees | `confirmed` |
| Only a verified document/announcement quote | `confirmed`, strength `quoted` (shown with a lighter badge) |
| Two sources disagree on the date | `conflict` — both shown, nothing chosen for the student |
| Item is known to exist but no date is stated | `tbc` |
| A date exists but is implausible: outside the module's academic year (1 Aug – 30 Sep the following year), or before the module started | `needs-check`. Shown with the reason and its source; **not** put on the calendar until the student confirms it |
| Student picked or entered the date | `user-verified` — Crawler never overrides it, but still reports new conflicting sources |

Real case (ECS505U): four formative submission links had due dates in **2028**,
which are template placeholders. Treated as `confirmed`, they would have put
four fake deadlines into the student's calendar. Weight is read from the title
when stated ("mySkills Task 3 (3%)" → `weight: 3`).

A conflict is cleared only by the student (pick a source or enter a date) or
by the sources coming back into agreement.

## Changes

Every sync appends to `history` and to `Changes.md`:

```
## 2026-10-15 18:00
- ECS401U · Coursework 2 — due moved 3 Mar 12:00 → 10 Mar 12:00
  (announcement "CW2 extension", https://qmplus…/discuss.php?d=…)
- ECS414U · 6 new files in Lectures/
```
