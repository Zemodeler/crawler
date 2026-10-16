/** Subject vocabulary and presentation only; independent of course-format. */
export type SubjectId = "law" | "stem" | "humanities" | "general";
export type FoundationKind = "concept" | "authority" | "rule" | "statute" | "result" | "theorem" | "algorithm" | "source" | "argument" | "thinker" | "method";
export type SubjectProfile = {
  id: SubjectId; label: string; description: string;
  terms: { authority: string; authorities: string; examQuestion: string; issueSpotting: string; bestAuthority: string };
  decks: readonly { id: string; file: string; label: string; min: number; max: number }[];
  guides: readonly { n: number; title: string; source: "ai" | "derived" }[];
  packSections: readonly { letter: string; key: string; heading: string }[];
  workedLabels: readonly string[];
  foundationKinds: readonly (readonly FoundationKind[])[];
  namedFoundationKinds: readonly FoundationKind[];
  beginnerNote: string; fiveQuestions: readonly string[];
  checklistIntro: string;
  coverage: { intro: string; empty: string; header: string; complete: string };
  prompts: { ruleFor3: string; ruleFor4: string; ruleFor6: string; examFormat: readonly string[]; workedFields: readonly string[] };
};

const law: SubjectProfile = {
  "id": "law",
  "label": "Law",
  "description": "Legal rules, cases and problem-question application.",
  "terms": {
    "authority": "Authority",
    "authorities": "authorities",
    "examQuestion": "problem question",
    "issueSpotting": "Issue-spotting",
    "bestAuthority": "Best authority/rule"
  },
  "workedLabels": [
    "Facts",
    "Issue",
    "Rule",
    "Application",
    "Conclusion"
  ],
  "foundationKinds": [
    [
      "concept"
    ],
    [
      "rule",
      "statute"
    ],
    [
      "authority"
    ]
  ],
  "namedFoundationKinds": [
    "authority"
  ],
  "beginnerNote": "**Beginner starting point:** You are not expected to know this topic before opening the pack. Learn the plain-English gateway below first, then the framework, then the cases. A case is an authority: use its legal principle on similar exam facts rather than retelling its whole story.",
  "fiveQuestions": [
    "What fact activates this topic?",
    "What legal test must be satisfied?",
    "Which case supplies that test?",
    "What fact supports the opposing argument?",
    "What remedy or practical result follows?"
  ],
  "checklistIntro": "> Run this over any problem question before you start writing. Each item is the trigger question from that topic's pack, so a tick means you have consciously ruled the topic in or out.",
  "coverage": {
    "intro": "> Every authority in your topic packs, with whether it also appears in each flashcard deck. Anything marked No is a gap to close before the exam.",
    "empty": "No authorities were recorded for this topic.",
    "header": "| Authority | Foundations card | Scenario card |",
    "complete": "**Every authority appears in both decks.**"
  },
  "prompts": {
    "ruleFor3": "3. Ground every legal or factual proposition in the SOURCE EXCERPTS in this message.\n   For every authority, rule, statute, definition or figure you assert, set\n   \"sourceFile\" to the exact file name from the excerpt header and \"evidence\" to a\n   VERBATIM span of 5 to 25 words copied character-for-character from that excerpt.\n   Copy it; do not paraphrase it. Automated checks compare your evidence against the\n   source and discard anything that cannot be found.",
    "ruleFor4": "4. If the sources do not support something, omit it. Never invent, guess, complete, or\n   recall from general knowledge a case name, citation, year, judge, statute section,\n   quotation, syllabus item, or assessment rule. Omission always beats invention. An\n   empty array is a valid answer.",
    "ruleFor6": "6. Write for a student who has never seen the topic: plain English first, then the\n   framework, then the authorities. Case names in *italics*; emphasis in **bold**.",
    "examFormat": [
      "problem-question",
      "essay",
      "mixed",
      "mcq",
      "unknown"
    ],
    "workedFields": [
      "facts",
      "issue",
      "rule",
      "application",
      "conclusion"
    ]
  },
 decks: [{ id: "foundations", file: "Foundations and Cases.csv", label: "Foundations and cases", min: 8, max: 60 },
    { id: "scenario", file: "Scenario to Case.csv", label: "Scenario to case", min: 6, max: 60 },
    { id: "pack-essentials", file: "Pack Essentials.csv", label: "Pack essentials", min: 8, max: 50 },],
 guides: [{ n: 0, title: "Problem Question Technique + Issue-Spotting Map", source: "ai" },
    { n: 1, title: "How to Learn From Scratch", source: "ai" },
    { n: 2, title: "Five-Day First-Class Checklist", source: "ai" },
    { n: 3, title: "Master Issue-Spotting Checklist", source: "derived" },
    { n: 4, title: "Model Problem-Question Paragraphs", source: "ai" },
    { n: 5, title: "Case Coverage Index", source: "derived" },],
 packSections: [{ letter: "A", key: "framework", heading: "Core framework (memorise this shape)" },
    { letter: "B", key: "rules", heading: "The law, rule-by-rule (with your case list)" },
    { letter: "C", key: "checklist", heading: "Issue-spotting checklist (run this on the facts)" },
    { letter: "D", key: "moves", heading: 'The "80+ moves" (how to score above a 2:1)' },
    { letter: "E", key: "worked", heading: "Worked micro-application" },
    { letter: "F", key: "traps", heading: "Common traps" },]
};

