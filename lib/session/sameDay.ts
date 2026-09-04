import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating, SessionStage } from "@/lib/db/schema";
import { capRating, nextSchedule, todayIso, worstRating } from "@/lib/schedule";
import {
  askQuestion,
  gradeAnswer,
  giveHint,
  type ConceptContext,
  type GradeOutput,
  type QuestionFormat,
} from "@/lib/tutor";
import { planNextTurn, type GradedTurn } from "./plan";

/**
 * The same-day review session.
 *
 * Code owns the pacing, the ratings that reach the dashboard, and when items
 * come back. The model only asks, grades, and explains — and its rating is
 * advisory until capRating has had the last word.
 */

/** Injectable so tests can run the whole flow without a provider. */
export interface TutorDeps {
  askQuestion: typeof askQuestion;
  gradeAnswer: typeof gradeAnswer;
  giveHint: typeof giveHint;
}

const REAL_TUTOR: TutorDeps = { askQuestion, gradeAnswer, giveHint };

export interface Turn {
  attemptId: number;
  stage: SessionStage;
  loId: number | null;
  objective: string | null;
  format: string;
  question: string;
  hintsUsed: boolean;
}

export async function startSameDaySession(lectureId: number): Promise<number> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });

  if (!lecture) throw new Error(`Lecture ${lectureId} not found.`);
  if (!lecture.committedAt) {
    throw new Error(
      "Review the lecture's objectives and commit them before studying it.",
    );
  }

  // Rejoin an unfinished session rather than starting a parallel one, so a
  // closed tab does not silently split a sitting across two sessions.
  const open = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.lectureId, lectureId),
      eq(schema.sessions.type, "same_day"),
      isNull(schema.sessions.endedAt),
    ),
  });
  if (open) return open.id;

  const [created] = await db
    .insert(schema.sessions)
    .values({ type: "same_day", lectureId })
    .returning({ id: schema.sessions.id });

  return created.id;
}

interface SessionContext {
  session: typeof schema.sessions.$inferSelect;
  lectureTitle: string;
  objectives: (typeof schema.learningObjectives.$inferSelect)[];
  conceptsByLo: Map<number, ConceptContext[]>;
  attempts: (typeof schema.attempts.$inferSelect)[];
}

async function loadContext(sessionId: number): Promise<SessionContext> {
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  if (!session) throw new Error(`Session ${sessionId} not found.`);
  if (session.lectureId === null) {
    throw new Error("This session is not attached to a lecture.");
  }

  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, session.lectureId),
  });
  if (!lecture) throw new Error("The session's lecture no longer exists.");

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, session.lectureId),
    orderBy: [asc(schema.learningObjectives.orderIndex)],
  });

  const conceptsByLo = new Map<number, ConceptContext[]>();
  if (objectives.length > 0) {
    const items = await db.query.reviewItems.findMany({
      where: inArray(
        schema.reviewItems.loId,
        objectives.map((objective) => objective.id),
      ),
    });
    for (const item of items) {
      const list = conceptsByLo.get(item.loId) ?? [];
      list.push({
        concept: item.concept,
        kind: item.kind,
        provenance: item.provenance,
      });
      conceptsByLo.set(item.loId, list);
    }
  }

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
    orderBy: [asc(schema.attempts.id)],
  });

  return { session, lectureTitle: lecture.title, objectives, conceptsByLo, attempts };
}

function gradedTurns(
  attempts: (typeof schema.attempts.$inferSelect)[],
): GradedTurn[] {
  return attempts
    .filter((attempt) => attempt.rating !== null)
    .map((attempt) => ({
      stage: attempt.stage,
      loId: attempt.loId,
      rating: attempt.rating as Rating,
    }));
}

