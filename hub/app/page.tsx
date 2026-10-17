"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { SubjectControl, useModuleSubject } from "./subject-control.tsx";
import ChatPanel from "./chat/ChatPanel.tsx";
import { FormatCheckBanner, FormatCheckDialog } from "./format-check-dialog.tsx";
import { Markdown } from "./markdown.tsx";
import { hasAnyConnection, isHosted } from "../lib/ai/settings.ts";
import {
  currentAcademicYear,
  fetchDeadlines,
  fetchTree,
  getModuleProfile,
  loadModule,
  migrateModuleKeys,
  moduleColor,
  pickModule,
  saveActiveModule,
  suggestModuleProfile,
  type Deadline,
  type LibraryTree,
} from "../lib/library.ts";
import { NextSevenDays } from "./calendar/deadline-ui.tsx";
import SyncButton from "./sync-button.tsx";
import ModuleOverview from "./module-overview.tsx";
import {
  SUPPORTED_EXTS,
  TEXT_EXTS,
  canonicalTopicKey,
  inferCategory,
  parseCSV,
  resolveCourseLink,
  stableCardId,
  topicLabel,
  validateCourse,
} from "../lib/course-format.ts";
import { getProfile, type SubjectProfile } from "../lib/subject-profiles.ts";
import {
  collectDirectory,
  loadHandles,
  readManifest,
  saveHandle,
  type DirectoryHandle,
  type LocalFile,
  type Manifest,
} from "../lib/course-fs.ts";

type Card = {
  id: string;
  question: string;
  answer: string;
  deck: string;
  /** The canonical join key — always group on this. */
  topic: string;
  /** The raw on-disk label — always display this. */
  topicLabel: string;
};
type FlashcardReview = { confidence: Confidence };
type FlashcardStats = { reviews?: Record<string, FlashcardReview> };
type Confidence = 1 | 2 | 3 | 4 | 5;
type LegacyRating = "again" | "hard" | "good" | "easy";
type CardRecord = {
  confidence: Confidence;
  reviews: number;
  due: number;
  updated: number;
};
type CourseProgress = {
  cards: Record<string, CardRecord>;
  checks: Record<string, boolean>;
  recent: string[];
  opened: Record<string, number>;
  selected?: string;
};

const EMPTY_PROGRESS: CourseProgress = {
  cards: {},
  checks: {},
  recent: [],
  opened: {},
};

function migrateProgress(raw: unknown): CourseProgress {
  if (!raw || typeof raw !== "object") return { ...EMPTY_PROGRESS };
  const old = raw as Partial<CourseProgress> & {
    cards?: Record<string, CardRecord & { rating?: LegacyRating }>;
  };
  const legacyMap: Record<LegacyRating, Confidence> = {
    again: 1,
    hard: 2,
    good: 4,
    easy: 5,
  };
  const cards = Object.fromEntries(
    Object.entries(old.cards || {}).map(([id, record]) => [
      id,
      {
        confidence:
          record.confidence || (record.rating ? legacyMap[record.rating] : 3),
        reviews: record.reviews || 0,
        due: record.due || 0,
        updated: record.updated || 0,
      },
    ]),
  );
  return {
    cards,
    checks: old.checks || {},
    recent: old.recent || [],
    opened: old.opened || {},
    selected: old.selected,
  };
}

