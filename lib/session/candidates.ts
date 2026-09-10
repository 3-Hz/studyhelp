import { db, schema } from "@/lib/db";
import type { Score } from "@/lib/db/schema";
import type { ItemCandidate, LoCandidate } from "./select";

/**
 * Everything the daily session could ask about: one candidate per objective,
 * carrying its dashboard scores and its concepts. Objectives exist only once
 * a lecture has been extracted, so there is no lecture-level gate.
 *
 * Read as whole tables and assembled here rather than joined in SQL: this is
 * one student's local file, a few hundred rows at most, and the shape the
 * selector wants — an objective's scores as an ordered array, its items
 * beneath it — is clearer in TypeScript than in a query.
 */
export async function dailyCandidates(): Promise<LoCandidate[]> {
  const objectives = await db.query.learningObjectives.findMany();
  if (objectives.length === 0) return [];

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
    // A suspended concept is not something the session could ask about; an
    // objective left with no items drops out through isEligible.
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

  return objectives.map((objective) => ({
    loId: objective.id,
    lectureId: objective.lectureId,
    suspended: objective.suspended,
    scores: scoresByLo.get(objective.id) ?? [],
    items: itemsByLo.get(objective.id) ?? [],
  }));
}
