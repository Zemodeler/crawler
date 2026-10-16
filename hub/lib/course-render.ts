import { PROFILES, type SubjectProfile, type FoundationKind } from "./subject-profiles.ts";

/**
 * Deterministic file assembly.
 *
 * Everything structural about a generated file is spelled here, in code: the
 * headings, the section letters, the numbering, the tables, the links, the CSV
 * framing. The model only ever supplies prose, as the `Block` union below.
 *
 * That split is the whole correctness argument. A model asked to "write a topic
 * pack in the right format" gets it wrong eventually; a model asked to fill in
 * `framework: Block[]` cannot get the format wrong at all, because it never
 * touches the format.
 */

import {
  SPEC,
  type TopicIdent,
  type InventoryFile,
  csvHeaderIsValid,
  deckPath,
  guidePath,
  inferCategory,
  packPath,
  parseCSV,
  plainForCsv,
  relLink,
  topicFolderName,
  writeCsv,
} from "./course-format.ts";

/* ------------------------------------------------------------ the AI's shape */

/** Restricted inline syntax: **bold**, *italic*, `code`. Nothing else survives. */
export type Inline = string;

export type Block =
  | { t: "para"; text: Inline }
  | { t: "bullets"; items: Inline[] }
  | { t: "numbered"; items: Inline[] }
  | { t: "checklist"; items: Inline[] }
  | { t: "blockquote"; lines: Inline[] }
  | { t: "table"; head: Inline[]; rows: Inline[][] }
  | { t: "sub"; heading: string; blocks: Block[] };

export type Authority = {
  name: string;
  citation?: string;
  principle: string;
  deploy: string;
  sourceFile: string;
  evidence: string;
};

export type PackContent = {
  plainEnglish: { question: string; answer: string };
  whereItSits: string[];
  framework: Block[];
  rules: { heading: string; blocks: Block[] }[];
  checklist: string[];
  /** One string per move — discrete and enumerable, like `checklist`/`traps`,
   *  so a Pack Essentials flashcard can be guaranteed for every one of them. */
  moves: string[];
  worked: {
    facts: string;
    issue: string;
    rule: string;
    application: string[];
    conclusion: string;
  };
  traps: string[];
  authorities: Authority[];
  /** Set by the pipeline, not the model, when a section could not be produced. */
  degradedNote?: string;
};

export type FoundationCard = {
  kind: FoundationKind;
  prompt: string;
  authority?: string;
  citation?: string;
  principle: string;
  deploy?: string;
  sourceFile: string;
  evidence: string;
};

export type ScenarioCard = {
  facts: string;
  bestAuthority: string;
  whyItFits: string;
  counterpoint: string;
  examSentence: string;
};

/** One enumerable pack item — a rule, a checklist item, a move or a trap. */
export type PackItemSlot = {
  section: "B" | "C" | "D" | "F";
  index: number;
  /** e.g. "B2" — used in prompts and logs, never rendered to the user. */
  label: string;
  /** The item's own brief wording — a rule's heading, or the checklist/move/trap line. */
  short: string;
  /** The fuller text used as the guaranteed answer: `short` plus, for rules, their body. */
  itemText: string;
};

export type PackEssentialCard = {
  section: "B" | "C" | "D" | "F";
  question: string;
  answer: string;
  /** The pack's own verbatim slot text, kept as a CSV column for future coverage lookups. */
  item: string;
  hasEnrichment: boolean;
};

/* ------------------------------------------------------- inline sanitisation */

/**
 * Strips everything the reader's renderer cannot handle. Runs on every string
 * the model produced, so a stray fenced block or markdown link can never reach
 * a file. Bare pipes are escaped because they would silently split a table cell.
 */
