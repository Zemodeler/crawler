/**
 * Real unit tests for the format module — not source greps.
 *
 * These are the tests that matter: if `writeCsv` and `parseCSV` disagree, or a
 * generated link does not resolve, or a pack and its deck folder drift apart,
 * the conversion feature is silently broken in a way no build error catches.
 *
 * The modules are TypeScript, so they are transpiled on the fly by Node's
 * built-in type stripping (Node 22.6+ / 24). No build step, no bundler.
 */

import assert from "node:assert/strict";
import test from "node:test";

const format = await import("../lib/course-format.ts");
const render = await import("../lib/course-render.ts");

const {
  SPEC,
  canonicalTopicKey,
  csvHeaderIsValid,
  deckPath,
  guidePath,
  inferCategory,
  isSafeRelativePath,
  isWritablePath,
  normaliseTopicName,
  packPath,
  parseCSV,
  plainForCsv,
  relativePath,
  relLink,
  resolvePosix,
  stableCardId,
  topicFolderName,
  topicLabel,
  topicName,
  topicNumber,
  validateCourse,
  writeCsv,
} = format;

/* ------------------------------------------------------------- CSV round trip */

test("writeCsv and parseCSV round-trip exactly, with BOM and CRLF", () => {
  const rows = [
    ["Question", "Answer"],
    ["Balfour v Balfour [1919] 2 KB 571", 'Domestic agreements: NO intention. DEPLOY whenever "family" appears.'],
    ["Comma, in a cell", "Quote \" and newline-free text"],
    ["Trailing space ", " leading space"],
  ];
  const csv = writeCsv(rows);

  assert.ok(csv.startsWith("\uFEFF"), "must start with a BOM");
  assert.ok(csv.includes("\r\n"), "must use CRLF");
  assert.ok(csv.endsWith("\r\n"), "must end with a newline");
  assert.ok(/^\uFEFF"Question","Answer"/.test(csv), "every field must be quoted");

  const parsed = parseCSV(csv.replace(/^\uFEFF/, ""));
  assert.deepEqual(parsed, rows);
});

test("csvHeaderIsValid tolerates BOM, case and extra columns, and rejects the rest", () => {
  assert.ok(csvHeaderIsValid(["\uFEFFQuestion", "Answer"]));
  assert.ok(csvHeaderIsValid([" question ", "ANSWER", "Notes"]));
  assert.ok(csvHeaderIsValid(["Answer", "Question"]), "column order must not matter");
  assert.ok(!csvHeaderIsValid(["Front", "Back"]));
  assert.ok(!csvHeaderIsValid(["Question"]));
  assert.ok(!csvHeaderIsValid(undefined));
});

test("plainForCsv strips every trace of markdown", () => {
  const messy = "See *Balfour* [text](<a/b.md>) and `code` and ![img](x.png)\nnext line — dash";
  const clean = plainForCsv(messy);
  for (const forbidden of ["*", "`", "[", "]", "(", ")", "\n", "—"]) {
    assert.ok(!clean.includes(forbidden), `${forbidden} survived: ${clean}`);
  }
  assert.equal(clean, "See Balfour text and code and next line - dash");
});

/* --------------------------------------------------------- the topic-key join */

const NASTY_NAMES = [
  "Agreement (Offer & Acceptance)",
  "Consideration & Promissory Estoppel",
  "Exemption Clauses & Unfair Terms",
  "Intention to Create Legal Relations",
  "Damages for Breach",
  "Rylands v Fletcher / Nuisance",
  "Duty: the neighbour principle",
  "Article 8 “private life”",
  "Employer’s liability",
  "Remedies — equitable",
  "CON",
  "  padded name  ",
];