function subject(id: SubjectId, label: string, description: string, authority: string, authorities: string,
  question: string, decks: readonly string[], titles: readonly string[], labels: readonly string[],
  kinds: SubjectProfile["foundationKinds"], questions: readonly string[]): SubjectProfile {
  return {
    ...law, id, label, description,
    terms: { authority, authorities, examQuestion: question, issueSpotting: "Planning", bestAuthority: id === "stem" ? "Best result/method" : id === "humanities" ? "Best source/argument" : "Best principle/method" },
    decks: law.decks.map((d, i) => i < 2 ? { ...d, file: `${decks[i]}.csv`, label: decks[i].charAt(0) + decks[i].slice(1).toLowerCase() } : d),
    guides: law.guides.map((g) => ({ ...g, title: titles[g.n] })),
    packSections: law.packSections.map((section, i) => ({ ...section, heading: [
      "Core framework (memorise this shape)",
      id === "stem" ? "Key results, theorems and algorithms" : id === "humanities" ? "Sources, arguments and thinkers" : "Key principles and methods",
      "Planning checklist (run this on the question)", section.heading,
      id === "stem" ? "Worked problem" : id === "humanities" ? "Worked essay plan" : "Worked example", section.heading,
    ][i] })),
    workedLabels: labels, foundationKinds: kinds, namedFoundationKinds: kinds.slice(2).flat(),
    beginnerNote: `**Beginner starting point:** You are not expected to know this topic before opening the pack. Learn the plain-English gateway below first, then the framework, then the ${authorities}. Practise explaining when and how to use each one.`,
    fiveQuestions: questions,
    checklistIntro: `> Run this over any ${question} before you start writing. Check what is being asked, select relevant ${authorities}, and plan your response.`,
    coverage: {
      intro: `> Every ${authority.toLowerCase()} in your topic packs, with whether it also appears in each flashcard deck. Anything marked No is a gap to close before the exam.`,
      empty: `No ${authorities} were recorded for this topic.`,
      header: `| ${authority} | Foundations card | ${id === "humanities" ? "Essay" : "Problem"} card |`,
      complete: `**Every ${authority.toLowerCase()} appears in both decks.**`,
    },
    prompts: {
      ruleFor3: "3. Ground every factual proposition, result and interpretation in the SOURCE EXCERPTS in this message.\n   For every result, definition or figure you assert, set \"sourceFile\" to the exact file name from\n   the excerpt header and \"evidence\" to a VERBATIM span of 5 to 25 words copied\n   character-for-character from that excerpt. Copy it; do not paraphrase it. Automated checks\n   compare your evidence against the source and discard anything that cannot be found.",
      ruleFor4: `4. If the sources do not support something, omit it. Never invent ${authorities}, quotations, syllabus items or assessment rules. Omission always beats invention. An empty array is a valid answer.`,
      ruleFor6: `6. Write for a student who has never seen the topic: plain English first, then the framework, then the ${authorities}. Emphasis in **bold**.`,
      examFormat: [id === "stem" ? "worked-problem" : id === "humanities" ? "essay" : "short-answer", "essay", "mixed", "mcq", "unknown"].filter((v, i, a) => a.indexOf(v) === i),
      workedFields: labels.map((v) => v.toLowerCase()),
    },
  };
}