function toTurn(
  attempt: typeof schema.attempts.$inferSelect,
  objectives: (typeof schema.learningObjectives.$inferSelect)[],
): Turn {
  return {
    attemptId: attempt.id,
    stage: attempt.stage,
    loId: attempt.loId,
    objective:
      objectives.find((objective) => objective.id === attempt.loId)?.text ??
      null,
    format: attempt.format,
    question: attempt.question,
    hintsUsed: attempt.hintsUsed,
  };
}

/**
 * The question the student is currently on, generating it if the session has
 * moved on to a new one.
 *
 * A generated question is persisted before it is returned, so refreshing the
 * page shows the same question rather than quietly swapping it for another.
 * Returns null when the session is complete.
 */
export async function currentTurn(
  sessionId: number,
  deps: TutorDeps = REAL_TUTOR,
): Promise<Turn | null> {
  const context = await loadContext(sessionId);

  const pending = context.attempts.find((attempt) => attempt.rating === null);
  if (pending) return toTurn(pending, context.objectives);

  const plan = planNextTurn(context.objectives, gradedTurns(context.attempts));
  if (!plan) return null;

  const objective =
    plan.loId === null
      ? undefined
      : context.objectives.find((o) => o.id === plan.loId);

  // The summary stage is about the whole lecture, so it sees every concept.
  const concepts =
    plan.loId === null
      ? [...context.conceptsByLo.values()].flat()
      : (context.conceptsByLo.get(plan.loId) ?? []);

  const question = await deps.askQuestion({
    stage: plan.stage,
    lectureTitle: context.lectureTitle,
    objective: objective?.text,
    concepts,
    usedFormats: context.attempts.map(
      (attempt) => attempt.format as QuestionFormat,
    ),
  });

  const [created] = await db
    .insert(schema.attempts)
    .values({
      sessionId,
      stage: plan.stage,
      loId: plan.loId,
      format: question.format,
      question: question.question,
    })
    .returning();

  return toTurn(created, context.objectives);
}

export interface TurnFeedback {
  rating: Rating;
  /** The model's rating before capRating. Differs only when a cue was taken. */
  modelRating: Rating;
  grade: GradeOutput;
}

