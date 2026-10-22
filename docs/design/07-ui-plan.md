# 07 — Study Hub UI plan

Status: proposal, 2026-10-22. Based on screenshots of every route in the
desktop build (1440 px and 390 px wide, real `My Studies` library), a read of
`hub/app/*`, and the Impeccable (Operate mode) and taste-skill guidance.

## Design read

Study Hub is an **operate** surface: a student opens it to answer "what is due,
and what do I study next?", then reads, drills cards or checks a date. It is
not a landing page. Scanability, consistency and trust in dates outrank
expression; the brand lives in details (module colours, the reading view,
precise date language).

**Direction: refine, don't redesign.** The teal/paper identity is calm,
distinctive and already right for studying. What is wrong is structure and
system, not taste: five different page chromes, a marketing hero inside the
app, no tokens, and dense pages that repeat themselves.

Dials (taste skill): variance 4, motion 3, density 6.

## What the screenshots show

### Structure
1. **No shared shell.** Home has a dark sidebar; Calendar and Assessments have
   a light top bar with "← Study Hub"; Flashcards has a dark teal bar with a
   coral "Switch course" button; AI settings and Build packs are centred cards
   on a blurred teal/coral gradient; Welcome is a third card style. Leaving
   Home loses the navigation.
2. **Home is a 2,900 px stack** with no priority: Subject picker (a settings
   control) sits first, then two notices, deadlines, modules, then a marketing
   hero ("Your revision command centre / Know what to study next"), a 0 %
   ring, a second 0 % bar, four count tiles, and a "Recent materials" list
   that is really all 12 packs plus 5 files. The coral "Recommended now" panel
   stretches to 1,000 px of empty colour.
3. **The sidebar mixes levels.** App navigation, the module list and the
   current module's 13 topics share one column; topics are truncated and two
   look identical ("01 - Introduction and Overview…").
4. **Assessments is a 4,000 px wall.** ~40 identical rows under "To do", then
   every module repeats the same rows again under its weight breakdown. The
   weight bars are a green/grey that matches nothing else.
5. **The chat button covers content** (Calendar's TBC pills, Home's list).

### System
6. `globals.css` is 47 KB on effectively one line. Ten custom properties; about
   70 other hard-coded hex colours; **24 border-radius values**; 23 font sizes,
   most of them 10–12 px (35 × 11 px, 21 × 10 px); weights 600–900 with 800 as
   the default. Tailwind is imported but barely used.
7. **Type:** Georgia headings + Inter body. Body UI text at 10–11 px is too small
   for a desktop app and fails contrast in muted grey.
8. **Eyebrows everywhere:** 20 uppercase tracked labels in the TSX (DEADLINES ·
   TEACHING WEEK…, 2026-27, RESUME, RECOMMENDED NOW, PACKS…), plus a second,
   different uppercase label style on settings pages ("1. WHICH ASSISTANT" vs
   "CLAUDE API KEY").
9. **Callout fatigue:** Build packs stacks three tinted callouts; "Redo study
   packs" is plain text inside one.
10. **Background blobs** (radial teal/coral mesh) on Welcome, AI settings and
    Build packs read as generic AI styling.
11. **Narrow windows:** the calendar month grid scrolls sideways and chips
    truncate to "ECS529U" with no title; Home's pack bars run off the right edge.
    (Electron is desktop-only, but a half-screen snapped window is ~720 px.)
12. **States:** loading is a text line ("Opening your modules…"); 2 focus-visible
    rules in the whole stylesheet; no dark theme.

### Content spotted on the way (not UI, but visible)
- Duplicate topic: "Introduction and Overview" and "Introduction and Overview
  of Software Engineering" (sidebar and Flashcards categories).
