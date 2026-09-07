/**
 * How much a session can hold, from the minutes the student has
 * (new_prompt.txt: "note how much time I have … to determine the quantity
 * and depth of the questions"). Pure, so a plan is reproducible from the
 * number stored on the session row.
 */

/** A retrieval question, its answer, and reading the feedback. */
export const MINUTES_PER_QUESTION = 2;

/** What a session gets when no time is given: the ten questions of old. */
export const DEFAULT_MINUTES = 20;

/** Questions per objective, by session length: depth follows time. */
const DEPTH_BANDS: { belowMinutes: number; perLo: number }[] = [
  { belowMinutes: 15, perLo: 1 },
  { belowMinutes: 30, perLo: 2 },
];
const MAX_PER_LO = 3;

export interface Budget {
  questions: number;
  perLo: number;
  /** Objectives to cover. */
  los: number;
}

export function budgetFor(minutes: number): Pick<Budget, "questions" | "perLo"> {
  const questions = Math.max(1, Math.floor(minutes / MINUTES_PER_QUESTION));
  const band = DEPTH_BANDS.find((band) => minutes < band.belowMinutes);
  return { questions, perLo: band?.perLo ?? MAX_PER_LO };
}

/** Depth first: the time band fixes questions per objective, then as many objectives as fit. */
export function dailyBudget(minutes: number): Budget {
  const { questions, perLo } = budgetFor(minutes);
  return { questions, perLo, los: Math.max(1, Math.floor(questions / perLo)) };
}

/**
 * Breadth first: every objective once before any objective twice, since a
 * same-day review is the lecture's only pass through all of them. Depth is
 * whatever is left over, capped so one objective never eats the session.
 */
export function sameDayBudget(minutes: number, activeLoCount: number): Budget {
  const { questions } = budgetFor(minutes);
  const los = Math.min(activeLoCount, questions);
  const perLo = los === 0 ? 1 : Math.min(MAX_PER_LO, Math.max(1, Math.floor(questions / los)));
  return { questions, perLo, los };
}

/**
 * `count` items spread evenly through `items`, first and last included, so a
 * short session spans the lecture rather than stopping partway through it.
 */
export function spacedSubset<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= items.length) return [...items];
  if (count === 1) return [items[0]];
  const last = items.length - 1;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * last) / (count - 1))]);
}
