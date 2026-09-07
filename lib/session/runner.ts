import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { ConceptMark, Mark, Score } from "@/lib/db/schema";
import {
  band,
  capMark,
  capScore,
  minScoreByLo,
  nextSchedule,
  tierOf,
  todayIso,
  worstMark,
} from "@/lib/schedule";
import {
  askQuestion,
  gradeAnswer,
  giveHint,
  summariseSession,
  type DebriefOutput,
  type DebriefRequest,
  type GradeOutput,
  type QuestionFormat,
  type TurnContext,
} from "@/lib/tutor";
import type {
  AttemptRow,
  MarkedConcept,
  Outcome,
  SessionKind,
  SessionRow,
  TurnWhy,
  TutorDeps,
} from "./kind";
import { sameDayKind } from "./sameDay";

/**
 * The parts of a session that do not depend on which flavour it is.
 *
 * Code owns the pacing, the scores that reach the dashboard, the marks that
 * reach the concepts, and when items come back. The model only asks, grades
 * and explains — and its score and marks are advisory until capScore and
 * capMark have had the last word.
 */

export type { TutorDeps } from "./kind";

const REAL_TUTOR: TutorDeps = { askQuestion, gradeAnswer, giveHint, summariseSession };

/**
 * The reflection question, fixed and code-owned: prompt.txt's close-out asked
 * as one turn, at no model cost.
 */
export const REFLECTION_QUESTION: Record<SessionRow["type"], string> = {
  same_day:
    "Without looking back: what were the key ideas of this lecture, what was the hardest point, what misconception did you correct today, and what are you still unsure of?",
  daily:
    "Before the summary: what was the hardest question today, what did you get wrong and what is the correction you would give yourself, and what are you still unsure of?",
};

