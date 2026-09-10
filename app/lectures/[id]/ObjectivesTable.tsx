import { BADGE, EMPHASIS_BADGE, PROVENANCE_STYLE, QUIZ_BADGE } from "@/app/components/badges";
import { SUSPENDED_STYLE } from "@/app/components/scores";
import { SuspendToggle } from "@/app/components/SuspendToggle";
import type { ConceptRow, ObjectiveConcepts } from "@/lib/concepts";

/**
 * The lecture's objectives, each folding open on its numbered concepts.
 * This is where the student checks what a read produced and suspends what
 * should not be quizzed: an objective the model invented, a concept the
 * lecturer set aside and the student agrees about. Suspension keeps the row
 * and its number; nothing here deletes.
 */
export default function ObjectivesTable({
  objectives,
}: {
  objectives: ObjectiveConcepts[];
}) {
  if (objectives.length === 0) {
    return (
      <p className="mt-6 text-sm text-stone-500">
        No objectives yet. Add the deck above and press Extract.
      </p>
    );
  }

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
        Learning objectives ({objectives.length})
      </h2>
      <p className="mt-1 text-xs text-stone-500">
        Each objective opens on its concepts, numbered in the lecture&rsquo;s
        order. A concept the lecturer set aside starts suspended; reactivate it
        to have it quizzed. Suspending keeps a row and its number, and leaves it
        out of every session.
      </p>

      {objectives.map((objective) => (
        <ObjectiveRow key={objective.id} objective={objective} />
      ))}
    </section>
  );
}

function ObjectiveRow({ objective }: { objective: ObjectiveConcepts }) {
  const suspendedItems = objective.items.filter((item) => item.suspended).length;

  return (
    <div className="mt-3 flex items-start gap-3">
      {/* The objective's toggle sits beside the disclosure, not inside its
          summary, so clicking it never folds the section as well. */}
      <details
        open
        className="min-w-0 flex-1 rounded-lg border border-stone-200 dark:border-stone-800"
      >
        <summary
          className={`cursor-pointer px-4 py-3 text-sm font-medium ${
            objective.suspended ? "text-stone-400 dark:text-stone-600" : ""
          }`}
        >
          {objective.suspended && (
            <span
              title="Suspended — not quizzed until reactivated"
              className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${SUSPENDED_STYLE} align-middle`}
            />
          )}
          {objective.text}
          <span className="ml-2 text-xs font-normal text-stone-400">
            {objective.items.length} concept{objective.items.length === 1 ? "" : "s"}
            {suspendedItems > 0 && ` · ${suspendedItems} suspended`}
            {objective.suspended && " · not in play"}
          </span>
        </summary>

        {objective.items.length === 0 ? (
          <p className="border-t border-stone-200 px-4 py-3 text-sm text-stone-500 dark:border-stone-800">
            No concepts were extracted for this objective.
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-stone-200 dark:border-stone-800">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Concept</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Suspend</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {objective.items.map((item) => (
                  <ConceptLine key={item.id} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <div className="pt-3">
        <SuspendToggle
          endpoint={`/api/objectives/${objective.id}/suspend`}
          suspended={objective.suspended}
          subject="objective"
        />
      </div>
    </div>
  );
}

function ConceptLine({ item }: { item: ConceptRow }) {
  const emphasis = EMPHASIS_BADGE[item.emphasis];

  return (
    <tr
      className={`border-t border-stone-200 dark:border-stone-800 ${
        item.suspended ? "text-stone-400 dark:text-stone-600" : ""
      }`}
    >
      <td className="px-3 py-2 align-top font-mono text-xs text-stone-400">
        {item.suspended && (
          <span
            title="Suspended — not quizzed until reactivated"
            className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-sm ${SUSPENDED_STYLE} align-middle`}
          />
        )}
        {item.ordinal > 0 ? item.ordinal : "—"}
      </td>
      <td className="px-3 py-2 align-top">
        <span>{item.concept}</span>
        <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
          {item.provenance !== "taught" && (
            <span className={`${BADGE} ${PROVENANCE_STYLE[item.provenance]}`}>
              {item.provenance}
            </span>
          )}
          {emphasis && (
            <span title={item.emphasisCue} className={`${BADGE} ${emphasis.style}`}>
              {emphasis.label}
            </span>
          )}
          {item.practiceQuestions.length > 0 && (
            <span
              title={item.practiceQuestions.join("\n")}
              className={`${BADGE} ${QUIZ_BADGE.style}`}
            >
              {QUIZ_BADGE.label}
            </span>
          )}
        </span>
        {emphasis && item.emphasisCue && (
          <p className="mt-1 text-xs italic text-stone-500">
            &ldquo;{item.emphasisCue}&rdquo;
          </p>
        )}
      </td>
      <td className="px-3 py-2 align-top text-stone-500">{item.kind}</td>
      <td className="px-3 py-2 align-top">
        <SuspendToggle
          endpoint={`/api/review-items/${item.id}/suspend`}
          suspended={item.suspended}
          subject="concept"
        />
      </td>
    </tr>
  );
}
