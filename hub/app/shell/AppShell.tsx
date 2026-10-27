"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- full page loads on purpose: client navigation back to "/" does not re-render the hub, and "/" handles its own links in place. */

/**
 * The one frame every page sits in: a navigation rail on the left (modules,
 * Today, Calendar, Assessments, Flashcards, sync, AI settings) and the page
 * beside it. First-run setup and the hidden /auto window get no rail, and a
 * page can drop it for a full-screen state with <ShellOff />.
 *
 * On "/" the rail navigates in place (history + NAVIGATE_EVENT) so the open
 * module is not reloaded; everywhere else its links are plain page loads.
 */

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { isHosted } from "../../lib/ai/settings.ts";
import {
  ACTIVE_MODULE_EVENT,
  currentAcademicYear,
  fetchTree,
  moduleColor,
  pickModule,
  saveActiveModule,
  type LibraryTree,
} from "../../lib/library.ts";
import SyncButton from "../sync-button.tsx";

/** Fired on `window` after the rail changed the URL of "/" in place. */
export const NAVIGATE_EVENT = "studyhub:navigate";
/** Fired on `window` after a sync finished, so pages re-read the library. */
export const LIBRARY_CHANGED_EVENT = "studyhub:library-changed";
/** Fired on `window` with `true`/`false` to open or close the study assistant. */
export const CHAT_TOGGLE_EVENT = "studyhub:chat-toggle";
/** Fired by the study assistant with its open state. */
export const CHAT_STATE_EVENT = "studyhub:chat-state";

const NO_SHELL = ["/welcome", "/auto"];
export type HomeView = "today" | "overview" | "reader" | "files";

/** The view "/" should show, from its URL. */
export function homeView(search: string, hosted: boolean): HomeView {
  const view = new URLSearchParams(search).get("view");
  if (view === "overview" || view === "reader" || view === "files") return view;
  return hosted ? "today" : "overview";
}

/** Points "/" at `view` without a reload, when already on "/". */
export function navigateHome(view: HomeView) {
  const url = view === "today" ? "/" : `/?view=${view}`;
  if (window.location.pathname !== "/") return window.location.assign(url);
  if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: view }));
}

/** Renders nothing; while mounted, the page has no rail (first-run and error screens). */
export function ShellOff() {
  useEffect(() => {
    document.body.classList.add("shell-off");
    return () => document.body.classList.remove("shell-off");
  }, []);
  return null;
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const bare = NO_SHELL.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (bare) return <>{children}</>;
  return (
    <div className="shell">
      <Rail pathname={pathname} />
      <div className="shell-main">{children}</div>
    </div>
  );
}