export function sanitiseInline(text: string, opts: { inTable?: boolean } = {}): string {
  let out = String(text ?? "")
    .replace(/```+/g, "")
    .replace(/~~~+/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/~~([^~]+)~~/g, "$1")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (opts.inTable) out = out.replace(/\|/g, "\\|");
  // An odd number of backticks would swallow the rest of the line.
  if ((out.match(/`/g) || []).length % 2) out = out.replace(/`/g, "");
  return out;
}

const line = (text: string) => sanitiseInline(text);

/** Block[] -> markdown restricted to the subset app/markdown.tsx understands. */
export function renderBlocks(blocks: Block[], depth = 0): string {
  const out: string[] = [];
  for (const block of blocks || []) {
    switch (block?.t) {
      case "para":
        if (line(block.text)) out.push(line(block.text), "");
        break;
      case "bullets":
        for (const item of block.items || []) if (line(item)) out.push(`- ${line(item)}`);
        out.push("");
        break;
      case "numbered":
        (block.items || []).forEach((item, i) => {
          if (line(item)) out.push(`${i + 1}. ${line(item)}`);
        });
        out.push("");
        break;
      case "checklist":
        for (const item of block.items || []) if (line(item)) out.push(`- [ ] ${line(item)}`);
        out.push("");
        break;
      case "blockquote":
        (block.lines || []).forEach((text, i) => {
          if (!line(text)) return;
          if (i) out.push(">");
          out.push(`> ${line(text)}`);
        });
        out.push("");
        break;
      case "table": {
        const head = (block.head || []).map((cell) => sanitiseInline(cell, { inTable: true }));
        if (!head.length) break;
        out.push(`| ${head.join(" | ")} |`);
        out.push(`|${head.map(() => "---").join("|")}|`);
        for (const row of block.rows || []) {
          const cells = head.map((_, i) => sanitiseInline(row?.[i] ?? "", { inTable: true }));
          out.push(`| ${cells.join(" | ")} |`);
        }
        out.push("");
        break;
      }
      case "sub":
        // Only one level of nesting; deeper headings are flattened to bold text.
        if (depth === 0) out.push(`### ${line(block.heading)}`, "");
        else out.push(`**${line(block.heading)}**`, "");
        out.push(renderBlocks(block.blocks || [], depth + 1));
        break;
      default:
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/* ------------------------------------------------------------- the topic pack */

export function renderPack(topic: TopicIdent, content: PackContent, profile: SubjectProfile = PROFILES.law): string {
  const layoutNote = `**How this pack is laid out:** ${profile.packSections.map((s) => `(${s.letter}) ${s.heading.replace(/\s*\(.*\)$/, "").toLowerCase()}`).join(" \u00b7 ")}.`;
  const self = packPath(topic);
  const out: string[] = [];

  out.push(`# Topic Pack ${topic.number} — ${line(topic.name)}`, "");
  out.push(`> ${profile.beginnerNote}`, "");
  if (content.degradedNote) out.push(`> **Needs review:** ${line(content.degradedNote)}`, "");

  out.push(`## Start here — the idea in plain English`, "");
  out.push(`**${line(content.plainEnglish.question)}**`, "");
  out.push(line(content.plainEnglish.answer), "");

  out.push(`### The five questions to ask while learning`, "");
  profile.fiveQuestions.forEach((q, i) => out.push(`${i + 1}. ${q}`));
  out.push("", "---", "");

  for (const [i, paragraph] of (content.whereItSits || []).entries()) {
    if (i) out.push(">");
    out.push(`> ${line(paragraph)}`);
  }
  if (content.whereItSits?.length) out.push(">");
  out.push(`> ${layoutNote}`, "", "---", "");

  for (const section of profile.packSections) {
    out.push(`## ${section.letter}. ${section.heading}`, "");
    switch (section.key) {
      case "framework":
        out.push(renderBlocks(content.framework), "");
        break;
      case "rules":
        (content.rules || []).forEach((rule, i) => {
          out.push(`### ${i + 1}. ${line(rule.heading)}`, "");
          out.push(renderBlocks(rule.blocks), "");
        });
        break;
      case "checklist":
        for (const item of content.checklist || []) out.push(`- [ ] ${line(item)}`);
        out.push("");
        break;
      case "moves":
        for (const move of content.moves || []) out.push(`- ${line(move)}`);
        out.push("");
        break;
      case "worked": {
        const worked = content.worked;
        if (worked) {
          out.push(`**${profile.workedLabels[0]}.** ${line(worked.facts)}`, "");
          out.push(`**${profile.workedLabels[1]}.** ${line(worked.issue)}`, "");
          out.push(`**${profile.workedLabels[2]}.** ${line(worked.rule)}`, "");
          out.push(`**${profile.workedLabels[3]}.**`, "");
          (worked.application || []).forEach((step, i) => out.push(`${i + 1}. ${line(step)}`));
          out.push("");
          out.push(`**${profile.workedLabels[4]}.** ${line(worked.conclusion)}`, "");
        }
        break;
      }
      case "traps":
        for (const trap of content.traps || []) out.push(`- ${line(trap)}`);
        out.push("");
        break;
    }
    out.push("---", "");
  }

  out.push(`## Practise this topic`, "");
  for (const deck of profile.decks)
    out.push(`- ${relLink(self, deckPath(topic, deck.id, profile), `${deck.label} deck`)}`);
  out.push(`- ${relLink(self, SPEC.hub, "Back to the revision hub")}`, "");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/* ----------------------------------------------------------------- the decks */

/** Card 1 is always the plain-English concept card, then one card per authority. */
export function foundationRows(cards: FoundationCard[], profile: SubjectProfile = PROFILES.law): string[][] {
  const rows: string[][] = [[...SPEC.csv.header]];
  const seen = new Set<string>();
  const ordered = profile.foundationKinds.flatMap((kinds) => cards.filter((c) => kinds.includes(c.kind)));
  for (const card of ordered) {
    const question =
      profile.namedFoundationKinds.includes(card.kind) && card.authority
        ? plainForCsv([card.authority, card.citation].filter(Boolean).join(" "))
        : plainForCsv(card.prompt);
    const answer = [plainForCsv(card.principle), card.deploy ? `DEPLOY ${plainForCsv(card.deploy)}` : ""]
      .filter(Boolean)
      .join(" ");
    if (!question || !answer) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([question, answer]);
  }
  return rows;
}

/** The four labelled fields are assembled here, so every answer reads the same. */
export function scenarioRows(cards: ScenarioCard[], profile: SubjectProfile = PROFILES.law): string[][] {
  const rows: string[][] = [[...SPEC.csv.header]];
  const seen = new Set<string>();
  for (const card of cards) {
    const question = plainForCsv(card.facts);
    const answer = [
      `${profile.terms.bestAuthority}: ${plainForCsv(card.bestAuthority)}.`,
      `Why it fits: ${plainForCsv(card.whyItFits)}`,
      `Counterpoint: ${plainForCsv(card.counterpoint)}`,
      `Exam sentence: ${plainForCsv(card.examSentence)}`,
    ].join(" ");
    if (!question || !plainForCsv(card.bestAuthority)) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([question, answer]);
  }
  return rows;
}

/**
 * One flashcard slot per rule, checklist item, move and trap — enumerated here,
 * in code, from the pack's own pre-render structure. This is the single source
 * of truth for how many cards a topic's Pack Essentials deck must contain: the
 * model fills in the question (and, optionally, extra detail) for each slot,
 * but it cannot decide which items get covered — that is fixed by this list.
 */
export function enumeratePackItems(pack: PackContent): PackItemSlot[] {
  const slots: PackItemSlot[] = [];
  (pack.rules || []).forEach((rule, i) => {
    const body = flattenBlocksToText(rule.blocks);
    slots.push({
      section: "B",
      index: i,
      label: `B${i + 1}`,
      short: rule.heading,
      itemText: body ? `${rule.heading} — ${body}` : rule.heading,
    });
  });
  (pack.checklist || []).forEach((item, i) => {
    slots.push({ section: "C", index: i, label: `C${i + 1}`, short: item, itemText: item });
  });
  (pack.moves || []).forEach((item, i) => {
    slots.push({ section: "D", index: i, label: `D${i + 1}`, short: item, itemText: item });
  });
  (pack.traps || []).forEach((item, i) => {
    slots.push({ section: "F", index: i, label: `F${i + 1}`, short: item, itemText: item });
  });
  return slots;
}

/**
 * Plain-text flattening of a rule's blocks, for the generation prompt only —
 * it is never rendered, so it does not need to respect the reader's markdown
 * subset the way `renderBlocks` does.
 */
export function flattenBlocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks || []) {
    switch (block?.t) {
      case "para":
        if (block.text) parts.push(block.text);
        break;
      case "bullets":
      case "numbered":
      case "checklist":
        parts.push(...(block.items || []));
        break;
      case "blockquote":
        parts.push(...(block.lines || []));
        break;
      case "sub":
        if (block.heading) parts.push(block.heading);
        parts.push(flattenBlocksToText(block.blocks || []));
        break;
      default:
        break;
    }
  }
  return parts.filter(Boolean).join(". ");
}