test("pack path and deck folder are byte-identical for every topic", () => {
  NASTY_NAMES.forEach((raw, i) => {
    const ident = { number: i + 1, name: normaliseTopicName(raw) };
    const folder = topicFolderName(ident);
    const pack = packPath(ident);
    const foundations = deckPath(ident, "foundations");
    const scenario = deckPath(ident, "scenario");
    const essentials = deckPath(ident, "pack-essentials");

    assert.equal(pack, `${SPEC.packsDir}/${folder}${SPEC.packSuffix}.md`);
    assert.equal(foundations, `${SPEC.decksDir}/${folder}/Foundations and Cases.csv`);
    assert.equal(essentials, `${SPEC.decksDir}/${folder}/Pack Essentials.csv`);
    assert.ok(isSafeRelativePath(pack), `unsafe pack path for ${raw}: ${pack}`);
    assert.ok(isSafeRelativePath(foundations), `unsafe deck path for ${raw}`);
    assert.ok(
      isWritablePath(pack) && isWritablePath(foundations) && isWritablePath(scenario) && isWritablePath(essentials),
    );

    // The property the dashboard depends on: pack and decks join on one key.
    assert.equal(canonicalTopicKey(pack), canonicalTopicKey(foundations), `join broke for ${raw}`);
    assert.equal(canonicalTopicKey(pack), canonicalTopicKey(scenario), `join broke for ${raw}`);
    assert.equal(canonicalTopicKey(pack), canonicalTopicKey(essentials), `join broke for ${raw}`);
  });
});

test("canonicalTopicKey heals the & / and split that breaks the real Contract folder", () => {
  const pack = "Revision/Topic Packs/02 - Agreement (Offer & Acceptance) (Topic Pack).md";
  const deck = "Flashcards/02 - Agreement (Offer and Acceptance)/Foundations and Cases.csv";
  assert.notEqual(topicLabel(pack), topicLabel(deck), "labels genuinely differ on disk");
  assert.equal(canonicalTopicKey(pack), canonicalTopicKey(deck), "but they must join");
  assert.equal(canonicalTopicKey(pack), "agreement (offer and acceptance)");
});

test("normaliseTopicName removes characters Windows refuses and reserved device names", () => {
  assert.equal(normaliseTopicName("A/B:C*D?E\"F<G>H|I"), "A-B-C-D-E-F-G-H-I");
  assert.equal(normaliseTopicName("Offer & Acceptance"), "Offer and Acceptance");
  assert.equal(normaliseTopicName("trailing dot."), "trailing dot");
  assert.equal(normaliseTopicName("NUL"), "NUL Topic");
  assert.equal(normaliseTopicName("   "), "Untitled Topic");
  assert.ok(normaliseTopicName("x".repeat(200)).length <= 70);
});

test("topic label, name and number are read off the path", () => {
  const pack = "Revision/Topic Packs/08 - Economic Duress (Topic Pack).md";
  assert.equal(topicLabel(pack), "08 - Economic Duress");
  assert.equal(topicName(pack), "Economic Duress");
  assert.equal(topicNumber(pack), 8);
  assert.equal(topicNumber("Revision/Guides/Unnumbered.md"), null);
});

/* ----------------------------------------------------------------- card ids */

test("card ids are stable for identical input and change when a row moves", () => {
  const path = "Flashcards/08 - Economic Duress/Foundations and Cases.csv";
  const a = stableCardId(path, 3, "What is economic duress?");
  assert.equal(a, stableCardId(path, 3, "What is economic duress?"));
  assert.notEqual(a, stableCardId(path, 4, "What is economic duress?"));
  assert.notEqual(a, stableCardId(`${path}x`, 3, "What is economic duress?"));
});

test("mergeDeck keeps existing rows at their exact index so review history survives", () => {
  const path = "Flashcards/01 - Topic/Foundations and Cases.csv";
  const existing = writeCsv([
    ["Question", "Answer"],
    ["Old card one", "Answer one"],
    ["Old card two", "Answer two"],
  ]);
  const fresh = [
    ["Question", "Answer"],
    ["Brand new card", "New answer"],
    ["Old card one", "A rewritten answer"],
  ];
  const merged = render.mergeDeck(existing, fresh);

  assert.deepEqual(merged[1], ["Old card one", "Answer one"], "row 1 must not move or change");
  assert.deepEqual(merged[2], ["Old card two", "Answer two"], "row 2 must not move");
  assert.deepEqual(merged[3], ["Brand new card", "New answer"], "new cards append");
  assert.equal(merged.length, 4, "the duplicate question must not be added twice");

  for (let i = 1; i <= 2; i++) {
    assert.equal(
      stableCardId(path, i - 1, merged[i][0]),
      stableCardId(path, i - 1, parseCSV(existing.replace(/^\uFEFF/, ""))[i][0]),
      "card id changed, review history would be lost",
    );
  }
});

