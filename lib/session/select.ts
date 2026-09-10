import type { Mark, ReviewKind, Score } from "@/lib/db/schema";
import {
  band,
  daysBetween,
  orderFor,
  tierOf,
  type QuestionOrder,
  type Tier,
} from "@/lib/schedule";
import type { QuestionFormat } from "@/lib/tutor";

/**
 * Choosing the day's objectives and the questions on each, per new_prompt.txt
 * "Repetition Quiz Session": spaced by time since last review and performance
 * history, interleaved by switching between lectures, one objective at a
 * time, never combining objectives.
 *
 * One ranking does the choosing: the objective whose concept is most overdue
 * comes first, dashboard weakness breaks ties, then never having been
 * scored. Each concept keeps its own expanding interval (lib/schedule.ts),
 * the Leitner model Make It Stick recommends, so "time since last review"
 * is read off the concept's due date rather than estimated for the
 * objective as a whole.
 *
 * Pure by design — no database, no clock, no randomness. Ties break on ids,
 * so a test can assert an exact plan and a session can be explained after
 * the fact.
 */

/** A review item, as selection sees it. */
export interface ItemCandidate {
  reviewItemId: number;
  /** The concept's number within its objective. */
  ordinal: number;
  kind: ReviewKind;
  dueOn: string;
  intervalDays: number;
  lapses: number;
  streak: number;
  lastRating: Mark | null;
}

/** An objective, with everything selection needs to weigh it and pick its items. */
export interface LoCandidate {
  loId: number;
  lectureId: number;
  suspended: boolean;
  /** The objective's dashboard scores, oldest first. */
  scores: Score[];
  items: ItemCandidate[];
}

export interface PlannedSlot {
  /** 1-based position in the running order. */
  slot: number;
  /**
   * How demanding the question is, from the objective's latest score. Frozen
   * with the plan, like the tier: the row does not change until finish, and
   * a session stays explainable from its plan alone.
   */
  order: QuestionOrder;
  /** The item's mastery tier when the plan was made, for the badge. */
  tier: Tier;
  loId: number;
  reviewItemId: number;
  formatFamily: QuestionFormat[];
}

export const FORMAT_FAMILY: Record<ReviewKind, QuestionFormat[]> = {
  fact: ["free_recall", "short_answer", "error_correction"],
  mechanism: ["mechanism", "pathway", "consequence"],
  relationship: ["mechanism", "comparison", "consequence"],
  distinction: ["discrimination", "comparison", "error_correction"],
  application: ["vignette", "patient_teaching", "discrimination"],
};

/**
 * Whether an objective is in play at all. Suspended (dark green) means "do
 * not quiz again unless I reactivate it" — exported so /practice's counts
 * and select()'s pool share one definition instead of two that can drift.
 */
export function isEligible(candidate: LoCandidate): boolean {
  return !candidate.suspended && candidate.items.length > 0;
}

/** Whether a review item is owed today. */
export function isItemDue(item: ItemCandidate, today: string): boolean {
  return item.dueOn <= today;
}

/**
 * Whether an objective is owed today: it is when any concept under it is.
 * Exported for the same reason as isEligible: /practice's "due today" count
 * has to mean what select() means.
 */
export function isDue(candidate: LoCandidate, today: string): boolean {
  return candidate.items.some((item) => isItemDue(item, today));
}

/** The objective's most recent dashboard score, if it has one. */
export function latestScore(candidate: LoCandidate): Score | null {
  return candidate.scores.length > 0 ? candidate.scores[candidate.scores.length - 1] : null;
}

const LAST_MARK_WEIGHT: Record<Mark, number> = { red: 3, yellow: 1, green: 0 };
const HISTORY_WEIGHT: Record<Mark, number> = { red: 2, yellow: 1, green: 0 };

/** How badly one concept has been going: lapses twice over, plus its last mark. */
export function itemWeakness(item: ItemCandidate): number {
  return 2 * item.lapses + (item.lastRating ? LAST_MARK_WEIGHT[item.lastRating] : 0);
}

/**
 * How badly an objective has been going: its weakest concept, plus its last
 * three dashboard scores weighted by band — the "performance history" the
 * new prompt reads off the Dashboard. Three reds and then a five still
 * scores 4: one good day does not erase the record.
 */
export function weakness(candidate: LoCandidate): number {
  const weakestItem = Math.max(0, ...candidate.items.map(itemWeakness));
  const recent = candidate.scores
    .slice(-3)
    .reduce((sum, score) => sum + HISTORY_WEIGHT[band(score)], 0);
  return weakestItem + recent;
}

