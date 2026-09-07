import type { Mark, Score } from "@/lib/db/schema";

/**
 * Deterministic spaced repetition, per prompt.txt "Spaced-Repetition
 * Scheduling". This is the bookkeeping half of the project's split: the model
 * judges an answer, but when the item comes back is decided here, in code that
 * can be read and tested.
 */

/** The default successful-review sequence. Beyond the last rung, intervals double. */
export const LADDER = [0, 1, 3, 7, 14, 30, 60] as const;

/**
 * The ladder for an item that has ever lapsed: the same span with twice the
 * rungs. Recovery is slower, never punitive. Lapses are permanent, so an item
 * that failed once climbs this ladder from then on — "review the full
 * history, not only the latest colour", in the scheduler's own terms.
 */
export const LAPSED_LADDER = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60] as const;

/** Yellow returns within the prompt's 1–3 day band. */
const YELLOW_MIN = 1;
const YELLOW_MAX = 3;

/** Red returns tomorrow, near the bottom of the ladder but not below it. */
const RED_INTERVAL = 1;

/** Mastery needs repeated retrieval across increasing intervals: three greens, two weeks. */
const MATURE_STREAK = 3;
const MATURE_INTERVAL = 14;

/**
 * Today as a local calendar date.
 *
 * Local, not UTC: `toISOString()` would roll over to tomorrow for anyone west
 * of Greenwich studying in the evening, filing a 9pm session under the wrong
 * dashboard column.
 */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Midnight of the local calendar day, for bounding "did this session start
 * today" queries.
 *
 * Local, not UTC, for the same reason todayIso is: a UTC-based midnight would
 * file an evening session west of Greenwich under the wrong day, either
 * rejoining a session that should count as yesterday's or refusing to rejoin
 * one that should still count as today's.
 */
export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Calendar arithmetic on a YYYY-MM-DD string, done in UTC so DST cannot shift it. */
export function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Whole days from one calendar date to another, negative when `to` is earlier.
 *
 * Parsed as UTC for the same reason addDays is: a daylight-saving boundary
 * between the two dates would otherwise make the difference a fraction and
 * round it to the wrong day.
 */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * A score folded onto a mark. 5 is green; 4 — "correct with help, or mostly
 * correct" — is yellow; 3 and below are red, because the rubric's 3 includes
 * "a big mistake", and a big mistake is what red has always meant here.
 *
 * One function for three uses: the dashboard cell's colour, the objective's
 * question order, and the mark a target concept falls back to when the
 * grader did not mark it.
 */
export function band(score: Score): Mark {
  if (score === 5) return "green";
  if (score === 4) return "yellow";
  return "red";
}

/**
 * How demanding the next question on an objective should be, from its latest
 * score (new_prompt.txt "Repetition Quiz Session"): first-order on recent
 * poor performance, second on neutral, third on good. Never scored counts as
 * poor: nothing is known yet.
 */
export const QUESTION_ORDERS = ["first", "second", "third"] as const;
export type QuestionOrder = (typeof QUESTION_ORDERS)[number];

export function orderFor(latestScore: Score | null): QuestionOrder {
  if (latestScore === null) return "first";
  if (latestScore <= 3) return "first";
  if (latestScore === 4) return "second";
  return "third";
}

/**
 * Hinted recall is never independent mastery (prompt.txt Retrieval Rule 8).
 * "Correct with help" is a 4 by the rubric, so a cue turns a 5 into a 4 and
 * touches nothing else.
 *
 * This lives in code rather than the grading prompt on purpose: it is a
 * policy, not a judgement, and the model should not be able to grade its way
 * around it.
 */
export function capScore(score: Score, hintsUsed: boolean): Score {
  if (hintsUsed && score === 5) return 4;
  return score;
}

/** The mark-level twin of capScore: hinted recall of a concept is not green. */
export function capMark(mark: Mark, hintsUsed: boolean): Mark {
  if (hintsUsed && mark === "green") return "yellow";
  return mark;
}

