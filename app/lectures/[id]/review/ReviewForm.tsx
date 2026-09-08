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

/** The lecturer's cue, when there was one. Neutral concepts carry no badge. */
const EMPHASIS_BADGE: Record<string, { label: string; style: string }> = {
  emphasized: {
    label: "lecturer emphasized",
    style: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  deemphasized: {
    label: "lecturer set aside",
    style: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  },
};

type DraftConcept = LectureExtract["concepts"][number];

/** Drafts extracted before emphasis existed carry no cue. */
function emphasisOf(concept: DraftConcept): string {
  return concept.emphasis ?? "neutral";
}

export interface SlideSource {
  text: string;
  /** Which file this slide came from, and its number inside that file. */
  label: string;
}

export default function ReviewForm({
  lectureId,
  draft,
  slidesByOrdinal,
}: {
  lectureId: number;
  draft: LectureExtract;
  slidesByOrdinal: Record<number, SlideSource>;
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
  // Which concepts start active, by draft index. A concept the lecturer set
  // aside starts unticked; unticked concepts are committed suspended, not
  // dropped, so the LO Map can bring them back.
  const [ticked, setTicked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(
      draft.concepts.map((concept, index) => [
        index,
        emphasisOf(concept) !== "deemphasized",
      ]),
    ),
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
          concepts: draft.concepts
            .map((_, index) => index)
            .filter((index) => ticked[index]),
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

  // Concepts under the first objective each serves, as commit will file them;
  // -1 collects concepts that name no objective. Draft order within a group
  // is the lecture's order, which is what the numbering means.
  const conceptGroups = (() => {
    const groups = new Map<number, { draftIndex: number; concept: DraftConcept }[]>();
    draft.concepts.forEach((concept, draftIndex) => {
      const objectiveIndex = concept.relatedObjectiveIndexes[0] ?? -1;
      const list = groups.get(objectiveIndex) ?? [];
      list.push({ draftIndex, concept });
      groups.set(objectiveIndex, list);
    });
    return [...groups.entries()]
      .sort((a, b) => (a[0] === -1 ? 1 : b[0] === -1 ? -1 : a[0] - b[0]))
      .map(([draftIndex, concepts]) => ({ draftIndex, concepts }));
  })();

  const schedulable = draft.concepts.filter(
    (concept, index) => concept.relatedObjectiveIndexes.length > 0 && ticked[index],
  ).length;

  // Drafts extracted before Phase 5 carry no practice questions.
  const practiceQuestions = draft.practiceQuestions ?? [];

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
                          <div key={ref}>
                            <p className="font-mono text-[10px] uppercase tracking-wide text-stone-400">
                              {slidesByOrdinal[ref]?.label ?? `slide ${ref}`}
                            </p>
                            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-stone-100 p-3 font-mono text-xs text-stone-700 dark:bg-stone-900 dark:text-stone-300">
                              {slidesByOrdinal[ref]?.text ??
                                "(slide text unavailable)"}
                            </pre>
                          </div>
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
          Concepts to be scheduled ({schedulable} of {draft.concepts.length})
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Numbered under the objective each serves, in the order the lecture
          presented them — the numbers a session marks. Anything marked{" "}
          <em>supplemental</em> is outside the lecture materials. An unticked
          concept keeps its number but starts suspended; the LO Map can bring
          it back. Concepts the lecturer set aside start unticked.
        </p>
        {conceptGroups.map((group) => (
          <div key={group.draftIndex} className="mt-4">
            <h3 className="text-xs font-medium text-stone-600 dark:text-stone-400">
              {group.draftIndex === -1
                ? "Not tied to an objective — these will not be scheduled"
                : objectives[group.draftIndex]?.text || `Objective ${group.draftIndex + 1}`}
              <span className="ml-2 text-stone-400">
                {group.concepts.length} concept{group.concepts.length === 1 ? "" : "s"}
              </span>
            </h3>
            <ol className="mt-2 grid gap-2 sm:grid-cols-2">
              {group.concepts.map(({ draftIndex, concept }, index) => {
                const badge = EMPHASIS_BADGE[emphasisOf(concept)];
                const active = group.draftIndex !== -1 && ticked[draftIndex];
                return (
                  <li
                    key={draftIndex}
                    className={`rounded-md border p-3 text-sm ${
                      active
                        ? "border-stone-200 dark:border-stone-800"
                        : "border-stone-200 bg-stone-100 opacity-50 dark:border-stone-800 dark:bg-stone-900"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {group.draftIndex !== -1 && (
                        <input
                          type="checkbox"
                          checked={ticked[draftIndex]}
                          onChange={(e) =>
                            setTicked((prev) => ({ ...prev, [draftIndex]: e.target.checked }))
                          }
                          aria-label="Schedule this concept"
                        />
                      )}
                      <span className="font-mono text-xs text-stone-400">{index + 1}.</span>
                      <span className="font-medium">{concept.label}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                          PROVENANCE_STYLE[concept.provenance] ?? ""
                        }`}
                      >
                        {concept.provenance}
                      </span>
                      {badge && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badge.style}`}
                        >
                          {badge.label}
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-stone-400">
                        {concept.kind}
                      </span>
                    </div>
                    <p className="mt-1 text-stone-600 dark:text-stone-400">
                      {concept.detail}
                    </p>
                    {badge && concept.emphasisCue && (
                      <p className="mt-1 text-xs italic text-stone-500">
                        “{concept.emphasisCue}”
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </section>

      {practiceQuestions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Practice questions the lecture poses ({practiceQuestions.length})
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            Kept with the lecture. A session prefers one of these when it fits
            the concept being tested.
          </p>
          <ul className="mt-4 space-y-2">
            {practiceQuestions.map((item, index) => (
              <li
                key={index}
                className="rounded-md border border-stone-200 p-3 text-sm dark:border-stone-800"
              >
                <p className="font-medium">{item.question}</p>
                <p className="mt-1 text-stone-600 dark:text-stone-400">
                  {item.answer || "(no answer given in the materials)"}
                </p>
                {item.slideRefs.length > 0 && (
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-stone-400">
                    Slide{item.slideRefs.length > 1 ? "s" : ""} {item.slideRefs.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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
