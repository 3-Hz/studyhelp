import type { ConceptEmphasis, Provenance } from "@/lib/db/schema";

/** The small uppercase tag every badge is built on. */
export const BADGE = "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide";

export const PROVENANCE_STYLE: Record<Provenance, string> = {
  taught:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  derived: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  supplemental: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
};

/** The lecturer's cue, when there was one. Neutral concepts carry no badge. */
export const EMPHASIS_BADGE: Partial<
  Record<ConceptEmphasis, { label: string; style: string }>
> = {
  emphasized: {
    label: "lecturer emphasized",
    style: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  deemphasized: {
    label: "lecturer set aside",
    style: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  },
};

/** Tested by one of the lecture's own questions: a key concept by construction. */
export const QUIZ_BADGE = {
  label: "practice quiz",
  style: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200",
};