export const PROFILES: Readonly<Record<SubjectId, SubjectProfile>> = {
  law,
  stem: subject("stem", "STEM", "Key results, theorems, algorithms and worked problems.", "Key result", "key results, theorems and algorithms", "problem",
    ["Foundations and Key Results", "Problem to Method"],
    ["Problem-Solving Technique + Method Map", "How to Learn From Scratch", "Five-Day First-Class Checklist", "Master Problem-Solving Checklist", "Model Worked Problems", "Key Results Coverage Index"],
    ["Given", "Find", "Method", "Working", "Answer"], [["concept"], ["rule", "method"], ["result", "theorem", "algorithm", "authority"]],
    ["What quantities or inputs are given?", "What must be found or proved?", "Which result or algorithm applies, and under what assumptions?", "How can each step be checked?", "Does the answer have the right units and limiting behaviour?"]),
  humanities: subject("humanities", "Humanities", "Sources, arguments, thinkers and evidence-led essays.", "Source or argument", "sources, arguments and thinkers", "essay question",
    ["Foundations and Sources", "Question to Argument"],
    ["Essay Technique + Argument Map", "How to Learn From Scratch", "Five-Day First-Class Checklist", "Master Essay-Planning Checklist", "Model Essay Plans", "Sources and Arguments Coverage Index"],
    ["Question", "Thesis", "Evidence", "Counterargument", "Conclusion"], [["concept"], ["argument", "rule"], ["source", "thinker", "authority"]],
    ["What is the question asking you to evaluate?", "What thesis will your answer defend?", "Which sources and thinkers support it?", "What counterargument challenges your interpretation?", "What judgement follows from the evidence?"]),
  general: subject("general", "General", "Concepts, principles and practical applications.", "Principle", "principles and methods", "exam question",
    ["Foundations and Principles", "Question to Method"],
    ["Exam Technique + Planning Map", "How to Learn From Scratch", "Five-Day First-Class Checklist", "Master Revision Checklist", "Model Worked Examples", "Principles Coverage Index"],
    ["Context", "Question", "Principle", "Application", "Answer"], [["concept"], ["rule", "method"], ["authority"]],
    ["What is the question asking?", "Which concept explains the situation?", "Which principle or method applies?", "What evidence supports the answer?", "How can you check the result?"]),
};

export function getProfile(id: SubjectId): SubjectProfile { return PROFILES[id]; }

export function inferProfile(code: string, title: string): { id: SubjectId; reason: string } {
  const codes: [SubjectId, RegExp][] = [
    ["law", /^(LAW|SOL)(?=\d|\b)/i],
    ["stem", /^(ECS|MTH|PHY|CHE|EEE|SEF|SPA|BIO)(?=\d|\b)/i],
    ["humanities", /^(HST|ENG|POL|PHI|GEO|SML|FLM)(?=\d|\b)/i],
  ];
  for (const [id, pattern] of codes) if (pattern.test(code.trim())) return { id, reason: `Module code ${code} identifies ${id}.` };
  const words: [SubjectId, RegExp][] = [
    ["law", /\b(law|legal|contract|tort|jurisprudence|litigation)\b/i],
    ["stem", /\b(computing|computer|software|engineering|maths|mathematics|physics|chemistry|biology|algorithm|algorithms|statistics)\b/i],
    ["humanities", /\b(history|literature|politics|political|philosophy|geography|linguistics|film|humanities)\b/i],
  ];
  for (const [id, pattern] of words) if (pattern.test(title)) return { id, reason: `Course title identifies ${id}.` };
  return { id: "general", reason: "No subject-specific code or title matched." };
}

/** A saved valid choice wins; invalid or absent settings use course inference. */
export function resolveProfile(stored: unknown, code: string, title: string): SubjectProfile {
  return getProfile(typeof stored === "string" && Object.hasOwn(PROFILES, stored) ? stored as SubjectId : inferProfile(code, title).id);
}
