"use client";
/**
 * The Practice dashboard: where the student stands on each topic, what to do
 * next, and the next exam. Cards, exercises and papers are three separate
 * pieces of evidence and are drawn as three separate bars; there is no
 * combined score anywhere on this page.
 */
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { isHosted } from "../../lib/ai/settings.ts";
import { collectDirectory, loadHandles, type LocalFile } from "../../lib/course-fs.ts";
import { countdown, isExamLike, type PracticeView } from "../../lib/exam-focus.ts";
import { fetchDeadlines, fetchTree, getModuleProfile, loadModule, moduleCode } from "../../lib/library.ts";
import { loadStore, type Attempt } from "../../lib/practice.ts";
import { BAR_LABEL, barFor, countCards, doNext, hasNoMaterial, parseReviews, practiceSearch, splitTopics } from "../../lib/practice-view.ts";
import { LEVEL_LABEL, buildReadiness, type Kind, type TopicReadiness } from "../../lib/readiness.ts";
import type { SubjectId } from "../../lib/subject-profiles.ts";
import { loadProgress, loadTutorials, type TutorialProgress, type TutorialSheet } from "../../lib/tutorial.ts";
import { formatDue, latestDate, placeDate } from "../calendar/deadline-ui.tsx";

export type OpenView = (view: PracticeView, options?: { topic?: string; mode?: string }) => void;

type Coming = { title: string; when: string; label: string; urgent: boolean };

type Loaded = {
  files: LocalFile[];
  sheets: TutorialSheet[];
  progress: TutorialProgress;
  attempts: Attempt[];
  reviews: Record<string, { confidence: number }>;
  subject: SubjectId;
  coming: Coming | null;
};

const KINDS: readonly Kind[] = ["cards", "exercises", "papers"];

/** The module's next exam, test or quiz that has not passed, or null (also when the library is not available). */
async function nextExam(course: string): Promise<Coming | null> {
  try {
    const [year, ...rest] = course.split("/");
    const code = moduleCode(rest.join("/"));
    const now = Date.now();
    const upcoming = (await fetchDeadlines())
      .filter((d) => d.year === year && d.module === code && d.status !== "cancelled" && !d.done && isExamLike(d))
      .map((d) => {
        const first = placeDate(d)?.getTime();
        const last = latestDate(d)?.getTime();
        if (first === undefined || last === undefined) return null;
        return { d, first, left: countdown(first, last, d.due?.allDay ?? true, now) };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item) && !item!.left.passed)
      .sort((a, b) => a.first - b.first);
    const next = upcoming[0];
    return next ? { title: next.d.title, when: formatDue(next.d, "short"), label: next.left.label, urgent: next.left.urgent } : null;
  } catch {
    return null;
  }
}

/** Everything the dashboard reads, once. A piece that cannot be read is treated as empty. */
async function load(course: string): Promise<Loaded> {
  const hosted = isHosted();
  let files: LocalFile[] = [];
  let target: Parameters<typeof getModuleProfile>[0] | null = null;
  try {
    if (hosted) {
      const [year, ...rest] = course.split("/");
      files = await loadModule(await fetchTree(), year, rest.join("/"));
      target = course;
    } else {
      const { handles } = await loadHandles();
      const handle = handles.find((h) => h.name === course);
      if (handle && (await handle.queryPermission?.({ mode: "read" })) === "granted") {
        files = await collectDirectory(handle);
        target = handle;
      }
    }
  } catch {
    /* an unreadable module reads as an empty one */
  }
  const [tutorials, subject, coming] = await Promise.all([
    loadTutorials(course, hosted).catch(() => null),
    target ? getModuleProfile(target, files).then((p) => p.profile).catch((): SubjectId => "general") : Promise.resolve<SubjectId>("general"),
    hosted ? nextExam(course) : Promise.resolve(null),
  ]);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(`studyhub:flashcards:${course}`);
  } catch {
    /* no saved reviews */
  }
  return {
    files,
    sheets: tutorials?.sheets ?? [],
    progress: loadProgress(course),
    attempts: loadStore(course).attempts,
    reviews: parseReviews(raw),
    subject,
    coming,
  };
}

/** A link that switches the view in the page, and still opens in a new tab when asked to. */
function ViewLink({ view, topic, mode, onOpen, children }: { view: PracticeView; topic?: string; mode?: string; onOpen: OpenView; children: ReactNode }) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(view, { topic, mode });
  };
  return (
    <a className="pv-link" href={`/practice${practiceSearch("", { view, topic, mode })}`} onClick={click}>
      {children}
    </a>
  );
}

const ACTION_BUTTON: Record<PracticeView, string> = {
  dashboard: "Open",
  cards: "Start revising",
  tutorials: "Open the exercises",
  papers: "Make a paper",
  essays: "Work on an essay",
};