function fallbackQuestion(slot: PackItemSlot): string {
  switch (slot.section) {
    case "B":
      return `State and explain this rule from the pack: "${slot.short}"`;
    case "C":
      return /\?\s*$/.test(slot.short) ? slot.short : `Checklist point: ${slot.short}`;
    case "D":
      return `What move should you make here: "${slot.short}"?`;
    case "F":
      return `What is the trap, and how do you avoid it: "${slot.short}"?`;
  }
}

/**
 * A zero-AI card built straight from the pack's own text. This is the
 * guaranteed floor every slot gets — used when the model omits a slot, when
 * its response cannot be matched back to one, or when the whole call fails.
 */
export function fallbackPackEssentialCard(slot: PackItemSlot): PackEssentialCard {
  return {
    section: slot.section,
    question: fallbackQuestion(slot),
    answer: slot.itemText,
    item: slot.short,
    hasEnrichment: false,
  };
}

export function buildPackEssentialsFallback(slots: PackItemSlot[]): PackEssentialCard[] {
  return slots.map(fallbackPackEssentialCard);
}

/** Extra `Section`/`Item` columns turn "does slot X have a card?" into a direct
 *  lookup, and cost nothing — CSV parsing already tolerates extra columns. */
export function packEssentialsRows(cards: PackEssentialCard[]): string[][] {
  const rows: string[][] = [[...SPEC.csv.header, "Section", "Item"]];
  const seen = new Set<string>();
  for (const card of cards) {
    const question = plainForCsv(card.question);
    const answer = plainForCsv(card.answer);
    if (!question || !answer) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([question, answer, card.section, plainForCsv(card.item)]);
  }
  return rows;
}

