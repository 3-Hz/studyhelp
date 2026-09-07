import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { LectureExtract } from "@/lib/extract";
import { todayIso } from "@/lib/schedule";

export interface ApprovedObjective {
  /** Index into the draft's learningObjectives, or -1 if added by hand. */
  draftIndex: number;
  text: string;
}

/**
 * Commits reviewed objectives to the dashboard and seeds concept-level review
 * items. Review items are keyed to objectives but live in their own table, so
 * scheduling can be fine-grained without ever adding a dashboard row.
 */
export async function commitLecture(
  lectureId: number,
  approved: ApprovedObjective[],
): Promise<{
  objectivesCreated: number;
  reviewItemsCreated: number;
  practiceQuestionsCreated: number;
}> {
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

  /** The first surviving objective among the draft indexes given, if any. */
  const survivingObjective = (draftIndexes: number[]): number | undefined =>
    draftIndexes
      .map((i) => objectiveIdByDraftIndex.get(i))
      .find((id): id is number => id !== undefined);

  const reviewItems: (typeof schema.reviewItems.$inferInsert)[] = [];
  const due = todayIso();
  // Concepts are numbered within their objective in the order the extract
  // listed them, which the prompt asks to be the lecture's own order.
  const countByLo = new Map<number, number>();

  for (const concept of draft?.concepts ?? []) {
    // Attach to the first surviving objective this concept relates to.
    const loId = survivingObjective(concept.relatedObjectiveIndexes);

    // A concept whose objectives were all deleted has nothing to hang from.
    if (loId === undefined) continue;

    const ordinal = (countByLo.get(loId) ?? 0) + 1;
    countByLo.set(loId, ordinal);

    reviewItems.push({
      loId,
      ordinal,
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

  // The lecture's own questions stay with the lecture even when the objective
  // they served was rejected: the material asked them, and the tutor can
  // still prefer them.
  const practiceRows = (draft?.practiceQuestions ?? []).map((item) => ({
    lectureId,
    loId: survivingObjective(item.relatedObjectiveIndexes) ?? null,
    question: item.question,
    answer: item.answer,
    slideRefs: item.slideRefs,
  }));

  if (practiceRows.length > 0) {
    await db.insert(schema.practiceQuestions).values(practiceRows);
  }

  await db
    .update(schema.lectures)
    .set({ committedAt: new Date() })
    .where(eq(schema.lectures.id, lectureId));

  return {
    objectivesCreated: insertedObjectives.length,
    reviewItemsCreated: reviewItems.length,
    practiceQuestionsCreated: practiceRows.length,
  };
}