export async function submitAnswer(
  sessionId: number,
  answer: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<TurnFeedback> {
  const context = await loadContext(sessionId);

  const pending = context.attempts.find((attempt) => attempt.rating === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  const objective = context.objectives.find((o) => o.id === pending.loId);
  const concepts =
    pending.loId === null
      ? [...context.conceptsByLo.values()].flat()
      : (context.conceptsByLo.get(pending.loId) ?? []);

  const grade = await deps.gradeAnswer({
    stage: pending.stage,
    lectureTitle: context.lectureTitle,
    objective: objective?.text,
    concepts,
    question: pending.question,
    studentAnswer: answer,
    hintsUsed: pending.hintsUsed,
  });

  const rating = capRating(grade.rating, pending.hintsUsed);

  await db
    .update(schema.attempts)
    .set({
      studentAnswer: answer,
      rating,
      feedback: JSON.stringify(grade),
    })
    .where(eq(schema.attempts.id, pending.id));

  return { rating, modelRating: grade.rating, grade };
}

/**
 * A cue for the question in hand. Taking one is recorded on the attempt, which
 * is what later caps the rating at yellow.
 */
export async function requestHint(
  sessionId: number,
  partialAnswer?: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<string> {
  const context = await loadContext(sessionId);

  const pending = context.attempts.find((attempt) => attempt.rating === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  const objective = context.objectives.find((o) => o.id === pending.loId);
  const concepts =
    pending.loId === null
      ? [...context.conceptsByLo.values()].flat()
      : (context.conceptsByLo.get(pending.loId) ?? []);

  const { hint } = await deps.giveHint({
    stage: pending.stage,
    lectureTitle: context.lectureTitle,
    objective: objective?.text,
    concepts,
    question: pending.question,
    partialAnswer,
  });

  await db
    .update(schema.attempts)
    .set({ hintsUsed: true })
    .where(eq(schema.attempts.id, pending.id));

  return hint;
}

export interface SessionResult {
  /** One dashboard cell per objective actually tested. */
  cellsWritten: number;
  reviewItemsRescheduled: number;
  ratingByLo: Record<number, Rating>;
}

/**
 * Closes the session and writes the day: one dashboard cell per tested
 * objective, and a new due date for every review item beneath it.
 */
export async function finishSession(
  sessionId: number,
  now: Date = new Date(),
): Promise<SessionResult> {
  const context = await loadContext(sessionId);
  if (context.session.endedAt) {
    throw new Error("This session has already been finished.");
  }

  const today = todayIso(now);

  // Group the session's graded ratings by objective. The summary stage carries
  // no loId and so contributes to no cell — it assessed the lecture, not an
  // objective.
  const ratingsByLo = new Map<number, Rating[]>();
  for (const turn of gradedTurns(context.attempts)) {
    if (turn.loId === null) continue;
    const list = ratingsByLo.get(turn.loId) ?? [];
    list.push(turn.rating);
    ratingsByLo.set(turn.loId, list);
  }

  const ratingByLo: Record<number, Rating> = {};
  for (const [loId, ratings] of ratingsByLo) {
    const worst = worstRating(ratings);
    if (worst) ratingByLo[loId] = worst;
  }

  const testedLoIds = Object.keys(ratingByLo).map(Number);

  if (testedLoIds.length > 0) {
    const studyDateId = await studyDateFor(today);

    for (const loId of testedLoIds) {
      // Merge with whatever is already in today's cell rather than replacing
      // it. Two sessions can share a date — a same-day review and a daily
      // session — and the cell has to describe the whole day.
      const existing = await db.query.performances.findFirst({
        where: and(
          eq(schema.performances.loId, loId),
          eq(schema.performances.studyDateId, studyDateId),
        ),
      });

      const rating =
        worstRating(
          existing ? [existing.rating, ratingByLo[loId]] : [ratingByLo[loId]],
        ) ?? ratingByLo[loId];

      await db
        .insert(schema.performances)
        .values({ loId, studyDateId, rating })
        .onConflictDoUpdate({
          target: [schema.performances.loId, schema.performances.studyDateId],
          set: { rating },
        });
    }
  }

  let reviewItemsRescheduled = 0;
  if (testedLoIds.length > 0) {
    const items = await db.query.reviewItems.findMany({
      where: inArray(schema.reviewItems.loId, testedLoIds),
    });

    // Every item under an objective moves on that objective's rating. Phase 2
    // tests objectives, not individual concepts; the daily session will set
    // attempts.reviewItemId and schedule them one at a time.
    for (const item of items) {
      const rating = ratingByLo[item.loId];
      const next = nextSchedule(
        { intervalDays: item.intervalDays, lapses: item.lapses },
        rating,
        today,
      );

      await db
        .update(schema.reviewItems)
        .set({
          dueOn: next.dueOn,
          intervalDays: next.intervalDays,
          lapses: next.lapses,
          lastRating: rating,
        })
        .where(eq(schema.reviewItems.id, item.id));

      reviewItemsRescheduled++;
    }
  }

  await db
    .update(schema.sessions)
    .set({ endedAt: now })
    .where(eq(schema.sessions.id, sessionId));

  return {
    cellsWritten: testedLoIds.length,
    reviewItemsRescheduled,
    ratingByLo,
  };
}

/** Today's dashboard column, created only if this is the first study of the day. */
async function studyDateFor(date: string): Promise<number> {
  await db
    .insert(schema.studyDates)
    .values({ date })
    .onConflictDoNothing({ target: schema.studyDates.date });

  const row = await db.query.studyDates.findFirst({
    where: eq(schema.studyDates.date, date),
  });
  if (!row) throw new Error(`Could not resolve a study date for ${date}.`);
  return row.id;
}
