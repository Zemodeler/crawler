"use client";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { loadHandles } from "../../lib/course-fs.ts";
import { isHosted } from "../../lib/ai/settings.ts";
import { fetchTree, loadModule, pickModule } from "../../lib/library.ts";
import Practice from "./practice.tsx";
type Confidence = 1 | 2 | 3 | 4 | 5;
type Card = {
  id: string;
  q: string;
  a: string;
  deck: string;
  category: string;
  order: number;
};
type Review = {
  confidence: Confidence;
  history: Confidence[];
  reviews: number;
  updated: number;
  due: number;
};
type Stats = {
  reviews: Record<string, Review>;
  starred: Record<string, boolean>;
  events: { at: number; confidence: Confidence }[];
  seconds: number;
  streak: { current: number; best: number; last: string; revivals: string[] };
  goals: { cards: number; minutes: number };
};
type Mode =
  | "smart"
  | "random"
  | "progressive"
  | "due"
  | "weak"
  | "unseen"
  | "starred";
const EMPTY: Stats = {
  reviews: {},
  starred: {},
  events: [],
  seconds: 0,
  streak: { current: 0, best: 0, last: "", revivals: [] },
  goals: { cards: 20, minutes: 15 },
};
function csv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quote && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') quote = !quote;
    else if (c === "," && !quote) {
      row.push(cell);
      cell = "";
    } else if (/[\r\n]/.test(c) && !quote) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
