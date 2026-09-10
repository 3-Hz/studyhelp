"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_MINUTES } from "@/lib/session/budget";
import { MinutesSelect } from "./MinutesSelect";

export interface PickableLecture {
  id: number;
  title: string;
  /** Has at least one objective, so a review has something to ask. */
  reviewable: boolean;
  objectiveCount: number;
  conceptCount: number;
  sourceCount: number;
  /** YYYY-MM-DD, formatted on the server so the two renders agree. */
  addedOn: string;
}

/** Where the lecture stands: read, waiting to be read, or still empty. */
function describe(lecture: PickableLecture): string {
  if (lecture.objectiveCount > 0) {
    return (
      `${lecture.objectiveCount} objective${lecture.objectiveCount === 1 ? "" : "s"}` +
      ` · ${lecture.conceptCount} concept${lecture.conceptCount === 1 ? "" : "s"}`
    );
  }
  if (lecture.sourceCount > 0) {
    return `${lecture.sourceCount} file${lecture.sourceCount === 1 ? "" : "s"}, not extracted yet`;
  }
  return "No materials yet";
}

/**
 * The lecture list with a box beside each lecture that has objectives and
 * one start bar: tick the lectures to review, say how long you have, go.
 * Starting is a POST rather than a link because it creates a row — and
 * rejoins today's unfinished review of the same lectures instead of opening
 * a second one. `afterList` sits between the list and the bar: the place
 * for adding a lecture.
 */
export function ReviewPicker({
  lectures,
  afterList,
}: {
  lectures: PickableLecture[];
  afterList?: React.ReactNode;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: number) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "review", lectureIds: [...chosen], minutes }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start.");
      router.push(`/sessions/${data.sessionId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start.");
      setBusy(false);
    }
  }

  const count = chosen.size;

  return (
    <>
      <ul className="mt-6 divide-y divide-stone-200 dark:divide-stone-800">
        {lectures.map((lecture) => (
          <li
            key={lecture.id}
            className="flex items-baseline justify-between gap-4 py-4"
          >
            <div className="flex items-baseline gap-3">
              {lecture.reviewable ? (
                <input
                  type="checkbox"
                  checked={chosen.has(lecture.id)}
                  onChange={() => toggle(lecture.id)}
                  aria-label={`Review ${lecture.title}`}
                  className="h-4 w-4 accent-stone-900 dark:accent-stone-100"
                />
              ) : (
                <span aria-hidden className="inline-block h-4 w-4" />
              )}
              <div>
                <Link
                  href={`/lectures/${lecture.id}`}
                  className="font-medium hover:underline"
                >
                  {lecture.title}
                </Link>
                <p className="mt-0.5 text-xs text-stone-500">{describe(lecture)}</p>
              </div>
            </div>
            <span className="text-xs text-stone-400">{lecture.addedOn}</span>
          </li>
        ))}
      </ul>

      {afterList}

      <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-4 border-t border-stone-200 bg-stone-50 py-4 dark:border-stone-800 dark:bg-stone-950">
        <MinutesSelect value={minutes} onChange={setMinutes} />
        <button
          type="button"
          onClick={start}
          disabled={busy || count === 0}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy
            ? "Starting…"
            : count === 0
              ? "Tick lectures to review"
              : `Review ${count} lecture${count === 1 ? "" : "s"}`}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </>
  );
}