/**
 * Append-only merge. Existing rows keep their exact index and question text, so
 * `stableCardId` returns bit-identical ids and the user's review history — which
 * is keyed on `path:index:question` — survives a regeneration untouched.
 */
export function mergeDeck(existingCsv: string | null, freshRows: string[][]): string[][] {
  if (!existingCsv) return freshRows;
  const existing = parseCSV(existingCsv);
  if (!csvHeaderIsValid(existing[0])) return freshRows;
  const header = existing[0].map((v) => v.replace(/^\uFEFF/, "").trim().toLowerCase());
  const qi = header.indexOf("question");
  const ai = header.indexOf("answer");
  // The header comes from `freshRows`, not the existing file, so a deck whose
  // column set has grown (e.g. Pack Essentials' Section/Item columns) still gets
  // the right header on every regeneration.
  const kept: string[][] = [freshRows[0] ?? [...SPEC.csv.header]];
  const seen = new Set<string>();
  for (const row of existing.slice(1)) {
    const question = (row[qi] || "").trim();
    const answer = (row[ai] || "").trim();
    if (!question || !answer) continue;
    // Keep the whole row, not just [question, answer] \u2014 a deck with extra
    // columns (Section/Item) would otherwise lose them on every regeneration.
    kept.push(row);
    seen.add(question.toLowerCase());
  }
  for (const row of freshRows.slice(1)) {
    if (seen.has(row[0].toLowerCase())) continue;
    seen.add(row[0].toLowerCase());
    kept.push(row);
  }
  return kept;
}

export function renderDeck(rows: string[][]): string {
  return writeCsv(rows);
}

/* ------------------------------------------------------------------ the hub */

export type CoursePlan = {
  subject: string;
  level: string;
  examFormat: string;
  examTarget: string[];
  topics: (TopicIdent & { shortLabel: string })[];
  excluded?: { name: string; reason: string }[];
};

const ORDER_GUIDES = [1, 0, 3];

