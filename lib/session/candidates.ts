import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { todayIso } from "@/lib/schedule";
import type { Candidate } from "./select";

/**
 * Everything the daily session could ask about, flattened for selection.
 *
 * Read as whole tables and assembled here rather than joined in SQL: this is
 * one student's local file, a few hundred rows at most, and the shape the
 * selector wants — an objective's colours as an ordered array — is clearer in
 * TypeScript than in a query.
 */
export async function dailyCandidates(): Promise<Candidate[]> {
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

  const historyByLo = new Map<number, Rating[]>();
  const chronological = [...performances].sort((a, b) =>
    (dateById.get(a.studyDateId) ?? "").localeCompare(
      dateById.get(b.studyDateId) ?? "",
    ),
  );
  for (const performance of chronological) {
    const colours = historyByLo.get(performance.loId) ?? [];
    colours.push(performance.rating);
    historyByLo.set(performance.loId, colours);
  }

  const objectiveById = new Map(objectives.map((o) => [o.id, o]));
  const candidates: Candidate[] = [];

  for (const item of items) {
    const objective = objectiveById.get(item.loId);
    if (!objective) continue;

    const lecture = committed.get(objective.lectureId);
    // Objectives only reach the dashboard on commit, so an uncommitted
    // lecture has nothing to practise.
    if (!lecture?.committedAt) continue;

    candidates.push({
      reviewItemId: item.id,
      loId: objective.id,
      lectureId: lecture.id,
      block: lecture.block,
      kind: item.kind,
      dueOn: item.dueOn,
      intervalDays: item.intervalDays,
      lapses: item.lapses,
      streak: item.streak,
      lastRating: item.lastRating,
      loSuspended: objective.suspended,
      lectureCommittedOn: todayIso(lecture.committedAt),
      history: historyByLo.get(objective.id) ?? [],
    });
  }

  return candidates;
}
