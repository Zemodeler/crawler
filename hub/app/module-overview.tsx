"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";

import { SUPPORTED_EXTS } from "../lib/course-format.ts";
import { moduleCode, moduleColor, rebuildPacks, type Deadline, type LibraryTree } from "../lib/library.ts";
import { chosenAssistant, watchSync } from "../lib/setup.ts";
import type { SubjectId } from "../lib/subject-profiles.ts";
import { formatDue, latestDate, placeDate } from "./calendar/deadline-ui.tsx";
import { LIBRARY_CHANGED_EVENT } from "./shell/AppShell.tsx";
import { SubjectControl, useModuleSubject } from "./subject-control.tsx";

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

/** "year/module" keys the student hid from the home page. */
const HIDDEN_KEY = "studyhub:hidden-modules";

function readHidden(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function writeHidden(keys: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(keys));
  } catch {
    /* hidden until the page is reloaded */
  }
}

/** A desktop-app action (`/api/setup/*`); the host refuses it in a plain browser. */
async function setupPost(path: string, payload: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "x-study-hub-host": "1", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Study Hub could not finish that (${response.status}).`);
}

const POPOVER_WIDTH = 320;

/** The cogwheel on a module card and the small dialog it opens. */
function ModuleSettings({
  tree,
  moduleKey,
  module,
  onHide,
  onSubjectSaved,
}: {
  tree: LibraryTree;
  moduleKey: string;
  module: string;
  onHide: () => void;
  onSubjectSaved?: (profile: SubjectId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [alignLeft, setAlignLeft] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) gearRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    // A click or focus anywhere else closes it; the gear and the dialog are "inside".
    const onOutside = (event: Event) => {
      if (!anchorRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open, close]);

  const toggle = () => {
    if (open) return close(false);
    // The leftmost cards would push a right-aligned dialog out of the page.
    const card = anchorRef.current?.parentElement?.getBoundingClientRect();
    setAlignLeft(Boolean(card) && card!.right - POPOVER_WIDTH < 16);
    setOpen(true);
  };

  return (
    <div className="module-settings-anchor" ref={anchorRef}>
      <button
        ref={gearRef}
        type="button"
        className="module-gear"
        aria-label={`Settings for ${module}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <SettingsPanel
          id={panelId}
          panelRef={panelRef}
          alignLeft={alignLeft}
          tree={tree}
          moduleKey={moduleKey}
          module={module}
          onHide={onHide}
          onSubjectSaved={onSubjectSaved}
        />
      )}
    </div>
  );
}

