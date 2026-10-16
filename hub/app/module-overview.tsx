"use client";

import { useEffect, useState } from "react";

import { SUPPORTED_EXTS } from "../lib/course-format.ts";
import { moduleCode, moduleColor, type Deadline, type LibraryTree } from "../lib/library.ts";
import { dueDate, formatDue } from "./calendar/deadline-ui.tsx";

type ModuleStats = { files: number; opened: number; reviewed: number };

/** Read from what each module's own pages saved: files opened, cards reviewed. */
function statsFor(tree: LibraryTree, key: string, liveOpened?: Record<string, number>): ModuleStats {
  const prefix = `${key}/`;
  const paths = tree.files
    .filter((f) => f.path.startsWith(prefix) && SUPPORTED_EXTS.has(f.path.split(".").pop()?.toLowerCase() || ""))
    .map((f) => f.path.slice(prefix.length));
  let opened: Record<string, number> = liveOpened || {};
  let reviewed = 0;
  try {
    if (!liveOpened) opened = JSON.parse(localStorage.getItem(`studyhub:${key}`) || "{}").opened || {};
    reviewed = Object.keys(JSON.parse(localStorage.getItem(`studyhub:flashcards:${key}`) || "{}").reviews || {}).length;
  } catch {
    /* nothing saved yet */
  }
  const set = new Set(paths);
  return { files: paths.length, opened: Object.keys(opened).filter((p) => set.has(p)).length, reviewed };
}

/** Every module of the year side by side; the open one is marked. */
export default function ModuleOverview({
  tree,
  year,
  activeKey,
  activeOpened,
  deadlines,
  onOpen,
}: {
  tree: LibraryTree;
  year: string;
  activeKey: string;
  activeOpened: Record<string, number>;
  deadlines: Deadline[];
  onOpen: (module: string) => void;
}) {
  const modules = tree.years.find((y) => y.year === year)?.modules || [];
  const all = tree.years.flatMap((y) => y.modules);
  const [now, setNow] = useState(0);
  useEffect(() => queueMicrotask(() => setNow(Date.now())), []);
  if (modules.length < 2) return null;

  return (
    <section className="module-overview" aria-labelledby="module-overview-title">
      <div className="section-title">
        <div>
          <p className="eyebrow">{year}</p>
          <h3 id="module-overview-title">Your modules</h3>
        </div>
      </div>
      <div className="module-cards">
        {modules.map((m) => {
          const key = `${year}/${m}`;
          const active = key === activeKey;
          const stats = statsFor(tree, key, active ? activeOpened : undefined);
          const percent = stats.files ? Math.round((stats.opened / stats.files) * 100) : 0;
          const next = deadlines
            .filter((d) => d.module === moduleCode(m) && d.status !== "cancelled" && (dueDate(d)?.getTime() ?? 0) >= now)
            .sort((a, b) => dueDate(a)!.getTime() - dueDate(b)!.getTime())[0];
          const [code, ...rest] = m.split(" - ");
          return (
            <button
              key={m}
              className={`module-card${active ? " active" : ""}`}
              aria-current={active ? "true" : undefined}
              onClick={() => !active && onOpen(m)}
            >
              <span className="module-card-head">
                <span className="module-dot" style={{ background: moduleColor(all, m) }} aria-hidden="true" />
                <b>{code}</b>
                {active && <span className="here">Open</span>}
              </span>
              <span className="module-card-name">{rest.join(" - ") || m}</span>
              <span className="module-bar" aria-hidden="true">
                <i style={{ width: `${percent}%`, background: moduleColor(all, m) }} />
              </span>
              <span className="module-card-stats">
                {stats.opened} of {stats.files} files opened
                {stats.reviewed > 0 && ` · ${stats.reviewed} cards reviewed`}
              </span>
              <span className="module-card-next">
                {next ? <>Next: <b>{next.title}</b>, {formatDue(next, "short")}</> : "No upcoming deadlines"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
