"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LectureExtract } from "@/lib/extract/schema";

interface DraftObjective {
  draftIndex: number;
  text: string;
  slideRefs: number[];
  kept: boolean;
}

const PROVENANCE_STYLE: Record<string, string> = {
  taught:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  derived: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  supplemental: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
};

export default function ReviewForm({
  lectureId,
  draft,
  slideTextByOrdinal,
}: {
  lectureId: number;
  draft: LectureExtract;
  slideTextByOrdinal: Record<number, string>;
}) {
  const router = useRouter();
  const [objectives, setObjectives] = useState<DraftObjective[]>(
    draft.learningObjectives.map((objective, index) => ({
      draftIndex: index,
      text: objective.text,
      slideRefs: objective.slideRefs,
      kept: true,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(index: number, patch: Partial<DraftObjective>) {
    setObjectives((prev) =>
      prev.map((objective, i) =>
        i === index ? { ...objective, ...patch } : objective,
      ),
    );
  }

  function addObjective() {
    setObjectives((prev) => [
      ...prev,
      { draftIndex: -1, text: "", slideRefs: [], kept: true },
    ]);
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/lectures/${lectureId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objectives: objectives
            .filter((o) => o.kept && o.text.trim().length > 0)
            .map((o) => ({ draftIndex: o.draftIndex, text: o.text })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Commit failed.");
      router.push("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Commit failed.");
      setBusy(false);
    }
  }

  const keptCount = objectives.filter(
    (o) => o.kept && o.text.trim().length > 0,
  ).length;

  return (
    <div className="mt-8 space-y-10">
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Learning objectives ({keptCount})
        </h2>

        {objectives.length === 0 && (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The lecture stated no explicit objectives. Add them by hand if the
            course lists them elsewhere.
          </p>
        )}

        <ul className="mt-4 space-y-4">
          {objectives.map((objective, index) => (
            <li
              key={index}
              className={`rounded-lg border p-4 ${
                objective.kept
                  ? "border-stone-300 dark:border-stone-700"
                  : "border-stone-200 bg-stone-100 opacity-50 dark:border-stone-800 dark:bg-stone-900"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={objective.kept}
                  onChange={(e) => update(index, { kept: e.target.checked })}
                  className="mt-2"
                  aria-label="Keep this objective"
                />
                <div className="flex-1">
                  <textarea
                    value={objective.text}
                    onChange={(e) => update(index, { text: e.target.value })}
                    rows={2}
                    className="w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
                  />
                  {objective.slideRefs.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-stone-500">
                        Source — slide{objective.slideRefs.length > 1 ? "s" : ""}{" "}
                        {objective.slideRefs.join(", ")}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {objective.slideRefs.map((ref) => (
                          <pre
                            key={ref}
                            className="overflow-x-auto whitespace-pre-wrap rounded bg-stone-100 p-3 font-mono text-xs text-stone-700 dark:bg-stone-900 dark:text-stone-300"
                          >
                            {slideTextByOrdinal[ref] ?? "(slide text unavailable)"}
                          </pre>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={addObjective}
          className="mt-4 text-sm text-stone-600 underline dark:text-stone-400"
        >
          Add an objective
        </button>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Concepts to be scheduled ({draft.concepts.length})
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          These become internal review items, not dashboard rows. Anything
          marked <em>supplemental</em> is outside the lecture materials.
        </p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {draft.concepts.map((concept, index) => (
            <li
              key={index}
              className="rounded-md border border-stone-200 p-3 text-sm dark:border-stone-800"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{concept.label}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    PROVENANCE_STYLE[concept.provenance] ?? ""
                  }`}
                >
                  {concept.provenance}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-stone-400">
                  {concept.kind}
                </span>
              </div>
              <p className="mt-1 text-stone-600 dark:text-stone-400">
                {concept.detail}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {draft.conflicts.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600">
            Conflicts with general medical knowledge
          </h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {draft.conflicts.map((conflict, index) => (
              <li key={index}>{conflict}</li>
            ))}
          </ul>
        </section>
      )}

      {draft.commonConfusions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Common confusions
          </h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {draft.commonConfusions.map((confusion, index) => (
              <li key={index}>{confusion}</li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={commit}
        disabled={busy || keptCount === 0}
        className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
      >
        {busy
          ? "Committing…"
          : `Commit ${keptCount} objective${keptCount === 1 ? "" : "s"} to the dashboard`}
      </button>
    </div>
  );
}
