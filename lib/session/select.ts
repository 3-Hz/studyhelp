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
 * time, never combining objectives. The mix keeps prompt.txt's proportions —
 * due, weak, recent, interleaved — as shares of the objectives covered.
 *
 * Pure by design — no database, no clock, no randomness. Ties break on ids,
 * so a test can assert an exact plan and a session can be explained after
 * the fact.
 */

/** A lecture counts as recent for a week after it reaches the dashboard. */
export const RECENT_DAYS = 7;

export type Bucket = "due" | "weak" | "recent" | "interleaved" | "fill";

/** The mix, as shares of the objectives a session covers: prompt.txt's 4/2/2/2 of ten. */
const MIX: { bucket: Exclude<Bucket, "fill">; share: number }[] = [
  { bucket: "due", share: 0.4 },
  { bucket: "weak", share: 0.2 },
  { bucket: "recent", share: 0.2 },
  { bucket: "interleaved", share: 0.2 },
];

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
  block: string | null;
  suspended: boolean;
  lectureCommittedOn: string;
  /** The objective's dashboard scores, oldest first. */
  scores: Score[];
  items: ItemCandidate[];
}

export interface PlannedSlot {
  /** 1-based position in the running order. */
  slot: number;
  bucket: Bucket;
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
 * three dashboard scores weighted by band. prompt.txt: "Review the full LO
 * history, not only the latest color." Three reds and then a five still
 * scores 4 — one good day does not erase the record.
 */
export function weakness(candidate: LoCandidate): number {
  const weakestItem = Math.max(0, ...candidate.items.map(itemWeakness));
  const recent = candidate.scores
    .slice(-3)
    .reduce((sum, score) => sum + HISTORY_WEIGHT[band(score)], 0);
  return weakestItem + recent;
}

function isWeak(candidate: LoCandidate): boolean {
  return (
    candidate.items.some(
      (item) =>
        item.lastRating === "red" || item.lastRating === "yellow" || item.lapses > 0,
    ) || candidate.scores.slice(-3).some((score) => band(score) !== "green")
  );
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

interface Pick {
  candidate: LoCandidate;
  bucket: Bucket;
}

export function select(
  candidates: LoCandidate[],
  opts: { today: string; los: number; perLo: number },
): PlannedSlot[] {
  const { today, los, perLo } = opts;

  const pool = candidates.filter(isEligible);

  const picks: Pick[] = [];
  const takenLos = new Set<number>();
  const perLecture = new Map<number, number>();
  // Without a cap, one freshly committed lecture takes the whole session.
  const cap = Math.max(1, Math.ceil(los / 3));

  const overdueBy = (c: LoCandidate) =>
    Math.max(...c.items.map((item) => daysBetween(item.dueOn, today)));
  const lectureAge = (c: LoCandidate) => daysBetween(c.lectureCommittedOn, today);
  const byLo = (c: LoCandidate) => c.loId;

  function represented(): Set<number> {
    return new Set(picks.map((pick) => pick.candidate.lectureId));
  }

  /** The block most of the session already sits in, if there is one. */
  function modalBlock(): string | null {
    const counts = new Map<string, number>();
    for (const pick of picks) {
      const block = pick.candidate.block;
      if (block) counts.set(block, (counts.get(block) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [block, count] of counts) {
      if (count > bestCount) {
        best = block;
        bestCount = count;
      }
    }
    return best;
  }

  /** The best remaining objective, relaxing the lecture cap only if it must. */
  function pick(
    options: LoCandidate[],
    compare: Comparator<LoCandidate>,
  ): LoCandidate | undefined {
    const strict = options.filter(
      (c) => !takenLos.has(c.loId) && (perLecture.get(c.lectureId) ?? 0) < cap,
    );
    const loose = options.filter((c) => !takenLos.has(c.loId));

    for (const list of [strict, loose]) {
      if (list.length > 0) return [...list].sort(compare)[0];
    }
    return undefined;
  }

  function take(
    bucket: Bucket,
    want: number,
    eligible: (c: LoCandidate) => boolean,
    compare: () => Comparator<LoCandidate>,
  ): number {
    let filled = 0;
    while (filled < want && picks.length < los) {
      const chosen = pick(pool.filter(eligible), compare());
      if (!chosen) break;

      picks.push({ candidate: chosen, bucket });
      takenLos.add(chosen.loId);
      perLecture.set(chosen.lectureId, (perLecture.get(chosen.lectureId) ?? 0) + 1);
      filled++;
    }
    return filled;
  }

  const eligibleFor: Record<Exclude<Bucket, "fill">, (c: LoCandidate) => boolean> = {
    due: (c) => isDue(c, today),
    weak: isWeak,
    recent: (c) => lectureAge(c) <= RECENT_DAYS,
    interleaved: (c) => !represented().has(c.lectureId),
  };

  const compareFor: Record<Exclude<Bucket, "fill">, () => Comparator<LoCandidate>> = {
    due: () => compose(byLo, highestFirst(overdueBy), highestFirst(weakness)),
    weak: () => compose(byLo, highestFirst(weakness), highestFirst(overdueBy)),
    recent: () =>
      compose(
        byLo,
        highestFirst((c) => (latestScore(c) === null ? 1 : 0)),
        (a, b) => lectureAge(a) - lectureAge(b),
      ),
    interleaved: () => {
      const block = modalBlock();
      return compose(
        byLo,
        highestFirst((c) => (block !== null && c.block === block ? 1 : 0)),
        highestFirst((c) => c.scores.length),
        highestFirst((c) => Math.max(0, ...c.items.map((item) => item.intervalDays))),
      );
    },
  };

  // An underfilled bucket hands its slots to the next one rather than
  // shortening the session: practising something not yet owed costs a little
  // efficiency, and nothing else.
  let carry = 0;
  for (const { bucket, share } of MIX) {
    // Interleaving is worth its own share and no more. Handing it a large
    // carry would turn a thin day into a tour of unrelated lectures, so its
    // overflow goes to the fallback fill below instead.
    const quota = Math.round(los * share) + (bucket === "interleaved" ? 0 : carry);
    const want = Math.min(quota, los - picks.length);
    const filled = take(bucket, want, eligibleFor[bucket], compareFor[bucket]);
    if (bucket !== "interleaved") carry = want - filled;
  }

  if (picks.length < los) {
    take(
      "fill",
      los - picks.length,
      () => true,
      () => compose(byLo, highestFirst(overdueBy), highestFirst(weakness)),
    );
  }

  return order(picks, perLo, today);
}

/**
 * The running order, decided after selection: objectives alternate lectures,
 * which is what interleaving is for, and an objective's questions stay
 * together, so the student sees one objective at a time.
 */
function order(picks: Pick[], perLo: number, today: string): PlannedSlot[] {
  const slots: PlannedSlot[] = [];
  for (const pick of interleave(picks)) {
    const questionOrder = orderFor(latestScore(pick.candidate));
    for (const item of itemsFor(pick.candidate, perLo, today)) {
      slots.push({
        slot: slots.length + 1,
        bucket: pick.bucket,
        order: questionOrder,
        tier: tierOf(item),
        loId: pick.candidate.loId,
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
function interleave(picks: Pick[]): Pick[] {
  const remaining = [...picks];
  const out: Pick[] = [];
  let previous: Pick | undefined;

  while (remaining.length > 0) {
    let index = 0;
    if (previous) {
      const differs = remaining.findIndex(
        (pick) => pick.candidate.lectureId !== previous!.candidate.lectureId,
      );
      index = Math.max(differs, 0);
    }

    previous = remaining[index];
    out.push(previous);
    remaining.splice(index, 1);
  }

  return out;
}
