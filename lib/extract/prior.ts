/**
 * What a lecture already holds, shown to the model before it reads the
 * materials again. An amend re-extracts everything and reconciles the result
 * into the existing rows by wording, so the model has to be told the wording
 * to reuse; otherwise every re-read would coin new labels and the LO Map
 * would fill with duplicates.
 */
export interface PriorObjective {
  /** The objective's text, verbatim. */
  text: string;
  /** The labels of its concepts, in ordinal order, suspended ones included. */
  concepts: string[];
}

export const PRIOR_HEADING = "# Already extracted";

/** The block as the model sees it; empty when nothing has been extracted yet. */
export function formatPrior(prior: PriorObjective[]): string {
  if (prior.length === 0) return "";

  const sections = prior.map((objective, index) => {
    const lines =
      objective.concepts.length === 0
        ? ["(no concepts recorded)"]
        : objective.concepts.map((label) => `- ${label}`);
    return [`Objective ${index + 1}: ${objective.text}`, ...lines].join("\n");
  });

  return [PRIOR_HEADING, ...sections].join("\n\n");
}
