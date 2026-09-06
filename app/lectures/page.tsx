import Link from "next/link";
import { StartSessionButton } from "@/app/components/StartSessionButton";
import { listLectures } from "@/lib/lectures";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const lectures = await listLectures();
  const pending = lectures.filter((l) => !l.committedAt);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Lectures</h1>

      {lectures.length === 0 ? (
        <p className="mt-4 max-w-xl text-sm text-stone-600 dark:text-stone-400">
          Nothing ingested yet.{" "}
          <Link href="/import" className="underline">
            Add your first lecture
          </Link>{" "}
          — upload the deck and any transcript or PDF that goes with it.
        </p>
      ) : (
        <>
          {pending.length > 0 && (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {pending.length} lecture{pending.length === 1 ? "" : "s"} awaiting
              review before the objectives reach the dashboard.
            </p>
          )}

          <ul className="mt-6 divide-y divide-stone-200 dark:divide-stone-800">
            {lectures.map((lecture) => (
              <li
                key={lecture.id}
                className="flex items-baseline justify-between gap-4 py-4"
              >
                <div>
                  {lecture.committedAt ? (
                    <Link
                      href={`/lectures/${lecture.id}/concepts`}
                      className="font-medium hover:underline"
                    >
                      {lecture.title}
                    </Link>
                  ) : (
                    <Link
                      href={`/lectures/${lecture.id}/review`}
                      className="font-medium hover:underline"
                    >
                      {lecture.title}
                    </Link>
                  )}
                  <p className="mt-0.5 text-xs text-stone-500">
                    {lecture.committedAt
                      ? `${lecture.objectiveCount} objectives on the dashboard`
                      : "Draft — needs review"}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-stone-400">
                    {lecture.createdAt.toISOString().slice(0, 10)}
                  </span>
                  {lecture.committedAt && (
                    <StartSessionButton lectureId={lecture.id} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
