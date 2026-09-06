import type { Rating, SessionStage } from "@/lib/db/schema";

/**
 * The same-day session's running order, as a pure function of what has already
 * been graded. Nothing stores a cursor: the plan is re-derived on every request,
 * so a reload, a crash, or coming back an hour later all resume in place.
 */

export interface PlannedObjective {
  id: number;
  orderIndex: number;
  suspended: boolean;
}

/** A graded turn. Ungraded (pending) attempts are not part of the plan. */
export interface GradedTurn {
  stage: SessionStage;
  loId: number | null;
  rating: Rating;
}

export interface TurnPlan {
  stage: SessionStage;
  loId: number | null;
}

/**
 * Order: recall every objective, summarise the lecture, elaborate on whatever
 * did not come back cleanly, then reflect.
 *
 * Elaboration is deliberately limited to objectives that scored below green.
 * That is prompt.txt Retrieval Rule 5 — after a correction, retrieve again —
 * and it keeps a session that went well short rather than padding it.
 *
 * Returns null when the session has nothing left to ask.
 */
export function planNextTurn(
  objectives: PlannedObjective[],
  graded: GradedTurn[],
  options: { reflected: boolean } = { reflected: false },
): TurnPlan | null {
  // Suspended objectives are dark green: do not quiz until reactivated.
  const active = objectives
    .filter((objective) => !objective.suspended)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const ratingFor = (stage: SessionStage, loId: number): Rating | undefined =>
    graded.find((turn) => turn.stage === stage && turn.loId === loId)?.rating;

  for (const objective of active) {
    if (!ratingFor("lo_recall", objective.id)) {
      return { stage: "lo_recall", loId: objective.id };
    }
  }

  if (!graded.some((turn) => turn.stage === "summary")) {
    return { stage: "summary", loId: null };
  }

  for (const objective of active) {
    const recalled = ratingFor("lo_recall", objective.id);
    if (recalled === "green") continue;
    if (!ratingFor("elaboration", objective.id)) {
      return { stage: "elaboration", loId: objective.id };
    }
  }

  // Every session closes with the student's own account of it (prompt.txt
  // "Elaboration and Reflection": key ideas, hardest point, corrected
  // misconception, remaining uncertainty). It is ungraded, so it is never in
  // `graded`; the caller says whether it has been given.
  if (!options.reflected) return { stage: "reflection", loId: null };
  return null;
}
