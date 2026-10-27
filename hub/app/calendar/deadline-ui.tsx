"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";

import { teachingWeekAt, type TeachingWeek } from "crawler/weeks";

import {
  libraryUrl,
  moduleCode,
  moduleColor,
  resolveDeadline,
  type Deadline,
  type DeadlineSource,
  type DeadlineStatus,
} from "../../lib/library.ts";

const TZ = "Europe/London";

export const STATUS_LABEL: Record<DeadlineStatus, string> = {
  confirmed: "Confirmed",
  "user-verified": "Checked by you",
  "needs-check": "Needs check",
  conflict: "Dates disagree",
  tbc: "Date TBC",
  cancelled: "Cancelled",
};

export const KIND_LABEL: Record<Deadline["kind"], string> = {
  coursework: "Coursework",
  exam: "Exam",
  quiz: "Quiz",
  presentation: "Presentation",
  lab: "Lab",
  other: "Other",
};

/** Statuses the student should look at: the date may be wrong or missing. */
export const needsAttention = (d: Deadline) =>
  d.status === "conflict" || d.status === "needs-check" || (d.status === "tbc" && !weekOnly(d));

export function dueDate(d: Deadline): Date | null {
  return d.due ? new Date(d.due.iso) : null;
}

/** Due some day in a known week ("week 11"), the day not stated. */
export const weekOnly = (d: Deadline) => d.due === null && d.window !== undefined;

/** Where it sits in time: the due date, else the first day of its week. */
export function placeDate(d: Deadline): Date | null {
  return dueDate(d) ?? (d.window ? new Date(d.window.from.iso) : null);
}

/** The last moment it can be due: the due date, else the end of its week. */
export function latestDate(d: Deadline): Date | null {
  return dueDate(d) ?? (d.window ? new Date(new Date(d.window.to.iso).getTime() + 24 * 60 * 60 * 1000 - 1) : null);
}

/** `2026-10-20` in London, for grouping by calendar day. */
export function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function formatDue(d: Deadline, style: "short" | "long" = "long"): string {
  if (weekOnly(d)) {
    const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }).format(new Date(iso));
    const from = fmt(d.window!.from.iso, { day: "numeric", month: "short" });
    if (style === "short") return `w/c ${from}`;
    return `Week of ${fmt(d.window!.from.iso, { weekday: "short", day: "numeric", month: "short" })} – ${fmt(d.window!.to.iso, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} (day not stated)`;
  }
  const date = dueDate(d);
  if (!date) return "Date to be confirmed";
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(style === "long" ? { year: "numeric" } : {}),
  }).format(date);
  if (d.due!.allDay) return day;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day}, ${time}`;
}

export function StatusPill({ status, deadline }: { status: DeadlineStatus; deadline?: Deadline }) {
  if (deadline && weekOnly(deadline)) return <span className="status-pill status-week">Day not stated</span>;
  return <span className={`status-pill status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ModuleDot({ modules, code }: { modules: string[]; code: string }) {
  const folder = modules.find((m) => moduleCode(m) === code) || code;
  return <span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />;
}

/**
 * The teaching week `at` falls in. Deadline ids start with the university they
 * came from ("qmul:…"), which picks the term calendar.
 */
export function teachingWeek(deadlines: Deadline[], at: Date | number): TeachingWeek | null {
  for (const university of new Set(deadlines.map((d) => d.id.split(":")[0]))) {
    const week = teachingWeekAt(university, at);
    if (week) return week;
  }
  return null;
}

/** "Teaching week 4 · Semester A". */
export const weekLabel = (week: TeachingWeek) => `Teaching week ${week.week} · ${week.term.replace(/^\S+\s+/, "")}`;