- Raw VLE names leak through ("test_quiz", "001 ECO Examination 60% January
  exam period").

## Target information architecture

One left rail on every route except first-run Welcome:

```
[module switcher: ● ECS505U Software Engineering ▾]
Today            ← was Home's overview
Module           ← Overview · Read · Files · Cards tabs for the active module
Calendar
Assessments
Flashcards
────────
Sync status / Sync now
AI settings
```

- **Today** answers one question per block, in this order: *Due soon* (next 7
  days, with the "13 need a check" link), *Pick up where you left off* (last
  opened file + weak cards due), *Your modules* (the existing module cards).
  Remove the hero, the ring, the duplicate bar and the PACKS/TOPICS count tiles.
  One recommended action, not a coloured panel.
- **Module** owns what is module-specific today: topics (as a progress list,
  one row each), the reader, files, and the Subject picker as a small
  "Subject: STEM ▾" control in the module header.
- Transient notices ("106 study files found. Nothing was uploaded.") become a
  toast or go away in the desktop app; the format-check banner stays inline.
- **Chat** docks as a right-side panel that pushes content, so it never covers
  it; the launcher sits in the rail footer or top bar.

## Visual system (DESIGN.md)

- **Colour:** primitives → semantic tokens (`--surface`, `--surface-raised`,
  `--text`, `--text-muted`, `--accent`, `--border`, `--status-*`), light and
  dark sets. Teal stays the only accent; coral is retired as a second CTA colour
  and kept only for "overdue/danger". Module colours become the main source of
  colour in data views (bars, chips, dots), including the Assessments weight
  bars.
- **Type:** one UI sans (Geist, self-hosted, tabular figures for dates and
  percentages) and one serif kept deliberately for the reader and page titles
  (Source Serif 4 or Newsreader, self-hosted; not Georgia, not Fraunces).
  Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32. Nothing under 12 px; body 14 px.
  Weights 400 / 500 / 600 only.
- **Shape:** radius 6 (inputs, chips), 10 (cards, buttons), 16 (dialogs),
  full (pills, dots). Nothing else.
- **Labels:** at most one eyebrow per screen (the page context, e.g. teaching
  week). Section headings are plain 16 px/600. One form-label style.
- **Depth:** borders first; one tinted shadow for floating layers only.
- **Backgrounds:** flat paper; no radial blobs.
- **Status pills:** keep the existing vocabulary (Checked by you, Needs check,
  Dates disagree, Date TBC, Day not stated) — it is good copy — but give them
  one shape and a colour per meaning used everywhere.

## Phases

Each phase is shippable on its own and sized for one focused session. Phases
2–6 depend on 0 and 1 and can run in parallel after that.

| # | Phase | Main files | Done when |
|---|-------|------------|-----------|
| 0 | **Foundations.** Write PRODUCT.md and DESIGN.md; split `globals.css` into `tokens.css` + area files; self-host fonts; map every hex/radius/size to a token; dark theme via `prefers-color-scheme`. No layout changes. | `hub/app/globals.css`, new `hub/app/styles/*`, `hub/public/fonts/*`, `hub/app/layout.tsx` | Screenshots match today's layout; hex count outside tokens ≈ 0; 4 radii; no text < 12 px. |
| 1 | **App shell.** Shared rail + module switcher in `layout.tsx`; every route renders inside it; chat as a docked panel. | `hub/app/layout.tsx`, new `hub/app/shell/*`, `hub/app/chat/ChatDock.tsx`, route headers | Navigation identical on all routes; nothing covered by chat. |
| 2 | **Today page.** New block order; hero/ring/count tiles removed; Subject picker and topics moved to Module. | `hub/app/page.tsx`, `module-overview.tsx`, `calendar/deadline-ui.tsx`, `subject-control.tsx` | Home fits in ~1.5 screens at 1440×900 with a real library. |
| 3 | **Assessments.** Group by time: Overdue · This week · Next 4 weeks · Later · Date TBC; one compact row per item; per-module weight summary as a stacked bar in module colours instead of repeating rows. | `hub/app/assessments/page.tsx` | No item appears twice; page < 2 screens for 40 items. |
| 4 | **Calendar.** Header (title left, view + filters right, Assessments in the rail); chip titles always readable (tooltip/wrap); below 900 px switch to the agenda list automatically; keyboard navigation between days. | `hub/app/calendar/*` | No horizontal scroll at 720 px. |
| 5 | **Flashcards.** Inside the shell; hosted mode drops "Switch course"; hero → a compact session panel; categories as a progress list. | `hub/app/flashcards/page.tsx` | Same visual language as Today. |
| 6 | **Settings and first run.** AI settings and Build packs become normal shell pages (no centred card, no blobs); one callout max per step; Welcome's stepper replaces the duplicate "STEP 1 OF 3" eyebrow and the university picker becomes a proper field. | `hub/app/connect/page.tsx`, `generate/page.tsx`, `welcome/page.tsx`, `format-check-dialog.tsx` | One label style; one primary action per step. |
| 7 | **Harden.** Skeleton loading for library/deadlines; designed empty and error states; focus-visible everywhere; contrast audit (WCAG AA) light and dark; reduced motion; copy pass on raw VLE names where we control the display. | all routes | Accessibility audit passes; every route has loading/empty/error. |

**Verification for every phase:** capture all routes at 1440 and 720 px
before and after with an Electron screenshot script (prototype used for this
plan: starts the host, loads each route, `capturePage()`); add it as
`hub/tools/ui-shots.mjs` in phase 0 so later phases can diff against it.

## Out of scope

- Changing what the crawler extracts or how deadlines are scored.
- A new brand, logo or colour world.
- Mobile phone layouts beyond "nothing breaks at 390 px".
