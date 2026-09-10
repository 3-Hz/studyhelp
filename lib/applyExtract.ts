import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { LectureExtract } from "@/lib/extract";
import { todayIso } from "@/lib/schedule";
import {
  reconcileConcepts,
  reconcileObjectives,
  reconcileQuestions,
} from "./reconcile";

export interface ApplyResult {
  objectivesCreated: number;
  objectivesMatched: number;
  reviewItemsCreated: number;
  reviewItemsMatched: number;
  /** Matched concepts whose emphasis a stronger cue moved. */
  reviewItemsRefreshed: number;
  practiceQuestionsCreated: number;
}

/**
 * Writes an extraction onto a lecture's rows: the dashboard objectives, the
 * numbered concepts under each, and the lecture's own practice questions.
 *
 * The same function serves a first extraction and every amend. Rows the
 * extraction names again are matched by wording and left as they are; what
 * is new appends with the next number. Applying one extract twice writes
 * nothing the second time, which is also the recovery path: the raw extract
 * is saved before this runs, and a write that failed halfway completes on
 * the next Extract. No transaction, as nowhere else in the app.
 */
export async function applyExtract(
  lectureId: number,
  extract: LectureExtract,
  today: string = todayIso(),
): Promise<ApplyResult> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });
  if (!lecture) throw new Error(`Lecture ${lectureId} not found.`);

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
    orderBy: [asc(schema.learningObjectives.orderIndex)],
  });
  const items =
    objectives.length === 0
      ? []
      : await db.query.reviewItems.findMany({
          where: inArray(
            schema.reviewItems.loId,
            objectives.map((objective) => objective.id),
          ),
        });
  const questions = await db.query.practiceQuestions.findMany({
    where: eq(schema.practiceQuestions.lectureId, lectureId),
  });

  // Objectives first: the concepts hang from their ids.
  const objectivePlan = reconcileObjectives(objectives, extract.learningObjectives);
  const loIdByExtractIndex = new Map(objectivePlan.matched);
  if (objectivePlan.inserts.length > 0) {
    const inserted = await db
      .insert(schema.learningObjectives)
      .values(
        objectivePlan.inserts.map((insert) => ({
          lectureId,
          text: insert.text,
          orderIndex: insert.orderIndex,
        })),
      )
      .returning({ id: schema.learningObjectives.id });
    objectivePlan.inserts.forEach((insert, i) => {
      for (const index of insert.extractIndexes) {
        loIdByExtractIndex.set(index, inserted[i].id);
      }
    });
  }

  // Then the concepts, whose ids the questions link to.
  const itemPlan = reconcileConcepts(
    items.map((item) => ({
      id: item.id,
      loId: item.loId,
      ordinal: item.ordinal,
      // Rows written before labels existed carry an empty one.
      label: item.label || item.concept.split(" — ")[0],
      emphasis: item.emphasis,
      emphasisCue: item.emphasisCue,
    })),
    extract.concepts,
    loIdByExtractIndex,
    today,
  );
  const itemIdByExtractIndex = new Map(itemPlan.matched);
  if (itemPlan.inserts.length > 0) {
    const inserted = await db
      .insert(schema.reviewItems)
      .values(itemPlan.inserts.map(({ extractIndexes: _, ...row }) => row))
      .returning({ id: schema.reviewItems.id });
    itemPlan.inserts.forEach((insert, i) => {
      for (const index of insert.extractIndexes) {
        itemIdByExtractIndex.set(index, inserted[i].id);
      }
    });
  }
  for (const update of itemPlan.updates) {
    await db
      .update(schema.reviewItems)
      .set({ emphasis: update.emphasis, emphasisCue: update.emphasisCue })
      .where(eq(schema.reviewItems.id, update.id));
  }

  const questionPlan = reconcileQuestions(
    questions,
    extract.practiceQuestions,
    loIdByExtractIndex,
    itemIdByExtractIndex,
  );
  if (questionPlan.inserts.length > 0) {
    await db
      .insert(schema.practiceQuestions)
      .values(questionPlan.inserts.map((insert) => ({ lectureId, ...insert })));
  }
  for (const update of questionPlan.updates) {
    await db
      .update(schema.practiceQuestions)
      .set({ reviewItemIds: update.reviewItemIds })
      .where(eq(schema.practiceQuestions.id, update.id));
  }

  return {
    objectivesCreated: objectivePlan.inserts.length,
    objectivesMatched: objectivePlan.matched.size,
    reviewItemsCreated: itemPlan.inserts.length,
    reviewItemsMatched: itemPlan.matched.size,
    reviewItemsRefreshed: itemPlan.updates.length,
    practiceQuestionsCreated: questionPlan.inserts.length,
  };
}
