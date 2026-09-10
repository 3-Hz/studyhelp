import type { LectureExtract } from "./schema";

/**
 * Factories for extracts in tests. Not a test file: importing one of those
 * re-registers its tests in the importer.
 */

export type ExtractConcept = LectureExtract["concepts"][number];
export type ExtractQuestion = LectureExtract["practiceQuestions"][number];

export function extract(partial: Partial<LectureExtract>): LectureExtract {
  return {
    title: "",
    learningObjectives: [],
    concepts: [],
    practiceQuestions: [],
    commonConfusions: [],
    conflicts: [],
    ...partial,
  };
}

/** A taught, neutral fact under the first objective, unless told otherwise. */
export function concept(
  partial: Partial<ExtractConcept> & { label: string },
): ExtractConcept {
  return {
    detail: "",
    kind: "fact",
    provenance: "taught",
    emphasis: "neutral",
    emphasisCue: "",
    relatedObjectiveIndexes: [0],
    ...partial,
  };
}

export function question(
  partial: Partial<ExtractQuestion> & { question: string },
): ExtractQuestion {
  return {
    answer: "The answer.",
    slideRefs: [],
    conceptIndexes: [0],
    relatedObjectiveIndexes: [0],
    ...partial,
  };
}