/** Overview tile: what is due in the next week across this year's modules. */
export function NextSevenDays({
  deadlines,
  modules,
  yearModules,
}: {
  deadlines: Deadline[];
  modules: string[];
  yearModules: string[];
}) {
  const codes = new Set(yearModules.map(moduleCode));
  // Read the clock after mount, never during render.
  const [now, setNow] = useState(0);
  useEffect(() => queueMicrotask(() => setNow(Date.now())), []);
  // Today plus the next 7 whole days.
  const week = new Date(now).setHours(0, 0, 0, 0) + 8 * 24 * 60 * 60 * 1000;
  const soon = deadlines
    .filter((d) => codes.has(d.module) && d.status !== "cancelled")
    .filter((d) => {
      const start = placeDate(d)?.getTime();
      const end = latestDate(d)?.getTime();
      return start !== undefined && end !== undefined && end >= now && start <= week;
    })
    .sort((a, b) => placeDate(a)!.getTime() - placeDate(b)!.getTime());
  const unsure = deadlines.filter((d) => codes.has(d.module) && needsAttention(d)).length;
  const thisWeek = now ? teachingWeek(deadlines, now) : null;

  return (
    <section className="panel next-week">
      <div className="section-title">
        <div>
          <p className="eyebrow">Deadlines{thisWeek ? ` · ${weekLabel(thisWeek)}` : ""}</p>
          <h3>Next 7 days</h3>
        </div>
        <a className="text-link" href="/calendar">Open calendar →</a>
      </div>
      {soon.length ? (
        <ul className="deadline-rows">
          {soon.map((d) => (
            <li key={d.id}>
              <a href={`/calendar#${encodeURIComponent(d.id)}`} className="deadline-row">
                <span className="deadline-when">{formatDue(d, "short")}</span>
                <ModuleDot modules={modules} code={d.module} />
                <span className="deadline-title">
                  {d.title} <small>{d.module}</small>
                </span>
                {d.status !== "confirmed" && <StatusPill status={d.status} deadline={d} />}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">Nothing due in the next 7 days.</p>
      )}
      {unsure > 0 && (
        <p className="quiet">
          {unsure} deadline{unsure === 1 ? "" : "s"} need{unsure === 1 ? "s" : ""} a check.{" "}
          <a className="text-link" href="/calendar">Review in the calendar</a>
        </p>
      )}
    </section>
  );
}

function sourceLabel(source: DeadlineSource): string {
  if (source.localPath) {
    const name = source.localPath.split("/").pop();
    return source.page ? `${name}, page ${source.page}` : name || "Document";
  }
  return { "vle-field": "QMplus deadline field", page: "QMplus page", announcement: "Announcement", document: "Document" }[
    source.type
  ];
}

function openSource(source: DeadlineSource) {
  const target = source.localPath
    ? `${libraryUrl(source.localPath)}${source.page ? `#page=${source.page}` : ""}`
    : source.url;
  window.open(target, "_blank", "noopener,noreferrer");
}

/** `YYYY-MM-DD` and `HH:MM` of the due date in London wall time; empty for TBC or week-only. */
function londonParts(d: Deadline): { date: string; time: string } {
  if (!d.due) return { date: "", time: "" };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(d.due.iso))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: d.due.allDay ? "" : `${parts.hour}:${parts.minute}` };
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * The cogwheel beside a deadline and the inline editor it opens. Renders the
 * button and, when open, the editor as siblings so the parent can lay them out
 * (the editor wraps onto its own line).
 */
export function ChangeDate({ deadline, onResolved }: { deadline: Deadline; onResolved: (updated: Deadline) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cog = useRef<HTMLButtonElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    dateInput.current?.focus();
    const form = dateInput.current?.form;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      setError("");
      cog.current?.focus();
    };
    form?.addEventListener("keydown", onKey);
    return () => form?.removeEventListener("keydown", onKey);
  }, [open]);
  const id = `change-${deadline.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const close = () => {
    setOpen(false);
    setError("");
    cog.current?.focus();
  };
  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (open) return close();
    const current = londonParts(deadline);
    setDate(current.date);
    setTime(current.time);
    setError("");
    setOpen(true);
  };
  const save = async () => {
    if (!date) return;
    setBusy(true);
    setError("");
    try {
      const updated = await resolveDeadline(deadline.id, { date: time ? `${date}T${time}` : date });
      setOpen(false);
      onResolved(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={cog}
        type="button"
        className="btn btn-ghost cog-button"
        aria-label={`Change date of ${deadline.title}`}
        title="Change date"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
      >
        <GearIcon />
      </button>
      {open && (
        <form
          id={id}
          className="change-date"
          aria-label={`Change date of ${deadline.title}`}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="change-date-fields">
            <label>
              Date
              <input type="date" value={date} ref={dateInput} required onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              Time <small>(optional)</small>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
          <p className="quiet">Your date is kept: later syncs will not change it.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="change-date-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !date}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/** The side panel: every source with its quote, and settling a doubtful date. */
export function DeadlinePanel({
  deadline,
  modules,
  onClose,
  onResolved,
}: {
  deadline: Deadline;
  modules: string[];
  onClose: () => void;
  onResolved: (updated: Deadline) => void;
}) {
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canResolve = needsAttention(deadline);
  const folder = modules.find((m) => moduleCode(m) === deadline.module);

  const resolve = async (choice: { sourceIndex: number } | { date: string }) => {
    setBusy(true);
    setError("");
    try {
      onResolved(await resolveDeadline(deadline.id, choice));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="deadline-panel" aria-label={`${deadline.title} details`}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">
            <ModuleDot modules={modules} code={deadline.module} /> {folder || deadline.module}
          </p>
          <h2>{deadline.title}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      <dl className="facts">
        <div>
          <dt>Due</dt>
          <dd className="due-with-cog">
            <span>{formatDue(deadline)}</span>
            <ChangeDate deadline={deadline} onResolved={onResolved} />
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusPill status={deadline.status} deadline={deadline} />
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>
            {KIND_LABEL[deadline.kind]}
            {deadline.formative ? " (formative)" : ""}
          </dd>
        </div>
        {deadline.weight !== undefined && (
          <div>
            <dt>Weight</dt>
            <dd>{deadline.weight}% of the module</dd>
          </div>
        )}
      </dl>
      {deadline.checkReason && <p className="check-reason">{deadline.checkReason}</p>}

      <h3>{deadline.sources.length === 1 ? "Source" : `${deadline.sources.length} sources`}</h3>
      <ol className="sources">
        {deadline.sources.map((source, index) => (
          <li key={index}>
            <blockquote>{source.quote}</blockquote>
            <div className="source-meta">
              <span>{sourceLabel(source)}</span>
              {source.date && (
                <span>
                  says <b>{formatDue({ ...deadline, due: source.date })}</b>
                </span>
              )}
            </div>
            <div className="source-actions">
              <button className="secondary small" onClick={() => openSource(source)}>
                Open source
              </button>
              {canResolve && source.date && (
                <button className="primary small" disabled={busy} onClick={() => resolve({ sourceIndex: index })}>
                  Use this date
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {canResolve && (
        <form
          className="enter-date"
          onSubmit={(e) => {
            e.preventDefault();
            if (date) resolve({ date });
          }}
        >
          <label htmlFor="deadline-date">Know the right date? Enter it</label>
          <div>
            <input id="deadline-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="primary small" type="submit" disabled={busy || !date}>
              Save date
            </button>
          </div>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {deadline.submitUrl && (
        <a className="text-link" href={deadline.submitUrl} target="_blank" rel="noreferrer">
          Open the submission page →
        </a>
      )}
    </aside>
  );
}
