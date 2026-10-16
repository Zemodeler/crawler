"use client";

/**
 * The Markdown reader, lifted out of app/page.tsx unchanged.
 *
 * It lives on its own so the conversion preview renders with the exact component
 * the reader uses. That is what makes "preview" mean "what you will actually
 * see", rather than "what a second, slightly different renderer thinks".
 *
 * The subset it supports is the contract that lib/course-format.ts SPEC.markdown
 * documents and lib/course-render.ts is careful never to exceed.
 */

import { Fragment, type ReactNode } from "react";

export function inline(text: string, onLink: (target: string) => void): ReactNode[] {
  const tokens = text.split(
    /(\[[^\]]+\]\((?:<[^>]+>|[^)]+)\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g,
  );
  return tokens.map((token, i) => {
    const link = token.match(/^\[([^\]]+)\]\((?:<([^>]+)>|([^)]+))\)$/);
    if (link)
      return (
        <button className="inline-link" key={i} onClick={() => onLink(link[2] || link[3])}>
          {link[1]}
        </button>
      );
    if (token.startsWith("**") && token.endsWith("**"))
      return <strong key={i}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`"))
      return <code key={i}>{token.slice(1, -1)}</code>;
    if (token.startsWith("*") && token.endsWith("*"))
      return <em key={i}>{token.slice(1, -1)}</em>;
    return <Fragment key={i}>{token}</Fragment>;
  });
}

export function Markdown({
  text,
  path,
  onLink,
  checks,
  toggleCheck,
}: {
  text: string;
  path: string;
  onLink: (target: string) => void;
  /** Checkbox state, keyed `"<path>:<lineIndex>"`. */
  checks: Record<string, boolean>;
  toggleCheck: (key: string) => void;
}) {
  const lines = text.replace(/\r/g, "").split("\n");
  const nodes: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      const Tag = `h${heading[1].length}` as keyof React.JSX.IntrinsicElements;
      nodes.push(<Tag key={i}>{inline(heading[2], onLink)}</Tag>);
      continue;
    }
    if (line.startsWith("|")) {
      const table: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        table.push(
          lines[i]
            .split("|")
            .slice(1, -1)
            .map((s) => s.trim()),
        );
        i++;
      }
      i--;
      const data = table.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
      nodes.push(
        <div className="table-wrap" key={`t${i}`}>
          <table>
            <tbody>
              {data.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) =>
                    ri === 0 ? (
                      <th key={ci}>{inline(c, onLink)}</th>
                    ) : (
                      <td key={ci}>{inline(c, onLink)}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/);
    if (check) {
      const key = `${path}:${i}`;
      nodes.push(
        <label className="check-row" key={i}>
          <input
            type="checkbox"
            checked={checks[key] ?? check[1].toLowerCase() === "x"}
            onChange={() => toggleCheck(key)}
          />
          <span>{inline(check[2], onLink)}</span>
        </label>,
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      nodes.push(
        <div className="bullet" key={i}>
          • <span>{inline(bullet[1], onLink)}</span>
        </div>,
      );
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (numbered) {
      nodes.push(
        <div className="bullet numbered" key={i}>
          {inline(line, onLink)}
        </div>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      nodes.push(
        <blockquote key={i}>{inline(line.replace(/^>\s?/, ""), onLink)}</blockquote>,
      );
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={i} />);
      continue;
    }
    if (!line.trim()) {
      nodes.push(<div className="spacer" key={i} />);
      continue;
    }
    nodes.push(<p key={i}>{inline(line, onLink)}</p>);
  }
  return <div className="markdown">{nodes}</div>;
}
