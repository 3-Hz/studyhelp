import { count, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export interface LectureSummary {
  id: number;
  title: string;
  committedAt: Date | null;
  createdAt: Date;
  objectiveCount: number;
}

/**
 * Lectures with their committed objective counts, newest first.
 *
 * The count is a separate grouped query rather than a correlated subquery in a
 * raw `sql` template. Drizzle renders interpolated columns *unqualified* inside
 * such a template, producing `WHERE "lecture_id" = "id"` — and because
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

  const counts = await db
    .select({
      lectureId: schema.learningObjectives.lectureId,
      total: count(),
    })
    .from(schema.learningObjectives)
    .groupBy(schema.learningObjectives.lectureId);

  const countByLecture = new Map(counts.map((c) => [c.lectureId, c.total]));

  return lectures.map((lecture) => ({
    ...lecture,
    objectiveCount: countByLecture.get(lecture.id) ?? 0,
  }));
}
