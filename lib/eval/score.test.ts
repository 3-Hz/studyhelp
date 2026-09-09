import { expect, test } from "bun:test";
import type { LectureExtract } from "@/lib/extract/schema";
import type { GroundTruth } from "@/lib/fixtures/syntheticLecture";
import { scoreExtract, verbatimRate } from "./score";

const truth: GroundTruth = {
  title: "Systemic Amyloidosis",
  objectives: [
    "Describe the structural features common to all amyloid fibrils.",
    "Compare AL and ATTR amyloidosis.",
  ],
  taughtConcepts: ["cross-beta sheet"],
  supplementalTraps: ["tafamidis"],
  notesOnlyFacts: ["0.26 to 1.65"],
  practiceQuestions: ["Which stain confirms amyloid on the biopsy?"],
  emphasized: ["low voltage"],
  deemphasized: ["V122I"],
  quizTested: [
    {
      question: "Which light-chain isotype is more often implicated in AL amyloidosis?",
      concept: "lambda",
    },
  ],
  additionalOnlyConcepts: ["SAP scintigraphy"],
};

function extract(partial: Partial<LectureExtract>): LectureExtract {
  return {
    title: "Systemic Amyloidosis",
    learningObjectives: [],
    concepts: [],
    practiceQuestions: [],
    commonConfusions: [],
    conflicts: [],
    ...partial,
  };
}

test("counts the deck's practice questions the model found, allowing for close wording", () => {
  const score = scoreExtract(
    extract({
      practiceQuestions: [
        {
          question: "Test yourself: which stain confirms amyloid on the biopsy?",
          answer: "Congo red.",
          slideRefs: [8],
          relatedObjectiveIndexes: [],
          conceptIndexes: [],
        },
      ],
    }),
    truth,
  );
  expect(score.practiceQuestionsFound).toEqual(truth.practiceQuestions);
});

test("a practice question the model composed itself is not one it found", () => {
  const score = scoreExtract(
    extract({
      practiceQuestions: [
        {
          question: "What is the precursor in AL amyloidosis?",
          answer: "Light chains.",
          slideRefs: [],
          relatedObjectiveIndexes: [],
          conceptIndexes: [],
        },
      ],
    }),
    truth,
  );
  expect(score.practiceQuestionsFound).toEqual([]);
});

function objectives(...texts: string[]) {
  return texts.map((text) => ({ text, slideRefs: [] }));
}

test("counts a byte-identical objective as exact", () => {
  const score = scoreExtract(
    extract({ learningObjectives: objectives(truth.objectives[0]) }),
    truth,
  );
  expect(score.exact).toEqual([truth.objectives[0]]);
  expect(score.paraphrased).toHaveLength(0);
});

test("counts a reworded objective as paraphrased, not as found", () => {
  // The whole point of the metric: this is a defect, not a pass. The dashboard
  // is supposed to show the course's wording, not the model's.
  const score = scoreExtract(
    extract({
      learningObjectives: objectives(
        "describe the structural features common to all amyloid fibrils",
      ),
    }),
    truth,
  );
  expect(score.exact).toHaveLength(0);
  expect(score.paraphrased).toHaveLength(1);
  expect(score.paraphrased[0].expected).toBe(truth.objectives[0]);
  expect(score.missed).toHaveLength(1); // the other objective
});

test("a paraphrase is not also counted as a hallucination", () => {
  const score = scoreExtract(
    extract({
      learningObjectives: objectives(
        "describe the structural features common to all amyloid fibrils",
      ),
    }),
    truth,
  );
  expect(score.hallucinated).toHaveLength(0);
});

test("reports objectives that are not in the deck", () => {
  const score = scoreExtract(
    extract({
      learningObjectives: objectives(
        truth.objectives[0],
        truth.objectives[1],
        "Explain the pharmacology of doxycycline.",
      ),
    }),
    truth,
  );
  expect(score.hallucinated).toEqual(["Explain the pharmacology of doxycycline."]);
});

test("reports objectives the model never produced", () => {
  const score = scoreExtract(extract({}), truth);
  expect(score.missed).toEqual(truth.objectives);
  expect(verbatimRate(score, truth)).toBe(0);
});

test("flags supplemental content labelled as taught", () => {
  const score = scoreExtract(
    extract({
      concepts: [
        {
          label: "Tafamidis",
          detail: "Stabilises the transthyretin tetramer.",
          kind: "application",
          provenance: "taught",
          emphasis: "neutral",
          emphasisCue: "",
          relatedObjectiveIndexes: [],
        },
      ],
    }),
    truth,
  );
  expect(score.provenanceErrors).toHaveLength(1);
});

test("does not flag supplemental content correctly labelled", () => {
  const score = scoreExtract(
    extract({
      concepts: [
        {
          label: "Tafamidis",
          detail: "Stabilises the transthyretin tetramer.",
          kind: "application",
          provenance: "supplemental",
          emphasis: "neutral",
          emphasisCue: "",
          relatedObjectiveIndexes: [],
        },
      ],
    }),
    truth,
  );
  expect(score.provenanceErrors).toHaveLength(0);
});

test("detects that presenter notes were actually read", () => {
  const score = scoreExtract(
    extract({
      concepts: [
        {
          label: "Free light chain ratio",
          detail: "A normal ratio is 0.26 to 1.65.",
          kind: "fact",
          provenance: "taught",
          emphasis: "neutral",
          emphasisCue: "",
          relatedObjectiveIndexes: [],
        },
      ],
    }),
    truth,
  );
  expect(score.notesFactsFound).toEqual(["0.26 to 1.65"]);
});

