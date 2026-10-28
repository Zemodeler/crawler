"use client";
import { useEffect, useMemo, useState } from "react";

import {
  KIND_LABELS,
  gradeBand,
  statusOf,
  studyPackMarkdown,
  studyPackName,
  topicScores,
  type Answer,
  type Attempt,
  type Paper,
  type Question,
  type SelfMark,
} from "../../lib/practice.ts";
import { Markdown } from "../markdown.tsx";

const LETTERS = "ABCDEF";

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------- taking */

export function Taker({
  paper,
  onFinish,
  onExit,
}: {
  paper: Pick<Paper, "title" | "kind" | "questions">;
  onFinish: (answers: Record<string, Answer>, seconds: number) => void;
  onExit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [seconds, setSeconds] = useState(0);
  const total = paper.questions.length;
  const question = paper.questions[index];

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const answered = (q: Question) =>
    q.type === "mcq" ? answers[q.id]?.choice !== undefined : Boolean(answers[q.id]?.text?.trim());
  const left = paper.questions.filter((q) => !answered(q)).length;

  function finish() {
    if (left && !window.confirm(`${left} question${left === 1 ? " is" : "s are"} unanswered and will score nothing. Finish anyway?`))
      return;
    onFinish(answers, seconds);
  }
  function exit() {
    if (Object.keys(answers).length && !window.confirm("Leave this paper? Your answers so far will be lost.")) return;
    onExit();
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || event.metaKey || event.ctrlKey) return;
      if (event.key === "ArrowRight") setIndex((i) => Math.min(total - 1, i + 1));
      else if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      else if (/^[1-6]$/.test(event.key)) {
        const current = paper.questions[index];
        const choice = Number(event.key) - 1;
        if (current.type === "mcq" && choice < current.options.length)
          setAnswers((a) => ({ ...a, [current.id]: { choice } }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, total, paper.questions]);

  return (
    <section className="pr-take">
      <header className="pr-take-head">
        <div>
          <p className="eyebrow">{KIND_LABELS[paper.kind]}</p>
          <h1>{paper.title}</h1>
        </div>
        <div className="pr-take-meta">
          <span aria-label="Time taken">{clock(seconds)}</span>
          <button type="button" className="pr-quiet" onClick={exit}>
            Leave
          </button>
        </div>
      </header>

      <nav className="pr-dots" aria-label="Questions">
        {paper.questions.map((q, i) => (
          <button
            type="button"
            key={q.id}
            className={`${i === index ? "current" : ""} ${answered(q) ? "done" : ""}`}
            aria-label={`Question ${i + 1}${answered(q) ? ", answered" : ""}`}
            aria-current={i === index ? "step" : undefined}
            onClick={() => setIndex(i)}
          >
            {i + 1}
          </button>
        ))}
      </nav>

      <article className="pr-question">
        <p className="pr-qmeta">
          <span>
            Question {index + 1} of {total}
          </span>
          <span>
            {question.topic} · {question.marks} {question.marks === 1 ? "mark" : "marks"}
          </span>
        </p>
        <p className="pr-prompt">{question.prompt}</p>
        {question.type === "mcq" ? (
          <div className="pr-options" role="radiogroup" aria-label="Choices">
            {question.options.map((option, i) => (
              <button
                type="button"
                role="radio"
                aria-checked={answers[question.id]?.choice === i}
                key={i}
                className={answers[question.id]?.choice === i ? "picked" : ""}
                onClick={() => setAnswers((a) => ({ ...a, [question.id]: { choice: i } }))}
              >
                <b>{LETTERS[i]}</b>
                <span>{option}</span>
              </button>
            ))}
          </div>
        ) : (
          <label className="pr-written">
            <span>Your answer. Show your working; you mark it yourself against the model answer afterwards.</span>
            <textarea
              rows={7}
              value={answers[question.id]?.text || ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [question.id]: { text: e.target.value } }))}
            />
          </label>
        )}
      </article>

      <footer className="pr-take-foot">
        <button type="button" className="pr-quiet" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          ← Previous
        </button>
        <span>{left ? `${left} unanswered` : "All answered"}</span>
        {index < total - 1 ? (
          <button type="button" className="pr-primary" onClick={() => setIndex(index + 1)}>
            Next →
          </button>
        ) : (
          <button type="button" className="pr-primary" onClick={finish}>
            Finish paper
          </button>
        )}
      </footer>
      <p className="pr-hint">Keys: 1–4 choose an option, ← → move between questions.</p>
    </section>
  );
}

