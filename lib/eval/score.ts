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
  /** The deck's own practice questions the model recorded, allowing close wording. */
  practiceQuestionsFound: string[];
  /**
   * Concepts the lecturer stressed that the model did not mark emphasized:
   * absent, or present but unmarked. Either way it would not be guaranteed a
   * place, which is what the cue was for.
   */
  emphasisMissed: string[];
  /**
   * Concepts the lecturer set aside that the model kept as ordinary. Left out
   * altogether is not a miss: the student gets the right outcome, only
   * without the audit trail the prompt asks for.
   */
  deemphasisMissed: string[];
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

  // "Copied closely" allows a lead-in like "Test yourself:" either side, so a
  // question counts when one normalised text contains the other.
  const producedQuestions = extract.practiceQuestions
    .map((item) => normaliseKey(item.question))
    .filter((key) => key.length > 0);
  const practiceQuestionsFound = truth.practiceQuestions.filter((expected) => {
    const key = normaliseKey(expected);
    return producedQuestions.some((got) => got.includes(key) || key.includes(got));
  });

  const mentioning = (keyword: string) =>
    extract.concepts.filter((concept) =>
      `${concept.label} ${concept.detail}`.toLowerCase().includes(keyword.toLowerCase()),
    );

  const emphasisMissed = truth.emphasized.flatMap((keyword) => {
    const mentions = mentioning(keyword);
    if (mentions.some((concept) => concept.emphasis === "emphasized")) return [];
    return [
      mentions.length === 0
        ? `${keyword} — absent`
        : `${keyword} → "${mentions[0].label}" marked ${mentions[0].emphasis}`,
    ];
  });

  const deemphasisMissed = truth.deemphasized.flatMap((keyword) => {
    const kept = mentioning(keyword).filter((concept) => concept.emphasis !== "deemphasized");
    return kept.length === 0 ? [] : [`${keyword} → "${kept[0].label}" marked ${kept[0].emphasis}`];
  });

  return {
    exact,
    paraphrased,
    missed,
    hallucinated,
    provenanceErrors,
    notesFactsFound,
    practiceQuestionsFound,
    emphasisMissed,
    deemphasisMissed,
    conceptCount: extract.concepts.length,
  };
}

/** Single number for ranking: fraction of objectives reproduced verbatim. */
export function verbatimRate(score: Score, truth: GroundTruth): number {
  if (truth.objectives.length === 0) return 1;
  return score.exact.length / truth.objectives.length;
}
