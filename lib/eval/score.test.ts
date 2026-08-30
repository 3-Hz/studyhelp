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
};

function extract(partial: Partial<LectureExtract>): LectureExtract {
  return {
    title: "Systemic Amyloidosis",
    learningObjectives: [],
    concepts: [],
    commonConfusions: [],
    conflicts: [],
    ...partial,
  };
}

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