/** The next rung strictly above the current interval; doubling past the top. */
export function nextInterval(intervalDays: number, lapses = 0): number {
  const ladder: readonly number[] = lapses > 0 ? LAPSED_LADDER : LADDER;
  const rung = ladder.find((days) => days > intervalDays);
  return rung ?? intervalDays * 2;
}

/**
 * Yellow halves the interval, held within 1–3 days: a mature item that was
 * merely incomplete comes back in three days, a fragile one tomorrow.
 */
export function yellowInterval(intervalDays: number): number {
  return Math.min(YELLOW_MAX, Math.max(YELLOW_MIN, Math.floor(intervalDays / 2)));
}

export interface ScheduleState {
  intervalDays: number;
  lapses: number;
  /** Consecutive greens. */
  streak: number;
}

export interface ScheduleResult {
  dueOn: string;
  intervalDays: number;
  lapses: number;
  streak: number;
}

/**
 * Where a review item lands after its concept was marked.
 *
 * `dueOn` is always `today + intervalDays`, so the stored interval always
 * describes the gap actually being used rather than a rung the item is not on.
 * A suspended objective's items are never marked, so there is nothing to
 * schedule for them.
 */
export function nextSchedule(
  state: ScheduleState,
  mark: Mark,
  today: string,
): ScheduleResult {
  const intervalDays =
    mark === "green"
      ? nextInterval(state.intervalDays, state.lapses)
      : mark === "yellow"
        ? yellowInterval(state.intervalDays)
        : RED_INTERVAL;

  return {
    dueOn: addDays(today, intervalDays),
    intervalDays,
    lapses: mark === "red" ? state.lapses + 1 : state.lapses,
    streak: mark === "green" ? state.streak + 1 : 0,
  };
}

export const TIERS = ["new", "relearning", "consolidating", "mature"] as const;
export type Tier = (typeof TIERS)[number];

export interface TierState {
  lastRating: Mark | null;
  lapses: number;
  streak: number;
  intervalDays: number;
}

/**
 * How far an item has come, from the four fields on its row.
 *
 * "relearning", not "weak": select() has a weak bucket with a broader meaning
 * that includes the objective's dashboard history. Bucket says why an item
 * was chosen today; tier is the badge's account of how far it has come. No
 * single mark reaches mature — that takes three greens in a row and a
 * fortnight's interval.
 */
export function tierOf(state: TierState): Tier {
  if (state.lastRating === null) return "new";
  if (state.lastRating === "red" || state.lastRating === "yellow") {
    return "relearning";
  }
  if (state.streak >= MATURE_STREAK && state.intervalDays >= MATURE_INTERVAL) {
    return "mature";
  }
  return "consolidating";
}

/** Mark severity, worst first — the order used to summarise a day's marks. */
const MARK_SEVERITY: Mark[] = ["red", "yellow", "green"];

/**
 * The mark that represents a concept across one sitting: the worst one. A
 * green that follows a red in the same sitting is recall of the correction
 * just given, not independent retrieval, and the record has to describe the
 * day honestly.
 */
export function worstMark(marks: Mark[]): Mark | undefined {
  return MARK_SEVERITY.find((mark) => marks.includes(mark));
}

/**
 * The score that represents each objective across a set of turns: the lowest
 * one. A 5 that follows a 2 in the same sitting is recall of the correction
 * just given, and the dashboard cell has to describe the day honestly.
 */
export function minScoreByLo(
  turns: { loId: number | null; score: Score | null }[],
): Map<number, Score> {
  const lowest = new Map<number, Score>();
  for (const turn of turns) {
    if (turn.score === null || turn.loId === null) continue;
    const current = lowest.get(turn.loId);
    if (current === undefined || turn.score < current) {
      lowest.set(turn.loId, turn.score);
    }
  }
  return lowest;
}
