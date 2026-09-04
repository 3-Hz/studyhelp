import type { Rating, ReviewKind } from "@/lib/db/schema";
import { daysBetween } from "@/lib/schedule";
import type { QuestionFormat } from "@/lib/tutor";

/**
 * Choosing the day's ten questions, per prompt.txt "Daily Anki-Like Retrieval
 * Practice": four due for spaced review, two from recent material, two weak or
 * previously missed, two interleaved or cumulative.
 *
 * Pure by design — no database, no clock, no randomness. Ties break on review
 * item id, so a test can assert an exact plan and a session can be explained
 * after the fact.
 */

export const SESSION_SIZE = 10;
/** A lecture counts as recent for a week after it reaches the dashboard. */
export const RECENT_DAYS = 7;
/** Without a cap, one freshly committed lecture takes the whole session. */
export const MAX_PER_LECTURE = 3;

export type Bucket = "due" | "weak" | "recent" | "interleaved" | "fill";

export interface Candidate {
  reviewItemId: number;
  loId: number;
  lectureId: number;
  block: string | null;
  kind: ReviewKind;
  dueOn: string;
  intervalDays: number;
  lapses: number;
  lastRating: Rating | null;
  loSuspended: boolean;
  lectureCommittedOn: string;
  /** The objective's dashboard colours, oldest first. */
  history: Rating[];
}

export interface PlannedSlot {
  /** 1-based position in the running order. */
  slot: number;
  bucket: Bucket;
  loId: number;
  reviewItemId: number;
  /** Concepts from other lectures a cumulative question should reach for. */
  companionItemIds: number[];
  formatFamily: QuestionFormat[];
}

export const FORMAT_FAMILY: Record<ReviewKind, QuestionFormat[]> = {
  fact: ["free_recall", "short_answer", "error_correction"],
  mechanism: ["mechanism", "pathway", "consequence"],
  application: ["vignette", "patient_teaching", "discrimination"],
};

/** Cumulative slots ask the student to connect or distinguish, never to recite. */
export const CUMULATIVE_FAMILY: QuestionFormat[] = [
  "synthesis",
  "comparison",
  "discrimination",
];

/**
 * Whether an objective is in play at all. Suspended (dark green) means "do
 * not quiz again unless I reactivate it" — exported so /practice's counts
 * and select()'s pool share one definition instead of two that can drift.
 */
export function isEligible(candidate: Candidate): boolean {
  return !candidate.loSuspended;
}

/**
 * Whether a review item is owed today. Exported for the same reason as
 * isEligible: /practice's "due today" count has to mean what select() means.
 */
export function isDue(candidate: Candidate, today: string): boolean {
  return candidate.dueOn <= today;
}

const LAST_RATING_WEIGHT: Record<Rating, number> = {
  red: 3,
  yellow: 1,
  green: 0,
  suspended: 0,
};

const HISTORY_WEIGHT: Record<Rating, number> = {
  red: 2,
  yellow: 1,
  green: 0,
  suspended: 0,
};

/**
 * How badly an item has been going.
 *
 * prompt.txt: "Review the full LO history, not only the latest color." This
 * reads the last three dashboard colours, not the item's whole history — a
 * bounded stand-in for that rule, not the rule itself. Three reds and then a
 * green still scores 4 — one good day does not erase the record.
 */
export function weakness(candidate: Candidate): number {
  const recent = candidate.history.slice(-3);
  return (
    2 * candidate.lapses +
    (candidate.lastRating ? LAST_RATING_WEIGHT[candidate.lastRating] : 0) +
    recent.reduce((sum, rating) => sum + HISTORY_WEIGHT[rating], 0)
  );
}

function isWeak(candidate: Candidate): boolean {
  return (
    candidate.lastRating === "red" ||
    candidate.lastRating === "yellow" ||
    candidate.lapses > 0 ||
    candidate.history.slice(-3).some((r) => r === "red" || r === "yellow")
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

type Comparator = (a: Candidate, b: Candidate) => number;

/** Ties always break on review item id, which keeps selection reproducible. */
function compose(...comparators: Comparator[]): Comparator {
  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b);
      if (result !== 0) return result;
    }
    return a.reviewItemId - b.reviewItemId;
  };
}