function SettingsPanel({
  id,
  panelRef,
  alignLeft,
  tree,
  moduleKey,
  module,
  onHide,
  onSubjectSaved,
}: {
  id: string;
  panelRef: RefObject<HTMLDivElement | null>;
  alignLeft: boolean;
  tree: LibraryTree;
  moduleKey: string;
  module: string;
  onHide: () => void;
  onSubjectSaved?: (profile: SubjectId) => void;
}) {
  const files = useMemo(() => {
    const prefix = `${moduleKey}/`;
    return tree.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length) }));
  }, [tree, moduleKey]);
  const subject = useModuleSubject(moduleKey, files, module);
  const [busy, setBusy] = useState<"sync" | "packs" | "folder" | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const say = (text: string, error = false) => {
    if (alive.current) setNote({ text, error });
  };

  /** Syncs only this module's folder; the page refreshes itself when the sync is done. */
  const resync = async () => {
    setBusy("sync");
    say("Starting the sync…");
    try {
      await setupPost("/api/setup/sync", { module: moduleKey, assistant: chosenAssistant() });
    } catch (error) {
      say((error as Error).message, true);
      if (alive.current) setBusy(null);
      return;
    }
    watchSync((run) => {
      if (run.state === "running") say(`Syncing… ${run.newFiles} new ${run.newFiles === 1 ? "file" : "files"} so far.`);
      else if (run.state === "done") {
        say(`Synced. ${run.newFiles} new ${run.newFiles === 1 ? "file" : "files"}.`);
        if (alive.current) setBusy(null);
        window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
      } else if (run.state === "failed") {
        say(run.error || "The sync did not finish.", true);
        if (alive.current) setBusy(null);
      }
    });
  };

  const regenerate = async () => {
    setBusy("packs");
    try {
      await rebuildPacks(moduleKey);
      say("Rebuilding the study pack in the background. This can take several minutes.");
    } catch (error) {
      say((error as Error).message, true);
    }
    if (alive.current) setBusy(null);
  };

  const openFolder = async () => {
    setBusy("folder");
    try {
      await setupPost("/api/setup/module/open", { module: moduleKey });
      say("Opened the folder.");
    } catch (error) {
      say((error as Error).message, true);
    }
    if (alive.current) setBusy(null);
  };

  return (
    <div
      id={id}
      ref={panelRef}
      className={`module-settings${alignLeft ? " align-left" : ""}`}
      role="dialog"
      aria-label={`Settings for ${module}`}
      tabIndex={-1}
    >
      <p className="eyebrow">{moduleCode(module)} settings</p>
      <SubjectControl target={moduleKey} subject={subject} onSaved={onSubjectSaved} />
      <div className="module-settings-actions">
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={resync}>
          Resync this module
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={regenerate}>
          Regenerate study pack
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={openFolder}>
          Open module folder
        </button>
        <button type="button" className="btn btn-ghost" onClick={onHide}>
          Hide module from home
        </button>
      </div>
      {note && (
        <p className={`module-settings-note${note.error ? " error" : ""}`} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
    </div>
  );
}

/** Every module of the year side by side; the open one is marked. */
export default function ModuleOverview({
  tree,
  year,
  activeKey,
  activeOpened,
  deadlines,
  onOpen,
  onSubjectSaved,
}: {
  tree: LibraryTree;
  year: string;
  activeKey: string;
  activeOpened: Record<string, number>;
  deadlines: Deadline[];
  onOpen: (module: string) => void;
  /** A subject saved from a card's settings, so the open module can follow it. */
  onSubjectSaved?: (moduleKey: string, profile: SubjectId) => void;
}) {
  const modules = tree.years.find((y) => y.year === year)?.modules || [];
  const all = tree.years.flatMap((y) => y.modules);
  const [now, setNow] = useState(0);
  useEffect(() => queueMicrotask(() => setNow(Date.now())), []);
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => queueMicrotask(() => setHidden(readHidden())), []);
  if (modules.length < 1) return null;

  const hide = (key: string) => {
    const next = [...new Set([...hidden, key])];
    setHidden(next);
    writeHidden(next);
  };
  const showAll = () => {
    const next = hidden.filter((key) => !modules.some((m) => `${year}/${m}` === key));
    setHidden(next);
    writeHidden(next);
  };
  const hiddenCount = modules.filter((m) => hidden.includes(`${year}/${m}`)).length;

  return (
    <section className="module-overview" aria-labelledby="module-overview-title">
      <div className="section-title">
        <div>
          <p className="eyebrow">{year}</p>
          <h3 id="module-overview-title">Your modules</h3>
        </div>
        {hiddenCount > 0 && (
          <button type="button" onClick={showAll}>
            Show {hiddenCount} hidden {hiddenCount === 1 ? "module" : "modules"}
          </button>
        )}
      </div>
      <div className="module-cards">
        {modules.filter((m) => !hidden.includes(`${year}/${m}`)).map((m) => {
          const key = `${year}/${m}`;
          const active = key === activeKey;
          const stats = statsFor(tree, key, active ? activeOpened : undefined);
          const percent = stats.files ? Math.round((stats.opened / stats.files) * 100) : 0;
          const next = deadlines
            .filter((d) => {
              const t = latestDate(d)?.getTime();
              return d.module === moduleCode(m) && d.status !== "cancelled" && t !== undefined && t >= now;
            })
            .sort((a, b) => placeDate(a)!.getTime() - placeDate(b)!.getTime())[0];
          const [code, ...rest] = m.split(" - ");
          return (
            // The gear is a sibling of the card: a button cannot hold another button.
            <div key={m} className="module-card-wrap">
              <button
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
              <ModuleSettings
                tree={tree}
                moduleKey={key}
                module={m}
                onHide={() => hide(key)}
                onSubjectSaved={(profile) => onSubjectSaved?.(key, profile)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
