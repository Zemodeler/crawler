import { createHash } from "node:crypto";
import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILES, getProfile, inferProfile, resolveProfile } from '../lib/subject-profiles.ts';
import { SPEC, deckFile, deckPath, guidePath, packPath, validateCourse } from '../lib/course-format.ts';
import { renderPack, foundationRows, scenarioRows, buildHub, buildMasterChecklist, buildCaseCoverageIndex, buildGuide, buildEmptyScaffoldHub } from '../lib/course-render.ts';
import { ConversionRun, validateStaged } from '../lib/conversion-run.ts';

const topic = { number: 1, name: 'Introduction' };
const pack = {
  plainEnglish: { question: 'What is this?', answer: 'An introduction.' }, whereItSits: [],
  framework: [], rules: [], checklist: ['Check the question'], moves: [],
  worked: { facts: 'Inputs', issue: 'Goal', rule: 'Method', application: ['Step'], conclusion: 'Result' },
  traps: [], authorities: [],
};
const plan = { subject: 'Example', level: 'undergraduate', examFormat: 'mixed', examTarget: [], topics: [topic] };

test('subject inference uses codes, then titles, with an explained general fallback', () => {
  for (const [code, title, id] of [
    ['ECS505U', 'Software Engineering', 'stem'], ['LAW101', 'Contract Law', 'law'],
    ['SOL200', 'Introduction', 'law'], ['MTH100', 'Introduction', 'stem'],
    ['PHY100', '', 'stem'], ['CHE100', '', 'stem'], ['EEE100', '', 'stem'],
    ['SEF100', '', 'stem'], ['SPA100', '', 'stem'], ['BIO100', '', 'stem'],
    ['HST100', '', 'humanities'], ['ENG100', '', 'humanities'], ['POL100', '', 'humanities'],
    ['PHI100', '', 'humanities'], ['GEO100', '', 'humanities'], ['SML100', '', 'humanities'], ['FLM100', '', 'humanities'],
    ['', 'Computing and mathematics', 'stem'], ['', 'Engineering', 'stem'],
    ['', 'History and literature', 'humanities'], ['', 'Politics', 'humanities'],
    ['', 'Criminal law', 'law'], ['BUS100', 'Management', 'general'],
  ]) {
    const result = inferProfile(code, title);
    assert.equal(result.id, id, `${code}: ${title}`);
    assert.ok(result.reason.length);
  }
  assert.equal(resolveProfile('humanities', 'LAW100', 'Law'), PROFILES.humanities);
  assert.equal(resolveProfile('invalid', 'ECS505U', 'Software Engineering'), PROFILES.stem);
  assert.equal(resolveProfile(undefined, '', ''), PROFILES.general);
  assert.equal(resolveProfile('toString', '', ''), PROFILES.general);
});

test('law profile retains the exact existing spec and default rendering', () => {
  assert.deepEqual(PROFILES.law.decks, SPEC.decks);
  assert.deepEqual(PROFILES.law.guides, SPEC.guides);
  assert.deepEqual(PROFILES.law.packSections, SPEC.packSections);
  assert.equal(renderPack(topic, pack), renderPack(topic, pack, PROFILES.law));
  assert.ok(renderPack(topic, pack).includes(" \u00b7 "));
  assert.equal(buildHub(plan, { hasMaterialsIndex: false }), buildHub(plan, { hasMaterialsIndex: false }, PROFILES.law));
  assert.equal(buildMasterChecklist([]), buildMasterChecklist([], PROFILES.law));
  assert.equal(buildCaseCoverageIndex([]), buildCaseCoverageIndex([], PROFILES.law));
  // Historical rule/statute ordering is a shared group, preserving input order.
  const card = (kind, prompt) => ({ kind, prompt, principle: 'Answer', sourceFile: '', evidence: '' });
  assert.deepEqual(foundationRows([card('statute', 'S'), card('rule', 'R'), card('concept', 'C')]).slice(1).map(r => r[0]), ['C', 'S', 'R']);
});

