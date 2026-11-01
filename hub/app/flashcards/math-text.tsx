"use client";

/**
 * Tutorial text: the reader's Markdown subset ("- " bullets, "1." numbered
 * lists, one paragraph per line, **bold**, *italic*, `code`) with [[a b; c d]]
 * matrices drawn as small bracketed tables.
 */

import { Fragment, type ReactNode } from "react";

import { splitMath } from "../../lib/tutorial.ts";
import { inline } from "../markdown.tsx";

const noLink = () => {};

/** One line of text with its matrices. */
function Run({ text }: { text: string }) {
  return (
    <>
      {splitMath(text).map((piece, i) =>
        typeof piece === "string" ? (
          <Fragment key={i}>{inline(piece, noLink)}</Fragment>
        ) : (
          <span
            key={i}
            className="tu-matrix"
            style={{ gridTemplateColumns: `repeat(${piece.matrix[0].length}, auto)` }}
          >
            {piece.matrix.flatMap((row, r) => row.map((cell, c) => <span key={`${r}-${c}`}>{cell}</span>))}
          </span>
        ),
      )}
    </>
  );
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const nodes: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^[-*] /.test(lines[i].trim()); i++) items.push(lines[i].trim().slice(2));
      i--;
      nodes.push(
        <ul key={i}>
          {items.map((item, k) => (
            <li key={k}>
              <Run text={item} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+[.)] /.test(line)) {
      const items: string[] = [];
      const start = Number(line.match(/^\d+/)![0]);
      for (; i < lines.length && /^\d+[.)] /.test(lines[i].trim()); i++) items.push(lines[i].trim().replace(/^\d+[.)] /, ""));
      i--;
      nodes.push(
        <ol key={i} start={start}>
          {items.map((item, k) => (
            <li key={k}>
              <Run text={item} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }
    nodes.push(
      <p key={i}>
        <Run text={line} />
      </p>,
    );
  }
  return <div className={`tu-text${className ? ` ${className}` : ""}`}>{nodes}</div>;
}