/**
 * The formats the model may pick from for one slot.
 *
 * Narrowed from the slot's family by what the session has already used: no
 * format twice in a row, none more than twice in a session. The two rules
 * are not equally important — a repeat right after itself is far more
 * visible to the student than a repeat somewhere in the last ten questions
 * — so when narrowing by both would empty the set, only the twice-in-a-
 * session cap is relaxed first, and the immediate-repeat rule survives as
 * long as there is any format left to satisfy it. The whole family, repeat
 * and all, is the last resort: a repeated format beats no question at all.
 */
export function allowedFormats(
  family: QuestionFormat[],
  used: QuestionFormat[],
  previous?: QuestionFormat,
): QuestionFormat[] {
  const counts = new Map<QuestionFormat, number>();
  for (const format of used) {
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }

  const narrowed = family.filter(
    (format) => (counts.get(format) ?? 0) < 2 && format !== previous,
  );
  if (narrowed.length > 0) return narrowed;

  const notPrevious = family.filter((format) => format !== previous);
  return notPrevious.length > 0 ? notPrevious : family;
}

type Comparator<T> = (a: T, b: T) => number;

/** Ties always break on an id, which keeps selection reproducible. */
function compose<T>(id: (x: T) => number, ...comparators: Comparator<T>[]): Comparator<T> {
  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b);
      if (result !== 0) return result;
    }
    return id(a) - id(b);
  };
}

const highestFirst =
  <T>(score: (x: T) => number): Comparator<T> =>
  (a, b) =>
    score(b) - score(a);

export function select(
  candidates: LoCandidate[],
  opts: { today: string; los: number; perLo: number },
): PlannedSlot[] {
  const { today, los, perLo } = opts;

  const pool = candidates.filter(isEligible);

  // Days past the objective's earliest due date. Negative means nothing is
  // owed yet: such an objective sorts last but still fills a thin session —
  // practising early costs a little efficiency, skipping costs the session.
  const overdueBy = (c: LoCandidate) =>
    Math.max(...c.items.map((item) => daysBetween(item.dueOn, today)));

  const ranked = [...pool].sort(
    compose<LoCandidate>(
      (c) => c.loId,
      highestFirst(overdueBy),
      highestFirst(weakness),
      highestFirst((c) => (latestScore(c) === null ? 1 : 0)),
    ),
  );

  // Without a cap, one freshly extracted lecture takes the whole session.
  // The cap gives way only when nothing under it remains.
  const cap = Math.max(1, Math.ceil(los / 3));
  const picks: LoCandidate[] = [];
  const taken = new Set<number>();
  const perLecture = new Map<number, number>();

  for (const strict of [true, false]) {
    for (const candidate of ranked) {
      if (picks.length >= los) break;
      if (taken.has(candidate.loId)) continue;
      const fromLecture = perLecture.get(candidate.lectureId) ?? 0;
      if (strict && fromLecture >= cap) continue;

      picks.push(candidate);
      taken.add(candidate.loId);
      perLecture.set(candidate.lectureId, fromLecture + 1);
    }
  }

  return order(picks, perLo, today);
}

/**
 * The running order, decided after selection: objectives alternate lectures,
 * which is what interleaving is for, and an objective's questions stay
 * together, so the student sees one objective at a time.
 */
function order(picks: LoCandidate[], perLo: number, today: string): PlannedSlot[] {
  const slots: PlannedSlot[] = [];
  for (const candidate of interleave(picks)) {
    const questionOrder = orderFor(latestScore(candidate));
    for (const item of itemsFor(candidate, perLo, today)) {
      slots.push({
        slot: slots.length + 1,
        order: questionOrder,
        tier: tierOf(item),
        loId: candidate.loId,
        reviewItemId: item.reviewItemId,
        formatFamily: FORMAT_FAMILY[item.kind],
      });
    }
  }
  return slots;
}

/** The concepts to ask under one objective: most overdue, then weakest, then never asked. */
function itemsFor(candidate: LoCandidate, perLo: number, today: string): ItemCandidate[] {
  const compare = compose<ItemCandidate>(
    (item) => item.reviewItemId,
    highestFirst((item) => daysBetween(item.dueOn, today)),
    highestFirst(itemWeakness),
    highestFirst((item) => (item.lastRating === null ? 1 : 0)),
  );
  return [...candidate.items].sort(compare).slice(0, perLo);
}

/** Greedy: take the next objective whose lecture differs from the last. */
function interleave(picks: LoCandidate[]): LoCandidate[] {
  const remaining = [...picks];
  const out: LoCandidate[] = [];
  let previous: LoCandidate | undefined;

  while (remaining.length > 0) {
    let index = 0;
    if (previous) {
      const differs = remaining.findIndex(
        (candidate) => candidate.lectureId !== previous!.lectureId,
      );
      index = Math.max(differs, 0);
    }

    previous = remaining[index];
    out.push(previous);
    remaining.splice(index, 1);
  }

  return out;
}