test("mergeDeck preserves extra columns on kept rows, not just Question/Answer", () => {
  const existing = writeCsv([
    ["Question", "Answer", "Section", "Item"],
    ["Old card one", "Answer one", "C", "Was there an offer?"],
  ]);
  const fresh = [
    ["Question", "Answer", "Section", "Item"],
    ["Old card one", "A rewritten answer", "C", "Was there an offer?"],
    ["Brand new card", "New answer", "F", "Do not confuse void with voidable."],
  ];
  const merged = render.mergeDeck(existing, fresh);

  assert.deepEqual(merged[0], ["Question", "Answer", "Section", "Item"]);
  assert.deepEqual(
    merged[1],
    ["Old card one", "Answer one", "C", "Was there an offer?"],
    "kept row must retain its Section/Item columns, not just [question, answer]",
  );
  assert.deepEqual(merged[2], ["Brand new card", "New answer", "F", "Do not confuse void with voidable."]);
});

/* --------------------------------------------------------------------- links */

test("relLink emits angle-bracketed relative paths that resolve under both resolvers", () => {
  const cases = [
    [SPEC.hub, "Revision/Topic Packs/01 - Foo (Topic Pack).md"],
    ["Revision/Topic Packs/01 - Foo (Topic Pack).md", "Flashcards/01 - Foo/Foundations and Cases.csv"],
    ["Revision/Guides/05 - Case Coverage Index.md", SPEC.hub],
    ["Course Materials/00 - COURSE MATERIALS INDEX.md", "Course Materials/Lectures/Week 1.pptx"],
  ];
  for (const [from, to] of cases) {
    const link = relLink(from, to, "Open");
    assert.match(link, /^\[Open\]\(<.+>\)$/, `must be angle bracketed: ${link}`);
    const target = link.slice(link.indexOf("<") + 1, link.lastIndexOf(">"));
    assert.ok(!target.startsWith("/"), "must not be absolute");
    assert.ok(!/^[a-z]:/i.test(target), "must not carry a drive letter");

    // Resolver 1: directory-relative (the strict one).
    const dir = from.split("/").slice(0, -1).join("/");
    assert.equal(resolvePosix(dir, target), to, `directory-relative resolution failed for ${link}`);
    // Resolver 2: the browser pops `..` from a root-relative base, landing on the same path.
    assert.equal(resolvePosix(dir, relativePath(from, to)), to);
  }
});

test("a link whose target contains parentheses survives the inline regex", () => {
  const link = relLink(SPEC.hub, "Revision/Topic Packs/02 - Agreement (Offer and Acceptance) (Topic Pack).md", "Open pack");
  const matches = [...link.matchAll(format.LINK_RE)];
  assert.equal(matches.length, 1, "the link must parse as exactly one link");
  assert.equal(
    matches[0][1],
    "Revision/Topic Packs/02 - Agreement (Offer and Acceptance) (Topic Pack).md",
    "the whole path must be captured, parentheses included",
  );
});

/* ------------------------------------------------------------ path allowlist */

test("unsafe and non-writable paths are refused", () => {
  for (const bad of [
    "../escape.md",
    "/absolute.md",
    "C:/Windows/system.md",
    "Revision/../../escape.md",
    "Revision/Guides/CON.md",
    "Revision/Guides/trailing-dot.md.",
    "Revision/Guides/trailing-space.md ",
    "a/b/c/d/e/too-deep.md",
    "Revision/Guides/bad\u0000.md",
    "Revision/Guides/pipe|name.md",
  ]) {
    assert.ok(!isWritablePath(bad), `should refuse: ${bad}`);
  }
  for (const bad of [
    "Course Materials/Lectures/Week 1.pptx",
    "some-random-file.md",
    "Revision/Guides/script.js",
    "Revision/Guides/note.txt",
  ]) {
    assert.ok(!isWritablePath(bad), `outside the writable area: ${bad}`);
  }
  for (const good of [
    SPEC.hub,
    SPEC.materialsIndex,
    guidePath(0, "Problem Question Technique + Issue-Spotting Map"),
    "Revision/Topic Packs/01 - Foo (Topic Pack).md",
    "Flashcards/01 - Foo/Foundations and Cases.csv",
    ".study-hub/manifest.json",
  ]) {
    assert.ok(isWritablePath(good), `should allow: ${good}`);
  }
});

/* -------------------------------------------------------------- the renderer */