function category(path: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.length > 1
    ? parts.at(-2)!.replace(/^\d+\s*[-–.]\s*/, "")
    : "General";
}
function stable(path: string, i: number, q: string) {
  let h = 2166136261;
  for (const c of `${path}:${i}:${q}`)
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return `${path}:${(h >>> 0).toString(36)}`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function dayDiff(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
type DirectoryHandle = FileSystemHandle & {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FileSystemHandle>;
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
};
/**
 * Reuses the reader's own handle store (course-fs.ts) rather than opening a
 * second, separately-versioned copy of the same IndexedDB database. This page
 * used to open "study-hub" at version 2 while the reader had already upgraded
 * it to version 3 — opening at a lower version than what already exists
 * throws, which a bare `.catch(() => {})` at the call site swallowed, so the
 * remembered folder silently failed to load and this page always looked like
 * a first run, asking to choose a folder that was already known.
 */
async function rememberedCourse(): Promise<DirectoryHandle | undefined> {
  const { active, handles } = await loadHandles();
  if (!active) return undefined;
  return handles.find((handle) => handle.name === active) as unknown as DirectoryHandle | undefined;
}
async function collectCsv(
  handle: DirectoryHandle,
  prefix = "",
): Promise<{ file: File; path: string }[]> {
  const output: { file: File; path: string }[] = [];
  for await (const entry of handle.values()) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory")
      output.push(...(await collectCsv(entry as DirectoryHandle, path)));
    else if (entry.name.toLowerCase().endsWith(".csv"))
      output.push({
        file: await (entry as FileSystemFileHandle).getFile(),
        path,
      });
  }
  return output;
}
export default function Flashcards() {
  const [course, setCourse] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY);
  const [tab, setTab] = useState<"home" | "study" | "browse" | "stats" | "practice">("home");
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [selectedDecks, setSelectedDecks] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("smart");
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [round, setRound] = useState<{ start: number; ratings: Confidence[] }>({
    start: 0,
    ratings: [],
  });
  const [undo, setUndo] = useState<{
    id: string;
    prior?: Review;
    eventCount: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Card | null>(null);
  const [notice, setNotice] = useState("");
  const [reconnect, setReconnect] = useState<DirectoryHandle>();
  const input = useRef<HTMLInputElement>(null);
  const started = useRef(0);
  // A link straight to the practice tab must survive the course loading, which otherwise resets to home.
  const wantPractice = useRef(false);
  // `now` comes from a ticking effect and the shuffle seed is derived, rather
  // than either being read during render. Reading the clock or the RNG while
  // rendering made the due-filter and the random order change on every
  // re-render, which could jump the card you were looking at mid-review.
  const [now, setNow] = useState(0);
  function returnToHub() {
    window.location.assign("/");
  }
  async function applyFiles(
    courseName: string,
    files: { file: File; path: string }[],
  ) {
    const all: Card[] = [];
    for (const { file, path } of files) {
      const rows = csv(await file.text());
      const heads = rows[0]?.map((value) => value.trim().toLowerCase());
      const question = heads?.indexOf("question") ?? -1;
      const answer = heads?.indexOf("answer") ?? -1;
      if (question < 0 || answer < 0) continue;
      rows.slice(1).forEach((row, index) => {
        if (row[question]?.trim() && row[answer]?.trim())
          all.push({
            id: stable(path, index, row[question]),
            q: row[question].trim(),
            a: row[answer].trim(),
            deck: file.name.replace(/\.csv$/i, ""),
            category: category(path),
            order: index,
          });
      });
    }
    setCourse(courseName);
    setCards(all);
    setSelectedCats([]);
    setTab(wantPractice.current ? "practice" : "home");
    setNotice(`${all.length} cards loaded automatically from ${courseName}.`);
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "practice") {
      wantPractice.current = true;
      queueMicrotask(() => setTab("practice"));
    }
    const requested = params.get("mode");
    const allowed: Mode[] = [
      "smart", "random", "progressive", "due", "weak", "unseen", "starred",
    ];
    if (requested && allowed.includes(requested as Mode)) {
      queueMicrotask(() => {
        setMode(requested as Mode);
        setTab("study");
      });
    }
    if (isHosted()) {
      // Under the desktop app the course is the module chosen on the hub.
      fetchTree()
        .then(async (tree) => {
          const picked = pickModule(tree);
          if (!picked) return;
          const files = await loadModule(tree, picked.year, picked.module);
          await applyFiles(
            `${picked.year}/${picked.module}`,
            files.filter((f) => f.ext === "csv").map((f) => ({ file: f.file, path: f.path })),
          );
        })
        .catch(() => {});
      return;
    }
    rememberedCourse()
      .then(async (handle) => {
        if (!handle) return;
        const permission = await handle.queryPermission?.({ mode: "read" });
        if (permission === "granted")
          await applyFiles(handle.name, await collectCsv(handle));
        else setReconnect(handle);
      })
      .catch(() => {});
  }, []);
  // One clock tick drives the due-filter and the shuffle order. A minute is
  // plenty: it lets a card become due while the tab is open without ever
  // reordering the deck under the user's cursor.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem(`studyhub:flashcards:${course}`);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (course && saved) setStats({ ...EMPTY, ...JSON.parse(saved) });
    started.current = Date.now();
    return () => {
      if (course)
        setStats((s) => ({
          ...s,
          seconds:
            s.seconds + Math.round((Date.now() - started.current) / 1000),
        }));
    };
  }, [course]);
  useEffect(() => {
    if (course)
      localStorage.setItem(
        `studyhub:flashcards:${course}`,
        JSON.stringify(stats),
      );
  }, [course, stats]);
  const categories = useMemo(
    () => [...new Set(cards.map((c) => c.category))],
    [cards],
  );
  const decks = useMemo(
    () => [
      ...new Set(
        cards
          .filter(
            (c) => !selectedCats.length || selectedCats.includes(c.category),
          )
          .map((c) => c.deck),
      ),
    ],
    [cards, selectedCats],
  );
  // Derived, not random: the same mode and course always shuffle the same way,
  // so re-rendering never reorders the deck under you.
  const shuffleSeed = useMemo(() => {
    let hash = 2166136261;
    for (const char of `${course}:${mode}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  }, [course, mode]);

  const pool = useMemo(() => {
    let list = cards.filter(
      (c) =>
        (!selectedCats.length || selectedCats.includes(c.category)) &&
        (!selectedDecks.length || selectedDecks.includes(c.deck)),
    );
    if (mode === "due")
      list = list.filter(
        (c) => !stats.reviews[c.id] || stats.reviews[c.id].due <= now,
      );
    if (mode === "weak")
      list = list.filter((c) => stats.reviews[c.id]?.confidence <= 2);
    if (mode === "unseen") list = list.filter((c) => !stats.reviews[c.id]);
    if (mode === "starred") list = list.filter((c) => stats.starred[c.id]);
    if (mode === "progressive")
      return [...list].sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.deck.localeCompare(b.deck) ||
          a.order - b.order,
      );
    if (mode === "random") {
      // Seeded so the order is stable until the mode or course changes.
      const keyed = list.map((card, index) => {
        let hash = shuffleSeed ^ index;
        for (let i = 0; i < card.id.length; i++)
          hash = Math.imul(hash ^ card.id.charCodeAt(i), 16777619);
        return { card, rank: hash >>> 0 };
      });
      return keyed.sort((a, b) => a.rank - b.rank).map((entry) => entry.card);
    }
    if (mode === "smart")
      return [...list].sort((a, b) => {
        const ar = stats.reviews[a.id],
          br = stats.reviews[b.id];
        const score = (r?: Review) =>
          !r
            ? 35
            : (6 - r.confidence) * 20 +
              Math.min(30, (now - r.updated) / 3600000) +
              (r.due <= now ? 30 : 0) -
              r.reviews * 2;
        return score(br) - score(ar);
      });
    return list;
  }, [cards, selectedCats, selectedDecks, mode, stats, now, shuffleSeed]);
  const current = pool[index % Math.max(pool.length, 1)];
  async function load(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files || [])].filter((f) =>
      f.name.toLowerCase().endsWith(".csv"),
    );
    if (!files.length) return;
    const root = files[0].webkitRelativePath.split("/")[0] || "Course";
    await applyFiles(
      root,
      files.map((file) => ({
        file,
        path: file.webkitRelativePath || file.name,
      })),
    );
  }
  function rate(confidence: Confidence) {
    if (!current) return;
    const prior = stats.reviews[current.id],
      history = [...(prior?.history || []), confidence].slice(-12),
      weak = Object.values(stats.reviews).filter(
        (r) => r.confidence <= 2,
      ).length,
      base = [0.04, 0.2, 0.75, 2, 5][confidence - 1],
      trend = history.length > 1 ? history.at(-1)! - history.at(-2)! : 0,
      hours = Math.max(
        0.02,
        (base *
          (1 + (prior?.reviews || 0) * 0.35) *
          (trend >= 0 ? 1.25 : 0.75)) /
          (1 + weak / Math.max(cards.length, 1)),
      );
    // `rate` only ever runs from a click or key press, never during render, but
    // the compiler lint cannot prove that from the function's position.
    // eslint-disable-next-line react-hooks/purity
    const at = Date.now();
    setUndo({ id: current.id, prior, eventCount: stats.events.length });
    setStats((s) => ({
      ...s,
      reviews: {
        ...s.reviews,
        [current.id]: {
          confidence,
          history,
          reviews: (prior?.reviews || 0) + 1,
          updated: at,
          due: at + hours * 3600000,
        },
      },
      events: [...s.events, { at, confidence }],
      streak: updateStreak(s.streak),
    }));
    const ratings = [...round.ratings, confidence];
    setRound({ start: round.start, ratings });
    setRevealed(false);
    setIndex((i) => i + 1);
  }
  function updateStreak(s: Stats["streak"]) {
    const t = today();
    if (s.last === t) return s;
    const gap = s.last ? dayDiff(s.last, t) : 1;
    const current = gap === 1 ? s.current + 1 : 1;
    return { ...s, current, best: Math.max(s.best, current), last: t };
  }
  function undoRate() {
    if (!undo) return;
    setStats((s) => {
      const reviews = { ...s.reviews };
      if (undo.prior) reviews[undo.id] = undo.prior;
      else delete reviews[undo.id];
      return { ...s, reviews, events: s.events.slice(0, undo.eventCount) };
    });
    setIndex((i) => Math.max(0, i - 1));
    setRevealed(true);
    setUndo(null);
    setRound((r) => ({ ...r, ratings: r.ratings.slice(0, -1) }));
  }
  function toggle(value: string, list: string[], set: (v: string[]) => void) {
    set(
      list.includes(value) ? list.filter((x) => x !== value) : [...list, value],
    );
  }
  function saveEdit() {
    if (!edit) return;
    setCards((cs) => cs.map((c) => (c.id === edit.id ? edit : c)));
    setEdit(null);
    setNotice(
      "Card edit saved in this browser only. The CSV file on disk is unchanged.",
    );
  }
  const totalReviews = stats.events.length,
    mastered = cards.filter(
      (c) => stats.reviews[c.id]?.confidence === 5,
    ).length,
    weak = cards.filter((c) => stats.reviews[c.id]?.confidence <= 2).length,
    unseen = cards.filter((c) => !stats.reviews[c.id]).length,
    todayEvents = stats.events.filter(
      (e) => new Date(e.at).toISOString().slice(0, 10) === today(),
    ).length,
    goal = Math.min(100, Math.round((todayEvents / stats.goals.cards) * 100));
  const checkpoint =
    round.ratings.length > 0 && round.ratings.length % 10 === 0;
  return (
    <main className="fc-app">
      <header className="fc-top">
        <button className="fc-back" onClick={returnToHub}>
          ← Study Hub
        </button>
        <div>
          <b>Flashcards</b>
          <small>{course || "Choose a course"}</small>
        </div>
        <button onClick={() => input.current?.click()}>
          {course ? "Switch course" : "Choose course folder"}
        </button>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          onChange={load}
          {...({ webkitdirectory: "" } as object)}
        />
      </header>
      {notice && (
        <button type="button" className="fc-notice" onClick={() => setNotice("")}>
          {notice} ×
        </button>
      )}
      {!course ? (
        <section className="fc-welcome">
          <p className="eyebrow">Confidence-based learning</p>
          <h1>Know more. Forget less.</h1>
          <p>
            Open a course folder to organise every CSV deck by topic and build
            adaptive study rounds.
          </p>
          {reconnect ? (
            <button
              onClick={async () => {
                const permission = await reconnect.requestPermission?.({ mode: "read" });
                if (permission === "granted")
                  await applyFiles(reconnect.name, await collectCsv(reconnect));
              }}
            >
              Reconnect {reconnect.name}
            </button>
          ) : (
            <button onClick={() => input.current?.click()}>
              Open flashcard library
            </button>
          )}
        </section>
      ) : (
        <>
          <nav className="fc-nav">
            {(["home", "study", "browse", "stats", "practice"] as const).map((t) => (
              <button
                className={tab === t ? "active" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>
          {tab === "practice" && <Practice key={course} course={course} />}
          {tab === "home" && (
            <section className="fc-page">
              <div className="fc-hero">
                <div>
                  <p className="eyebrow">Today’s focus</p>
                  <h1>
                    {goal < 100
                      ? `${stats.goals.cards - todayEvents} cards to reach your goal`
                      : "Daily goal complete"}
                  </h1>
                  <div className="fc-goal">
                    <span style={{ width: `${goal}%` }} />
                  </div>
                  <button onClick={() => setTab("study")}>Smart Study</button>
                </div>
                <div className="fc-mastery">
                  <strong>
                    {cards.length
                      ? Math.round((mastered / cards.length) * 100)
                      : 0}
                    %
                  </strong>
                  <span>mastery</span>
                </div>
              </div>
              <div className="fc-metrics">
                <div>
                  <b>{cards.length}</b>
                  <span>cards</span>
                </div>
                <div>
                  <b>{mastered}</b>
                  <span>mastered</span>
                </div>
                <div>
                  <b>{weak}</b>
                  <span>weak</span>
                </div>
                <div>
                  <b>{stats.streak.current}</b>
                  <span>day streak</span>
                </div>
              </div>
              <h2>Categories</h2>
              <div className="fc-categories">
                {categories.map((cat) => {
                  const cc = cards.filter((c) => c.category === cat),
                    done = cc.filter((c) => stats.reviews[c.id]).length;
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        setSelectedCats([cat]);
                        setTab("study");
                      }}
                    >
                      <b>{cat}</b>
                      <small>
                        {cc.length} cards •{" "}
                        {Math.round((done / cc.length) * 100) || 0}% studied
                      </small>
                      <i>
                        <span
                          style={{ width: `${(done / cc.length) * 100}%` }}
                        />
                      </i>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {tab === "study" && (
            <section className="fc-study">
              <aside>
                <h3>Study Mix</h3>
                <label>
                  Mode
                  <select
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as Mode);
                      setIndex(0);
                    }}
                  >
                    {[
                      "smart",
                      "random",
                      "progressive",
                      "due",
                      "weak",
                      "unseen",
                      "starred",
                    ].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <h4>Categories</h4>
                {categories.map((c) => (
                  <label className="fc-check" key={c}>
                    <input
                      type="checkbox"
                      checked={selectedCats.includes(c)}
                      onChange={() => toggle(c, selectedCats, setSelectedCats)}
                    />
                    {c}
                  </label>
                ))}
                <h4>Decks</h4>
                {decks.map((d) => (
                  <label className="fc-check" key={d}>
                    <input
                      type="checkbox"
                      checked={selectedDecks.includes(d)}
                      onChange={() =>
                        toggle(d, selectedDecks, setSelectedDecks)
                      }
                    />
                    {d}
                  </label>
                ))}
              </aside>
              <div className="fc-player">
                {checkpoint ? (
                  <div className="fc-checkpoint">
                    <p className="eyebrow">10-card checkpoint</p>
                    <h2>Round complete</h2>
                    <strong>
                      {(round.ratings.reduce((a, b) => a + b, 0) / 10).toFixed(
                        1,
                      )}
                    </strong>
                    <span>average confidence</span>
                    <p>
                      {round.ratings.filter((x) => x >= 4).length} strong •{" "}
                      {round.ratings.filter((x) => x <= 2).length} need work
                    </p>
                    <button
                      onClick={() => setRound({ start: index, ratings: [] })}
                    >
                      Continue
                    </button>
                  </div>
                ) : paused ? (
                  <div className="fc-checkpoint">
                    <h2>Session paused</h2>
                    <button onClick={() => setPaused(false)}>Resume</button>
                  </div>
                ) : current ? (
                  <>
                    <div className="fc-session-meta">
                      <span>
                        {(index % Math.max(pool.length, 1)) + 1} / {pool.length}
                      </span>
                      <span>
                        {current.category} • {current.deck}
                      </span>
                      <button
                        onClick={() =>
                          setStats((s) => ({
                            ...s,
                            starred: {
                              ...s.starred,
                              [current.id]: !s.starred[current.id],
                            },
                          }))
                        }
                      >
                        {stats.starred[current.id] ? "★" : "☆"}
                      </button>
                    </div>
                    <div
                      className={revealed ? "fc-card revealed" : "fc-card"}
                      // Tapping the card to reveal the answer is the primary
                      // interaction, so it needs to work from the keyboard too.
                      role={revealed ? undefined : "button"}
                      tabIndex={revealed ? undefined : 0}
                      aria-label={revealed ? undefined : "Reveal the answer"}
                      onClick={() => !revealed && setRevealed(true)}
                      onKeyDown={(event) => {
                        if (revealed) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setRevealed(true);
                        }
                      }}
                    >
                      <small>{revealed ? "ANSWER" : "QUESTION"}</small>
                      <p>{revealed ? current.a : current.q}</p>
                      {/* A label, not a control — the whole card is the button,
                          and a nested button would be invalid here. */}
                      {!revealed && <span className="fc-reveal">Reveal answer</span>}
                    </div>
                    {revealed && (
                      <div>
                        <p className="fc-confidence">
                          How well did you know this?
                        </p>
                        <div className="fc-ratings">
                          {([1, 2, 3, 4, 5] as Confidence[]).map((n) => (
                            <button
                              key={n}
                              onClick={() => rate(n)}
                              aria-label={`Confidence ${n} out of 5`}
                            >
                              <b>{n}</b>
                              <small>
                                {
                                  [
                                    "Not yet",
                                    "Barely",
                                    "Partly",
                                    "Well",
                                    "Perfectly",
                                  ][n - 1]
                                }
                              </small>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="fc-controls">
                      <button disabled={!undo} onClick={undoRate}>
                        Undo rating
                      </button>
                      <button onClick={() => setPaused(true)}>Pause</button>
                      <button onClick={() => setIndex((i) => i + 1)}>
                        Skip
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="fc-checkpoint">
                    <h2>No matching cards</h2>
                    <p>Change the category, deck, or mode filters.</p>
                  </div>
                )}
              </div>
            </section>
          )}
          {tab === "browse" && (
            <section className="fc-page">
              <div className="fc-browse-head">
                <h1>Browse and edit</h1>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search cards…"
                />
                <button
                  onClick={() =>
                    setEdit({
                      id: `new:${Date.now()}`,
                      q: "",
                      a: "",
                      deck: decks[0] || "New deck",
                      category: categories[0] || "General",
                      order: cards.length,
                    })
                  }
                >
                  New card
                </button>
              </div>
              <div className="fc-table">
                {cards
                  .filter((c) =>
                    `${c.q} ${c.a} ${c.deck} ${c.category}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((c) => (
                    <button key={c.id} onClick={() => setEdit(c)}>
                      <span>
                        <b>{c.q}</b>
                        <small>{c.a}</small>
                      </span>
                      <i>
                        {c.category}
                        <br />
                        {c.deck}
                      </i>
                    </button>
                  ))}
              </div>
              {edit && (
                <div className="fc-modal">
                  <div>
                    <h2>
                      {edit.id.startsWith("new:") ? "Create card" : "Edit card"}
                    </h2>
                    <label>
                      Question
                      <textarea
                        value={edit.q}
                        onChange={(e) =>
                          setEdit({ ...edit, q: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Answer
                      <textarea
                        value={edit.a}
                        onChange={(e) =>
                          setEdit({ ...edit, a: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Category
                      <select
                        value={edit.category}
                        onChange={(e) =>
                          setEdit({ ...edit, category: e.target.value })
                        }
                      >
                        {categories.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Deck
                      <select
                        value={edit.deck}
                        onChange={(e) =>
                          setEdit({ ...edit, deck: e.target.value })
                        }
                      >
                        {decks.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                    <div>
                      <button
                        onClick={() => {
                          if (edit.id.startsWith("new:"))
                            setCards((c) => [...c, edit]);
                          saveEdit();
                        }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setCards((c) => c.filter((x) => x.id !== edit.id));
                          setEdit(null);
                        }}
                      >
                        Delete
                      </button>
                      <button onClick={() => setEdit(null)}>Cancel</button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
          {tab === "stats" && (
            <section className="fc-page">
              <h1>Learning statistics</h1>
              <div className="fc-stats-grid">
                <div>
                  <b>{totalReviews}</b>
                  <span>reviews</span>
                </div>
                <div>
                  <b>{Math.round(stats.seconds / 60)}</b>
                  <span>minutes</span>
                </div>
                <div>
                  <b>{stats.streak.current}</b>
                  <span>current streak</span>
                </div>
                <div>
                  <b>{stats.streak.best}</b>
                  <span>best streak</span>
                </div>
                <div>
                  <b>{mastered}</b>
                  <span>mastered</span>
                </div>
                <div>
                  <b>{unseen}</b>
                  <span>unseen</span>
                </div>
              </div>
              <div className="fc-panel">
                <h2>Daily goals</h2>
                <label>
                  Cards
                  <input
                    type="number"
                    min="1"
                    value={stats.goals.cards}
                    onChange={(e) =>
                      setStats((s) => ({
                        ...s,
                        goals: { ...s.goals, cards: +e.target.value },
                      }))
                    }
                  />
                </label>
                <label>
                  Minutes
                  <input
                    type="number"
                    min="1"
                    value={stats.goals.minutes}
                    onChange={(e) =>
                      setStats((s) => ({
                        ...s,
                        goals: { ...s.goals, minutes: +e.target.value },
                      }))
                    }
                  />
                </label>
                <p>
                  {goal < 100
                    ? "Keep going—your card goal is still within reach."
                    : "You reached today’s card goal."}
                </p>
              </div>
              <div className="fc-panel">
                <h2>Confidence distribution</h2>
                {([1, 2, 3, 4, 5] as Confidence[]).map((n) => {
                  const count = Object.values(stats.reviews).filter(
                    (r) => r.confidence === n,
                  ).length;
                  return (
                    <div className="fc-bar" key={n}>
                      <b>{n}</b>
                      <i>
                        <span
                          style={{
                            width: `${cards.length ? (count / cards.length) * 100 : 0}%`,
                          }}
                        />
                      </i>
                      <small>{count}</small>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
