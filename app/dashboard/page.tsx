import { asc } from "drizzle-orm";
import Link from "next/link";
import {
  SCORE_LABEL,
  SCORES_DESC,
  scoreStyle,
  SUSPENDED_STYLE,
} from "@/app/components/scores";
import { SuspendToggle } from "@/app/components/SuspendToggle";
import { db, schema } from "@/lib/db";
import type { Score } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const objectives = await db.query.learningObjectives.findMany({
    orderBy: [
      asc(schema.learningObjectives.lectureId),
      asc(schema.learningObjectives.orderIndex),
    ],
  });

  const dates = await db.query.studyDates.findMany({
    orderBy: [asc(schema.studyDates.date)],
  });

  const performances = await db.query.performances.findMany();
  const lectures = await db.query.lectures.findMany();

  const lectureTitleById = new Map(lectures.map((l) => [l.id, l.title]));

  // "loId:studyDateId" -> score. A missing key renders as a blank cell,
  // which is the whole point: untested never looks like tested.
  const cellByKey = new Map<string, Score>();
  for (const performance of performances) {
    cellByKey.set(
      `${performance.loId}:${performance.studyDateId}`,
      performance.score,
    );
  }

  if (objectives.length === 0) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">LO Dashboard</h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          No objectives yet.{" "}
          <Link href="/import" className="underline">
            Add a lecture
          </Link>{" "}
          to get started.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">LO Dashboard</h1>
        <p className="text-sm text-stone-500">
          {objectives.length} objectives · {dates.length} study days
        </p>
      </div>

      <div className="mt-6 flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-400">
        {SCORES_DESC.map((score) => (
          <span key={score} className="flex items-center gap-1.5">
            <span
              className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-semibold ${scoreStyle(score)}`}
            >
              {score}
            </span>
            {SCORE_LABEL[score].slice(4)}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-3 rounded-sm ${SUSPENDED_STYLE}`} />
          Suspended — marks the objective, not a day
        </span>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-[24rem] border-b border-r border-stone-200 bg-stone-50 px-4 py-3 text-left font-medium dark:border-stone-800 dark:bg-stone-950">
                Learning objective
              </th>
              {dates.map((date) => (
                <th
                  key={date.id}
                  className="border-b border-stone-200 px-2 py-3 text-xs font-medium whitespace-nowrap dark:border-stone-800"
                >
                  {date.date.slice(5)}
                </th>
              ))}
              {dates.length === 0 && (
                <th className="border-b border-stone-200 px-4 py-3 text-left text-xs font-normal text-stone-500 dark:border-stone-800">
                  No study days recorded yet
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {objectives.map((objective) => (
              <tr
                key={objective.id}
                className="odd:bg-white even:bg-stone-50/60 dark:odd:bg-stone-950 dark:even:bg-stone-900/40"
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-r border-stone-200 bg-inherit px-4 py-3 text-left font-normal dark:border-stone-800"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <Link
                      href={`/lectures/${objective.lectureId}/concepts`}
                      className="block text-[10px] uppercase tracking-wide text-stone-400 hover:underline"
                    >
                      {lectureTitleById.get(objective.lectureId)}
                    </Link>
                    <SuspendToggle
                      objectiveId={objective.id}
                      suspended={objective.suspended}
                    />
                  </span>
                  <span
                    className={
                      objective.suspended ? "text-stone-400 dark:text-stone-600" : ""
                    }
                  >
                    {objective.suspended && (
                      <span
                        title="Suspended — not quizzed until reactivated"
                        className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${SUSPENDED_STYLE} align-middle`}
                      />
                    )}
                    {objective.text}
                  </span>
                </th>
                {dates.map((date) => {
                  const score = cellByKey.get(`${objective.id}:${date.id}`);
                  return (
                    <td key={date.id} className="px-2 py-3 text-center">
                      {score ? (
                        <span
                          title={SCORE_LABEL[score]}
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs font-semibold ${scoreStyle(score)}`}
                        >
                          {score}
                        </span>
                      ) : (
                        <span className="sr-only">not tested</span>
                      )}
                    </td>
                  );
                })}
                {dates.length === 0 && <td />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