/** Kept as a thin wrapper over the shared report so behaviour cannot drift. */
function isFormattedCourse(files: LocalFile[], profile: SubjectProfile) {
  return validateCourse(files, {}, profile).legacyGate;
}
export default function Home() {
  const [course, setCourse] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [view, setView] = useState<"dashboard" | "reader" | "files">(
    "dashboard",
  );
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<CourseProgress>(EMPTY_PROGRESS);
  const [notice, setNotice] = useState("");
  const [remembered, setRemembered] = useState<DirectoryHandle[]>([]);
  const [flashcardReviews, setFlashcardReviews] = useState<
    Record<string, FlashcardReview>
  >({});
  /** "modal" only after an explicit pick; a silent auto-restore never interrupts. */
  const [formatPrompt, setFormatPrompt] = useState<"none" | "banner" | "modal">(
    "none",
  );
  const [aiReady, setAiReady] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const fallbackRef = useRef<HTMLInputElement>(null);
  /** Set when the desktop app serves My Studies; null for a picked folder. */
  const [library, setLibrary] = useState<LibraryTree | null>(null);
  const [libraryState, setLibraryState] = useState<"off" | "loading" | "empty" | "ready" | "error">("off");
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [pastOpen, setPastOpen] = useState(false);

  const [subjectTarget, setSubjectTarget] = useState<string | DirectoryHandle | null>(null);
  const subject = useModuleSubject(subjectTarget, files, course);
  const profile = subject.profile;
  const report = useMemo(() => subject.choice ? validateCourse(files, {
    courseName: course,
    manifestPresent: Boolean(manifest),
  }, profile) : null, [files, course, manifest, profile, subject.choice]);

  const openModule = async (tree: LibraryTree, year: string, module: string) => {
    const key = `${year}/${module}`;
    migrateModuleKeys(key);
    saveActiveModule(key);
    setQuery("");
    // Synced modules start as plain VLE folders, so the format check would fire
    // on every one; under the library it only ever offers itself as a banner.
    await loadCourse(key, await loadModule(tree, year, module), undefined, "restore");
  };

  const loadCourse = async (
    name: string,
    imported: LocalFile[],
    handle?: DirectoryHandle,
    trigger: "explicit" | "restore" = "explicit",
  ) => {
    const target = handle ?? (isHosted() ? name : null);
    setSubjectTarget(target);
    setCourse(name);
    setFiles(
      imported.sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true }),
      ),
    );
    const saved = localStorage.getItem(`studyhub:${name}`);
    const restored = migrateProgress(saved ? JSON.parse(saved) : null);
    setProgress(restored);
    const start =
      imported.find((f) => /start here|revision hub/i.test(f.name)) ||
      imported.find((f) => /index/i.test(f.name)) ||
      imported.find((f) => f.ext === "md");
    setSelected(
      restored.selected && imported.some((f) => f.path === restored.selected)
        ? restored.selected
        : start?.path || "",
    );
    const savedView = localStorage.getItem(`studyhub:view:${name}`);
    setView(
      savedView === "reader" || savedView === "files"
        ? savedView
        : "dashboard",
    );
    setNotice(`${imported.length} study files found. Nothing was uploaded.`);
    if (handle) {
      await saveHandle(handle);
      setRemembered((items) => [
        handle,
        ...items.filter((item) => item.name !== handle.name),
      ]);
    }

    // Check the format. Pure and fast, so it runs on every open.
    const [manifest, choice] = await Promise.all([
      handle ? readManifest(handle) : null,
      target ? getModuleProfile(target, imported) : suggestModuleProfile(name, imported),
    ]);
    setManifest(manifest);
    const fresh = validateCourse(imported, {
      courseName: name,
      manifestPresent: Boolean(manifest),
    }, getProfile(choice.profile));
    if (fresh.level === "valid") {
      setFormatPrompt("none");
      return;
    }
    // Offer once per materially-different folder, so it never nags.
    const dismissed = localStorage.getItem(`studyhub:formatcheck:${name}`);
    if (dismissed === fresh.hash) setFormatPrompt("none");
    else setFormatPrompt(trigger === "explicit" ? "modal" : "banner");
  };

  const dismissFormatPrompt = () => {
    if (report && course)
      localStorage.setItem(`studyhub:formatcheck:${course}`, report.hash);
    setFormatPrompt("none");
  };

  useEffect(() => {
    hasAnyConnection().then(setAiReady).catch(() => setAiReady(false));
    if (isHosted()) {
      // The desktop app: My Studies opens by itself, no picker.
      queueMicrotask(() => setLibraryState("loading"));
      fetchDeadlines().then(setDeadlines).catch(() => {});
      fetchTree()
        .then(async (tree) => {
          setLibrary(tree);
          const picked = pickModule(tree);
          if (!picked) {
            // Nothing synced yet: first launch. A plain `node host` cannot sign in, so it stays here.
            const canSetUp = await fetch("/api/setup/status", { headers: { "x-study-hub-host": "1" } }).then((r) => r.ok).catch(() => false);
            if (canSetUp) return window.location.assign("/welcome");
            return setLibraryState("empty");
          }
          await openModule(tree, picked.year, picked.module);
          setLibraryState("ready");
        })
        .catch(() => setLibraryState("error"));
      return;
    }
    loadHandles()
      .then(async ({ active, handles }) => {
        setRemembered(handles);
        const h = handles.find((item) => item.name === active);
        if (!h) return;
        const permission = await h.queryPermission?.({ mode: "read" });
        if (permission === "granted")
          loadCourse(h.name, await collectDirectory(h), h, "restore");
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (course)
      localStorage.setItem(`studyhub:${course}`, JSON.stringify(progress));
  }, [progress, course]);
  useEffect(() => {
    if (course) localStorage.setItem(`studyhub:view:${course}`, view);
  }, [course, view]);
  useEffect(() => {
    if (!course) return;
    const refresh = () => {
      try {
        const saved = localStorage.getItem(`studyhub:flashcards:${course}`);
        const parsed = saved ? (JSON.parse(saved) as FlashcardStats) : {};
        setFlashcardReviews(parsed.reviews || {});
      } catch {
        setFlashcardReviews({});
      }
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [course]);

  const cards = useMemo<Card[]>(
    () =>
      files
        .filter((f) => f.ext === "csv" && f.text)
        .flatMap((f) => {
          const rows = parseCSV(f.text!);
          const headers = rows[0]?.map((h) =>
            h
              .replace(/^\uFEFF/, "")
              .trim()
              .toLowerCase(),
          );
          const qi = headers?.indexOf("question"),
            ai = headers?.indexOf("answer");
          if (qi < 0 || ai < 0) return [];
          return rows
            .slice(1)
            .filter((r) => r[qi]?.trim() && r[ai]?.trim())
            .map((r, i) => ({
              id: stableCardId(f.path, i, r[qi].trim()),
              question: r[qi].trim(),
              answer: r[ai].trim(),
              deck: f.name.replace(/\.csv$/i, ""),
              // Grouped by the canonical key, displayed by the raw label. This is
              // what lets a pack spelled "Offer & Acceptance" find its deck folder
              // spelled "Offer and Acceptance".
              topic: canonicalTopicKey(f.path),
              topicLabel: f.topic,
            }));
        }),
    [files],
  );

  const reviewed = Object.keys(flashcardReviews).length;
  const weak = Object.values(flashcardReviews).filter(
    (r) => r.confidence <= 2,
  ).length;
  const markdownFiles = files.filter((f) => f.ext === "md");
  // De-duplicated on the canonical key so "&" and "and" spellings of the same
  // topic collapse into one entry instead of listing twice.
  const topics = Array.from(
    new Map(
      files
        .filter((f) => f.category === "Study packs" || f.ext === "csv")
        .map((f) => [canonicalTopicKey(f.path), f.topic] as const),
    ).values(),
  );
  const packs = files.filter(
    (f) => f.category === "Study packs" && f.ext === "md",
  );
  const packProgress = (pack: LocalFile) => {
    const parts: number[] = [progress.opened[pack.path] ? 100 : 0];
    const checkKeys = Object.keys(progress.checks).filter((k) =>
      k.startsWith(`${pack.path}:`),
    );
    const sourceChecks = (pack.text?.match(/^\s*[-*]\s+\[[ xX]\]/gm) || [])
      .length;
    if (sourceChecks)
      parts.push(
        Math.round(
          (checkKeys.filter((k) => progress.checks[k]).length / sourceChecks) *
            100,
        ),
      );
    const packKey = canonicalTopicKey(pack.path);
    const topicCards = cards.filter((c) => c.topic === packKey);
    if (topicCards.length)
      parts.push(
        Math.round(
          (topicCards.filter((c) => flashcardReviews[c.id]).length /
            topicCards.length) *
            100,
        ),
      );
    return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  };
  const overallPackProgress = packs.length
    ? Math.round(
        packs.reduce((sum, pack) => sum + packProgress(pack), 0) / packs.length,
      )
    : 0;

  const chooseFolder = async () => {
    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: (opts: {
            mode: "read";
          }) => Promise<DirectoryHandle>;
        }
      ).showDirectoryPicker;
      if (!picker) {
        fallbackRef.current?.click();
        return;
      }
      const handle = await picker({ mode: "read" });
      await loadCourse(handle.name, await collectDirectory(handle), handle);
    } catch (e) {
      if ((e as DOMException).name !== "AbortError")
        setNotice("Chrome could not read that folder. Please choose it again.");
    }
  };

  const restoreFolder = async (handle: DirectoryHandle) => {
    const p = await handle.requestPermission?.({ mode: "read" });
    if (p === "granted")
      loadCourse(handle.name, await collectDirectory(handle), handle);
  };
  const fallbackImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    const root = list[0].webkitRelativePath.split("/")[0] || "Imported course";
    const imported = await Promise.all(
      list
        .filter((file) =>
          SUPPORTED_EXTS.has(file.name.split(".").pop()?.toLowerCase() || ""),
        )
        .map(async (file) => {
          const path = file.webkitRelativePath.replace(`${root}/`, "");
          const ext = file.name.split(".").pop()?.toLowerCase() || "";
          return {
            path,
            name: file.name,
            ext,
            file,
            text: TEXT_EXTS.has(ext) ? await file.text() : undefined,
            category: inferCategory(path, ext),
            topic: topicLabel(path),
          } as LocalFile;
        }),
    );
    await loadCourse(root, imported);
  };

  const openFile = (path: string) => {
    const f = files.find((x) => x.path.toLowerCase() === path.toLowerCase());
    if (!f) return;
    setProgress((p) => ({
      ...p,
      recent: [path, ...p.recent.filter((x) => x !== path)].slice(0, 6),
      opened: { ...p.opened, [path]: Date.now() },
      selected: path,
    }));
    if (f.ext === "md" || f.ext === "txt") {
      setSelected(path);
      setView("reader");
    } else if (f.ext === "csv") {
      window.location.assign("/flashcards?mode=smart");
    } else if (f.url) {
      window.open(f.url, "_blank", "noopener,noreferrer");
    } else {
      const url = URL.createObjectURL(f.file);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  };

  // Uses the shared resolver, so a link the validator calls good always opens,
  // and a link it calls broken always fails here too.
  const resolveLink = (target: string) => {
    const match = resolveCourseLink(
      target,
      selected,
      course,
      files.map((f) => f.path),
    );
    if (match) openFile(match);
    else
      setNotice(
        `That linked file was not found in the imported folder: ${target}`,
      );
  };

  const selectedFile = files.find((f) => f.path === selected);
  const [activeYear, activeModule] = library ? [course.split("/")[0], course.slice(course.indexOf("/") + 1)] : ["", course];
  const yearModules = library?.years.find((y) => y.year === activeYear)?.modules || [];
  const allModules = library?.years.flatMap((y) => y.modules) || [];
  const thisYear = library?.years.find((y) => y.year === currentAcademicYear()) ? currentAcademicYear() : library?.years[0]?.year;
  const pastYears = library?.years.filter((y) => y.year !== thisYear && y.modules.length) || [];
  const searchResults = query.trim()
    ? files
        .filter((f) =>
          `${f.path}\n${f.text || ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice(0, 40)
    : [];
  const categoryOrder = [
    "Guides & hubs",
    "Study packs",
    "Flashcards",
    "Past papers",
    "Seminars",
    "Course materials",
    "Source materials",
  ];
  const categories = Array.from(new Set(files.map((f) => f.category))).sort(
    (a, b) =>
      (categoryOrder.indexOf(a) < 0 ? 99 : categoryOrder.indexOf(a)) -
      (categoryOrder.indexOf(b) < 0 ? 99 : categoryOrder.indexOf(b)),
  );

  if (!course && libraryState !== "off")
    return (
      <main className="welcome">
        <section className="welcome-card">
          <div className="mark">SH</div>
          <p className="eyebrow">My Studies</p>
          {libraryState === "loading" ? (
            <h1>Opening your modules…</h1>
          ) : libraryState === "error" ? (
            <>
              <h1>Study Hub could not read your library.</h1>
              <p className="lede">Quit Study Hub and open it again. If this keeps happening, check that the My Studies folder in Documents still exists.</p>
            </>
          ) : (
            <>
              <h1>No modules yet.</h1>
              <p className="lede">
                Sign in to your university so Study Hub can fetch your modules into
                {library?.root ? ` ${library.root}` : " Documents/My Studies"}.
              </p>
            </>
          )}
        </section>
      </main>
    );

  if (!course)
    return (
      <main className="welcome">
        <div className="privacy-pill">
          Private • read-only • stays on your device
        </div>
        <section className="welcome-card">
          <div className="mark">SH</div>
          <p className="eyebrow">Universal exam workspace</p>
          <h1>Turn any revision folder into a study hub.</h1>
          <p className="lede">
            Choose Contract, Tort, or another exam folder. Study Hub organises
            your notes, renders Markdown, builds flashcard sessions, and
            remembers your progress—without uploading a file.
          </p>
          <div className="welcome-actions">
            <button className="primary large" onClick={chooseFolder}>
              Choose an exam folder
            </button>
            {remembered.map((handle) => (
              <button className="secondary large" key={handle.name} onClick={() => restoreFolder(handle)}>Reconnect {handle.name}</button>
            ))}
          </div>
          <div className="trust-grid">
            <span>
              <b>01</b> Chrome asks permission
            </span>
            <span>
              <b>02</b> Files stay local
            </span>
            <span>
              <b>03</b> Progress stays private
            </span>
          </div>
        </section>
        <input
          ref={fallbackRef}
          className="hidden"
          type="file"
          multiple
          onChange={fallbackImport}
          {...({ webkitdirectory: "" } as object)}
        />
      </main>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">SH</span>
          <div>
            <strong>Study Hub</strong>
            <small>Local-first workspace</small>
          </div>
        </div>
        <nav>
          {[
            ["dashboard", "Overview"],
            ["reader", "Reading"],
            ["files", "All files"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id as typeof view)}
            >
              {label}
            </button>
          ))}
          <a className="flashcards-link" href="/flashcards?mode=smart">Flashcards</a>
          {library && <a className="flashcards-link" href="/calendar">Calendar</a>}
          {library && <a className="flashcards-link" href="/assessments">Assessments</a>}
        </nav>
        {library && (
          <div className="side-section module-list">
            {library.years
              .filter((y) => y.year === thisYear || (pastOpen && y.modules.length))
              .map((y) => (
                <div key={y.year}>
                  <p>{y.year === thisYear ? `${y.year} modules` : y.year}</p>
                  {y.modules.map((m) => (
                    <button
                      key={m}
                      className={`${y.year}/${m}` === course ? "active" : ""}
                      aria-current={`${y.year}/${m}` === course ? "page" : undefined}
                      title={m}
                      onClick={() => openModule(library, y.year, m)}
                    >
                      <span className="module-dot" style={{ background: moduleColor(allModules, m) }} aria-hidden="true" />
                      <span className="module-name">{m}</span>
                    </button>
                  ))}
                </div>
              ))}
            {pastYears.length > 0 && (
              <button className="past-toggle" aria-expanded={pastOpen} onClick={() => setPastOpen((o) => !o)}>
                {pastOpen ? "Hide past years" : "Past years"}
              </button>
            )}
          </div>
        )}
        <div className="side-section">
          <p>Topics</p>
          {topics.slice(0, 18).map((topic) => (
            <button
              key={topic}
              onClick={() => {
                const key = canonicalTopicKey(topic);
                const f = files.find(
                  (x) => canonicalTopicKey(x.path) === key && x.ext === "md",
                );
                if (f) openFile(f.path);
                else {
                  setQuery(topic);
                  setView("files");
                }
              }}
            >
              {topic}
            </button>
          ))}
        </div>
        <div className="side-bottom">
          <span className="privacy-dot" />
          Files remain on this device
          {library && (
            <SyncButton
              onSynced={() =>
                fetchTree()
                  .then((tree) => {
                    setLibrary(tree);
                    return fetchDeadlines().then(setDeadlines);
                  })
                  .catch(() => {})
              }
            />
          )}
          {!library && (
            <button className="switch" onClick={chooseFolder}>
              Switch course folder
            </button>
          )}
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{library ? `${activeYear} module` : "Active course"}</p>
            <h2>{activeModule}</h2>
          </div>
          <div className="search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={profile.id === "law" ? "Search notes, cases and cards…" : `Search notes, ${profile.terms.authorities} and cards…`}
            />
          </div>
          <div className="top-actions"><a className="ai-button" href="/connect">AI settings</a><span className="save-state">Saved locally</span></div>
        </header>
        {course && <section className="hub-card"><SubjectControl key={course} target={subjectTarget} subject={subject} /></section>}
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")}>×</button>
          </div>
        )}
        {report && formatPrompt === "banner" && (
          <FormatCheckBanner
            report={report}
            onOpen={() => setFormatPrompt("modal")}
            onDismiss={dismissFormatPrompt}
          />
        )}
        {report && formatPrompt === "modal" && (
          <FormatCheckDialog
            report={report}
            aiReady={aiReady}
            onDismiss={dismissFormatPrompt}
            onChoose={(choice) => {
              setFormatPrompt("none");
              if (choice === "keep") return dismissFormatPrompt();
              // The conversion workspace owns the long-running work; it re-reads
              // the folder handle from IndexedDB, so nothing needs passing here.
              window.location.assign(`/generate?mode=${choice}`);
            }}
          />
        )}
        {query && (
          <section className="search-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Search</p>
                <h3>{searchResults.length} matching files</h3>
              </div>
              <button onClick={() => setQuery("")}>Clear</button>
            </div>
            <div className="result-list">
              {searchResults.map((f) => (
                <button key={f.path} onClick={() => { setQuery(""); openFile(f.path); }}>
                  <span className={`file-icon ${f.ext}`}>
                    {f.ext.toUpperCase()}
                  </span>
                  <span>
                    <b>{f.name}</b>
                    <small>{f.path}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {!query && view === "dashboard" && (
          <section className="dashboard">
            {/* Under the desktop app the whole year comes first: what is due, then every module. */}
            {library && (
              <NextSevenDays
                deadlines={deadlines}
                modules={allModules}
                yearModules={yearModules}
              />
            )}
            {library && (
              <ModuleOverview
                tree={library}
                year={activeYear}
                activeKey={course}
                activeOpened={progress.opened}
                deadlines={deadlines}
                onOpen={(m) => openModule(library, activeYear, m)}
              />
            )}
            <div className="hero">
              <div>
                <p className="eyebrow">Your revision command centre</p>
                <h1>Know what to study next.</h1>
                <p>
                  {files.length} files are organised and ready. Continue
                  reading, review weak cards, or follow your revision checklist.
                </p>
                <div className="hero-actions">
                  <button className="primary" onClick={() => { window.location.assign("/flashcards?mode=smart"); }}>
                    Start a card session
                  </button>
                  {selected && (
                    <button
                      className="secondary"
                      onClick={() => openFile(selected)}
                    >
                      Continue reading
                    </button>
                  )}
                </div>
              </div>
              <div className="score">
                <span>
                  {overallPackProgress}%
                </span>
                <small>packs complete</small>
              </div>
            </div>
            <div className="overall-progress"><span style={{ width: `${overallPackProgress}%` }} /><b>All study packs: {overallPackProgress}%</b></div>
            <div className="metrics">
              <div>
                <span>PACKS</span>
                <strong>{packs.length}</strong>
                <p>focused study guides</p>
              </div>
              <div>
                <span>TOPICS</span>
                <strong>{topics.length}</strong>
                <p>organised automatically</p>
              </div>
              <button
                className="metric-link"
                onClick={() => {
                  window.location.assign("/flashcards?mode=smart");
                }}
              >
                <span>CARDS</span>
                <strong>{cards.length}</strong>
                <p>{reviewed} reviewed</p>
              </button>
              <button
                className="metric-link"
                onClick={() => {
                  window.location.assign("/flashcards?mode=weak");
                }}
              >
                <span>WEAK</span>
                <strong>{weak}</strong>
                <p>need another pass</p>
              </button>
            </div>
            <div className="dashboard-grid">
              <section className="panel">
                <div className="section-title">
                  <div>
                    <p className="eyebrow">Resume</p>
                    <h3>Recent materials</h3>
                  </div>
                </div>
                <div className="pack-list">{packs.map((pack) => <button key={pack.path} onClick={() => openFile(pack.path)}><span><b>{pack.name.replace(/\.md$/i, "")}</b><small>{packProgress(pack)}% complete</small></span><i><span style={{ width: `${packProgress(pack)}%` }} /></i></button>)}</div>
                <div className="recent-list">
                  {(progress.recent.length
                    ? progress.recent
                    : markdownFiles.slice(0, 5).map((f) => f.path)
                  ).map((path) => {
                    const f = files.find((x) => x.path === path);
                    return (
                      f && (
                        <button key={path} onClick={() => openFile(path)}>
                          <span className="doc-glyph">¶</span>
                          <span>
                            <b>{f.name}</b>
                            <small>{f.category}</small>
                          </span>
                          <i>→</i>
                        </button>
                      )
                    );
                  })}
                </div>
              </section>
              <section className="panel focus-panel">
                <p className="eyebrow">Recommended now</p>
                <h3>
                  {weak
                    ? `Revisit ${weak} weak cards`
                    : "Build your first recall streak"}
                </h3>
                <p>
                  {weak
                    ? profile.id === "law" ? "A short targeted session will strengthen the cases you are least confident about." : `A short targeted session will strengthen the ${profile.terms.authorities} you are least confident about.`
                    : profile.id === "law" ? "Start with your foundations deck, then move into scenario recognition." : `Start with your ${profile.decks[0].label.toLowerCase()} deck, then practise ${profile.terms.examQuestion} recognition.`}
                </p>
                <button
                  onClick={() => {
                    window.location.assign(
                      weak
                        ? "/flashcards?mode=weak"
                        : "/flashcards?mode=progressive",
                    );
                  }}
                >
                  {weak ? "Review weak cards" : profile.id === "law" ? "Begin foundations" : `Begin ${profile.decks[0].label.toLowerCase()}`}
                </button>
                {!isFormattedCourse(files, profile) && <a className="convert-link" href="/generate">Generate topic packs from this course</a>}
              </section>
            </div>
          </section>
        )}
        {!query && view === "reader" && (
          <section className="reader-layout">
            <div className="reader-menu">
              <p className="eyebrow">Reading library</p>
              {categories
                .filter((c) =>
                  files.some(
                    (f) =>
                      f.category === c && (f.ext === "md" || f.ext === "txt"),
                  ),
                )
                .map((cat) => (
                  <div key={cat}>
                    <h4>{cat}</h4>
                    {files
                      .filter(
                        (f) =>
                          f.category === cat &&
                          (f.ext === "md" || f.ext === "txt"),
                      )
                      .map((f) => (
                        <button
                          className={selected === f.path ? "selected" : ""}
                          key={f.path}
                          onClick={() => openFile(f.path)}
                        >
                          {f.name.replace(/\.md$|\.txt$/i, "")}
                        </button>
                      ))}
                  </div>
                ))}
            </div>
            <div className="reader-paper">
              {selectedFile?.text && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
                  <button className="chat-launch" onClick={() => setChatOpen(true)}>
                    Ask about this
                  </button>
                </div>
              )}
              {selectedFile?.text ? (
                selectedFile.ext === "md" ? (
                  <Markdown
                    text={selectedFile.text}
                    path={selectedFile.path}
                    onLink={resolveLink}
                    checks={progress.checks}
                    toggleCheck={(key) =>
                      setProgress((p) => ({
                        ...p,
                        checks: { ...p.checks, [key]: !p.checks[key] },
                      }))
                    }
                  />
                ) : (
                  <article className="transcript">
                    <h1>{selectedFile.name}</h1>
                    <pre>{selectedFile.text}</pre>
                  </article>
                )
              ) : (
                <div className="empty">
                  Choose a Markdown guide or topic pack to begin.
                </div>
              )}
            </div>
          </section>
        )}
        {!query && view === "files" && (
          <section className="files-view">
            <div className="section-title">
              <div>
                <p className="eyebrow">Imported course</p>
                <h1>All files</h1>
              </div>
              <span>{files.length} supported files</span>
            </div>
            {categories.map((cat) => (
              <div className="file-group" key={cat}>
                <h3>{cat}</h3>
                <div>
                  {files
                    .filter((f) => f.category === cat)
                    .map((f) => (
                      <button key={f.path} onClick={() => openFile(f.path)}>
                        <span className={`file-icon ${f.ext}`}>
                          {f.ext.toUpperCase()}
                        </span>
                        <span>
                          <b>{f.name}</b>
                          <small>{f.path}</small>
                        </span>
                        <i>Open</i>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
      <input
        ref={fallbackRef}
        className="hidden"
        type="file"
        multiple
        onChange={fallbackImport}
        {...({ webkitdirectory: "" } as object)}
      />
      {chatOpen && selectedFile && (
        <ChatPanel
          onClose={() => setChatOpen(false)}
          files={files}
          selected={selected}
          manifest={manifest}
          aiReady={aiReady}
        />
      )}
    </div>
  );
}
