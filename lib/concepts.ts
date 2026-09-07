import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Mark, Provenance, ReviewKind } from "@/lib/db/schema";
import { daysBetween, tierOf, todayIso, type Tier } from "@/lib/schedule";

export interface ConceptRow {
  id: number;
  /** The concept's number within its objective: what a session marks. */
  ordinal: number;
  concept: string;
  kind: ReviewKind;
  provenance: Provenance;
  tier: Tier;
  intervalDays: number;
  lapses: number;
  streak: number;
  lastRating: Mark | null;
  dueOn: string;
  /** Days until due; negative when overdue. */
  dueIn: number;
  /** The concept's mark on each date it was tested, keyed by ISO date. */
  marks: Record<string, Mark>;
}

export interface ObjectiveConcepts {
  id: number;
  text: string;
  suspended: boolean;
  items: ConceptRow[];
}

export interface LectureConcepts {
  id: number;
  title: string;
  committedAt: Date | null;
  /** Every date on which any of the lecture's concepts was marked, ascending. */
  dates: string[];
  objectives: ObjectiveConcepts[];
}

/**
 * A lecture's objectives and the numbered review items under each, with the
 * state the scheduler works from and the marks each has earned by date: the
 * new prompt's LO Map, with its coloured concept numbers. Read-only, and
 * never a dashboard row.
 */
export async function lectureConcepts(
  lectureId: number,
  today: string = todayIso(),
): Promise<LectureConcepts | null> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });
  if (!lecture) return null;

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
          orderBy: [asc(schema.reviewItems.ordinal), asc(schema.reviewItems.id)],
        });

  const marks =
    items.length === 0
      ? []
      : await db.query.conceptMarks.findMany({
          where: inArray(
            schema.conceptMarks.reviewItemId,
            items.map((item) => item.id),
          ),
        });

  const studyDates =
    marks.length === 0
      ? []
      : await db.query.studyDates.findMany({
          where: inArray(
            schema.studyDates.id,
            [...new Set(marks.map((mark) => mark.studyDateId))],
          ),
        });
  const dateById = new Map(studyDates.map((date) => [date.id, date.date]));

  const marksByItem = new Map<number, Record<string, Mark>>();
  for (const mark of marks) {
    const date = dateById.get(mark.studyDateId);
    if (!date) continue;
    const record = marksByItem.get(mark.reviewItemId) ?? {};
    record[date] = mark.mark;
    marksByItem.set(mark.reviewItemId, record);
  }

  const itemsByLo = new Map<number, ConceptRow[]>();
  for (const item of items) {
    const rows = itemsByLo.get(item.loId) ?? [];
    rows.push({
      id: item.id,
      ordinal: item.ordinal,
      concept: item.concept,
      kind: item.kind,
      provenance: item.provenance,
      tier: tierOf(item),
      intervalDays: item.intervalDays,
      lapses: item.lapses,
      streak: item.streak,
      lastRating: item.lastRating,
      dueOn: item.dueOn,
      dueIn: daysBetween(today, item.dueOn),
      marks: marksByItem.get(item.id) ?? {},
    });
    itemsByLo.set(item.loId, rows);
  }

  return {
    id: lecture.id,
    title: lecture.title,
    committedAt: lecture.committedAt,
    dates: [...dateById.values()].sort(),
    objectives: objectives.map((objective) => ({
      id: objective.id,
      text: objective.text,
      suspended: objective.suspended,
      items: itemsByLo.get(objective.id) ?? [],
    })),
  };
}