const REFLECTION_FORMAT = "reflection";

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
    // Imported lazily: daily.ts pulls in selection, which nothing needs while
    // a same-day session is running.
    const { dailyKind } = await import("./daily");
    return dailyKind;
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
  const context =
    attempt.stage === "reflection"
      ? null
      : loaded.kind.turnContext(
          { stage: attempt.stage, loId: attempt.loId, reviewItemId: attempt.reviewItemId },
          loaded.material,
        );

  const progress = loaded.kind.progress?.(loaded.material, loaded.attempts) ?? {
    position: loaded.attempts.filter((a) => a.score !== null).length + 1,
    total: null,
  };

  return {
    attemptId: attempt.id,
    stage: attempt.stage,
    loId: attempt.loId,
    objective: context?.objective ?? null,
    lectureTitle: context?.lectureTitle || null,
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

  // Pending means unanswered, not ungraded: the reflection is answered and
  // never graded, and for every other stage the two are set together.
  const pending = loaded.attempts.find((attempt) => attempt.studentAnswer === null);
  if (pending) return toTurn(pending, loaded);

  const planned = loaded.kind.planNext(loaded.material, loaded.attempts);
  if (!planned) return null;

  if (planned.stage === "reflection") {
    const [created] = await db
      .insert(schema.attempts)
      .values({
        sessionId,
        stage: "reflection",
        loId: null,
        reviewItemId: null,
        format: REFLECTION_FORMAT,
        question: REFLECTION_QUESTION[loaded.session.type],
      })
      .returning();
    return toTurn(created, { ...loaded, attempts: [...loaded.attempts, created] });
  }

  const context = loaded.kind.turnContext(planned, loaded.material);

  const question = await deps.askQuestion({
    ...context,
    usedFormats: loaded.attempts.map((a) => a.format as QuestionFormat),
    allowedFormats: planned.allowedFormats,
    bucket: planned.bucket,
    tier: planned.tier,
    order: planned.order,
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
  /** The question's score, after capScore. */
  score: Score;
  /** The model's score before capScore. Differs only when a cue was taken. */
  modelScore: Score;
  /** The concepts this answer marked, after capMark. */
  marks: MarkedConcept[];
  grade: GradeOutput;
  /** Why the turn was shaped as it was. Daily turns only. */
  why?: TurnWhy;
}

/**
 * The marks an answer earned, by concept: the grader's numbered marks mapped
 * through the turn's concepts and capped for a cue, with the target concept
 * guaranteed a mark — its score's band when the grader left it out. A
 * concept the grader named twice keeps its worse mark.
 */
export function marksFor(
  grade: GradeOutput,
  context: TurnContext,
  targetItemId: number | null,
  score: Score,
  hintsUsed: boolean,
): MarkedConcept[] {
  const byItem = new Map<number, MarkedConcept>();

  for (const { number, mark } of grade.conceptMarks) {
    const concept = context.concepts.find(
      (c) => c.ordinal === number && c.reviewItemId !== undefined,
    );
    if (!concept?.reviewItemId) continue;

    const capped = capMark(mark, hintsUsed);
    const current = byItem.get(concept.reviewItemId);
    byItem.set(concept.reviewItemId, {
      reviewItemId: concept.reviewItemId,
      ordinal: number,
      concept: concept.concept,
      mark: current ? worstMark([current.mark, capped])! : capped,
    });
  }

  if (targetItemId !== null && !byItem.has(targetItemId)) {
    const target = context.concepts.find((c) => c.reviewItemId === targetItemId);
    byItem.set(targetItemId, {
      reviewItemId: targetItemId,
      ordinal: target?.ordinal ?? 0,
      concept: target?.concept ?? context.targetConcept ?? "",
      mark: band(score),
    });
  }

  return [...byItem.values()];
}

export async function submitAnswer(
  sessionId: number,
  answer: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<TurnFeedback | null> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.studentAnswer === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  // The reflection is the student's account of the session: stored, never
  // graded, and the runner's only turn that ends with no feedback.
  if (pending.stage === "reflection") {
    await db
      .update(schema.attempts)
      .set({ studentAnswer: answer })
      .where(eq(schema.attempts.id, pending.id));
    return null;
  }

  const context = loaded.kind.turnContext(pending, loaded.material);

  const grade = await deps.gradeAnswer({
    ...context,
    question: pending.question,
    studentAnswer: answer,
    hintsUsed: pending.hintsUsed,
  });

  const score = capScore(grade.score, pending.hintsUsed);
  const marks = marksFor(grade, context, pending.reviewItemId, score, pending.hintsUsed);
  const stored: ConceptMark[] = marks.map(({ reviewItemId, mark }) => ({ reviewItemId, mark }));

  await db
    .update(schema.attempts)
    .set({ studentAnswer: answer, score, conceptMarks: stored, feedback: JSON.stringify(grade) })
    .where(eq(schema.attempts.id, pending.id));

  return {
    score,
    modelScore: grade.score,
    marks,
    grade,
    why: loaded.kind.explain?.(pending, loaded.material),
  };
}

/**
 * A cue for the question in hand. Taking one is recorded on the attempt, which
 * is what later caps the score at 4 and a green mark at yellow.
 */
export async function requestHint(
  sessionId: number,
  partialAnswer?: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<string> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.studentAnswer === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  if (pending.stage === "reflection") {
    throw new Error("The reflection has no cue — it is your own account of the session.");
  }

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
  scoreByLo: Record<number, Score>;
  /** Null when the session has no close-out, or the summary call failed. */
  debrief: DebriefOutput | null;
  /** One entry per review item that moved, in the order they were walked. */
  outcomes: Outcome[];
}

/**
 * What the close-out summary sees: every graded turn with what it missed and
 * got wrong. Kind-agnostic — a same-day session and a daily one are debriefed
 * the same way.
 */
function debriefRequest(attempts: AttemptRow[]): DebriefRequest {
  const answered = attempts
    .filter((attempt) => attempt.score !== null)
    .map((attempt) => {
      const grade = attempt.feedback
        ? (JSON.parse(attempt.feedback) as { missing?: string[]; incorrect?: string[] })
        : {};
      return {
        question: attempt.question,
        score: attempt.score as number,
        missing: grade.missing ?? [],
        incorrect: grade.incorrect ?? [],
      };
    });
  const reflection =
    attempts.find((attempt) => attempt.stage === "reflection")?.studentAnswer ?? null;
  return { answered, reflection };
}

/** Each concept's worst mark across a sitting's graded turns. */
function marksOf(attempts: AttemptRow[]): Map<number, Mark> {
  const worst = new Map<number, Mark>();
  for (const attempt of attempts) {
    for (const { reviewItemId, mark } of attempt.conceptMarks ?? []) {
      const current = worst.get(reviewItemId);
      worst.set(reviewItemId, current ? worstMark([current, mark])! : mark);
    }
  }
  return worst;
}

/**
 * Closes the session and writes the day: one dashboard cell per tested
 * objective with its lowest score, one mark per concept the sitting tested
 * with its worst mark, and a new due date for each of those concepts. A
 * concept the sitting never marked is left unchanged — new_prompt.txt's
 * "leave untested concept numbers unchanged".
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

  // The reflection has no loId: it is about the session, and earns no cell.
  const scoreByLo: Record<number, Score> = Object.fromEntries(minScoreByLo(loaded.attempts));
  const testedLoIds = Object.keys(scoreByLo).map(Number);
  const marks = marksOf(loaded.attempts);

  const studyDateId =
    testedLoIds.length > 0 || marks.size > 0 ? await studyDateFor(today) : null;

  for (const loId of testedLoIds) {
    // Merge with whatever is already in today's cell rather than replacing
    // it. Two sessions can share a date, and the cell describes the day.
    const existing = await db.query.performances.findFirst({
      where: and(
        eq(schema.performances.loId, loId),
        eq(schema.performances.studyDateId, studyDateId!),
      ),
    });
    const score = existing
      ? (Math.min(existing.score, scoreByLo[loId]) as Score)
      : scoreByLo[loId];

    await db
      .insert(schema.performances)
      .values({ loId, studyDateId: studyDateId!, score })
      .onConflictDoUpdate({
        target: [schema.performances.loId, schema.performances.studyDateId],
        set: { score },
      });
  }

  const outcomes: Outcome[] = [];

  for (const [itemId, mark] of marks) {
    const item = await db.query.reviewItems.findFirst({
      where: eq(schema.reviewItems.id, itemId),
    });
    if (!item) continue;

    const existing = await db.query.conceptMarks.findFirst({
      where: and(
        eq(schema.conceptMarks.reviewItemId, itemId),
        eq(schema.conceptMarks.studyDateId, studyDateId!),
      ),
    });
    const dayMark = existing ? worstMark([existing.mark, mark])! : mark;

    await db
      .insert(schema.conceptMarks)
      .values({ reviewItemId: itemId, studyDateId: studyDateId!, mark: dayMark })
      .onConflictDoUpdate({
        target: [schema.conceptMarks.reviewItemId, schema.conceptMarks.studyDateId],
        set: { mark: dayMark },
      });

    const next = nextSchedule(
      { intervalDays: item.intervalDays, lapses: item.lapses, streak: item.streak },
      mark,
      today,
    );

    await db
      .update(schema.reviewItems)
      .set({
        dueOn: next.dueOn,
        intervalDays: next.intervalDays,
        lapses: next.lapses,
        streak: next.streak,
        lastRating: mark,
      })
      .where(eq(schema.reviewItems.id, item.id));

    outcomes.push({
      reviewItemId: item.id,
      concept: item.concept,
      mark,
      tierBefore: tierOf(item),
      tierAfter: tierOf({ ...next, lastRating: mark }),
      dueOn: next.dueOn,
    });
  }

  let debrief: DebriefOutput | null = null;
  const request = debriefRequest(loaded.attempts);
  if (request.answered.length > 0) {
    try {
      debrief = await deps.summariseSession(request);
    } catch (error) {
      // The cells and the schedule are the session's real output. A summary
      // that failed to generate is not worth losing them over.
      console.error("Debrief failed:", error);
    }
  }

  await db
    .update(schema.sessions)
    .set({ endedAt: now, outcomes, ...(debrief ? { debrief } : {}) })
    .where(eq(schema.sessions.id, sessionId));

  return {
    cellsWritten: testedLoIds.length,
    reviewItemsRescheduled: outcomes.length,
    scoreByLo,
    debrief,
    outcomes,
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
