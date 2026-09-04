import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import {
  capRating,
  nextSchedule,
  todayIso,
  worstByLo,
  worstRating,
} from "@/lib/schedule";
import {
  askQuestion,
  gradeAnswer,
  giveHint,
  type QuestionFormat,
} from "@/lib/tutor";
import type { AttemptRow, SessionKind, SessionRow } from "./kind";
import { sameDayKind } from "./sameDay";

/**
 * The parts of a session that do not depend on which flavour it is.
 *
 * Code owns the pacing, the ratings that reach the dashboard, and when items
 * come back. The model only asks, grades and explains — and its rating is
 * advisory until capRating has had the last word.
 */

/** Injectable so tests can run a whole session without a provider. */
export interface TutorDeps {
  askQuestion: typeof askQuestion;
  gradeAnswer: typeof gradeAnswer;
  giveHint: typeof giveHint;
}

const REAL_TUTOR: TutorDeps = { askQuestion, gradeAnswer, giveHint };

export interface Turn {
  attemptId: number;
  stage: AttemptRow["stage"];
  loId: number | null;
  objective: string | null;
  lectureTitle: string | null;
  format: string;
  question: string;
  hintsUsed: boolean;
  position: number;
  /** Null when the session's length is not known in advance. */
  total: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKind = SessionKind<any>;

async function kindFor(session: SessionRow): Promise<AnyKind> {
  if (session.type === "daily") {
    throw new Error("Daily sessions are not implemented yet.");
  }
  return sameDayKind;
}

interface Loaded {
  session: SessionRow;
  kind: AnyKind;
  material: unknown;
  attempts: AttemptRow[];
}

async function load(sessionId: number): Promise<Loaded> {
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  if (!session) throw new Error(`Session ${sessionId} not found.`);

  const kind = await kindFor(session);
  const material = await kind.loadMaterial(session);

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
    orderBy: [asc(schema.attempts.id)],
  });

  return { session, kind, material, attempts };
}

function toTurn(
  attempt: AttemptRow,
  loaded: Loaded,
): Turn {
  const context = loaded.kind.turnContext(
    {
      stage: attempt.stage,
      loId: attempt.loId,
      reviewItemId: attempt.reviewItemId,
    },
    loaded.material,
  );

  const progress = loaded.kind.progress?.(loaded.material, loaded.attempts) ?? {
    position: loaded.attempts.filter((a) => a.rating !== null).length + 1,
    total: null,
  };

  return {
    attemptId: attempt.id,
    stage: attempt.stage,
    loId: attempt.loId,
    objective: context.objective ?? null,
    lectureTitle: context.lectureTitle || null,
    format: attempt.format,
    question: attempt.question,
    hintsUsed: attempt.hintsUsed,
    position: progress.position,
    total: progress.total,
  };
}

/**
 * The question the student is on, generating it if the session has moved to a
 * new one.
 *
 * A generated question is persisted before it is returned, so refreshing shows
 * the same question rather than quietly swapping it. Null means complete.
 */
export async function currentTurn(
  sessionId: number,
  deps: TutorDeps = REAL_TUTOR,
): Promise<Turn | null> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.rating === null);
  if (pending) return toTurn(pending, loaded);

  const planned = loaded.kind.planNext(loaded.material, loaded.attempts);
  if (!planned) return null;

  const context = loaded.kind.turnContext(planned, loaded.material);

  const question = await deps.askQuestion({
    ...context,
    usedFormats: loaded.attempts.map((a) => a.format as QuestionFormat),
    allowedFormats: planned.allowedFormats,
  });

  const [created] = await db
    .insert(schema.attempts)
    .values({
      sessionId,
      stage: planned.stage,
      loId: planned.loId,
      reviewItemId: planned.reviewItemId,
      format: question.format,
      question: question.question,
    })
    .returning();

  return toTurn(created, { ...loaded, attempts: [...loaded.attempts, created] });
}

export interface TurnFeedback {
  rating: Rating;
  /** The model's rating before capRating. Differs only when a cue was taken. */
  modelRating: Rating;
  grade: Awaited<ReturnType<typeof gradeAnswer>>;
}

export async function submitAnswer(
  sessionId: number,
  answer: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<TurnFeedback> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.rating === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  const context = loaded.kind.turnContext(pending, loaded.material);

  const grade = await deps.gradeAnswer({
    ...context,
    question: pending.question,
    studentAnswer: answer,
    hintsUsed: pending.hintsUsed,
  });

  const rating = capRating(grade.rating, pending.hintsUsed);

  await db
    .update(schema.attempts)
    .set({ studentAnswer: answer, rating, feedback: JSON.stringify(grade) })
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
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.rating === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  const context = loaded.kind.turnContext(pending, loaded.material);

  const { hint } = await deps.giveHint({
    ...context,
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
 * objective, and a new due date for every review item the flavour says moved.
 */
export async function finishSession(
  sessionId: number,
  options: { now?: Date; deps?: TutorDeps } = {},
): Promise<SessionResult> {
  const now = options.now ?? new Date();
  const deps = options.deps ?? REAL_TUTOR;
  const loaded = await load(sessionId);

  if (loaded.session.endedAt) {
    throw new Error("This session has already been finished.");
  }

  const today = todayIso(now);

  // A turn with no loId — the lecture summary — assessed the lecture, not an
  // objective, so it earns no cell.
  const ratingByLo: Record<number, Rating> = Object.fromEntries(
    worstByLo(loaded.attempts),
  );

  const testedLoIds = Object.keys(ratingByLo).map(Number);

  if (testedLoIds.length > 0) {
    const studyDateId = await studyDateFor(today);

    for (const loId of testedLoIds) {
      // Merge with whatever is already in today's cell rather than replacing
      // it. Two sessions can share a date, and the cell describes the day.
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

  const outcomes = loaded.kind.itemOutcomes(loaded.attempts, loaded.material);
  let reviewItemsRescheduled = 0;

  for (const [itemId, rating] of outcomes) {
    const item = await db.query.reviewItems.findFirst({
      where: eq(schema.reviewItems.id, itemId),
    });
    if (!item) continue;

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

  let debrief: unknown = null;
  if (loaded.kind.closeOut) {
    try {
      debrief = await loaded.kind.closeOut({
        session: loaded.session,
        attempts: loaded.attempts,
        material: loaded.material,
        deps,
      });
    } catch (error) {
      // The cells and the schedule are the session's real output. A summary
      // that failed to generate is not worth losing them over.
      console.error("Debrief failed:", error);
    }
  }

  await db
    .update(schema.sessions)
    .set({ endedAt: now, ...(debrief ? { debrief } : {}) })
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