const RENDERABLE = [
  /^#{1,6} /,
  /^- \[[ x]\] /,
  /^[-*] /,
  /^\d+[.)] /,
  /^> ?/,
  /^\|.*\|$/,
  /^---$/,
  /^$/,
];

function assertRenderable(markdown, label) {
  const lines = markdown.split("\n");
  for (const [i, raw] of lines.entries()) {
    // Angle-bracketed link targets are legal markdown and look like HTML tags,
    // so blank them out before the HTML check.
    const noLinks = raw.replace(/\]\(<[^>]*>\)/g, "]()");
    assert.ok(!/^```/.test(raw), `${label}: fenced code block on line ${i + 1}`);
    assert.ok(!/!\[[^\]]*\]\(/.test(raw), `${label}: image on line ${i + 1}`);
    assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(noLinks), `${label}: raw HTML on line ${i + 1}: ${raw}`);
    assert.ok(!/^\s+[-*] /.test(raw), `${label}: nested list on line ${i + 1}`);
    assert.ok(!/^={3,}$/.test(raw), `${label}: setext heading on line ${i + 1}`);
    const isProse = !RENDERABLE.some((re) => re.test(raw));
    if (isProse) assert.ok(!/^\s/.test(raw), `${label}: indented prose on line ${i + 1}`);
  }
  assert.ok(!/^---\n/.test(markdown), `${label}: leading rule reads as frontmatter`);
}

test("renderBlocks only emits constructs the reader supports", () => {
  const markdown = render.renderBlocks([
    { t: "para", text: "Plain **bold** and *italic* and `code`." },
    { t: "para", text: "Injected [link](<evil.md>) and <script>x</script> and ```fence```." },
    { t: "bullets", items: ["one", "two"] },
    { t: "numbered", items: ["first", "second"] },
    { t: "checklist", items: ["tick me"] },
    { t: "blockquote", lines: ["line one", "line two"] },
    { t: "table", head: ["A", "B"], rows: [["has | pipe", "ok"], ["short"]] },
    { t: "sub", heading: "Sub heading", blocks: [{ t: "para", text: "nested" }] },
  ]);
  assertRenderable(markdown, "renderBlocks");
  assert.ok(!markdown.includes("evil.md"), "model-authored links must be stripped");
  assert.ok(!markdown.includes("script"), "HTML must be stripped");
  assert.match(markdown, /\| has \\\| pipe \| ok \|/, "a bare pipe must be escaped inside a cell");
  assert.match(markdown, /\| short \|\s+\|/, "short rows must be padded to the header width");
  assert.match(markdown, /^### Sub heading$/m);
});

test("a rendered topic pack has every section, in order, and is renderable", () => {
  const topic = { number: 8, name: "Economic Duress" };
  const markdown = render.renderPack(topic, {
    plainEnglish: { question: "What is economic duress?", answer: "Illegitimate pressure." },
    whereItSits: ["It is a vitiating factor.", "It makes a contract voidable."],
    framework: [{ t: "para", text: "Three ingredients." }],
    rules: [
      { heading: "Recognition", blocks: [{ t: "bullets", items: ["*The Siboen* recognised it."] }] },
      { heading: "Illegitimate pressure", blocks: [{ t: "para", text: "*DSND Subsea* is the touchstone." }] },
    ],
    checklist: ["Was there a threat?", "Was there a realistic alternative?"],
    moves: ["Name the fault-line and argue it explicitly."],
    worked: {
      facts: "A carrier demands more money.",
      issue: "Is the variation voidable?",
      rule: "Illegitimate pressure plus causation.",
      application: ["No alternative carrier.", "The threat was a breach."],
      conclusion: "Voidable.",
    },
    traps: ["Do not confuse void with voidable."],
    authorities: [
      {
        name: "Atlas Express v Kafco",
        citation: "[1989] 1 All ER 641",
        principle: "No realistic alternative.",
        deploy: "Use for small dependent firms.",
        sourceFile: "Week 8.txt",
        evidence: "could not find another carrier",
      },
    ],
  });

  assertRenderable(markdown, "renderPack");
  assert.match(markdown, /^# Topic Pack 8 — Economic Duress$/m);
  assert.match(markdown, /^## Start here — the idea in plain English$/m);
  assert.match(markdown, /^### The five questions to ask while learning$/m);
  for (const section of SPEC.packSections) {
    assert.ok(
      markdown.includes(`## ${section.letter}. ${section.heading}`),
      `missing section ${section.letter}`,
    );
  }
  const order = SPEC.packSections.map((s) => markdown.indexOf(`## ${s.letter}. `));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections must be in order");
  assert.match(markdown, /^### 1\. Recognition$/m, "rules are numbered by code");
  assert.match(markdown, /- \[ \] Was there a threat\?/, "section C is a tickable checklist");
  assert.match(markdown, /^- Name the fault-line and argue it explicitly\.$/m, "section D is a bulleted list");
  assert.ok(markdown.includes("Foundations and Cases.csv"), "must cross-link its decks");
  assert.ok(markdown.includes("Scenario to Case.csv"), "must cross-link its decks");
  assert.ok(markdown.includes("Pack Essentials.csv"), "must cross-link its decks");
});

