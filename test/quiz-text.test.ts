import assert from "node:assert/strict";
import { test } from "node:test";

import { isPracticeQuiz, questionText, quizMarkdown } from "../src/quiz-text.ts";

// Shaped like a QMplus multianswer question, with the student's saved answers in it.
const MULTI = `<div id="question-1-3" class="que multianswer"><div class="info"><h3 class="no">Question <span class="qno">2</span></h3>
<div class="state">Incomplete answer</div><div class="grade">Marked out of 4.00</div><div class="questionflag editable">
<input type="hidden" value="qaid=41&amp;checksum=abc123&amp;sesskey=SESSKEY99" class="questionflagpostdata" /><span>Flag question</span></div></div>
<div class="content"><div class="formulation clearfix"><h4 class="accesshide">Question text</h4><input type="hidden" name="q1:3_:sequencecheck" value="2" />
<p>We construct 4-digit numbers from
the digits 0, 1, 3, 5, 7, 8, 9. Use <strong>4 </strong>digits.</p>
<p><!--[if !supportLists]-->a)&nbsp;How many? <span class="subquestion"><label class="subq accesshide" for="a">Answer 1 Question 2</label><input type="text" name="q1:3_sub1_answer" value="26^5" size="5" /></span></p>
<p>b) Which formula?</p><fieldset class="answer"><legend class="sr-only">Multiple choice 1 Question 2</legend>
<div class="form-check form-check-inline"><input type="radio" name="r" value="0" checked="checked" /><label class="form-check-label"> P(7,4)</label></div>
<div class="form-check form-check-inline"><input type="radio" name="r" value="1" /><label class="form-check-label">7<sup>4</sup></label></div></fieldset>
<p>c) Pick one <select name="s"><option value="">Choose...</option><option value="1">yes</option><option value="2">no</option></select></p>
<table><thead><tr><td><p><strong>X</strong></p></td><td><p><strong>p(X)</strong></p></td></tr></thead>
<tbody><tr><td><p>1</p></td><td><p><input type="text" value="0.33" /></p></td></tr></tbody></table>
<div class="validationerror">Please answer all parts of the question.</div></div></div></div><script>var require = { baseUrl: "x" };</script>`;

test("question text keeps the question, numbers the answer boxes and lists the choices", () => {
  assert.equal(
    questionText(MULTI),
    [
      "We construct 4-digit numbers from the digits 0, 1, 3, 5, 7, 8, 9. Use **4** digits.",
      "",
      "a) How many? [1]",
      "",
      "b) Which formula?",
      "",
      "- ( ) P(7,4)",
      "- ( ) 7^4",
      "",
      "c) Pick one [2: yes / no]",
      "",
      "| **X** | **p(X)** |",
      "| --- | --- |",
      "| 1 | [3] |",
    ].join("\n"),
  );
});

test("nothing the student typed, and no session data, survives", () => {
  const text = questionText(MULTI);
  for (const leak of ["26^5", "0.33", "SESSKEY99", "checksum", "qaid", "Flag question", "Answer 1 Question 2", "Please answer", "require"])
    assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test("the quiz file has a heading per question with its marks, and an information page", () => {
  const md = quizMarkdown("Probability demo quiz", "https://qmplus.example/mod/quiz/view.php?id=5", [
    { slot: 2, type: "multianswer", number: 1, maxmark: 6, html: '<div class="content"><p>First</p></div>' },
    { slot: 1, type: "description", number: null, maxmark: 0, html: '<div class="content"><p>Read me</p></div>' },
    { slot: 3, type: "multichoice", number: "2", maxmark: 1, html: '<div class="content"><p>Second</p></div>' },
  ]);
  assert.match(md ?? "", /^# Probability demo quiz\n\nA practice quiz from the course site: https:\/\/qmplus\.example\/mod\/quiz\/view\.php\?id=5\n/);
  assert.match(md ?? "", /## Information\n\nRead me\n\n## Question 1 \(6 marks\)\n\nFirst\n\n## Question 2 \(1 mark\)\n\nSecond\n$/);
  assert.equal(quizMarkdown("Empty", "u", [{ slot: 1, type: "description", html: "<p>Only info</p>" }]), null);
});

test("only practice quizzes outside Safe Exam Browser are read", () => {
  for (const name of ["Probability demo quiz", "Practice quiz 2", "Mock test", "Week 3 self-test", "Revision quiz", "Formative quiz"])
    assert.ok(isPracticeQuiz({ name, browsersecurity: "-" }), name);
  for (const name of ["In-term test", "End-term test", "Week 1 check-in quiz", "Quiz 3"])
    assert.ok(!isPracticeQuiz({ name, browsersecurity: "-" }), name);
  assert.ok(!isPracticeQuiz({ name: "Practice quiz", browsersecurity: "safebrowser" }));
  assert.ok(isPracticeQuiz({ name: "Practice quiz" }));
});
