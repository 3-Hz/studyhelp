import { count, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export interface LectureSummary {
  id: number;
  title: string;
  committedAt: Date | null;
  createdAt: Date;
  objectiveCount: number;
  conceptCount: number;
  /** Files attached, so the list can tell "not extracted yet" from "empty". */
  sourceCount: number;
}

/**
 * Lectures with their objective, concept and file counts, newest first.
 *
 * The counts are separate grouped queries rather than correlated subqueries
 * in a raw `sql` template. Drizzle renders interpolated columns *unqualified*
 * inside such a template, producing `WHERE "lecture_id" = "id"` — and because
 * learning_objectives has its own `id` column, SQLite resolves both names
 * against the inner table. That silently self-compares instead of correlating,
 * returning the same wrong count for every row rather than failing.
 */
export async function listLectures(): Promise<LectureSummary[]> {
  const lectures = await db
    .select({
      id: schema.lectures.id,
      title: schema.lectures.title,
      committedAt: schema.lectures.committedAt,
      createdAt: schema.lectures.createdAt,
    })
    .from(schema.lectures)
    .orderBy(desc(schema.lectures.createdAt));

  const objectiveCounts = await db
    .select({
      lectureId: schema.learningObjectives.lectureId,
      total: count(),
    })
    .from(schema.learningObjectives)
    .groupBy(schema.learningObjectives.lectureId);

  // Concepts hang from objectives, so they are counted through the join.
  const conceptCounts = await db
    .select({
      lectureId: schema.learningObjectives.lectureId,
      total: count(schema.reviewItems.id),
    })
    .from(schema.reviewItems)
    .innerJoin(
      schema.learningObjectives,
      eq(schema.reviewItems.loId, schema.learningObjectives.id),
    )
    .groupBy(schema.learningObjectives.lectureId);

  const sourceCounts = await db
    .select({
      lectureId: schema.lectureSources.lectureId,
      total: count(),
    })
    .from(schema.lectureSources)
    .groupBy(schema.lectureSources.lectureId);

  const byLecture = (rows: { lectureId: number; total: number }[]) =>
    new Map(rows.map((row) => [row.lectureId, row.total]));
  const objectives = byLecture(objectiveCounts);
  const concepts = byLecture(conceptCounts);
  const sources = byLecture(sourceCounts);

  return lectures.map((lecture) => ({
    ...lecture,
    objectiveCount: objectives.get(lecture.id) ?? 0,
    conceptCount: concepts.get(lecture.id) ?? 0,
    sourceCount: sources.get(lecture.id) ?? 0,
  }));
}