test("the hub table links every topic to its pack and both decks", () => {
  const plan = {
    subject: "LAW1054 Contract Law",
    level: "undergraduate",
    examFormat: "problem-question",
    examTarget: ["Closed-book problem questions."],
    topics: [
      { number: 1, name: "Intention to Create Legal Relations", shortLabel: "Intention" },
      { number: 2, name: "Agreement (Offer and Acceptance)", shortLabel: "Agreement" },
    ],
    excluded: [{ name: "Privity", reason: "excluded from this year's syllabus" }],
  };
  const markdown = render.buildHub(plan, { hasMaterialsIndex: true });
  assertRenderable(markdown, "buildHub");

  assert.match(markdown, /^# LAW1054 Contract Law — Revision Hub$/m);
  assert.match(markdown, /^## Topic system$/m);
  const targets = [...markdown.matchAll(format.LINK_RE)].map((m) => m[1] || m[2]);
  for (const topic of plan.topics) {
    const ident = { number: topic.number, name: topic.name };
    for (const expected of [packPath(ident), ...SPEC.decks.map((d) => deckPath(ident, d.id))]) {
      assert.ok(
        targets.some((t) => resolvePosix("", t) === expected),
        `hub does not link ${expected}`,
      );
    }
  }
  assert.ok(targets.every((t) => !t.startsWith("/") && !/^[a-z]:/i.test(t)), "no absolute links");
});

test("the two derived guides are computed with no AI input at all", () => {
  const topic = { number: 1, name: "Offer and Acceptance" };
  const coverage = render.buildCaseCoverageIndex([
    {
      topic,
      authorities: [
        { name: "Carlill v Carbolic Smoke Ball", citation: "[1893] 1 QB 256" },
        { name: "Missing Case", citation: "[1900] 1 KB 1" },
      ],
      foundationsQuestions: ["Carlill v Carbolic Smoke Ball [1893] 1 QB 256"],
      scenarioAuthorities: ["Carlill v Carbolic Smoke Ball"],
    },
  ]);
  assertRenderable(coverage, "buildCaseCoverageIndex");
  assert.match(coverage, /\| Carlill v Carbolic Smoke Ball \[1893\] 1 QB 256 \| Yes \| Yes \|/);
  assert.match(coverage, /\| Missing Case \[1900\] 1 KB 1 \| No \| No \|/);
  assert.match(coverage, /\*\*2 gaps to close\.\*\*/);

  const checklist = render.buildMasterChecklist([{ topic, checklist: ["Was there an offer?"] }]);
  assertRenderable(checklist, "buildMasterChecklist");
  assert.match(checklist, /- \[ \] Was there an offer\?/);
});

test("deck rows are ordered concept-first and de-duplicated", () => {
  const rows = render.foundationRows([
    {
      kind: "authority",
      prompt: "ignored",
      authority: "Atlas Express v Kafco",
      citation: "[1989] 1 All ER 641",
      principle: "No realistic alternative.",
      deploy: "Small dependent firms.",
      sourceFile: "a.txt",
      evidence: "x",
    },
    {
      kind: "concept",
      prompt: "What is economic duress?",
      principle: "Illegitimate pressure inducing a contract.",
      sourceFile: "a.txt",
      evidence: "x",
    },
    {
      kind: "authority",
      prompt: "ignored",
      authority: "Atlas Express v Kafco",
      citation: "[1989] 1 All ER 641",
      principle: "A duplicate.",
      sourceFile: "a.txt",
      evidence: "x",
    },
  ]);
  assert.deepEqual(rows[0], ["Question", "Answer"]);
  assert.equal(rows[1][0], "What is economic duress?", "the concept card must come first");
  assert.equal(rows[2][0], "Atlas Express v Kafco [1989] 1 All ER 641");
  assert.match(rows[2][1], /DEPLOY Small dependent firms\./);
  assert.equal(rows.length, 3, "the duplicate authority must be dropped");

  const scenario = render.scenarioRows([
    {
      facts: "A carrier refuses to deliver unless paid more.",
      bestAuthority: "Atlas Express v Kafco",
      whyItFits: "No alternative carrier.",
      counterpoint: "Ordinary commercial pressure.",
      examSentence: "The variation is voidable.",
    },
  ]);
  assert.equal(
    scenario[1][1],
    "Best authority/rule: Atlas Express v Kafco. Why it fits: No alternative carrier. " +
      "Counterpoint: Ordinary commercial pressure. Exam sentence: The variation is voidable.",
    "the four labelled fields are assembled by code, not by the model",
  );
});

test("enumeratePackItems returns one slot per rule, checklist item, move and trap, in order", () => {
  const slots = render.enumeratePackItems({
    rules: [
      { heading: "Recognition", blocks: [{ t: "para", text: "The Siboen recognised it." }] },
      { heading: "Illegitimate pressure", blocks: [] },
    ],
    checklist: ["Was there a threat?", "Was there a realistic alternative?"],
    moves: ["Name the fault-line and argue it explicitly."],
    traps: ["Do not confuse void with voidable.", "Do not skip causation."],
  });

  assert.equal(slots.length, 2 + 2 + 1 + 2, "one slot per B/C/D/F item, none dropped");
  assert.deepEqual(slots.map((s) => s.section), ["B", "B", "C", "C", "D", "F", "F"], "sections stay in B/C/D/F order");
  assert.deepEqual(slots.map((s) => s.label), ["B1", "B2", "C1", "C2", "D1", "F1", "F2"]);
  assert.equal(slots[0].short, "Recognition");
  assert.ok(slots[0].itemText.includes("The Siboen recognised it."), "a rule's body is folded into itemText");
  assert.equal(slots[1].itemText, "Illegitimate pressure", "a rule with no body falls back to its heading alone");
  assert.equal(slots[2].itemText, "Was there a threat?", "checklist/move/trap items are used verbatim");
});

test("packEssentialsRows carries Section/Item columns and de-duplicates by question", () => {
  const rows = render.packEssentialsRows([
    { section: "C", question: "Was there a threat?", answer: "Yes — check for illegitimate pressure.", item: "Was there a threat?", hasEnrichment: false },
    { section: "F", question: "What is the trap here?", answer: "Void vs voidable.", item: "Do not confuse void with voidable.", hasEnrichment: true },
    { section: "C", question: "Was there a threat?", answer: "A duplicate.", item: "Was there a threat?", hasEnrichment: false },
  ]);
  assert.deepEqual(rows[0], ["Question", "Answer", "Section", "Item"]);
  assert.equal(rows.length, 3, "the duplicate question must be dropped");
  assert.deepEqual(rows[1], ["Was there a threat?", "Yes - check for illegitimate pressure.", "C", "Was there a threat?"]);
  assert.equal(rows[2][2], "F");
});

test("fallbackPackEssentialCard builds a usable card straight from the pack's own text", () => {
  const slots = render.enumeratePackItems({
    rules: [{ heading: "Recognition", blocks: [] }],
    checklist: ["Was there a threat?"],
    moves: ["Name the fault-line."],
    traps: ["Do not confuse void with voidable."],
  });
  const cards = render.buildPackEssentialsFallback(slots);
  assert.equal(cards.length, slots.length, "every slot must get a card, with no AI at all");
  assert.ok(cards.every((c) => !c.hasEnrichment), "a zero-AI fallback card is never marked enriched");
  assert.ok(cards.every((c) => c.question.trim() && c.answer.trim()), "every card must have real content");
});

/* ------------------------------------------------------------- the validator */

test("inferCategory matches the reader's classification, in order", () => {
  assert.equal(inferCategory("Flashcards/01 - X/Deck.csv", "csv"), "Flashcards");
  assert.equal(inferCategory("Revision/Topic Packs/01 - X (Topic Pack).md", "md"), "Study packs");
  assert.equal(inferCategory("Revision/Guides/01 - X.md", "md"), "Guides & hubs");
  assert.equal(inferCategory("0 - START HERE.md", "md"), "Guides & hubs");
  assert.equal(inferCategory("Course Materials/Past Papers/2024.pdf", "pdf"), "Past papers");
  assert.equal(inferCategory("Course Materials/Seminars/Week 1.docx", "docx"), "Seminars");
  assert.equal(inferCategory("Course Materials/Lectures/Week 1.pptx", "pptx"), "Source materials");
  assert.equal(inferCategory("Course Materials/Reference/Cases.docx", "docx"), "Course materials");
});

test("an empty folder reports empty and nothing else", () => {
  const report = validateCourse([], { courseName: "Tort" });
  assert.equal(report.level, "empty");
  assert.equal(report.legacyGate, false);
  assert.ok(report.issues.some((i) => i.code === "empty-folder"));
  assert.equal(report.topics.length, 0);
});

test("a source-materials-only folder is unformatted and names every missing piece", () => {
  const report = validateCourse([
    { path: "Lectures/Week 1 Offer.pptx", ext: "pptx", size: 900 },
    { path: "Transcripts/Week 1 Offer.txt", ext: "txt", text: "offer and acceptance", size: 500 },
  ]);
  assert.equal(report.level, "unformatted");
  assert.equal(report.legacyGate, false);
  const codes = report.issues.map((i) => i.code);
  for (const expected of ["no-hub", "no-guides", "no-packs", "no-decks", "no-materials-index"]) {
    assert.ok(codes.includes(expected), `expected issue ${expected}`);
  }
  assert.ok(report.missing.some((m) => m.path === SPEC.hub));
  assert.ok(report.missing.some((m) => m.path === SPEC.materialsIndex));
  assert.ok(report.missing.some((m) => m.kind === "guide" && m.needsAI));
  assert.ok(report.canConvert, "there are sources to work from");
  assert.ok(report.missing.every((m) => isWritablePath(m.path)), "every planned write must be legal");
});

test("a well-formed folder validates clean", () => {
  const topic = { number: 1, name: "Offer and Acceptance" };
  const pack = packPath(topic);
  const deck = deckPath(topic, "foundations");
  const guide = guidePath(5, "Case Coverage Index");
  const files = [
    { path: SPEC.hub, ext: "md", text: `# Hub\n\n- ${relLink(SPEC.hub, pack, "Pack")}\n` },
    { path: guide, ext: "md", text: `# Guide\n\n- ${relLink(guide, SPEC.hub, "Hub")}\n` },
    { path: pack, ext: "md", text: `# Pack\n\n- ${relLink(pack, deck, "Deck")}\n` },
    { path: deck, ext: "csv", text: writeCsv([["Question", "Answer"], ["Q", "A"]]) },
    { path: "Course Materials/00 - COURSE MATERIALS INDEX.md", ext: "md", text: "# Index\n" },
    { path: "Course Materials/Lectures/Week 1.pptx", ext: "pptx", size: 10 },
  ];
  const report = validateCourse(files, { courseName: "Contract" });

  assert.equal(report.links.broken, 0, JSON.stringify(report.issues.filter((i) => i.code === "link-broken")));
  assert.equal(report.links.absolute, 0);
  assert.equal(report.legacyGate, true);
  assert.equal(report.level, "valid", JSON.stringify(report.issues));
  assert.equal(report.topics.length, 1);
  assert.equal(report.topics[0].joined, true);
  assert.equal(report.counts.cards, 1);
});

test("the three real defects of the reference Contract folder are all reported", () => {
  const packA = "Revision/Topic Packs/02 - Agreement (Offer & Acceptance) (Topic Pack).md";
  const deckA = "Flashcards/02 - Agreement (Offer and Acceptance)/Foundations and Cases.csv";
  const files = [
    {
      path: SPEC.hub,
      ext: "md",
      // Defect 1: absolute Windows links. Defect 2: a link to a folder that does not exist.
      text:
        "# Hub\n\n" +
        `| 2 | Agreement | [Open pack](</C:/Users/User/Downloads/Claude Work Law/Contract/${packA}>) |\n` +
        "- [Stale](<Contract/01 - Old (Topic Pack).md>)\n",
    },
    { path: "0 - START HERE (Revision Hub).md", ext: "md", text: "# Stale hub\n" },
    { path: packA, ext: "md", text: "# Pack\n" },
    { path: deckA, ext: "csv", text: writeCsv([["Question", "Answer"], ["Q", "A"]]) },
    { path: "Revision/Guides/00 - Technique.md", ext: "md", text: "# Guide\n" },
    { path: "Revision/Topic Packs/03 - Lonely (Topic Pack).md", ext: "md", text: "# Lonely\n" },
  ];
  const report = validateCourse(files, { courseName: "Contract" });
  const codes = report.issues.map((i) => i.code);

  // The absolute links must still RESOLVE (the reader re-roots them at the course
  // folder name), so they are a fragility warning, not a dead link.
  const absolute = report.issues.filter((i) => i.code === "link-absolute");
  assert.ok(absolute.length, "defect 1: absolute links");
  assert.ok(
    absolute.every((i) => i.severity === "warning"),
    "an absolute link that resolves is a warning, not an error",
  );
  assert.ok(
    !report.issues.some(
      (i) => i.code === "link-broken" && i.detail?.target?.includes("Claude Work Law"),
    ),
    "the absolute link resolves, so it must not also be reported broken",
  );
  assert.ok(codes.includes("link-broken"), "defect 2: the stale Contract/ links");
  assert.ok(codes.includes("duplicate-hub"), "defect 2: two start-here files");
  assert.ok(codes.includes("pack-without-decks"), "defect 3 sibling: a pack with no deck");

  // Defect 3 itself: the & / and spelling difference must NOT split the topic.
  const agreement = report.topics.filter((t) => t.key.startsWith("agreement"));
  assert.equal(agreement.length, 1, "the & and 'and' spellings must collapse to one topic");
  assert.equal(agreement[0].joined, true, "and it must join its deck");
  assert.ok(
    report.issues.some((i) => i.code === "topic-key-collision" && i.severity === "warning"),
    "but the user should still be told the two spellings differ",
  );
  assert.equal(report.level, "partial");
});

test("a flashcard file with the wrong header is an error, not a silent skip", () => {
  const report = validateCourse([
    { path: SPEC.hub, ext: "md", text: "# Hub\n" },
    { path: "Revision/Topic Packs/01 - X (Topic Pack).md", ext: "md", text: "# X\n" },
    { path: "Flashcards/01 - X/Bad.csv", ext: "csv", text: "Front,Back\r\na,b\r\n" },
  ]);
  const issue = report.issues.find((i) => i.code === "csv-missing-columns");
  assert.ok(issue, "the bad header must be reported");
  assert.equal(issue.severity, "error");
  assert.equal(issue.path, "Flashcards/01 - X/Bad.csv");
  assert.equal(report.counts.cards, 0);
});

test("the report hash changes only when the folder materially changes", () => {
  const base = [{ path: "a.md", ext: "md", size: 10, text: "# a" }];
  const same = [{ path: "a.md", ext: "md", size: 10, text: "# a" }];
  const bigger = [{ path: "a.md", ext: "md", size: 11, text: "# ab" }];
  const extra = [...base, { path: "b.md", ext: "md", size: 3, text: "# b" }];
  assert.equal(validateCourse(base).hash, validateCourse(same).hash);
  assert.notEqual(validateCourse(base).hash, validateCourse(bigger).hash);
  assert.notEqual(validateCourse(base).hash, validateCourse(extra).hash);
});

test("topic names without a number keep their own key, so a plan keeps all its topics", async () => {
  const { canonicalTopicKey, topicLabel: label } = await import("../lib/course-format.ts");
  const names = ["Introduction and Overview", "Design Patterns", "Software Testing"];
  assert.deepEqual(names.map(canonicalTopicKey), ["introduction and overview", "design patterns", "software testing"]);
  assert.equal(canonicalTopicKey("02 - Design Patterns"), "design patterns");
  assert.equal(canonicalTopicKey("Revision/Topic Packs/02 - Design Patterns (Topic Pack).md"), "design patterns");
  assert.equal(label("Flashcards/02 - Design Patterns/Pack Essentials.csv"), "02 - Design Patterns");
});