function Rail({ pathname }: { pathname: string }) {
  const [hosted, setHosted] = useState(false);
  const [tree, setTree] = useState<LibraryTree | null>(null);
  const [active, setActive] = useState("");
  const [search, setSearch] = useState("");
  const [pastOpen, setPastOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    const host = isHosted();
    queueMicrotask(() => {
      setHosted(host);
      setSearch(window.location.search);
    });
    if (host)
      fetchTree()
        .then((t) => {
          setTree(t);
          const picked = pickModule(t);
          if (picked) setActive(`${picked.year}/${picked.module}`);
        })
        .catch(() => {});
    const onModule = (event: Event) => setActive((event as CustomEvent<string>).detail);
    const onUrl = () => setSearch(window.location.search);
    const onChat = (event: Event) => setChatOpen(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(ACTIVE_MODULE_EVENT, onModule);
    window.addEventListener(NAVIGATE_EVENT, onUrl);
    window.addEventListener("popstate", onUrl);
    window.addEventListener(CHAT_STATE_EVENT, onChat);
    return () => {
      window.removeEventListener(ACTIVE_MODULE_EVENT, onModule);
      window.removeEventListener(NAVIGATE_EVENT, onUrl);
      window.removeEventListener("popstate", onUrl);
      window.removeEventListener(CHAT_STATE_EVENT, onChat);
    };
  }, []);

  const onHome = pathname === "/";
  const view = homeView(search, hosted);
  const allModules = tree?.years.flatMap((y) => y.modules) || [];
  const thisYear = tree?.years.find((y) => y.year === currentAcademicYear()) ? currentAcademicYear() : tree?.years[0]?.year;
  const years = tree?.years.filter((y) => y.modules.length && (y.year === thisYear || pastOpen)) || [];
  const hasPast = Boolean(tree?.years.some((y) => y.year !== thisYear && y.modules.length));

  /** On "/" switch view in place; elsewhere let the link load the page. */
  const go = (target: HomeView) => (event: MouseEvent) => {
    if (!onHome) return;
    event.preventDefault();
    navigateHome(target);
  };
  const openModule = (key: string) => (event: MouseEvent) => {
    event.preventDefault();
    saveActiveModule(key);
    navigateHome("overview");
  };
  const current = (on: boolean) => (on ? { "aria-current": "page" as const } : {});

  return (
    <nav className="rail" aria-label="Study Hub">
      <a className="rail-brand" href="/" onClick={go(hosted ? "today" : "overview")}>
        <span className="brand-mark" aria-hidden="true">SH</span>
        <span>Study Hub</span>
      </a>

      <div className="rail-group">
        {hosted && (
          <a className="rail-link" href="/" onClick={go("today")} {...current(onHome && view === "today")}>
            Today
          </a>
        )}
        {!hosted && (
          <a className="rail-link" href="/?view=overview" onClick={go("overview")} {...current(onHome && view === "overview")}>
            Course
          </a>
        )}
        {tree && (
          <>
            <a className="rail-link" href="/calendar" {...current(pathname === "/calendar")}>Calendar</a>
            <a className="rail-link" href="/assessments" {...current(pathname === "/assessments")}>Assessments</a>
          </>
        )}
        <a className="rail-link" href="/flashcards?mode=smart" {...current(pathname === "/flashcards")}>Flashcards</a>
      </div>

      {tree && years.length > 0 && (
        <div className="rail-group rail-modules">
          {years.map((y) => (
            <div key={y.year} className="rail-year">
              <p className="rail-label">{y.year === thisYear ? "Modules" : y.year}</p>
              {y.modules.map((m) => {
                const key = `${y.year}/${m}`;
                const isActive = key === active;
                const [code, ...rest] = m.split(" - ");
                return (
                  <div key={key} className={`rail-module${isActive ? " active" : ""}`}>
                    <a
                      className="rail-link"
                      href="/?view=overview"
                      title={m}
                      onClick={openModule(key)}
                      {...current(onHome && isActive && view !== "today")}
                    >
                      <span className="module-dot" style={{ background: moduleColor(allModules, m) }} aria-hidden="true" />
                      <span className="rail-module-text">
                        <b>{code}</b>
                        <span>{rest.join(" - ") || m}</span>
                      </span>
                    </a>
                    {isActive && onHome && view !== "today" && (
                      <div className="rail-sub">
                        <a href="/?view=overview" onClick={go("overview")} {...current(view === "overview")}>Overview</a>
                        <a href="/?view=reader" onClick={go("reader")} {...current(view === "reader")}>Read</a>
                        <a href="/?view=files" onClick={go("files")} {...current(view === "files")}>Files</a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {hasPast && (
            <button className="rail-quiet" aria-expanded={pastOpen} onClick={() => setPastOpen((o) => !o)}>
              {pastOpen ? "Hide past years" : "Past years"}
            </button>
          )}
        </div>
      )}

      <div className="rail-foot">
        {hosted && (
          <button
            className="rail-link rail-chat"
            aria-pressed={chatOpen}
            onClick={() => window.dispatchEvent(new CustomEvent(CHAT_TOGGLE_EVENT, { detail: !chatOpen }))}
          >
            Ask the assistant
          </button>
        )}
        <a className="rail-link" href="/connect" {...current(pathname === "/connect")}>AI settings</a>
        {hosted && (
          <SyncButton
            onSynced={() => {
              fetchTree().then(setTree).catch(() => {});
              window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
            }}
          />
        )}
        <p className="rail-privacy">
          <span className="privacy-dot" aria-hidden="true" />
          Files stay on this computer
        </p>
      </div>
    </nav>
  );
}
