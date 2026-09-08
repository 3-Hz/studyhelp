import Link from "next/link";
import { ReviewPicker, type PickableLecture } from "@/app/components/ReviewPicker";
import { listLectures } from "@/lib/lectures";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const lectures = await listLectures();
  const pending = lectures.filter((l) => !l.committedAt);

  const rows: PickableLecture[] = lectures.map((lecture) => ({
    id: lecture.id,
    title: lecture.title,
    committed: lecture.committedAt !== null,
    objectiveCount: lecture.objectiveCount,
    addedOn: lecture.createdAt.toISOString().slice(0, 10),
  }));

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
          <p className="mt-1 max-w-xl text-sm text-stone-500">
            Tick the lectures to review and say how long you have. A review
            is first-order throughout: recall each objective, then the
            concepts the recall left short, switching between lectures.
          </p>

          {pending.length > 0 && (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {pending.length} lecture{pending.length === 1 ? "" : "s"} awaiting
              review before the objectives reach the dashboard.
            </p>
          )}

          <ReviewPicker lectures={rows} />
        </>
      )}
    </div>
  );
}
