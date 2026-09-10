"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OpenReview } from "@/lib/session/openReviews";

/**
 * Reviews the student started and left. Resume is a link: the session
 * re-derives its place from what has been graded, so it picks up where it
 * stopped. Finish now records what was graded on the day it is pressed and
 * closes the session, so a stale one need not stay open for ever.
 */
export default function OpenReviews({ reviews }: { reviews: OpenReview[] }) {
  if (reviews.length === 0) return null;

  return (
    <section className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950">
      <h2 className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Unfinished review{reviews.length === 1 ? "" : "s"}
      </h2>
      <ul className="mt-1 divide-y divide-amber-200 dark:divide-amber-900">
        {reviews.map((review) => (
          <ReviewRow key={review.id} review={review} />
        ))}
      </ul>
    </section>
  );
}

function ReviewRow({ review }: { review: OpenReview }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${review.id}/finish`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not finish.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div>
        <p className="text-sm font-medium">
          {review.lectures.map((lecture) => lecture.title).join(" · ")}
        </p>
        <p className="text-xs text-stone-600 dark:text-stone-400">
          started {review.startedOn} · {review.answered} answered
          {review.minutes !== null && ` · ${review.minutes} min`}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Link
          href={`/sessions/${review.id}`}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900"
        >
          Resume
        </Link>
        <button
          type="button"
          onClick={finish}
          disabled={busy}
          title="Record what was graded and close this review"
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-stone-700"
        >
          {busy ? "Finishing…" : "Finish now"}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </li>
  );
}