for (const id of ['law', 'stem', 'humanities', 'general']) {
  test(`${id}: staged conversion reports missing files using the saved run profile`, () => {
    const run = ConversionRun.create('Example', 'scaffold', {}, { profile: id });
    const profile = getProfile(run.state.profile);
    const staged = [{ path: packPath(topic), content: renderPack(topic, pack, profile), generator: 'code' }];
    staged.push(...run.buildScaffold(plan, [], staged));
    const report = validateStaged([], staged, run.state.courseName, profile);
    assert.equal(run.state.profile, id);
    assert.ok(!report.missing.some((m) => m.path === SPEC.hub));
    for (const deck of profile.decks) assert.ok(report.missing.some((m) => m.path.endsWith('/' + deck.file)));
    for (const guide of profile.guides) assert.ok(report.missing.some((m) => m.path.endsWith(guide.title + '.md')));
    if (id !== 'law') assert.ok(report.missing.every((m) => !/Cases|Case Coverage|Problem Question|Issue-Spotting/.test(m.path)));
  });
  test(`${id}: format paths, validation, packs, decks and derived guides agree`, () => {
    const profile = getProfile(id);
    for (const deck of profile.decks) {
      assert.equal(deckFile(deck.id, profile), deck.file);
      assert.ok(deckPath(topic, deck.id, profile).endsWith('/' + deck.file));
    }
    for (const guide of profile.guides) assert.ok(guidePath(guide.n, undefined, profile).endsWith(guide.title + '.md'));
    const rendered = renderPack(topic, pack, profile);
    assert.ok(rendered.includes(profile.beginnerNote));
    for (const label of profile.workedLabels) assert.ok(rendered.includes(`**${label}.**`));
    for (const section of profile.packSections) assert.ok(rendered.includes(section.heading));
    const hub = buildHub(plan, { hasMaterialsIndex: false }, profile);
    for (const deck of profile.decks) assert.ok(hub.includes(deck.file));
    const checklist = buildMasterChecklist([{ topic, checklist: pack.checklist }], profile);
    assert.ok(checklist.includes(profile.checklistIntro));
    assert.ok(checklist.includes(profile.guides[3].title));
    const coverage = buildCaseCoverageIndex([{ topic, authorities: [], foundationsQuestions: [], scenarioAuthorities: [] }], profile);
    assert.ok(coverage.includes(profile.coverage.empty));
    assert.ok(coverage.includes(profile.guides[5].title));
    assert.ok(buildGuide(0, SPEC.guides[0].title, [], undefined, profile).includes(profile.guides[0].title));
    assert.ok(scenarioRows([{ facts: 'Input', bestAuthority: 'Result', whyItFits: 'Reason', counterpoint: 'Limit', examSentence: 'Sentence' }], profile)[1][1].startsWith(profile.terms.bestAuthority + ':'));
    const report = validateCourse([{ path: packPath(topic), ext: 'md', text: rendered }], {}, profile);
    for (const deck of profile.decks) assert.ok(report.missing.some(m => m.path.endsWith('/' + deck.file)));
    for (const guide of profile.guides) assert.ok(report.missing.some(m => m.path.endsWith(guide.title + '.md')));
    const kinds = profile.foundationKinds.flat();
    const cards = kinds.map((kind) => ({ kind, prompt: kind, authority: 'Named ' + kind, principle: 'Meaning', sourceFile: '', evidence: '' }));
    assert.equal(foundationRows(cards, profile).length, cards.length + 1);
  });
}

// Golden hashes captured from the original m2-library renderer (7557fc0).
test("default law output matches the original renderer byte for byte", () => {
  const cases = [
  [
    "renderPack",
    [
      {
        "number": 1,
        "name": "Introduction"
      },
      {
        "plainEnglish": {
          "question": "What is this?",
          "answer": "An introduction."
        },
        "whereItSits": [],
        "framework": [],
        "rules": [],
        "checklist": [
          "Check the question"
        ],
        "moves": [],
        "worked": {
          "facts": "Inputs",
          "issue": "Goal",
          "rule": "Method",
          "application": [
            "Step"
          ],
          "conclusion": "Result"
        },
        "traps": [],
        "authorities": []
      }
    ],
    "83230723fa689fd5c6bcb47d6304ccb456ec302638f6e25add3ec06d54bab6d3"
  ],
  [
    "buildHub",
    [
      {
        "subject": "Example",
        "level": "undergraduate",
        "examFormat": "mixed",
        "examTarget": [],
        "topics": [
          {
            "number": 1,
            "name": "Introduction"
          }
        ]
      },
      {
        "hasMaterialsIndex": false
      }
    ],
    "f1955634875f53f8093557457b815bffc549b24b829d563740ff4834ba463c27"
  ],
  [
    "buildMasterChecklist",
    [
      [
        {
          "topic": {
            "number": 1,
            "name": "Introduction"
          },
          "checklist": [
            "Check the question"
          ]
        }
      ]
    ],
    "b664dd2789424b2e21f132387bea8e08f8cfcc84c2f66cec4f38ab201319d281"
  ],
  [
    "buildCaseCoverageIndex",
    [
      [
        {
          "topic": {
            "number": 1,
            "name": "Introduction"
          },
          "authorities": [
            {
              "name": "Example"
            }
          ],
          "foundationsQuestions": [
            "Example"
          ],
          "scenarioAuthorities": [
            "Example"
          ]
        }
      ]
    ],
    "3bf841f247e8ed67948b022498df54a8281121d72c9ed28e6a41938b63a8edcb"
  ],
  [
    "buildGuide",
    [
      0,
      "Custom title",
      []
    ],
    "23b2922f49cdf41505605798e9ed4fbac0806b7dcdc3c823d571b6a4a0670e9c"
  ],
  [
    "buildEmptyScaffoldHub",
    [
      "Example"
    ],
    "45cafe67c44f037a60608eb83328ecb1027459883b084f16d316741757873f04"
  ]
];
  const functions = { renderPack, buildHub, buildMasterChecklist, buildCaseCoverageIndex, buildGuide, buildEmptyScaffoldHub };
  for (const [name, args, expected] of cases) assert.equal(createHash("sha256").update(functions[name](...args)).digest("hex"), expected, name);
});
