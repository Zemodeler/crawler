"use client";

/**
 * A fill-in question laid out the way the course site's online quiz shows
 * one: answer boxes inside the sentence or a table cell, and a
 * multiple-choice part as a list of radio buttons. With `review`, the boxes
 * show what was given, whether it was right, and the right answer.
 */

import { Fragment, type ReactNode } from "react";

import { blankAnswerText, blankCorrect, clozeParts, type Blank, type Question } from "../../lib/practice.ts";
import { inline } from "../markdown.tsx";

const noLink = () => {};
const isTableRow = (line: string) => /^\|.*\|$/.test(line);
const isDivider = (line: string) => /^\|(\s*:?-{3,}:?\s*\|)+$/.test(line);
const cells = (line: string) => line.slice(1, -1).split("|").map((c) => c.trim());

type Props = {
  question: Pick<Question, "id" | "prompt" | "blanks">;
  /** One entry per box: the typed text, or a choice's index as text. */
  values: string[];
  onChange?: (index: number, value: string) => void;
  review?: boolean;
};

export function ClozeQuestion({ question, values, onChange, review }: Props) {
  const blanks = question.blanks ?? [];
  const label = (i: number) => `Answer ${i + 1}`;

  function mark(blank: Blank, i: number) {
    if (!review) return null;
    const right = blankCorrect(blank, values[i]);
    return <span className={`pr-blank-mark ${right ? "right" : "wrong"}`} aria-label={right ? "Correct" : `Wrong. Correct answer: ${blankAnswerText(blank)}`}>
      {right ? "✓" : `✗ ${blankAnswerText(blank)}`}
    </span>;
  }

  /** One box inside a line: a text box, or a dropdown for a choice that sits mid-sentence. */
  function box(i: number): ReactNode {
    const blank = blanks[i];
    if (!blank) return `[${i + 1}]`;
    const state = review ? (blankCorrect(blank, values[i]) ? " right" : " wrong") : "";
    if (blank.kind === "choice")
      return <Fragment key={`b${i}`}>
        <select className={`pr-blank${state}`} aria-label={label(i)} value={values[i] ?? ""} disabled={review}
          onChange={(e) => onChange?.(i, e.target.value)}>
          <option value="">Choose…</option>
          {blank.options.map((o, k) => <option key={k} value={String(k)}>{o}</option>)}
        </select>{mark(blank, i)}
      </Fragment>;
    return <Fragment key={`b${i}`}>
      <input className={`pr-blank${state}`} aria-label={label(i)} value={values[i] ?? ""} readOnly={review} autoComplete="off" spellCheck={false}
        inputMode={blank.kind === "number" ? "decimal" : "text"} size={blank.kind === "number" ? 8 : 12}
        onChange={(e) => onChange?.(i, e.target.value)} />{mark(blank, i)}
    </Fragment>;
  }

  /** Text with its boxes and inline formatting. */
  const run = (text: string) => clozeParts(text).map((part, k) =>
    typeof part === "string" ? <Fragment key={k}>{inline(part, noLink)}</Fragment> : <Fragment key={k}>{box(part.blank)}</Fragment>);

  /** A choice on a line of its own: radio buttons, one per option, like the quiz. */
  function choiceList(i: number) {
    const blank = blanks[i] as Extract<Blank, { kind: "choice" }>;
    return <fieldset className="pr-blank-choices" key={`c${i}`}>
      <legend className="pr-sr">{label(i)}</legend>
      {blank.options.map((option, k) => {
        const chosen = values[i] === String(k);
        const key = review && k === blank.correctIndex;
        return <label key={k} className={`${chosen ? "chosen" : ""}${key ? " key" : ""}`}>
          <input type="radio" name={`${question.id}-b${i}`} checked={chosen} disabled={review} onChange={() => onChange?.(i, String(k))} />
          <span>{inline(option, noLink)}</span>
          {review && key && <em>Correct answer</em>}
          {review && chosen && !key && <em>Your answer</em>}
        </label>;
      })}
    </fieldset>;
  }

  const lines = question.prompt.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const nodes: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const alone = line.match(/^\[(\d{1,2})\]$/);
    if (alone && blanks[Number(alone[1]) - 1]?.kind === "choice") {
      nodes.push(choiceList(Number(alone[1]) - 1));
      continue;
    }
    if (isTableRow(line)) {
      const rows: string[] = [];
      for (; i < lines.length && isTableRow(lines[i]); i++) rows.push(lines[i]);
      i--;
      const hasHead = rows.length > 1 && isDivider(rows[1]);
      const head = hasHead ? cells(rows[0]) : null;
      const body = rows.filter((r, k) => !isDivider(r) && !(hasHead && k === 0));
      nodes.push(<table className="pr-blank-table" key={`t${i}`}>
        {head && <thead><tr>{head.map((c, k) => <th key={k}>{run(c)}</th>)}</tr></thead>}
        <tbody>{body.map((r, k) => <tr key={k}>{cells(r).map((c, j) => <td key={j}>{run(c)}</td>)}</tr>)}</tbody>
      </table>);
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^[-*] /.test(lines[i]); i++) items.push(lines[i].slice(2));
      i--;
      nodes.push(<ul key={`u${i}`}>{items.map((item, k) => <li key={k}>{run(item)}</li>)}</ul>);
      continue;
    }
    nodes.push(<p key={`p${i}`}>{run(line)}</p>);
  }
  return <div className="pr-cloze">{nodes}</div>;
}