const highestFirst =
  (score: (c: Candidate) => number): Comparator =>
  (a, b) =>
    score(b) - score(a);

interface Pick {
  candidate: Candidate;
  bucket: Bucket;
}

export function select(
  candidates: Candidate[],
  opts: { today: string; size?: number },
): PlannedSlot[] {
  const { today } = opts;
  const size = opts.size ?? SESSION_SIZE;

  const pool = candidates.filter(isEligible);

  const picks: Pick[] = [];
  const takenItems = new Set<number>();
  const takenLos = new Set<number>();
  const perLecture = new Map<number, number>();

  const overdueBy = (c: Candidate) => daysBetween(c.dueOn, today);
  const lectureAge = (c: Candidate) => daysBetween(c.lectureCommittedOn, today);

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

  /**
   * The best remaining option, relaxing the diversity rules only as far as it
   * must: lecture cap first, since breaching it still varies the objective.
   */
  function pick(options: Candidate[], compare: Comparator): Candidate | undefined {
    const strict = options.filter(
      (c) =>
        !takenLos.has(c.loId) &&
        (perLecture.get(c.lectureId) ?? 0) < MAX_PER_LECTURE,
    );
    const loose = options.filter((c) => !takenLos.has(c.loId));

    for (const list of [strict, loose, options]) {
      if (list.length > 0) return [...list].sort(compare)[0];
    }
    return undefined;
  }

  function take(
    bucket: Bucket,
    want: number,
    eligible: (c: Candidate) => boolean,
    compare: () => Comparator,
  ): number {
    let filled = 0;
    while (filled < want && picks.length < size) {
      const options = pool.filter(
        (c) => !takenItems.has(c.reviewItemId) && eligible(c),
      );
      const chosen = pick(options, compare());
      if (!chosen) break;

      picks.push({ candidate: chosen, bucket });
      takenItems.add(chosen.reviewItemId);
      takenLos.add(chosen.loId);
      perLecture.set(
        chosen.lectureId,
        (perLecture.get(chosen.lectureId) ?? 0) + 1,
      );
      filled++;
    }
    return filled;
  }

  const buckets: {
    bucket: Bucket;
    quota: number;
    eligible: (c: Candidate) => boolean;
    compare: () => Comparator;
  }[] = [
    {
      bucket: "due",
      quota: 4,
      eligible: (c) => isDue(c, today),
      compare: () => compose(highestFirst(overdueBy), highestFirst(weakness)),
    },
    {
      bucket: "weak",
      quota: 2,
      eligible: isWeak,
      compare: () => compose(highestFirst(weakness), highestFirst(overdueBy)),
    },
    {
      bucket: "recent",
      quota: 2,
      eligible: (c) => lectureAge(c) <= RECENT_DAYS,
      compare: () =>
        compose(
          highestFirst((c) => (c.lastRating === null ? 1 : 0)),
          (a, b) => lectureAge(a) - lectureAge(b),
        ),
    },
    {
      bucket: "interleaved",
      quota: 2,
      eligible: (c) => !represented().has(c.lectureId),
      compare: () => {
        const block = modalBlock();
        return compose(
          highestFirst((c) => (block !== null && c.block === block ? 1 : 0)),
          highestFirst((c) => c.history.length),
          highestFirst((c) => c.intervalDays),
        );
      },
    },
  ];

  // An underfilled bucket hands its slots to the next one rather than
  // shortening the session: practising something not yet owed costs a little
  // efficiency, and nothing else.
  let carry = 0;
  for (const spec of buckets) {
    // Interleaving is worth exactly two slots. Handing it a large carry would
    // turn a thin day into six cumulative questions, so its overflow goes to
    // the fallback fill below instead.
    const quota =
      spec.bucket === "interleaved" ? spec.quota : spec.quota + carry;
    const want = Math.min(quota, size - picks.length);
    const filled = take(spec.bucket, want, spec.eligible, spec.compare);
    if (spec.bucket !== "interleaved") carry = want - filled;
  }

  if (picks.length < size) {
    take(
      "fill",
      size - picks.length,
      () => true,
      () => compose(highestFirst(overdueBy), highestFirst(weakness)),
    );
  }

  return order(picks);
}

