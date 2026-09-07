import { and, desc, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Score } from "@/lib/db/schema";
import { daysBetween, todayIso } from "@/lib/schedule";
import type { PriorAttempt } from "@/lib/tutor";

type AttemptRow = typeof schema.attempts.$inferSelect;

/**
 * The most recent graded attempt on each planned item, from any session but
 * this one: by review item where the item has been asked directly — a daily
 * turn or a same-day probe — else by objective: a same-day recall, the
 * item's first exposure, whose misses are the most relevant thing for its
 * first daily review.
 *
 * Read from `attempts` at load time rather than copied onto the item row:
 * one source of truth, nothing to keep in sync.
 *
 * Unfinished sessions count too: a miss is evidence whether or not the
 * session that produced it ever wrote the day.
 */
export async function priorAttempts(
  sessionId: number,
  slots: { reviewItemId: number; loId: number }[],
  today: string = todayIso(),
): Promise<Map<number, PriorAttempt>> {
  if (slots.length === 0) return new Map();

  const itemIds = slots.map((slot) => slot.reviewItemId);
  const loIds = [...new Set(slots.map((slot) => slot.loId))];

  const direct = await db.query.attempts.findMany({
    where: and(
      inArray(schema.attempts.reviewItemId, itemIds),
      isNotNull(schema.attempts.score),
      ne(schema.attempts.sessionId, sessionId),
    ),
    orderBy: [desc(schema.attempts.id)],
  });

  const onObjective = await db.query.attempts.findMany({
    where: and(
      inArray(schema.attempts.loId, loIds),
      isNull(schema.attempts.reviewItemId),
      isNotNull(schema.attempts.score),
      ne(schema.attempts.sessionId, sessionId),
    ),
    orderBy: [desc(schema.attempts.id)],
  });

  // Newest first, so the first row seen for a key is the latest.
  const latestByItem = new Map<number, AttemptRow>();
  for (const attempt of direct) {
    if (!latestByItem.has(attempt.reviewItemId!)) {
      latestByItem.set(attempt.reviewItemId!, attempt);
    }
  }
  const latestByLo = new Map<number, AttemptRow>();
  for (const attempt of onObjective) {
    if (!latestByLo.has(attempt.loId!)) latestByLo.set(attempt.loId!, attempt);
  }

  const prior = new Map<number, PriorAttempt>();
  for (const slot of slots) {
    const own = latestByItem.get(slot.reviewItemId);
    const objective = latestByLo.get(slot.loId);
    if (own) prior.set(slot.reviewItemId, toPrior(own, slot.reviewItemId, false, today));
    else if (objective) {
      prior.set(slot.reviewItemId, toPrior(objective, slot.reviewItemId, true, today));
    }
  }
  return prior;
}

function toPrior(
  attempt: AttemptRow,
  itemId: number,
  aboutObjective: boolean,
  today: string,
): PriorAttempt {
  const grade = attempt.feedback
    ? (JSON.parse(attempt.feedback) as {
        missing?: string[];
        incorrect?: string[];
        correction?: string;
      })
    : {};
  return {
    daysAgo: daysBetween(todayIso(attempt.createdAt), today),
    score: attempt.score as Score,
    // The mark this concept got in that attempt, if the answer touched it.
    mark: (attempt.conceptMarks ?? []).find((m) => m.reviewItemId === itemId)?.mark ?? null,
    hintsUsed: attempt.hintsUsed,
    missing: grade.missing ?? [],
    incorrect: grade.incorrect ?? [],
    correction: grade.correction ?? "",
    aboutObjective,
  };
}
