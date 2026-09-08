"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Score } from "@/lib/db/schema";
import { todayIso } from "@/lib/schedule";
import type { MarkedConcept, Outcome, TurnWhy } from "@/lib/session/kind";
import type { DebriefOutput, GradeOutput } from "@/lib/tutor/schema";
import { MARK_LABEL, MARK_STYLE, SCORE_LABEL, SCORES_DESC, scoreStyle } from "@/app/components/scores";
import { Debrief } from "./Debrief";
import { Outcomes } from "./Outcomes";

interface Turn {
  attemptId: number;
  stage: "lo_recall" | "lo_probe" | "daily" | "reflection";
  loId: number | null;
  objective: string | null;
  lectureTitle: string | null;
  format: string;
  question: string;
  hintsUsed: boolean;
  position: number;
  total: number | null;
}

interface Feedback {
  score: Score;
  modelScore: Score;
  marks: MarkedConcept[];
  grade: GradeOutput;
  why?: TurnWhy;
}

interface Finished {
  cellsWritten: number;
  debrief: DebriefOutput | null;
  scoreByLo: Record<number, Score>;
  outcomes: Outcome[];
}

const STAGE_LABEL: Record<Turn["stage"], string> = {
  lo_recall: "Objective recall",
  lo_probe: "Concept probe",
  daily: "Daily practice",
  reflection: "Reflection",
};

function monthDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** One line: why this question was shaped as it was. Rendered after grading only. */
function whyLine(why: TurnWhy): string {
  const today = todayIso();
  const parts: string[] = [];
  if (why.order) parts.push(`${why.order}-order`);
  parts.push(why.tier);
  if (why.lapses > 0) parts.push(`lapsed ${why.lapses}×`);
  if (why.streak > 0) parts.push(`${why.streak} green in a row`);
  parts.push(why.intervalDays === 0 ? "first review" : `was on a ${why.intervalDays}-day interval`);
  parts.push(
    why.dueOn < today
      ? `due since ${monthDay(why.dueOn)}`
      : why.dueOn === today
        ? "due today"
        : "not yet due",
  );
  return parts.join(" · ");
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data as T;
}