export default function Dashboard({ course, onOpen }: { course: string; onOpen: OpenView }) {
  const [data, setData] = useState<Loaded | null>(null);

  useEffect(() => {
    let live = true;
    load(course).then((loaded) => {
      if (live) setData(loaded);
    });
    return () => {
      live = false;
    };
  }, [course]);

  const topics = useMemo(
    () =>
      data
        ? buildReadiness({
            files: data.files,
            cardCounts: countCards(data.files),
            reviews: data.reviews,
            sheets: data.sheets,
            progress: data.progress,
            attempts: data.attempts,
            subject: data.subject,
          })
        : [],
    [data],
  );

  if (!data)
    return (
      <section className="pv-page" aria-busy="true">
        <p className="pr-meta" role="status">
          Reading your progress…
        </p>
      </section>
    );

  const { topics: listed, other } = splitTopics(topics);
  const action = doNext(topics, data.subject);

  return (
    <section className="pv-page pv-dash" aria-labelledby="pv-dash-title">
      <header className="pv-head">
        <p className="eyebrow">Practice</p>
        <h1 id="pv-dash-title">Where you stand</h1>
        <p className="pv-lede">
          Cards, exercises and papers measure different things, so each topic shows them one by one rather than as a single score.
        </p>
      </header>

      {data.coming && (
        <p className="pv-coming">
          <span>Coming up</span>
          <b>{data.coming.title}</b>
          <span>{data.coming.when}</span>
          <span className={`pv-countdown${data.coming.urgent ? " urgent" : ""}`}>{data.coming.label}</span>
          <a className="pv-link" href="/assessments">
            See all assessments
          </a>
        </p>
      )}

      {hasNoMaterial(topics) ? (
        <div className="pv-empty">
          <h2>Nothing to practise from yet</h2>
          <p>
            Practice starts from your course library. Generate study packs and flashcards from your lecture material, then come back here to see where you
            stand on each topic.
          </p>
          <div className="pr-actions">
            <a className="pr-primary pv-button" href="/generate">
              Generate study packs
            </a>
            <button type="button" className="pr-quiet" onClick={() => onOpen("papers")}>
              Make a practice paper
            </button>
            <button type="button" className="pr-quiet" onClick={() => onOpen("tutorials")}>
              Open tutorial sheets
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="pv-next" aria-labelledby="pv-next-title">
            <p className="eyebrow">Do next</p>
            {action ? (
              <>
                <h2 id="pv-next-title">{action.label}</h2>
                <p className="pv-meta">{action.detail}</p>
                <button type="button" className="pr-primary" onClick={() => onOpen(action.view, { topic: action.topic, mode: action.mode })}>
                  {ACTION_BUTTON[action.view]}
                </button>
              </>
            ) : (
              <>
                <h2 id="pv-next-title">You are on track on every topic</h2>
                <p className="pv-meta">A fresh paper is the best way to check it holds.</p>
                <button type="button" className="pr-primary" onClick={() => onOpen("papers")}>
                  Make a paper
                </button>
              </>
            )}
          </section>

          <section aria-labelledby="pv-topics-title">
            <h2 id="pv-topics-title">Topics, weakest first</h2>
            <ul className="pv-topic-list">
              {listed.map((topic) => (
                <TopicRow key={topic.key} topic={topic} onOpen={onOpen} />
              ))}
              {other && <TopicRow topic={other} onOpen={onOpen} />}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}

function TopicRow({ topic, onOpen }: { topic: TopicReadiness; onOpen: OpenView }) {
  const id = `pv-topic-${topic.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <li className={`pv-topic${topic.other ? " pv-other" : ""}`} aria-labelledby={id}>
      <div className="pv-topic-head">
        <h3 id={id}>{topic.name}</h3>
        <span className={`pv-pill pv-level-${topic.level}`}>{LEVEL_LABEL[topic.level]}</span>
      </div>
      {topic.other && <p className="pv-meta">Exercises and paper questions that do not match one of your topics.</p>}
      <div className="pv-bars">
        {KINDS.map((kind) => (
          <BarRow key={kind} kind={kind} topic={topic} />
        ))}
      </div>
      <p className="pv-links">
        {topic.cards && (
          <ViewLink view="cards" topic={topic.other ? undefined : topic.name} mode="smart" onOpen={onOpen}>
            Revise the cards
          </ViewLink>
        )}
        {topic.exercises && (
          <ViewLink view="tutorials" topic={topic.other ? undefined : topic.name} onOpen={onOpen}>
            Practise the exercises
          </ViewLink>
        )}
        {!topic.other && !topic.cards && !topic.exercises && (
          <ViewLink view="papers" topic={topic.name} onOpen={onOpen}>
            Make a paper on this
          </ViewLink>
        )}
      </p>
    </li>
  );
}

/** One kind of evidence: its label, a bar, and the figure in words. A dash when there is no material of that kind. */
function BarRow({ kind, topic }: { kind: Kind; topic: TopicReadiness }) {
  const bar = barFor(topic, kind);
  const label = BAR_LABEL[kind];
  const band = bar.percent === null ? "" : bar.percent >= 70 ? " good" : bar.percent >= 40 ? " mid" : " low";
  return (
    <div className="pv-bar-row">
      <span className="pv-bar-label" aria-hidden="true">
        {label}
      </span>
      {bar.percent === null ? (
        <div className="pv-bar" role="img" aria-label={`${label}: ${bar.empty}`} />
      ) : (
        <div
          className={`pv-bar${band}`}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={bar.percent}
          aria-valuetext={bar.text}
        >
          <i style={{ width: `${bar.percent}%` }} />
        </div>
      )}
      <span className="pv-bar-text" aria-hidden="true">
        {bar.text}
      </span>
    </div>
  );
}
