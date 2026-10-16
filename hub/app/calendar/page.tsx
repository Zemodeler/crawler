"use client";

import { useEffect, useMemo, useState } from "react";

import { isHosted } from "../../lib/ai/settings.ts";
import { currentAcademicYear, fetchDeadlines, fetchTree, moduleCode, type Deadline } from "../../lib/library.ts";
import {
  DeadlinePanel,
  KIND_LABEL,
  ModuleDot,
  StatusPill,
  dayKey,
  dueDate,
  formatDue,
} from "./deadline-ui.tsx";
import SyncSettings from "./sync-settings.tsx";

type View = "list" | "month";

function readView(): View {
  try {
    return localStorage.getItem("studyhub:calendar:view") === "list" ? "list" : "month";
  } catch {
    return "month";
  }
}

export default function CalendarPage() {
  const [state, setState] = useState<"loading" | "ready" | "unhosted" | "error">("loading");
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [view, setView] = useState<View>("month");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [showPast, setShowPast] = useState(false);
  const [openId, setOpenId] = useState("");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!isHosted()) {
      queueMicrotask(() => setState("unhosted"));
      return;
    }
    queueMicrotask(() => {
      setView(readView());
      setNow(Date.now());
      setOpenId(decodeURIComponent(window.location.hash.slice(1)));
    });
    Promise.all([fetchTree(), fetchDeadlines()])
      .then(([tree, items]) => {
        const year = tree.years.find((y) => y.year === currentAcademicYear()) || tree.years[0];
        setModules(tree.years.flatMap((y) => y.modules));
        // This year's deadlines; past years stay reachable through their modules.
        setDeadlines(items.filter((d) => !year || d.year === year.year));
        setState("ready");
      })
      .catch(() => setState("error"));
    // The overview links to a deadline by #id, which may arrive after load.
    const onHash = () => setOpenId(decodeURIComponent(window.location.hash.slice(1)));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const chooseView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem("studyhub:calendar:view", next);
    } catch {
      /* remembered for this visit only */
    }
  };

  const filtered = useMemo(
    () =>
      deadlines.filter(
        (d) => (moduleFilter === "all" || d.module === moduleFilter) && (kindFilter === "all" || d.kind === kindFilter),
      ),
    [deadlines, moduleFilter, kindFilter],
  );
  const dated = filtered
    .filter((d) => d.due && d.status !== "tbc")
    .sort((a, b) => dueDate(a)!.getTime() - dueDate(b)!.getTime());
  const startOfToday = now ? new Date(now).setHours(0, 0, 0, 0) : 0;
  const upcoming = dated.filter((d) => dueDate(d)!.getTime() >= startOfToday);
  const past = dated.filter((d) => dueDate(d)!.getTime() < startOfToday);
  const tbc = filtered.filter((d) => !d.due || d.status === "tbc");
  const codes = Array.from(new Set(deadlines.map((d) => d.module))).sort();
  const kinds = Array.from(new Set(deadlines.map((d) => d.kind)));
  const open = deadlines.find((d) => d.id === openId);

  const select = (id: string) => {
    setOpenId(id);
    history.replaceState(null, "", id ? `#${encodeURIComponent(id)}` : window.location.pathname);
  };

  const row = (d: Deadline) => (
    <li key={d.id}>
      <button className={`deadline-row${d.id === openId ? " selected" : ""}`} onClick={() => select(d.id)}>
        <span className="deadline-when">{d.due ? formatDue(d, "short") : "TBC"}</span>
        <ModuleDot modules={modules} code={d.module} />
        <span className="deadline-title">
          {d.title} <small>{d.module} · {KIND_LABEL[d.kind]}</small>
        </span>
        {d.weight !== undefined && <span className="weight">{d.weight}%</span>}
        {d.status !== "confirmed" && <StatusPill status={d.status} />}
      </button>
    </li>
  );

  /* Month grid: Monday-first weeks covering the month. */
  const byDay = new Map<string, Deadline[]>();
  for (const d of dated) {
    const key = dayKey(dueDate(d)!);
    byDay.set(key, [...(byDay.get(key) || []), d]);
  }
  const firstCell = new Date(month);
  firstCell.setDate(1 - ((month.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = new Date(firstCell);
    day.setDate(firstCell.getDate() + i);
    return day;
  });
  const localKey = (day: Date) =>
    `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const todayKey = now ? localKey(new Date(now)) : "";
  const goToday = () => {
    const today = new Date();
    setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  };
  const shiftMonth = (by: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + by, 1));

  return (
    <div className="calendar-page">
      <header className="topbar">
        <button className="back-link" onClick={() => window.location.assign("/")}>← Study Hub</button>
        <div>
          <p className="eyebrow">This year</p>
          <h2>Calendar</h2>
        </div>
        {state === "ready" && (
          <div className="calendar-tools">
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={view === "month"} onClick={() => chooseView("month")}>Month</button>
              <button aria-pressed={view === "list"} onClick={() => chooseView("list")}>List</button>
            </div>
            <label className="visually-hidden" htmlFor="module-filter">Module</label>
            <select id="module-filter" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
              <option value="all">All modules</option>
              {codes.map((code) => {
                const folder = modules.find((m) => moduleCode(m) === code);
                return <option key={code} value={code}>{folder || code}</option>;
              })}
            </select>
            <label className="visually-hidden" htmlFor="kind-filter">Type</label>
            <select id="kind-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="all">All types</option>
              {kinds.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
            </select>
          </div>
        )}
      </header>

      {state === "loading" && <p className="calendar-message">Reading your deadlines…</p>}
      {state === "unhosted" && (
        <p className="calendar-message">The calendar shows the deadlines Study Hub fetched from your university. Open Study Hub from the desktop app to see it.</p>
      )}
      {state === "error" && (
        <p className="calendar-message">Study Hub could not read Deadlines.json. Quit Study Hub and open it again.</p>
      )}

      {state === "ready" && (
        <div className={`calendar-body${open ? " with-panel" : ""}`}>
          <main className="calendar-main">
            {deadlines.length === 0 && view === "list" && (
              <p className="calendar-message">No deadlines yet. They appear here after your modules sync.</p>
            )}

            {deadlines.length > 0 && view === "list" && (
              <>
                <section>
                  <h3 className="list-heading">Coming up</h3>
                  {upcoming.length ? <ul className="deadline-rows">{upcoming.map(row)}</ul> : <p className="quiet">Nothing coming up for this filter.</p>}
                </section>
                {tbc.length > 0 && (
                  <section>
                    <h3 className="list-heading">Date to be confirmed</h3>
                    <p className="quiet">The university has not published these dates yet. Exams usually appear late in the term.</p>
                    <ul className="deadline-rows">{tbc.map(row)}</ul>
                  </section>
                )}
                {past.length > 0 && (
                  <section>
                    <button className="text-link" aria-expanded={showPast} onClick={() => setShowPast((s) => !s)}>
                      {showPast ? "Hide" : "Show"} {past.length} past deadline{past.length === 1 ? "" : "s"}
                    </button>
                    {showPast && <ul className="deadline-rows past">{[...past].reverse().map(row)}</ul>}
                  </section>
                )}
              </>
            )}

            {view === "month" && (
              <section>
                <div className="month-head">
                  <h3>{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h3>
                  <div className="month-nav">
                    <button className="icon-button" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
                    <button className="today-button" onClick={goToday}>Today</button>
                    <button className="icon-button" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
                  </div>
                </div>
                <div className="month-grid" role="grid">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <div key={d} className="weekday" role="columnheader">{d}</div>
                  ))}
                  {cells.map((day) => {
                    const key = localKey(day);
                    const items = byDay.get(key) || [];
                    return (
                      <div
                        key={key}
                        role="gridcell"
                        className={`day${day.getMonth() === month.getMonth() ? "" : " other"}${key === todayKey ? " today" : ""}${day.getDay() === 0 || day.getDay() === 6 ? " weekend" : ""}`}
                      >
                        <span className="day-number">{day.getDate()}</span>
                        {items.map((d) => (
                          <button
                            key={d.id}
                            className={`chip chip-${d.status}${d.id === openId ? " selected" : ""}`}
                            onClick={() => select(d.id)}
                            title={`${d.title} · ${d.module}`}
                          >
                            <span className="chip-top">
                              <ModuleDot modules={modules} code={d.module} />
                              <b>{d.module}</b>
                              {!d.due!.allDay && (
                                <span className="chip-time">
                                  {dueDate(d)!.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}
                                </span>
                              )}
                            </span>
                            <span className="chip-title">{d.title}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
                {deadlines.length === 0 && (
                  <p className="quiet">No deadlines yet. They appear here after your modules sync.</p>
                )}
                {tbc.length > 0 && (
                  <div className="tbc-below">
                    <h3 className="list-heading">Date to be confirmed</h3>
                    <ul className="deadline-rows">{tbc.map(row)}</ul>
                  </div>
                )}
              </section>
            )}
          </main>
          {open && (
            <DeadlinePanel
              key={open.id}
              deadline={open}
              modules={modules}
              onClose={() => select("")}
              onResolved={(updated) => setDeadlines((all) => all.map((d) => (d.id === updated.id ? updated : d)))}
            />
          )}
        </div>
      )}
      {state === "ready" && <SyncSettings />}
    </div>
  );
}
