import { db, schema } from "@/lib/db";
import type { Score } from "@/lib/db/schema";
import type { ItemCandidate, LoCandidate } from "./select";

/**
 * Everything the daily session could ask about: one candidate per objective
 * on a committed lecture, carrying its dashboard scores and its concepts.
 *
 * Read as whole tables and assembled here rather than joined in SQL: this is
 * one student's local file, a few hundred rows at most, and the shape the
 * selector wants — an objective's scores as an ordered array, its items
 * beneath it — is clearer in TypeScript than in a query.
 */
export async function dailyCandidates(): Promise<LoCandidate[]> {
  const lectures = await db.query.lectures.findMany();
  const committed = new Map(
    lectures.filter((lecture) => lecture.committedAt).map((l) => [l.id, l]),
  );
  if (committed.size === 0) return [];

  const objectives = await db.query.learningObjectives.findMany();
  const items = await db.query.reviewItems.findMany();
  const performances = await db.query.performances.findMany();
  const studyDates = await db.query.studyDates.findMany();

  const dateById = new Map(studyDates.map((date) => [date.id, date.date]));

  const scoresByLo = new Map<number, Score[]>();
  const chronological = [...performances].sort((a, b) =>
    (dateById.get(a.studyDateId) ?? "").localeCompare(
      dateById.get(b.studyDateId) ?? "",
    ),
  );
  for (const performance of chronological) {
    const scores = scoresByLo.get(performance.loId) ?? [];
    scores.push(performance.score);
    scoresByLo.set(performance.loId, scores);
  }

  const itemsByLo = new Map<number, ItemCandidate[]>();
  for (const item of [...items].sort((a, b) => a.ordinal - b.ordinal || a.id - b.id)) {
    // A suspended concept is not something the session could ask about, any
    // more than an uncommitted lecture is; an objective left with no items
    // drops out through isEligible.
    if (item.suspended) continue;
    const list = itemsByLo.get(item.loId) ?? [];
    list.push({
      reviewItemId: item.id,
      ordinal: item.ordinal,
      kind: item.kind,
      dueOn: item.dueOn,
      intervalDays: item.intervalDays,
      lapses: item.lapses,
      streak: item.streak,
      lastRating: item.lastRating,
    });
    itemsByLo.set(item.loId, list);
  }

  const candidates: LoCandidate[] = [];

  for (const objective of objectives) {
    const lecture = committed.get(objective.lectureId);
    // Objectives only reach the dashboard on commit, so an uncommitted
    // lecture has nothing to practise.
    if (!lecture?.committedAt) continue;

    candidates.push({
      loId: objective.id,
      lectureId: lecture.id,
      suspended: objective.suspended,
      scores: scoresByLo.get(objective.id) ?? [],
      items: itemsByLo.get(objective.id) ?? [],
    });
  }

  return candidates;
}