/**
 * The running order, decided after selection.
 *
 * Cumulative questions go at positions 5 and 10, where there is material
 * behind them. The rest avoid consecutive questions from one lecture or of one
 * kind, which is what interleaving is for.
 */
function order(picks: Pick[]): PlannedSlot[] {
  const total = picks.length;
  if (total === 0) return [];

  const cumulative = picks.filter((pick) => pick.bucket === "interleaved");
  const rest = picks.filter((pick) => pick.bucket !== "interleaved");

  const positions =
    total >= SESSION_SIZE
      ? [5, total].slice(0, cumulative.length)
      : cumulative.map((_, index) => total - cumulative.length + index + 1);

  const sequence: (Pick | undefined)[] = new Array(total).fill(undefined);
  cumulative.forEach((pick, index) => {
    const position = positions[index];
    if (position !== undefined) sequence[position - 1] = pick;
  });

  const spread = interleave(rest);
  let cursor = 0;
  for (let index = 0; index < total; index++) {
    if (sequence[index]) continue;
    sequence[index] = spread[cursor++];
  }

  // Spent across cumulative slots in order, so the second cumulative question
  // doesn't reach for exactly the material the first one already used.
  const spentCompanions = new Set<number>();

  return sequence
    .filter((pick): pick is Pick => pick !== undefined)
    .map((pick, index) => {
      const isCumulative = pick.bucket === "interleaved";
      const companionItemIds = isCumulative
        ? companionsFor(pick, picks, spentCompanions)
        : [];
      for (const id of companionItemIds) spentCompanions.add(id);
      return {
        slot: index + 1,
        bucket: pick.bucket,
        loId: pick.candidate.loId,
        reviewItemId: pick.candidate.reviewItemId,
        companionItemIds,
        formatFamily: isCumulative
          ? CUMULATIVE_FAMILY
          : FORMAT_FAMILY[pick.candidate.kind],
      };
    });
}

/** Greedy: take the next item that shares neither lecture nor kind with the last. */
function interleave(picks: Pick[]): Pick[] {
  const remaining = [...picks];
  const out: Pick[] = [];
  let previous: Pick | undefined;

  while (remaining.length > 0) {
    let index = 0;
    if (previous) {
      const differsInBoth = remaining.findIndex(
        (pick) =>
          pick.candidate.lectureId !== previous!.candidate.lectureId &&
          pick.candidate.kind !== previous!.candidate.kind,
      );
      const differsInLecture = remaining.findIndex(
        (pick) => pick.candidate.lectureId !== previous!.candidate.lectureId,
      );
      index = differsInBoth >= 0 ? differsInBoth : Math.max(differsInLecture, 0);
    }

    previous = remaining[index];
    out.push(previous);
    remaining.splice(index, 1);
  }

  return out;
}

/**
 * Up to two concepts from other lectures, for a question that spans them.
 *
 * Skips companions an earlier cumulative slot already spent, falling back to
 * the full pool only if that exclusion would leave nothing — a shared
 * companion beats a cumulative question with none.
 */
function companionsFor(
  pick: Pick,
  picks: Pick[],
  spent: Set<number>,
): number[] {
  const eligible = picks.filter(
    (other) =>
      other.candidate.reviewItemId !== pick.candidate.reviewItemId &&
      other.candidate.lectureId !== pick.candidate.lectureId,
  );
  const unspent = eligible.filter(
    (other) => !spent.has(other.candidate.reviewItemId),
  );
  const pool = unspent.length > 0 ? unspent : eligible;
  return pool.slice(0, 2).map((other) => other.candidate.reviewItemId);
}