/* --------------------------------------------------------------- marking */

const MARKS: { value: SelfMark; label: string }[] = [
  { value: "right", label: "Got it" },
  { value: "partly", label: "Partly" },
  { value: "wrong", label: "Missed" },
];

/** The written questions, marked by the student against the model answer. */
export function Marker({
  questions,
  answers,
  onDone,
}: {
  questions: Question[];
  answers: Record<string, Answer>;
  onDone: (marks: Record<string, SelfMark>) => void;
}) {
  // A question left blank cannot have been right, so it starts as missed.
  const [marks, setMarks] = useState<Record<string, SelfMark>>(() =>
    Object.fromEntries(questions.filter((q) => !answers[q.id]?.text?.trim()).map((q) => [q.id, "wrong" as const])),
  );
  const marked = questions.filter((q) => marks[q.id]).length;

  return (
    <section className="pr-page">
      <p className="eyebrow">Mark your written answers</p>
      <h1>How did you do?</h1>
      <p className="pr-lede">
        Compare each answer with the model answer and mark it honestly. Multiple-choice questions are already marked.
      </p>
      {questions.map((q, i) => (
        <article className="pr-mark" key={q.id}>
          <p className="pr-qmeta">
            <span>
              {i + 1}. {q.topic}
            </span>
            <span>{q.marks} marks</span>
          </p>
          <p className="pr-prompt">{q.prompt}</p>
          <div className="pr-compare">
            <div>
              <h3>Your answer</h3>
              <p>{answers[q.id]?.text?.trim() || "No answer"}</p>
            </div>
            <div>
              <h3>Model answer</h3>
              <p>{q.modelAnswer}</p>
            </div>
          </div>
          <div className="pr-selfmark" role="radiogroup" aria-label="Your mark">
            {MARKS.map((m) => (
              <button
                type="button"
                role="radio"
                aria-checked={marks[q.id] === m.value}
                key={m.value}
                className={`${m.value} ${marks[q.id] === m.value ? "picked" : ""}`}
                onClick={() => setMarks((s) => ({ ...s, [q.id]: m.value }))}
              >
                {m.label}
              </button>
            ))}
          </div>
        </article>
      ))}
      <div className="pr-actions">
        <button type="button" className="pr-primary" disabled={marked < questions.length} onClick={() => onDone(marks)}>
          See my grade
        </button>
        <span>
          {marked} of {questions.length} marked
        </span>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- results */

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STATUS_LABEL = { correct: "Correct", partial: "Partly right", wrong: "Wrong", skipped: "Skipped" } as const;

export function Result({
  attempt,
  previous,
  onSaveNote,
  onRetryMissed,
  onRetake,
  onBack,
}: {
  attempt: Attempt;
  /** The attempt before this one on the same paper, for the comparison line. */
  previous?: Attempt;
  /** Present only where the study pack can be saved into the module's notes. */
  onSaveNote?: (name: string, text: string) => Promise<string>;
  onRetryMissed: () => void;
  onRetake: () => void;
  onBack: () => void;
}) {
  const band = gradeBand(attempt.percent);
  const [onlyMissed, setOnlyMissed] = useState(false);
  const [saved, setSaved] = useState("");
  const [saveError, setSaveError] = useState("");
  const pack = useMemo(() => studyPackMarkdown(attempt), [attempt]);
  const topics = useMemo(() => topicScores([attempt]), [attempt]);
  const missed = attempt.questions.filter((q) => statusOf(q, attempt.answers[q.id]) !== "correct");
  const shown = onlyMissed ? missed : attempt.questions;
  const delta = previous ? attempt.percent - previous.percent : null;

  async function save() {
    setSaveError("");
    try {
      setSaved(await onSaveNote!(studyPackName(attempt), pack));
    } catch (error) {
      setSaveError((error as Error).message || "Could not save the study pack.");
    }
  }

  return (
    <section className="pr-page">
      <button type="button" className="pr-quiet" onClick={onBack}>
        ← Back to practice
      </button>
      <div className={`pr-grade band-${band.short.replace(":", "")}`}>
        <div className="pr-grade-ring">
          <strong>{attempt.percent}%</strong>
          <span>{band.short}</span>
        </div>
        <div>
          <p className="eyebrow">{KIND_LABELS[attempt.kind]}</p>
          <h1>{attempt.title}</h1>
          <p>
            {band.label}. {attempt.score} of {attempt.total} marks in {clock(attempt.seconds)}.
            {delta !== null && (
              <>
                {" "}
                {delta === 0 ? "Same as your last attempt on this paper." : `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} points on your last attempt on this paper.`}
              </>
            )}
          </p>
          <div className="pr-actions">
            {missed.length > 0 && (
              <button type="button" className="pr-primary" onClick={onRetryMissed}>
                Retry the {missed.length} you missed
              </button>
            )}
            <button type="button" className="pr-quiet" onClick={onRetake}>
              Take the paper again
            </button>
          </div>
        </div>
      </div>

      <h2>By topic</h2>
      <div className="pr-topics">
        {topics.map((t) => (
          <div key={t.topic}>
            <span>{t.topic}</span>
            <div className="pr-bar" role="img" aria-label={`${t.topic}: ${t.percent}%`}>
              <i style={{ width: `${t.percent}%` }} className={t.percent >= 70 ? "good" : t.percent >= 40 ? "mid" : "low"} />
            </div>
            <b>
              {t.got}/{t.total}
            </b>
          </div>
        ))}
      </div>

      <div className="pr-section-head">
        <h2>Your study pack</h2>
        <div className="pr-actions">
          <button type="button" className="pr-quiet" onClick={() => download(`${studyPackName(attempt)}.md`, pack)}>
            Download .md
          </button>
          {onSaveNote && (
            <button type="button" className="pr-quiet" onClick={save} disabled={Boolean(saved)}>
              {saved ? "Saved to My Files" : "Save to my notes"}
            </button>
          )}
        </div>
      </div>
      {saveError && <p className="pr-error">{saveError}</p>}
      {saved && <p className="pr-note">Saved as {saved}. It is now one of this module&apos;s files.</p>}
      <div className="pr-pack">
        <Markdown text={pack} path="study-pack" onLink={() => {}} checks={{}} toggleCheck={() => {}} />
      </div>

      <div className="pr-section-head">
        <h2>Every question</h2>
        <label className="fc-check">
          <input type="checkbox" checked={onlyMissed} onChange={(e) => setOnlyMissed(e.target.checked)} />
          Only the ones I missed
        </label>
      </div>
      {shown.map((q) => {
        const answer = attempt.answers[q.id];
        const status = statusOf(q, answer);
        return (
          <article className={`pr-review ${status}`} key={q.id}>
            <p className="pr-qmeta">
              <span>{q.topic}</span>
              <span className="pr-status">{STATUS_LABEL[status]}</span>
            </p>
            <p className="pr-prompt">{q.prompt}</p>
            {q.type === "mcq" ? (
              <ul className="pr-choices">
                {q.options.map((option, i) => (
                  <li key={i} className={`${i === q.correctIndex ? "key" : ""} ${answer?.choice === i ? "chosen" : ""}`}>
                    <b>{LETTERS[i]}</b>
                    <span>{option}</span>
                    {i === q.correctIndex && <em>Correct answer</em>}
                    {answer?.choice === i && i !== q.correctIndex && <em>Your answer</em>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="pr-compare">
                <div>
                  <h3>Your answer</h3>
                  <p>{answer?.text?.trim() || "No answer"}</p>
                </div>
                <div>
                  <h3>Model answer</h3>
                  <p>{q.modelAnswer}</p>
                </div>
              </div>
            )}
            <p className="pr-why">
              <b>Why:</b> {q.explanation}
            </p>
          </article>
        );
      })}
    </section>
  );
}