export default function SessionTurn({
  sessionId,
  sessionType,
}: {
  sessionId: number;
  /** Drives copy that must not be fooled by a lecture literally titled "Daily practice". */
  sessionType: "same_day" | "daily";
}) {
  const [turn, setTurn] = useState<Turn | null>(null);
  const [done, setDone] = useState(false);
  const [answer, setAnswer] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState<null | "loading" | "grading" | "hinting" | "finishing">("loading");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Finished | null>(null);

  // Two effect passes in development would otherwise fire two turn requests.
  const loading = useRef(false);

  const loadTurn = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    setBusy("loading");
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/turn`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load the question.");

      if (data.done) {
        setDone(true);
        setTurn(null);
      } else {
        setTurn(data.turn as Turn);
        setAnswer("");
        setHint(null);
        setFeedback(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the question.");
    } finally {
      loading.current = false;
      setBusy(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadTurn();
  }, [loadTurn]);

  async function grade() {
    setBusy("grading");
    setError(null);
    try {
      const result = await post<Feedback | null>(`/api/sessions/${sessionId}/answer`, {
        answer,
      });
      if (result === null) {
        await loadTurn();
        return;
      }
      setFeedback(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Grading failed.");
    } finally {
      setBusy(null);
    }
  }

  async function cue() {
    setBusy("hinting");
    setError(null);
    try {
      const result = await post<{ hint: string }>(
        `/api/sessions/${sessionId}/hint`,
        { partialAnswer: answer },
      );
      setHint(result.hint);
      setTurn((current) => (current ? { ...current, hintsUsed: true } : current));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not produce a cue.");
    } finally {
      setBusy(null);
    }
  }

  async function finish() {
    setBusy("finishing");
    setError(null);
    try {
      const finished = await post<Finished>(`/api/sessions/${sessionId}/finish`, {});
      setResult(finished);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finish.");
    } finally {
      setBusy(null);
    }
  }

  if (busy === "loading" && !turn) {
    return <p className="mt-8 text-sm text-stone-500">Composing a question…</p>;
  }

  if (result) {
    return (
      <div className="mt-8">
        <h2 className="text-lg font-medium">Recorded.</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          {result.cellsWritten} dashboard cell
          {result.cellsWritten === 1 ? "" : "s"} written for today, and{" "}
          {result.outcomes.length} concept{result.outcomes.length === 1 ? "" : "s"} marked.
        </p>
        <ScoreTally scoreByLo={result.scoreByLo} />
        {sessionType === "daily" && <Outcomes outcomes={result.outcomes} />}
        {result.debrief && <Debrief debrief={result.debrief} />}
        <Link href="/dashboard" className="mt-6 inline-block text-sm underline">
          Back to the dashboard
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mt-8">
        <h2 className="text-lg font-medium">
          {sessionType === "daily" ? "That is today's practice." : "That is the lecture for today."}
        </h2>
        <p className="mt-2 max-w-xl text-sm text-stone-600 dark:text-stone-400">
          Finishing records one dashboard cell per objective — the lowest score
          it earned today — and marks each concept the sitting tested. A
          concept never tested is left as it was.
        </p>
        {error && <ErrorNote message={error} />}
        <button
          type="button"
          onClick={finish}
          disabled={busy === "finishing"}
          className="mt-6 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy === "finishing" ? "Recording…" : "Finish and record the day"}
        </button>
      </div>
    );
  }

  if (!turn) {
    return (
      <div className="mt-8">
        {error ? <ErrorNote message={error} /> : null}
        <button
          type="button"
          onClick={() => void loadTurn()}
          className="mt-4 text-sm underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between gap-4 text-xs text-stone-500">
        <span className="uppercase tracking-wide">
          {STAGE_LABEL[turn.stage]}
          {turn.stage !== "reflection" && ` · ${turn.format.replace(/_/g, " ")}`}
        </span>
        <span>
          {turn.total ? `${turn.position} of ${turn.total}` : `Question ${turn.position}`}
        </span>
      </div>

      {turn.lectureTitle && (
        <p className="mt-3 text-[10px] uppercase tracking-wide text-stone-400">
          {turn.lectureTitle}
        </p>
      )}

      {turn.objective && (
        <p className="mt-3 rounded-md border-l-2 border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
          {turn.objective}
        </p>
      )}

      <p className="mt-5 text-lg">{turn.question}</p>

      {hint && (
        <p className="mt-4 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
          <span className="font-medium">Cue: </span>
          {hint}
        </p>
      )}

      {!feedback && (
        <>
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={8}
            autoFocus
            placeholder={
              turn.stage === "reflection"
                ? "In your own words. This is not graded."
                : "Everything you can remember. Write it out before checking."
            }
            className="mt-4 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />

          {error && <ErrorNote message={error} />}

          <div className="mt-4 flex items-center gap-4">
            <button
              type="button"
              onClick={grade}
              disabled={busy !== null || answer.trim().length === 0}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
            >
              {busy === "grading"
                ? turn.stage === "reflection"
                  ? "Saving…"
                  : "Checking…"
                : turn.stage === "reflection"
                  ? "Save and continue"
                  : "Submit answer"}
            </button>

            {turn.stage !== "reflection" && (
              <button
                type="button"
                onClick={cue}
                disabled={busy !== null || turn.hintsUsed}
                className="text-sm text-stone-600 underline disabled:no-underline disabled:opacity-40 dark:text-stone-400"
              >
                {turn.hintsUsed ? "Cue taken" : "I need a cue"}
              </button>
            )}
          </div>

          {turn.stage !== "reflection" && (
            <p className="mt-2 text-xs text-stone-500">
              A cue caps this answer at 4 — correct with help is not independent
              recall.
            </p>
          )}
        </>
      )}

      {feedback && <FeedbackPanel feedback={feedback} onContinue={loadTurn} />}
    </div>
  );
}

/** How many objectives landed on each score today. */
function ScoreTally({ scoreByLo }: { scoreByLo: Record<number, Score> }) {
  const scores = Object.values(scoreByLo);
  if (scores.length === 0) return null;

  const counts = SCORES_DESC.map((score) => ({
    score,
    count: scores.filter((s) => s === score).length,
  }));

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {counts.map(
        ({ score, count }) =>
          count > 0 && (
            <span
              key={score}
              title={SCORE_LABEL[score]}
              className={`rounded px-2 py-0.5 text-xs font-medium ${scoreStyle(score)}`}
            >
              {count} × {score}
            </span>
          ),
      )}
    </div>
  );
}

function FeedbackPanel({
  feedback,
  onContinue,
}: {
  feedback: Feedback;
  onContinue: () => Promise<void>;
}) {
  const { grade, score, modelScore, marks } = feedback;

  return (
    <div className="mt-6 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
      {feedback.why && (
        <p className="mb-3 text-xs text-stone-500">{whyLine(feedback.why)}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${scoreStyle(score)}`}
        >
          {SCORE_LABEL[score]}
        </span>
        {score !== modelScore && (
          <span className="text-xs text-stone-500">
            capped from {modelScore} — you took a cue
          </span>
        )}
      </div>

      {marks.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {marks.map((marked) => (
            <span
              key={marked.reviewItemId}
              title={`${marked.concept} — ${MARK_LABEL[marked.mark]}`}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${MARK_STYLE[marked.mark]}`}
            >
              {marked.ordinal > 0 ? `#${marked.ordinal}` : "concept"} {marked.mark}
            </span>
          ))}
        </div>
      )}

      <FeedbackList title="Correct" items={grade.correct} />
      <FeedbackList title="Missing" items={grade.missing} />
      <FeedbackList title="Wrong" items={grade.incorrect} />

      {/* A complete answer needs no correction, and the model returns an empty
          string for one. Rendering the heading anyway looks like a bug. */}
      <FeedbackBlock title="The correction" body={grade.correction} />
      <FeedbackBlock title="Model answer" body={grade.modelAnswer} muted />

      {grade.followUp && (
        <div className="mt-4 rounded-md bg-stone-50 px-3 py-2 dark:bg-stone-900">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Before you move on
          </h3>
          <p className="mt-1 text-sm">{grade.followUp}</p>
        </div>
      )}

      <button
        type="button"
        onClick={() => void onContinue()}
        className="mt-5 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900"
      >
        Continue
      </button>
    </div>
  );
}

function FeedbackBlock({
  title,
  body,
  muted = false,
}: {
  title: string;
  body: string;
  muted?: boolean;
}) {
  if (body.trim().length === 0) return null;

  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      <p
        className={`mt-1 text-sm ${muted ? "text-stone-700 dark:text-stone-300" : ""}`}
      >
        {body}
      </p>
    </div>
  );
}

function FeedbackList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;

  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {message}
    </p>
  );
}
