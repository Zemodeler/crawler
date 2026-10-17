import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAssessmentOverview } from "../src/index.ts";

test("parses assessment overview rows, weights and resits", () => {
  const html = `<table><tr><th>Seq</th><th>Type</th><th>Description</th><th>Weight</th><th>Submission Deadline</th><th>Feedback Deadline</th></tr>
    <tr><td>001</td><td>ECO</td><td>Examination</td><td>60%</td><td></td><td></td></tr>
    <tr><td>002</td><td>CWK</td><td>Mini-project</td><td>20%</td><td></td><td></td></tr>
    <tr><td>003</td><td>PRA</td><td>Lab assignments</td><td>20%</td><td></td><td></td></tr>
    <tr><td>999</td><td>ECO</td><td>Resit Examination</td><td>100%</td><td></td><td></td></tr>
    <tr><td>&nbsp;</td><td></td></tr></table>`;
  const rows = parseAssessmentOverview(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.weight), [60, 20, 20, 100]);
  assert.deepEqual(rows[0], { seq: "001", type: "ECO", description: "Examination", weight: 60, submission: null, resit: false });
  assert.equal(rows[3]!.resit, true);
  assert.equal(rows[3]!.submission, null);
});

test("ignores tables without Weight and pages without tables", () => {
  assert.deepEqual(parseAssessmentOverview("<table><tr><td>Description</td></tr><tr><td>Exam</td></tr></table>"), []);
  assert.deepEqual(parseAssessmentOverview("<p>No assessments here.</p>"), []);
});

test("decodes common HTML entities in assessment cells", () => {
  const rows = parseAssessmentOverview(`<table><tr><th>Description</th><th>Weight</th></tr>
    <tr><td>Mid&ndash;term test &amp; quiz</td><td>20%</td></tr>
    <tr><td>&lsquo;Project&rsquo;&nbsp;&mdash; &ldquo;report&rdquo;&hellip; &pound;5</td><td>80%</td></tr></table>`);
  assert.equal(rows[0]!.description, "Mid–term test & quiz");
  assert.equal(rows[1]!.description, "‘Project’ — “report”… £5");
});

test("maps reordered td headers, decodes text and reads every matching table", () => {
  const table = `<table><tr><td>Weight</td><td>Description</td><td>Submission Deadline</td></tr>
    <tr><td></td><td> Mini&nbsp; <b>project</b> &amp; &#49; </td><td> 12 October </td></tr>
    <tr><td>invalid</td><td>Resit exam</td></tr></table>`;
  const rows = parseAssessmentOverview(table + table);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { seq: null, type: null, description: "Mini project & 1", weight: null, submission: "12 October", resit: false });
  assert.equal(rows[1]!.resit, true);
  assert.equal(rows[1]!.weight, null);
  assert.equal(parseAssessmentOverview('<table><tr><td>Seq</td><td>Description</td><td>Weight</td></tr><tr><td>999</td><td>Exam</td><td>100%</td></tr></table>')[0]!.resit, true);
});
