import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { todayIso } from "@/lib/schedule";

export interface OpenReview {
  id: number;
  /** YYYY-MM-DD, local time, as the session started. */
  startedOn: string;
  minutes: number | null;
  /** The lectures it covers that still exist, ids ascending. */
  lectures: { id: number; title: string }[];
  /** Answers graded so far: how far along it is. */
  answered: number;
}

/**
 * Reviews started and not finished, newest first, for the Lectures tab to
 * offer Resume and Finish now on. Any day's: an old one is still a sitting
 * with graded answers in it, and Finish now is how it gets recorded rather
 * than left orphaned. A review whose lectures were all deleted is dropped,
 * since neither resuming nor finishing it could work.
 */
export async function openReviews(): Promise<OpenReview[]> {
  const sessions = await db.query.sessions.findMany({
    where: and(eq(schema.sessions.type, "review"), isNull(schema.sessions.endedAt)),
    orderBy: [desc(schema.sessions.startedAt), desc(schema.sessions.id)],
  });
  if (sessions.length === 0) return [];

  const lectureIds = [...new Set(sessions.flatMap((session) => session.lectureIds ?? []))];
  const lectures =
    lectureIds.length === 0
      ? []
      : await db.query.lectures.findMany({
          where: inArray(schema.lectures.id, lectureIds),
        });
  const titleById = new Map(lectures.map((lecture) => [lecture.id, lecture.title]));

  const graded = await db
    .select({ sessionId: schema.attempts.sessionId, answered: count() })
    .from(schema.attempts)
    .where(
      and(
        inArray(
          schema.attempts.sessionId,
          sessions.map((session) => session.id),
        ),
        isNotNull(schema.attempts.score),
      ),
    )
    .groupBy(schema.attempts.sessionId);
  const answeredBySession = new Map(graded.map((row) => [row.sessionId, row.answered]));

  return sessions.flatMap((session) => {
    const covered = [...(session.lectureIds ?? [])]
      .filter((id) => titleById.has(id))
      .sort((a, b) => a - b)
      .map((id) => ({ id, title: titleById.get(id)! }));
    if (covered.length === 0) return [];

    return [
      {
        id: session.id,
        startedOn: todayIso(session.startedAt),
        minutes: session.minutes,
        lectures: covered,
        answered: answeredBySession.get(session.id) ?? 0,
      },
    ];
  });
}
