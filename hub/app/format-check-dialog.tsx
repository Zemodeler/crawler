"use client";

/**
 * Shown when a folder does not match the Study Hub format.
 *
 * Two rules govern this dialog. First, it never appears without the user having
 * just asked for something — a silent auto-restore gets a dismissible banner
 * instead. Second, it shows the complete list of paths that would be written
 * before offering to write anything, and states plainly that nothing existing is
 * touched. A conversion tool that surprises you is worse than no conversion tool.
 */

import { useMemo, useState } from "react";

import {
  SPEC,
  groupIssues,
  type FormatReport,
} from "../lib/course-format.ts";

export type FormatChoice = "keep" | "restructure" | "generate" | "scaffold";

const KB = 1024;

function formatBytes(bytes: number) {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

export function FormatCheckDialog({
  report,
  aiReady,
  onChoose,
  onDismiss,
}: {
  report: FormatReport;
  /** False when no provider is connected, which disables the generate option. */
  aiReady: boolean;
  onChoose: (choice: FormatChoice) => void;
  onDismiss: () => void;
}) {
  const [showPaths, setShowPaths] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => groupIssues(report.issues), [report.issues]);
  const empty = report.level === "empty";

  const checks: { ok: boolean; label: string; detail: string }[] = [
    {
      ok: report.has.hub,
      label: `A start-here hub (${SPEC.hub})`,
      detail: "The file Study Hub opens first.",
    },
    {
      ok: report.has.guides,
      label: `Revision guides in ${SPEC.guidesDir}`,
      detail: `${report.counts.guides} found.`,
    },
    {
      ok: report.has.packs,
      label: `Topic packs in ${SPEC.packsDir}`,
      detail: `${report.counts.packs} found.`,
    },
    {
      ok: report.has.decks,
      label: `Flashcard CSV files in ${SPEC.decksDir}`,
      detail: `${report.counts.decks} files, ${report.counts.cards} cards.`,
    },
    {
      ok: report.has.materialsIndex,
      label: `An index of your original materials`,
      detail: `${report.counts.sources} source files found.`,
    },
  ];

  const missingByDir = useMemo(() => {
    const map = new Map<string, { path: string; approxBytes: number }[]>();
    for (const piece of report.missing) {
      const dir = piece.path.includes("/")
        ? piece.path.slice(0, piece.path.lastIndexOf("/"))
        : "(top level)";
      map.set(dir, [...(map.get(dir) || []), piece]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [report.missing]);

  const totalBytes = report.missing.reduce((sum, p) => sum + p.approxBytes, 0);
  const aiCount = report.missing.filter((p) => p.needsAI).length;
  const codeOnly = report.missing.filter((p) => !p.needsAI);

  return (
    <div
      className="fmt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fmt-title"
    >
      <div className="fmt-dialog">
        <h2 id="fmt-title">
          {empty
            ? "This folder has no study files yet"
            : report.level === "unformatted"
              ? "This folder isn't in Study Hub format yet"
              : "This folder is nearly in Study Hub format"}
        </h2>
        <p className="fmt-summary">
          {report.fileCount} file{report.fileCount === 1 ? "" : "s"} in{" "}
          <b>{report.courseName}</b> · {report.counts.packs} topic pack
          {report.counts.packs === 1 ? "" : "s"} · {report.counts.cards} flashcard
          {report.counts.cards === 1 ? "" : "s"}
          {report.previouslyConverted ? " · converted before" : ""}
        </p>

        {empty ? (
          <div className="callout">
            <b>Nothing to read yet.</b>
            Drop your lectures, transcripts and seminar files into this folder — or
            let Study Hub create the empty folder structure first, so you know where
            everything goes.
          </div>
        ) : (
          <>
            <div className="fmt-group">
              <h3>The format</h3>
              {checks.map((check) => (
                <div
                  className={`fmt-check ${check.ok ? "ok" : "miss"}`}
                  key={check.label}
                >
                  <i>{check.ok ? "✓" : "✕"}</i>
                  <span>
                    {check.label}
                    {check.ok ? ` — ${check.detail}` : ""}
                  </span>
                </div>
              ))}
            </div>

            {groups.map((group) => {
              const isOpen = expanded[group.title];
              const shown = isOpen ? group.issues : group.issues.slice(0, 4);
              return (
                <div className="fmt-group" key={group.title}>
                  <h3>
                    {group.title} — {group.issues.length} to look at
                  </h3>
                  {shown.map((issue, i) => (
                    <div
                      className={`fmt-check ${issue.severity === "error" ? "miss" : "warn"}`}
                      key={`${issue.code}-${i}`}
                    >
                      <i>{issue.severity === "error" ? "✕" : "!"}</i>
                      <span>
                        {issue.message}
                        {issue.path ? (
                          <>
                            {" "}
                            <code>
                              {issue.path}
                              {issue.line ? `:${issue.line}` : ""}
                            </code>
                          </>
                        ) : null}
                      </span>
                    </div>
                  ))}
                  {group.issues.length > 4 && (
                    <button
                      className="fmt-more"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [group.title]: !isOpen,
                        }))
                      }
                    >
                      {isOpen
                        ? "Show fewer"
                        : `Show all ${group.issues.length}`}
                    </button>
                  )}
                </div>
              );
            })}

            {report.canConvert && (
              <div className="callout">
                <b>What Study Hub can build from</b>
                {report.counts.sources} of your own files — lectures, transcripts,
                seminars and past papers. Everything generated is grounded in those
                files and quotes them, so you can check it.
              </div>
            )}
            {!report.canConvert && !empty && (
              <div className="callout callout-warn">
                <b>No source material found</b>
                There are no lectures, transcripts or seminar files here to generate
                topic packs from. Study Hub can still create the folder structure and
                fix the links.
              </div>
            )}
          </>
        )}

        {report.missing.length > 0 && (
          <div className="fmt-group">
            <button className="fmt-more" onClick={() => setShowPaths(!showPaths)}>
              {showPaths ? "Hide" : "Preview"} exactly what would be written —{" "}
              {report.missing.length} file
              {report.missing.length === 1 ? "" : "s"}, about{" "}
              {formatBytes(totalBytes)}
            </button>
            {showPaths && (
              <>
                <div className="fmt-paths">
                  {missingByDir.map(([dir, pieces]) => (
                    <div key={dir}>
                      <b>{dir}/</b>
                      {pieces.map((piece) => (
                        <span key={piece.path}>
                          {piece.path.split("/").pop()}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="callout">
                  <b>Nothing existing is changed.</b>
                  No file is modified, moved, renamed or deleted. Your lectures,
                  transcripts, seminars and past papers are never touched, and any
                  file you have edited yourself is never overwritten.
                </div>
              </>
            )}
          </div>
        )}

        <div className="fmt-actions">
          <button className="btn btn-ghost" onClick={onDismiss}>
            Keep as-is
          </button>
          {empty ? (
            <button className="btn btn-primary" onClick={() => onChoose("scaffold")}>
              Create the folder structure
            </button>
          ) : (
            <>
              <button
                className="btn btn-ghost"
                onClick={() => onChoose("restructure")}
                disabled={!codeOnly.length && !report.links.broken && !report.links.absolute}
                title="Creates the hub, the materials index and the derived guides, and rewrites links. No AI, no new writing."
              >
                Fix structure and links only
              </button>
              <button
                className="btn btn-primary"
                onClick={() => onChoose("generate")}
                disabled={!aiReady || !report.canConvert}
                title={
                  !aiReady
                    ? "Connect Claude, ChatGPT or Gemini first"
                    : !report.canConvert
                      ? "No source material to generate from"
                      : `Generates ${aiCount} files from your own materials`
                }
              >
                {aiReady
                  ? `Build packs and flashcards (${aiCount} files)`
                  : "Connect Claude, ChatGPT or Gemini to generate"}
              </button>
            </>
          )}
        </div>
        {!aiReady && !empty && (
          <p className="fmt-summary" style={{ margin: "12px 0 0" }}>
            <a className="hub-back" href="/connect" style={{ margin: 0 }}>
              Set up your AI connection →
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

/** The non-interrupting variant, used after a silent folder restore. */
export function FormatCheckBanner({
  report,
  onOpen,
  onDismiss,
}: {
  report: FormatReport;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const gaps = report.topics.filter((t) => !t.joined).length;
  const summary = report.level === "empty"
    ? "This folder has no study files Study Hub can read."
    : report.level === "unformatted"
      ? "This folder isn't in Study Hub format."
      : gaps
        ? `${gaps} topic${gaps === 1 ? "" : "s"} ${gaps === 1 ? "is" : "are"} missing packs or flashcards.`
        : `${errors} thing${errors === 1 ? "" : "s"} to fix in this folder.`;

  return (
    <div className="fmt-banner">
      <span>{summary}</span>
      <button onClick={onOpen}>Check format</button>
      <button onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