export function buildHub(plan: CoursePlan, options: { hasMaterialsIndex: boolean }, profile: SubjectProfile = PROFILES.law): string {
  const self = SPEC.hub;
  const guideOf = (n: number) => profile.guides.find((g) => g.n === n)!;
  const guideLink = (n: number, label?: string) => {
    const guide = guideOf(n);
    return relLink(self, guidePath(guide.n, guide.title, profile), label || guide.title);
  };

  const out: string[] = [];
  out.push(`# ${line(plan.subject)} — Revision Hub`, "");
  out.push(
    "> Start here every study session. This system assumes no prior knowledge and builds from " +
      "plain-English understanding to first-class exam application. Every link below points to a " +
      "file inside this folder.",
    "",
  );

  out.push("## Exam target", "");
  for (const item of plan.examTarget || []) out.push(`- ${line(item)}`);
  for (const excluded of plan.excluded || [])
    out.push(`- ${line(excluded.name)} is excluded: ${line(excluded.reason)}`);
  out.push("");

  out.push("## Use this order", "");
  ORDER_GUIDES.forEach((n, i) => out.push(`${i + 1}. ${guideLink(n)}`));
  out.push(
    `${ORDER_GUIDES.length + 1}. Learn each topic pack, then work through its flashcard decks in ` +
      `this order: ${profile.decks.map((d) => d.label).join(", ")}.`,
  );
  out.push(
    `${ORDER_GUIDES.length + 2}. Use the ${guideLink(4)} and move into timed practice.`,
    "",
  );

  out.push("## Topic system", "");
  out.push(`| # | Topic | Topic pack | ${profile.decks.map((d) => d.label).join(" | ")} |`);
  out.push(`|---|---|---|${profile.decks.map(() => "---").join("|")}|`);
  for (const topic of plan.topics) {
    const ident: TopicIdent = { number: topic.number, name: topic.name };
    const cells = [
      String(topic.number),
      sanitiseInline(topic.shortLabel || topic.name, { inTable: true }),
      relLink(self, packPath(ident), "Open pack"),
      ...profile.decks.map((deck) => relLink(self, deckPath(ident, deck.id, profile), "Open CSV")),
    ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  out.push("");

  out.push("## Schedule and tracking", "");
  out.push(`- ${guideLink(2)}`);
  out.push(`- ${guideLink(5)}`, "");

  if (options.hasMaterialsIndex) {
    out.push("## Original course materials", "");
    out.push(`- ${relLink(self, SPEC.materialsIndex, "Course materials file index")}`, "");
    out.push("Your original lectures, transcripts and past papers are preserved exactly as they were.", "");
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/* ------------------------------------------------ fully derived files, no AI */

const MATERIAL_GROUPS: { title: string; categories: string[] }[] = [
  { title: "Assessment guidance", categories: [] },
  { title: "Past papers", categories: ["Past papers"] },
  { title: "Lectures", categories: [] },
  { title: "Transcripts", categories: [] },
  { title: "Seminars", categories: ["Seminars"] },
  { title: "Reference", categories: [] },
  { title: "Other course materials", categories: ["Course materials", "Source materials"] },
];

function materialGroup(path: string, category: string): string {
  const p = path.toLowerCase();
  if (p.includes("assessment")) return "Assessment guidance";
  if (category === "Past papers") return "Past papers";
  if (p.includes("lecture")) return "Lectures";
  if (p.includes("transcript") || p.includes("caption")) return "Transcripts";
  if (category === "Seminars") return "Seminars";
  if (p.includes("reference") || p.includes("case list")) return "Reference";
  return "Other course materials";
}

/** Derived entirely from the inventory. Zero AI calls. */
export function buildMaterialsIndex(files: InventoryFile[]): string {
  const self = SPEC.materialsIndex;
  const relevant = files.filter((f) => {
    const category = f.category || inferCategory(f.path, f.ext || "");
    return ["Source materials", "Seminars", "Past papers", "Course materials"].includes(category);
  });
  const buckets = new Map<string, InventoryFile[]>();
  for (const file of relevant) {
    const group = materialGroup(file.path, file.category || inferCategory(file.path, file.ext || ""));
    buckets.set(group, [...(buckets.get(group) || []), file]);
  }

  const out: string[] = ["# Course materials index", ""];
  out.push(
    "> Every original course document, grouped by kind. Study Hub never edits or moves these files.",
    "",
  );
  let listed = 0;
  for (const group of MATERIAL_GROUPS) {
    const entries = (buckets.get(group.title) || []).sort((a, b) => a.path.localeCompare(b.path));
    if (!entries.length) continue;
    out.push(`## ${group.title}`, "");
    for (const entry of entries) {
      const label = (entry.name || entry.path.split("/").pop() || entry.path).replace(/\.[^.]+$/, "");
      out.push(`- ${relLink(self, entry.path, label)}`);
      listed++;
    }
    out.push("");
  }
  if (!listed) out.push("No original course materials were found in this folder.", "");
  out.push(`${relLink(self, SPEC.hub, "Back to the revision hub")}`, "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Guide 05. A coverage matrix computed from the decks that were actually written. */
export function buildCaseCoverageIndex(
  entries: {
    topic: TopicIdent;
    authorities: { name: string; citation?: string }[];
    foundationsQuestions: string[];
    scenarioAuthorities: string[];
  }[],
  profile: SubjectProfile = PROFILES.law,
): string {
  const guide = profile.guides.find((g) => g.n === 5)!;
  const self = guidePath(guide.n, guide.title, profile);
  const out: string[] = [`# ${guide.title}`, ""];
  out.push(
    profile.coverage.intro,
    "",
  );
  // A gap is one missing card, not one incomplete authority — the number should
  // tell the user how many cards they still need to write.
  let gaps = 0;
  for (const entry of entries) {
    out.push(`## ${topicFolderName(entry.topic)}`, "");
    if (!entry.authorities.length) {
      out.push(profile.coverage.empty, "");
      continue;
    }
    out.push(profile.coverage.header);
    out.push("|---|---|---|");
    const foundations = entry.foundationsQuestions.map((q) => q.toLowerCase());
    const scenarios = entry.scenarioAuthorities.map((a) => a.toLowerCase());
    for (const authority of entry.authorities) {
      const needle = authority.name.toLowerCase();
      const inFoundations = foundations.some((q) => q.includes(needle));
      const inScenario = scenarios.some((a) => a.includes(needle) || needle.includes(a));
      if (!inFoundations) gaps++;
      if (!inScenario) gaps++;
      out.push(
        `| ${sanitiseInline(
          [authority.name, authority.citation].filter(Boolean).join(" "),
          { inTable: true },
        )} | ${inFoundations ? "Yes" : "No"} | ${inScenario ? "Yes" : "No"} |`,
      );
    }
    out.push("");
  }
  out.push(
    gaps
      ? `**${gaps} ${gaps === 1 ? "gap" : "gaps"} to close.**`
      : profile.coverage.complete,
    "",
  );
  out.push(`${relLink(self, SPEC.hub, "Back to the revision hub")}`, "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Guide 03. The concatenation of every pack's section C, as one tickable list. */
export function buildMasterChecklist(
  entries: { topic: TopicIdent; checklist: string[] }[],
  profile: SubjectProfile = PROFILES.law,
): string {
  const guide = profile.guides.find((g) => g.n === 3)!;
  const self = guidePath(guide.n, guide.title, profile);
  const out: string[] = [`# ${guide.title}`, ""];
  out.push(
    profile.checklistIntro,
    "",
  );
  for (const entry of entries) {
    if (!entry.checklist.length) continue;
    out.push(`## ${topicFolderName(entry.topic)}`, "");
    out.push(`${relLink(self, packPath(entry.topic), "Open the topic pack")}`, "");
    for (const item of entry.checklist) out.push(`- [ ] ${line(item)}`);
    out.push("");
  }
  out.push(`${relLink(self, SPEC.hub, "Back to the revision hub")}`, "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** An AI-written guide: title and back-link are ours, body is the model's. */
export function buildGuide(n: number, title: string, blocks: Block[], intro?: string, profile: SubjectProfile = PROFILES.law): string {
  title = profile.id === "law" ? title : profile.guides.find((g) => g.n === n)?.title ?? title;
  const self = guidePath(n, title, profile);
  const out: string[] = [`# ${title}`, ""];
  if (intro) out.push(`> ${line(intro)}`, "");
  out.push(renderBlocks(blocks), "");
  out.push(`${relLink(self, SPEC.hub, "Back to the revision hub")}`, "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** The bare scaffold offered for a folder with nothing in it. */
export function buildEmptyScaffoldHub(courseName: string): string {
  const out: string[] = [`# ${line(courseName)} — Revision Hub`, ""];
  out.push(
    "> This folder is set up in Study Hub format but has no content yet. Drop your lectures, " +
      `transcripts and seminar files into \`${SPEC.materialsDir}\`, then reopen the folder and ` +
      "Study Hub will offer to build your topic packs and flashcards.",
    "",
  );
  out.push("## What goes where", "");
  out.push(`- \`${SPEC.materialsDir}/\` — your original lectures, transcripts, seminars and past papers.`);
  out.push(`- \`${SPEC.packsDir}/\` — one topic pack per topic.`);
  out.push(`- \`${SPEC.decksDir}/\` — one folder per topic, holding its flashcard CSV files.`);
  out.push(`- \`${SPEC.guidesDir}/\` — technique and revision guides.`, "");
  return `${out.join("\n")}\n`;
}
