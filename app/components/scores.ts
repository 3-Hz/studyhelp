import type { Mark, Score } from "@/lib/db/schema";
import { band } from "@/lib/schedule";

/** The rubric, per new_prompt.txt "Scoring", as the UI names each score. */
export const SCORE_LABEL: Record<Score, string> = {
  5: "5 — correct without help",
  4: "4 — correct with help, or mostly correct",
  3: "3 — partially correct, with a big mistake",
  2: "2 — not correct",
  1: "1 — no idea",
};

/** Highest first, for legends and tallies. */
export const SCORES_DESC: Score[] = [5, 4, 3, 2, 1];

export const MARK_LABEL: Record<Mark, string> = {
  green: "Correct",
  yellow: "Partially correct, or a minor error",
  red: "Incorrect",
};

export const MARK_STYLE: Record<Mark, string> = {
  green: "bg-emerald-500 text-white",
  yellow: "bg-amber-400 text-stone-900",
  red: "bg-red-500 text-white",
};

/** Dark green marks a suspended objective: do not quiz again unless reactivated. */
export const SUSPENDED_STYLE = "bg-emerald-900";

/** A score takes its band's colour. */
export function scoreStyle(score: Score): string {
  return MARK_STYLE[band(score)];
}
