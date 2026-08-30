import { normaliseKey } from "@/lib/extract/merge";
import type { LectureExtract } from "@/lib/extract/schema";
import type { GroundTruth } from "@/lib/fixtures/syntheticLecture";

/**
 * Scores an extraction against a known answer key.
 *
 * The headline metric is the paraphrase count. Verbatim objective wording is a
 * hard requirement of this app — the dashboard shows objectives as the course
 * worded them — and paraphrasing is exactly the failure a weaker model commits
 * silently. An objective that is "found" but reworded is a defect, not a pass,
 * so exact and normalised matches are counted separately rather than merged.
 */

export interface Score {
  /** Objectives reproduced byte-for-byte. */
  exact: string[];
  /** Present in substance but reworded — a failure for our purposes. */
  paraphrased: { expected: string; got: string }[];
  /** In the answer key, absent from the output. */
  missed: string[];
  /** In the output, matching nothing in the answer key. */
  hallucinated: string[];
  /** Supplemental content wrongly attributed to the lecture. */
  provenanceErrors: string[];
  /** Notes-only facts that surfaced, i.e. presenter notes were actually read. */
  notesFactsFound: string[];
  conceptCount: number;
}

export function scoreExtract(
  extract: LectureExtract,
  truth: GroundTruth,
): Score {
  const produced = extract.learningObjectives.map((o) => o.text);
  const producedByKey = new Map<string, string>();
  for (const text of produced) {
    const key = normaliseKey(text);
    if (!producedByKey.has(key)) producedByKey.set(key, text);
  }

  const exact: string[] = [];
  const paraphrased: { expected: string; got: string }[] = [];
  const missed: string[] = [];
  const matchedKeys = new Set<string>();

  for (const expected of truth.objectives) {
    if (produced.includes(expected)) {
      exact.push(expected);
      matchedKeys.add(normaliseKey(expected));
      continue;
    }

    const key = normaliseKey(expected);
    const near = producedByKey.get(key);
    if (near !== undefined) {
      paraphrased.push({ expected, got: near });
      matchedKeys.add(key);
      continue;
    }

    missed.push(expected);
  }

  const hallucinated = produced.filter(
    (text) => !matchedKeys.has(normaliseKey(text)),
  );

  // A supplemental trap labelled "taught" means the model attributed outside
  // knowledge to the lecture — the misattribution prompt.txt warns against.
  const provenanceErrors: string[] = [];
  for (const trap of truth.supplementalTraps) {
    const offending = extract.concepts.find(
      (concept) =>
        concept.provenance === "taught" &&
        `${concept.label} ${concept.detail}`
          .toLowerCase()
          .includes(trap.toLowerCase()),
    );
    if (offending) provenanceErrors.push(`${trap} → "${offending.label}"`);
  }

  const haystack = extract.concepts
    .map((c) => `${c.label} ${c.detail}`)
    .join(" ")
    .toLowerCase();
  const notesFactsFound = truth.notesOnlyFacts.filter((fact) =>
    haystack.includes(fact.toLowerCase()),
  );

  return {
    exact,
    paraphrased,
    missed,
    hallucinated,
    provenanceErrors,
    notesFactsFound,
    conceptCount: extract.concepts.length,
  };
}

/** Single number for ranking: fraction of objectives reproduced verbatim. */
export function verbatimRate(score: Score, truth: GroundTruth): number {
  if (truth.objectives.length === 0) return 1;
  return score.exact.length / truth.objectives.length;
}
