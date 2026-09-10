import Link from "next/link";
import { notFound } from "next/navigation";
import { MARK_LABEL, MARK_STYLE, SUSPENDED_STYLE } from "@/app/components/scores";
import { SuspendToggle } from "@/app/components/SuspendToggle";
import { lectureConcepts, type ConceptRow } from "@/lib/concepts";

export const dynamic = "force-dynamic";

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

  if (view.objectives.length === 0) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          No objectives yet.{" "}
          <Link href={`/lectures/${view.id}`} className="underline">
            Add the lecture&rsquo;s files and extract them
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
        The LO Map: every concept under each objective, numbered, with where
        it stands and how it was marked on each day it was tested. A concept
        marked <em>quiz</em> is tested by one of the lecture's own practice
        questions. Suspend a
        concept to keep its number but leave it out of every session.
      </p>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-400">
        {(["green", "yellow", "red"] as const).map((mark) => (
          <span key={mark} className="flex items-center gap-1.5">
            <span className={`inline-block h-3 w-3 rounded-sm ${MARK_STYLE[mark]}`} />
            {MARK_LABEL[mark]}
          </span>
        ))}
      </div>

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
                className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${SUSPENDED_STYLE} align-middle`}
              />
            )}
            {objective.text}
            <span className="ml-2 text-xs font-normal text-stone-400">
              {objective.items.length} concept{objective.items.length === 1 ? "" : "s"}
              {suspendedCount(objective.items) > 0 &&
                ` · ${suspendedCount(objective.items)} suspended`}
              {objective.suspended && " · not in play"}
            </span>
          </h2>

          {objective.items.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">No concepts were extracted for this objective.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Concept</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Last</th>
                    <th className="px-3 py-2 font-medium">Interval</th>
                    <th className="px-3 py-2 font-medium">Lapses / streak</th>
                    <th className="px-3 py-2 font-medium">Due</th>
                    {view.dates.map((date) => (
                      <th
                        key={date}
                        className="border-l border-stone-200 px-2 py-2 text-center font-medium whitespace-nowrap dark:border-stone-800"
                      >
                        {date.slice(5)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {objective.items.map((item) => (
                    <ConceptLine key={item.id} item={item} dates={view.dates} />
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

function suspendedCount(items: ConceptRow[]): number {
  return items.filter((item) => item.suspended).length;
}

function ConceptLine({ item, dates }: { item: ConceptRow; dates: string[] }) {
  return (
    <tr
      className={`border-t border-stone-200 dark:border-stone-800 ${
        item.suspended ? "text-stone-400 dark:text-stone-600" : ""
      }`}
    >
      <td className="px-3 py-2 font-mono text-xs text-stone-400">
        {item.suspended && (
          <span
            title="Suspended — not quizzed until reactivated"
            className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-sm ${SUSPENDED_STYLE} align-middle`}
          />
        )}
        {item.ordinal > 0 ? item.ordinal : "—"}
      </td>
      <td className="px-3 py-2">
        <span className="flex items-baseline justify-between gap-3">
          <span>
            {item.concept}
            {item.provenance !== "taught" && (
              <span className="ml-2 text-xs text-stone-400">{item.provenance}</span>
            )}
            {item.practiceQuestions.length > 0 && (
              <span
                title={item.practiceQuestions.join("\n")}
                className="ml-2 rounded bg-fuchsia-100 px-1 py-0.5 text-[10px] uppercase tracking-wide text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200"
              >
                quiz
              </span>
            )}
            {item.suspended && (
              <span className="ml-2 text-xs text-stone-400">not in play</span>
            )}
          </span>
          <SuspendToggle
            endpoint={`/api/review-items/${item.id}/suspend`}
            suspended={item.suspended}
            subject="concept"
          />
        </span>
      </td>
      <td className="px-3 py-2 text-stone-500">{item.kind}</td>
      <td className="px-3 py-2">{item.tier}</td>
      <td className="px-3 py-2">
        {item.lastRating ? (
          <span
            title={MARK_LABEL[item.lastRating]}
            className={`inline-block h-4 w-4 rounded-sm ${MARK_STYLE[item.lastRating]}`}
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
      {dates.map((date) => {
        const mark = item.marks[date];
        return (
          <td
            key={date}
            className="border-l border-stone-200 px-2 py-2 text-center dark:border-stone-800"
          >
            {mark ? (
              <span
                title={`${date}: ${MARK_LABEL[mark]}`}
                className={`inline-block h-4 w-4 rounded-sm ${MARK_STYLE[mark]}`}
              />
            ) : (
              <span className="sr-only">not tested</span>
            )}
          </td>
        );
      })}
    </tr>
  );
}
