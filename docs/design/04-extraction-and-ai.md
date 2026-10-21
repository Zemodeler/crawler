# 04 — Extraction and AI

How dates get out of the VLE and out of documents, and how we prove each one.

## Order of trust

1. **Structured VLE fields**: assignment due/cut-off dates, quiz open/close,
   calendar events. No AI. Always run.
2. **Rules on text**: date patterns near assessment words in pages,
   announcements and documents ("due", "deadline", "submit by", "exam",
   "test", "presentation", "week N"). No AI. Always run; produces *candidates*.
3. **AI extraction** with the local CLI: reads documents and announcements
   that rules flagged as likely to contain assessment information and returns
   structured candidates. Run only if a CLI is available.

All candidates from 2 and 3 must pass **quote verification** before they become
sources.

## Quote verification

Borrowed from Study Hub's card verification, tightened for dates:

- Every AI candidate carries a verbatim quote (5–40 words), a file, and a page
  or slide number.
- Crawler searches the extracted text of that page for the quote
  (whitespace- and quote-mark-normalised).
- The date in the candidate must be **parsable from the quote itself**, not
  inferred from elsewhere. "Due week 9" is accepted only if the module's
  teaching-week calendar is known (from a structured source or a verified
  "Week 1 starts …" quote); otherwise it becomes `tbc` with the quote kept.
- Fail → the candidate is dropped and the reason logged. Nothing invented
  reaches the calendar.

## Week-number resolution

QM content often says "week 7" rather than a date. Crawler keeps a per-term
week map:

- seeded from a configured term start for each university (QM: semester start
  dates in the adapter config, updated yearly),
- overridden by a verified quote from the module itself,
- reading week handled by the config, not guessed.

A date derived this way records both the "week N" quote and the week-map
source, so the student can see the reasoning.

Week references to feedback, announcements or teaching materials do not place
an assessment in that week. Release weeks stay undated; when a quote also gives
an explicit duration, Crawler can show a due window shifted by that many London
calendar days. Automatic windows on undated text deadlines are recomputed on
sync; confirmed dates and records with student choices are preserved.

## Text extraction

Done locally in Node, never by the AI:

| Format | Tool |
| --- | --- |
| PDF | `pdfjs-dist` (already a Study Hub dependency), per-page text |
| PPTX / DOCX / XLSX | unzip + XML text, per slide / paragraph / sheet (port Study Hub's `lib/source-extract.ts` to run in Node) |
| HTML (pages, announcements) | strip to text, keep links |

Extracted text is cached in `.crawler/text/<sha256>.<format>.json` (file hash
plus detected format) so re-syncs don't re-parse unchanged files.

Empty results are retried instead of cached indefinitely: an empty result can
mean a blank or scanned document, damaged content, or a parser failure. Course
reports identify unsupported formats, files over 50 MiB, empty extractions and
read failures. The CLI and desktop sync summaries show the filenames and
reasons without authenticated URLs. These files are not marked successfully
refreshed, so earlier deadline evidence survives an incomplete read.

## Calling the CLI

Through the host's `AiRunner` (see 01), which reuses the bridge's runner:

- `claude --print --output-format json` or `codex exec --sandbox read-only`,
  prompt on stdin, filesystem and shell tools disallowed, empty temp cwd.
- Document text is fenced in the prompt and labelled as material, not
  instructions. The model's output is parsed as JSON against a schema and
  never executed.
- One request per document (large documents split by page ranges). Requests
  are queued, at most 2 concurrent, so a sync doesn't eat the student's quota
  in one burst.
- Only documents that **changed** since the last sync and that rules flagged
  are sent. A typical re-sync sends nothing.

### Cost visibility

Subscription mode has no price, so the UI shows how many CLI runs a sync made
and how long they took, per module. First sync of a term asks before running
AI over more than 20 documents.

## Classification (sorter fallback)

The same runner classifies ambiguous files into the fixed category list
(see 03), given title, VLE section and the first page of text. One small
request per batch of up to 20 files.

## What the AI never does

- Never decides between conflicting dates.
- Never produces a date without a verified quote.
- Never writes filenames or paths (code owns the format, as in Study Hub).
- Never sees credentials or tokens; only document text.
