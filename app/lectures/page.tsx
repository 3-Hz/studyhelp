import { ReviewPicker, type PickableLecture } from "@/app/components/ReviewPicker";
import { listLectures } from "@/lib/lectures";
import { openReviews } from "@/lib/session/openReviews";
import AddLecture from "./AddLecture";
import OpenReviews from "./OpenReviews";

export const dynamic = "force-dynamic";

export default async function LecturesPage() {
  const lectures = await listLectures();
  const reviews = await openReviews();

  const rows: PickableLecture[] = lectures.map((lecture) => ({
    id: lecture.id,
    title: lecture.title,
    reviewable: lecture.objectiveCount > 0,
    objectiveCount: lecture.objectiveCount,
    conceptCount: lecture.conceptCount,
    sourceCount: lecture.sourceCount,
    addedOn: lecture.createdAt.toISOString().slice(0, 10),
  }));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Lectures</h1>
      <p className="mt-1 max-w-xl text-sm text-stone-500">
        Add a lecture, open it to give it its files and extract them. Then tick
        the lectures to review and say how long you have. A review is
        first-order throughout: recall each objective, then the concepts the
        recall left short, switching between lectures.
      </p>

      <OpenReviews reviews={reviews} />

      {lectures.length === 0 ? (
        <div className="mt-6">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            No lectures yet.
          </p>
          <AddLecture />
        </div>
      ) : (
        <ReviewPicker lectures={rows} afterList={<AddLecture />} />
      )}
    </div>
  );
}
