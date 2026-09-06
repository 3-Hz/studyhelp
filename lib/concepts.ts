import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Provenance, Rating, ReviewKind } from "@/lib/db/schema";
import { daysBetween, tierOf, todayIso, type Tier } from "@/lib/schedule";

export interface ConceptRow {
  id: number;
  concept: string;
  kind: ReviewKind;
  provenance: Provenance;
  tier: Tier;
  intervalDays: number;
  lapses: number;
  streak: number;
  lastRating: Rating | null;
  dueOn: string;
  /** Days until due; negative when overdue. */
  dueIn: number;
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
  objectives: ObjectiveConcepts[];
}

/**
 * A lecture's objectives and the review items under each, with the state the
 * scheduler works from. The first surface that shows review items at all;
 * read-only, and never a dashboard row.
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
          orderBy: [asc(schema.reviewItems.id)],
        });

  const itemsByLo = new Map<number, ConceptRow[]>();
  for (const item of items) {
    const rows = itemsByLo.get(item.loId) ?? [];
    rows.push({
      id: item.id,
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
    });
    itemsByLo.set(item.loId, rows);
  }

  return {
    id: lecture.id,
    title: lecture.title,
    committedAt: lecture.committedAt,
    objectives: objectives.map((objective) => ({
      id: objective.id,
      text: objective.text,
      suspended: objective.suspended,
      items: itemsByLo.get(objective.id) ?? [],
    })),
  };
}
