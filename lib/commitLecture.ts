import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { LectureExtract } from "@/lib/extract";

export interface ApprovedObjective {
  /** Index into the draft's learningObjectives, or -1 if added by hand. */
  draftIndex: number;
  text: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Commits reviewed objectives to the dashboard and seeds concept-level review
 * items. Review items are keyed to objectives but live in their own table, so
 * scheduling can be fine-grained without ever adding a dashboard row.
 */
export async function commitLecture(
  lectureId: number,
  approved: ApprovedObjective[],
): Promise<{ objectivesCreated: number; reviewItemsCreated: number }> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });

  if (!lecture) throw new Error(`Lecture ${lectureId} not found.`);
  if (lecture.committedAt) {
    throw new Error("This lecture has already been committed.");
  }

  const kept = approved.filter((o) => o.text.trim().length > 0);
  if (kept.length === 0) {
    throw new Error("Approve at least one learning objective.");
  }

  const draft = lecture.draftExtract as LectureExtract | null;

  const insertedObjectives = await db
    .insert(schema.learningObjectives)
    .values(
      kept.map((objective, index) => ({
        lectureId,
        text: objective.text.trim(),
        orderIndex: index,
      })),
    )
    .returning({ id: schema.learningObjectives.id });

  // draft index -> new objective id, for wiring concepts to objectives.
  const objectiveIdByDraftIndex = new Map<number, number>();
  kept.forEach((objective, index) => {
    if (objective.draftIndex >= 0) {
      objectiveIdByDraftIndex.set(
        objective.draftIndex,
        insertedObjectives[index].id,
      );
    }
  });

  const reviewItems: (typeof schema.reviewItems.$inferInsert)[] = [];
  const due = todayIso();

  for (const concept of draft?.concepts ?? []) {
    // Attach to the first surviving objective this concept relates to.
    const loId = concept.relatedObjectiveIndexes
      .map((i) => objectiveIdByDraftIndex.get(i))
      .find((id): id is number => id !== undefined);

    // A concept whose objectives were all deleted has nothing to hang from.
    if (loId === undefined) continue;

    reviewItems.push({
      loId,
      concept: concept.detail ? `${concept.label} — ${concept.detail}` : concept.label,
      kind: concept.kind,
      provenance: concept.provenance,
      dueOn: due,
      intervalDays: 0,
    });
  }

  if (reviewItems.length > 0) {
    await db.insert(schema.reviewItems).values(reviewItems);
  }

  await db
    .update(schema.lectures)
    .set({ committedAt: new Date() })
    .where(eq(schema.lectures.id, lectureId));

  return {
    objectivesCreated: insertedObjectives.length,
    reviewItemsCreated: reviewItems.length,
  };
}
