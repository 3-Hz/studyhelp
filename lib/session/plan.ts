import type { Mark, SessionStage } from "@/lib/db/schema";
import { spacedSubset } from "./budget";

/**
 * The review session's running order, as a pure function of what has already
 * been graded. Nothing stores a cursor: the plan is re-derived on every request,
 * so a reload, a crash, or coming back an hour later all resume in place.
 */

export interface PlannedObjective {
  id: number;
  lectureId: number;
  orderIndex: number;
  suspended: boolean;
  /** The numbered concepts under it, in order. */
  items: { id: number; ordinal: number }[];
}

/** A graded turn, with the marks it gave. Ungraded (pending) attempts are not part of the plan. */
export interface GradedTurn {
  stage: SessionStage;
  loId: number | null;
  reviewItemId: number | null;
  marks: { reviewItemId: number; mark: Mark }[];
}

export interface TurnPlan {
  stage: SessionStage;
  loId: number | null;
  /** The concept a probe is about; null for a recall and the reflection. */
  reviewItemId: number | null;
}

export interface PlanOptions {
  reflected: boolean;
  /** Objectives to cover, from the budget. */
  los: number;
  /** Questions per objective, from the budget: one recall, then probes. */
  perLo: number;
}

/** Untested first, then red, then yellow. Green is not probed. */
const PROBE_RANK: Record<Mark, number> = { red: 1, yellow: 2, green: 3 };

/**
 * Order, per new_prompt.txt "Review Quiz Session": one objective at a time,
 * first-order questions only. For each objective in the budget's subset,
 * recall the whole objective, then probe the concepts the recall left
 * untested or short of green, up to the budget's depth; then reflect.
 *
 * Returns null when the session has nothing left to ask.
 */
export function planNextTurn(
  objectives: PlannedObjective[],
  graded: GradedTurn[],
  options: PlanOptions,
): TurnPlan | null {
  // Suspended objectives are dark green: do not quiz until reactivated.
  const active = objectives.filter((objective) => !objective.suspended);
  const chosen = chooseObjectives(active, options.los);

  for (const objective of chosen) {
    const turns = graded.filter((turn) => turn.loId === objective.id);

    if (!turns.some((turn) => turn.stage === "lo_recall")) {
      return { stage: "lo_recall", loId: objective.id, reviewItemId: null };
    }

    const probes = turns.filter((turn) => turn.stage === "lo_probe");
    if (probes.length >= options.perLo - 1) continue;

    const probed = new Set(probes.map((turn) => turn.reviewItemId));
    const worst = worstMarkByItem(turns);

    const next = objective.items
      .filter((item) => !probed.has(item.id) && worst.get(item.id) !== "green")
      .sort(
        (a, b) =>
          rankOf(worst.get(a.id)) - rankOf(worst.get(b.id)) || a.ordinal - b.ordinal,
      )[0];

    if (next) return { stage: "lo_probe", loId: objective.id, reviewItemId: next.id };
  }

  // Every session closes with the student's own account of it (prompt.txt
  // "Elaboration and Reflection": key ideas, hardest point, corrected
  // misconception, remaining uncertainty). It is ungraded, so it is never in
  // `graded`; the caller says whether it has been given.
  if (!options.reflected) return { stage: "reflection", loId: null, reviewItemId: null };
  return null;
}

/**
 * Which objectives a review covers, and in what order. Each chosen lecture
 * gets a share of the budget in proportion to its objectives, at least one
 * while the budget allows; within a lecture the share is spaced through the
 * lecture's order, first and last included, so a short session spans it
 * rather than stopping partway. Lectures then take turns — the interleaving
 * new_prompt.txt asks for: switch between lectures, never combine
 * objectives. One lecture reduces to its spaced subset.
 */
export function chooseObjectives(
  active: PlannedObjective[],
  los: number,
): PlannedObjective[] {
  const byLecture = new Map<number, PlannedObjective[]>();
  for (const objective of active) {
    const list = byLecture.get(objective.lectureId) ?? [];
    list.push(objective);
    byLecture.set(objective.lectureId, list);
  }

  const groups = [...byLecture.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, list]) => [...list].sort((a, b) => a.orderIndex - b.orderIndex));

  const shares = allocate(
    groups.map((group) => group.length),
    los,
  );

  return roundRobin(groups.map((group, i) => spacedSubset(group, shares[i])));
}

/**
 * `total` split across groups in proportion to their sizes by largest
 * remainder, ties to the earlier group. A group is never left empty while
 * `total` covers every group: a lecture that was chosen is a lecture that
 * gets asked about.
 */
function allocate(sizes: number[], total: number): number[] {
  const all = sizes.reduce((sum, size) => sum + size, 0);
  if (total >= all) return [...sizes];

  const exact = sizes.map((size) => (total * size) / all);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((sum, share) => sum + share, 0);

  const byRemainder = exact
    .map((value, i) => ({ i, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    shares[i]++;
    left--;
  }

  if (total >= sizes.length) {
    for (let i = 0; i < shares.length; i++) {
      if (shares[i] > 0) continue;
      const richest = shares.indexOf(Math.max(...shares));
      shares[richest]--;
      shares[i]++;
    }
  }

  return shares;
}

/** The first of each group, then the second of each, until all are out. */
function roundRobin<T>(groups: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let i = 0; i < longest; i++) {
    for (const group of groups) {
      if (i < group.length) out.push(group[i]);
    }
  }
  return out;
}

function rankOf(mark: Mark | undefined): number {
  return mark === undefined ? 0 : PROBE_RANK[mark];
}

/** Each concept's worst mark across the turns given. */
function worstMarkByItem(turns: GradedTurn[]): Map<number, Mark> {
  const worst = new Map<number, Mark>();
  for (const turn of turns) {
    for (const { reviewItemId, mark } of turn.marks) {
      const current = worst.get(reviewItemId);
      if (current === undefined || PROBE_RANK[mark] < PROBE_RANK[current]) {
        worst.set(reviewItemId, mark);
      }
    }
  }
  return worst;
}
