import Link from "next/link";
import { notFound } from "next/navigation";
import { MARK_STYLE, SUSPENDED_STYLE } from "@/app/components/scores";
import { lectureConcepts, type ConceptRow } from "@/lib/concepts";

export const dynamic = "force-dynamic";

const SWATCH = { ...MARK_STYLE, suspended: SUSPENDED_STYLE };

function dueLabel(dueIn: number): string {
  if (dueIn < 0) return `overdue ${-dueIn}d`;
  if (dueIn === 0) return "due today";
  return `due in ${dueIn}d`;
}

export default async function ConceptsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lectureId = Number(id);
  if (!Number.isInteger(lectureId)) notFound();

  const view = await lectureConcepts(lectureId);
  if (!view) notFound();

  if (!view.committedAt) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          Nothing to show until the objectives are committed.{" "}
          <Link href={`/lectures/${view.id}/review`} className="underline">
            Review the draft
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
      <p className="mt-1 text-sm text-stone-500">
        Every concept the scheduler tracks under each objective, and where it stands.
      </p>

      {view.objectives.map((objective) => (
        <section key={objective.id} className="mt-8">
          <h2
            className={`text-base font-medium ${
              objective.suspended ? "text-stone-400 dark:text-stone-600" : ""
            }`}
          >
            {objective.suspended && (
              <span
                title="Suspended — not quizzed until reactivated"
                className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${SWATCH.suspended} align-middle`}
              />
            )}
            {objective.text}
            {objective.suspended && (
              <span className="ml-2 text-xs font-normal text-stone-400">not in play</span>
            )}
          </h2>

          {objective.items.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">No concepts were extracted for this objective.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500">
                    <th className="px-3 py-2 font-medium">Concept</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Last</th>
                    <th className="px-3 py-2 font-medium">Interval</th>
                    <th className="px-3 py-2 font-medium">Lapses / streak</th>
                    <th className="px-3 py-2 font-medium">Due</th>
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
        </section>
      ))}
    </div>
  );
}

function ConceptLine({ item }: { item: ConceptRow }) {
  return (
    <tr className="border-t border-stone-200 dark:border-stone-800">
      <td className="px-3 py-2">
        {item.concept}
        {item.provenance !== "taught" && (
          <span className="ml-2 text-xs text-stone-400">{item.provenance}</span>
        )}
      </td>
      <td className="px-3 py-2 text-stone-500">{item.kind}</td>
      <td className="px-3 py-2">{item.tier}</td>
      <td className="px-3 py-2">
        {item.lastRating ? (
          <span
            title={item.lastRating}
            className={`inline-block h-4 w-4 rounded-sm ${SWATCH[item.lastRating]}`}
          />
        ) : (
          <span className="text-stone-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-stone-500">{item.intervalDays}d</td>
      <td className="px-3 py-2 text-stone-500">
        {item.lapses} / {item.streak}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {item.dueOn}{" "}
        <span className={item.dueIn < 0 ? "text-red-600 dark:text-red-400" : "text-stone-500"}>
          ({dueLabel(item.dueIn)})
        </span>
      </td>
    </tr>
  );
}
