import type { Rating } from "@/lib/db/schema";

/**
 * Deterministic spaced repetition, per prompt.txt "Spaced-Repetition
 * Scheduling". This is the bookkeeping half of the project's split: the model
 * judges an answer, but when the item comes back is decided here, in code that
 * can be read and tested.
 */

/** The default successful-review sequence. Beyond the last rung, intervals double. */
export const LADDER = [0, 1, 3, 7, 14, 30, 60] as const;

/** Yellow returns in the 1–3 day band regardless of how far the item had got. */
const YELLOW_INTERVAL = 1 + 1;

/** Red returns tomorrow, near the bottom of the ladder but not below it. */
const RED_INTERVAL = 1;

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
 * Hinted recall is never independent mastery (prompt.txt Retrieval Rule 8), so
 * a hinted green becomes yellow.
 *
 * This lives in code rather than the grading prompt on purpose: it is a policy,
 * not a judgement, and the model should not be able to grade its way around it.
 */
export function capRating(rating: Rating, hintsUsed: boolean): Rating {
  if (hintsUsed && rating === "green") return "yellow";
  return rating;
}

/** The next rung strictly above the current interval; doubling past the top. */
export function nextInterval(intervalDays: number): number {
  const rung = LADDER.find((days) => days > intervalDays);
  return rung ?? intervalDays * 2;
}

export interface ScheduleState {
  intervalDays: number;
  lapses: number;
}

export interface ScheduleResult {
  dueOn: string;
  intervalDays: number;
  lapses: number;
}

/**
 * Where a review item lands after being answered.
 *
 * `dueOn` is always `today + intervalDays`, so the stored interval always
 * describes the gap actually being used rather than a rung the item is not on.
 * Suspended items come back untouched: dark green means do not quiz again
 * until reactivated, so there is nothing to schedule.
 */
export function nextSchedule(
  state: ScheduleState,
  rating: Rating,
  today: string,
): ScheduleResult {
  if (rating === "suspended") {
    return {
      dueOn: addDays(today, state.intervalDays),
      intervalDays: state.intervalDays,
      lapses: state.lapses,
    };
  }

  const intervalDays =
    rating === "green"
      ? nextInterval(state.intervalDays)
      : rating === "yellow"
        ? YELLOW_INTERVAL
        : RED_INTERVAL;

  return {
    dueOn: addDays(today, intervalDays),
    intervalDays,
    lapses: rating === "red" ? state.lapses + 1 : state.lapses,
  };
}

/** Rating severity, worst first — the order used to summarise a day's attempts. */
const SEVERITY: Rating[] = ["red", "yellow", "green", "suspended"];

/**
 * The rating that represents a set of attempts on one objective in one session.
 *
 * The worst one. A green that follows a red in the same sitting is recall of
 * the correction just given, not independent retrieval, and a dashboard cell
 * has to describe the day honestly.
 */
export function worstRating(ratings: Rating[]): Rating | undefined {
  return SEVERITY.find((rating) => ratings.includes(rating));
}

/**
 * The rating that represents each objective across a set of turns.
 *
 * The worst one, per worstRating — and computed once, because the dashboard
 * cell and the review-item schedule describe the same performance and must
 * not be able to drift apart.
 */
export function worstByLo(
  turns: { loId: number | null; rating: Rating | null }[],
): Map<number, Rating> {
  const byLo = new Map<number, Rating[]>();
  for (const turn of turns) {
    if (turn.rating === null || turn.loId === null) continue;
    const ratings = byLo.get(turn.loId) ?? [];
    ratings.push(turn.rating);
    byLo.set(turn.loId, ratings);
  }

  const worst = new Map<number, Rating>();
  for (const [loId, ratings] of byLo) {
    const rating = worstRating(ratings);
    if (rating) worst.set(loId, rating);
  }
  return worst;
}