test("verbatimRate reflects the fraction reproduced exactly", () => {
  const score = scoreExtract(
    extract({ learningObjectives: objectives(truth.objectives[0]) }),
    truth,
  );
  expect(verbatimRate(score, truth)).toBe(0.5);
});

test("duplicate objectives in the output do not inflate the score", () => {
  const score = scoreExtract(
    extract({
      learningObjectives: objectives(
        truth.objectives[0],
        truth.objectives[0],
        truth.objectives[1],
      ),
    }),
    truth,
  );
  expect(score.exact).toHaveLength(2);
  expect(verbatimRate(score, truth)).toBe(1);
  expect(score.hallucinated).toHaveLength(0);
});

function cued(
  label: string,
  emphasis: "emphasized" | "neutral" | "deemphasized",
): LectureExtract["concepts"][number] {
  return {
    label,
    detail: "",
    kind: "fact",
    provenance: "taught",
    emphasis,
    emphasisCue: emphasis === "neutral" ? "" : "The lecturer said so.",
    relatedObjectiveIndexes: [],
  };
}

test("an emphasized concept the model marked emphasized is not missed", () => {
  const score = scoreExtract(
    extract({ concepts: [cued("Low voltage with thick walls", "emphasized")] }),
    truth,
  );
  expect(score.emphasisMissed).toEqual([]);
});

test("an emphasized concept is missed whether the model left it unmarked or left it out", () => {
  const unmarked = scoreExtract(
    extract({ concepts: [cued("Low voltage with thick walls", "neutral")] }),
    truth,
  );
  expect(unmarked.emphasisMissed).toHaveLength(1);
  expect(unmarked.emphasisMissed[0]).toContain("low voltage");
  expect(unmarked.emphasisMissed[0]).toContain("neutral");

  const absent = scoreExtract(extract({ concepts: [] }), truth);
  expect(absent.emphasisMissed).toHaveLength(1);
  expect(absent.emphasisMissed[0]).toContain("absent");
});

test("a de-emphasized concept the model kept as ordinary is missed", () => {
  const score = scoreExtract(
    extract({ concepts: [cued("V122I variant", "neutral")] }),
    truth,
  );
  expect(score.deemphasisMissed).toHaveLength(1);
  expect(score.deemphasisMissed[0]).toContain("V122I");
});

test("a de-emphasized concept marked as such, or left out altogether, is not missed", () => {
  // Left out is not a miss: the student gets the right outcome, only without
  // the audit trail the prompt asks for.
  const flagged = scoreExtract(
    extract({ concepts: [cued("V122I variant", "deemphasized")] }),
    truth,
  );
  expect(flagged.deemphasisMissed).toEqual([]);

  const absent = scoreExtract(extract({ concepts: [] }), truth);
  expect(absent.deemphasisMissed).toEqual([]);
});

function labelled(
  label: string,
  provenance: "taught" | "derived" | "supplemental" = "taught",
): LectureExtract["concepts"][number] {
  return {
    label,
    detail: "",
    kind: "fact",
    provenance,
    emphasis: "neutral",
    emphasisCue: "",
    relatedObjectiveIndexes: [],
  };
}

function quizQuestion(conceptIndexes: number[]): LectureExtract["practiceQuestions"][number] {
  return {
    question: "Quiz: which light-chain isotype is more often implicated in AL amyloidosis?",
    answer: "Lambda.",
    slideRefs: [],
    relatedObjectiveIndexes: [],
    conceptIndexes,
  };
}

test("a quiz question found and linked to the concept it tests is honoured", () => {
  const score = scoreExtract(
    extract({
      concepts: [labelled("Congo red"), labelled("Lambda light chains predominate in AL")],
      practiceQuestions: [quizQuestion([1])],
    }),
    truth,
  );
  expect(score.quizConceptsMissed).toEqual([]);
});

test("a quiz question is missed when it is absent, its concept is absent, or the link is wrong", () => {
  const noQuestion = scoreExtract(
    extract({ concepts: [labelled("Lambda light chains predominate in AL")] }),
    truth,
  );
  expect(noQuestion.quizConceptsMissed).toEqual(["lambda — question not found"]);

  const noConcept = scoreExtract(
    extract({ concepts: [labelled("Congo red")], practiceQuestions: [quizQuestion([0])] }),
    truth,
  );
  expect(noConcept.quizConceptsMissed).toEqual(["lambda — concept absent"]);

  const wrongLink = scoreExtract(
    extract({
      concepts: [labelled("Congo red"), labelled("Lambda light chains predominate in AL")],
      practiceQuestions: [quizQuestion([0])],
    }),
    truth,
  );
  expect(wrongLink.quizConceptsMissed).toEqual([
    "lambda — concept present but not linked from the question",
  ]);
});

test("a handout concept extracted as taught is honoured", () => {
  const score = scoreExtract(
    extract({ concepts: [labelled("SAP scintigraphy images whole-body amyloid load")] }),
    truth,
  );
  expect(score.additionalMissed).toEqual([]);
});

test("a handout concept is missed when absent or labelled supplemental", () => {
  const absent = scoreExtract(extract({ concepts: [] }), truth);
  expect(absent.additionalMissed).toEqual(["SAP scintigraphy — absent"]);

  // The confusion the naming rule guards against: course material read as
  // outside knowledge.
  const outside = scoreExtract(
    extract({
      concepts: [labelled("SAP scintigraphy images whole-body amyloid load", "supplemental")],
    }),
    truth,
  );
  expect(outside.additionalMissed).toHaveLength(1);
  expect(outside.additionalMissed[0]).toContain("supplemental");
});
