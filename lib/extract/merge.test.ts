import { expect, test } from "bun:test";
import { mergeExtracts, normaliseKey } from "./merge";
import type { LectureExtract } from "./schema";

function extract(partial: Partial<LectureExtract>): LectureExtract {
  return {
    title: "",
    learningObjectives: [],
    concepts: [],
    commonConfusions: [],
    conflicts: [],
    ...partial,
  };
}

test("returns the single part untouched", () => {
  const only = extract({ title: "Amyloidosis" });
  expect(mergeExtracts([only])).toBe(only);
});

test("returns an empty extract for no parts", () => {
  expect(mergeExtracts([]).learningObjectives).toEqual([]);
});

test("takes the first non-empty title", () => {
  const merged = mergeExtracts([
    extract({ title: "" }),
    extract({ title: "Amyloidosis" }),
  ]);
  expect(merged.title).toBe("Amyloidosis");
});

test("collapses duplicate objectives and keeps the first verbatim wording", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [
        { text: "Describe the structure of amyloid fibrils.", slideRefs: [2] },
      ],
    }),
    extract({
      // Same objective, different casing and trailing punctuation — a very
      // common artifact of re-reading a repeated objectives slide.
      learningObjectives: [
        { text: "describe the structure of amyloid fibrils", slideRefs: [9] },
      ],
    }),
  ]);

  expect(merged.learningObjectives).toHaveLength(1);
  // The FIRST spelling survives; verbatim wording must not be normalised away.
  expect(merged.learningObjectives[0].text).toBe(
    "Describe the structure of amyloid fibrils.",
  );
  expect(merged.learningObjectives[0].slideRefs).toEqual([2, 9]);
});

test("ignores a leading list marker when deduping", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "1. Compare AL and ATTR.", slideRefs: [1] }],
    }),
    extract({
      learningObjectives: [{ text: "Compare AL and ATTR.", slideRefs: [4] }],
    }),
  ]);
  expect(merged.learningObjectives).toHaveLength(1);
});

test("keeps genuinely different objectives separate and in first-seen order", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
    }),
    extract({
      learningObjectives: [
        { text: "Objective B", slideRefs: [5] },
        { text: "Objective C", slideRefs: [6] },
      ],
    }),
  ]);
  expect(merged.learningObjectives.map((o) => o.text)).toEqual([
    "Objective A",
    "Objective B",
    "Objective C",
  ]);
});

test("remaps concept objective indexes onto merged positions", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        {
          label: "Concept A",
          detail: "",
          kind: "fact",
          provenance: "taught",
          relatedObjectiveIndexes: [0],
        },
      ],
    }),
    extract({
      // Local index 0 here is a DIFFERENT objective than local index 0 above.
      learningObjectives: [{ text: "Objective B", slideRefs: [5] }],
      concepts: [
        {
          label: "Concept B",
          detail: "",
          kind: "mechanism",
          provenance: "taught",
          relatedObjectiveIndexes: [0],
        },
      ],
    }),
  ]);

  const conceptA = merged.concepts.find((c) => c.label === "Concept A");
  const conceptB = merged.concepts.find((c) => c.label === "Concept B");
  expect(conceptA?.relatedObjectiveIndexes).toEqual([0]);
  // Must point at Objective B's merged index (1), not its local index (0).
  expect(conceptB?.relatedObjectiveIndexes).toEqual([1]);
});

test("merges duplicate concepts and unions their objective links", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        {
          label: "Congo red",
          detail: "Stains amyloid.",
          kind: "fact",
          provenance: "taught",
          relatedObjectiveIndexes: [0],
        },
      ],
    }),
    extract({
      learningObjectives: [{ text: "Objective B", slideRefs: [2] }],
      concepts: [
        {
          label: "congo red",
          detail: "Apple-green birefringence.",
          kind: "fact",
          provenance: "taught",
          relatedObjectiveIndexes: [0],
        },
      ],
    }),
  ]);

  expect(merged.concepts).toHaveLength(1);
  expect(merged.concepts[0].relatedObjectiveIndexes).toEqual([0, 1]);
});

test("drops concept links to objectives that were never emitted", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        {
          label: "Dangling",
          detail: "",
          kind: "fact",
          provenance: "taught",
          // Index 7 does not exist — a model hallucinating a reference.
          relatedObjectiveIndexes: [0, 7],
        },
      ],
    }),
    extract({}),
  ]);

  expect(merged.concepts[0].relatedObjectiveIndexes).toEqual([0]);
});

test("unions confusions and conflicts without duplicates", () => {
  const merged = mergeExtracts([
    extract({
      commonConfusions: ["AL vs ATTR"],
      conflicts: ["Slide says X, literature says Y"],
    }),
    extract({
      commonConfusions: ["AL vs ATTR.", "Primary vs secondary"],
      conflicts: ["Slide says X, literature says Y"],
    }),
  ]);

  expect(merged.commonConfusions).toEqual(["AL vs ATTR", "Primary vs secondary"]);
  expect(merged.conflicts).toHaveLength(1);
});

test("normaliseKey folds case, punctuation, quotes and whitespace", () => {
  expect(normaliseKey("  Describe   the “fibril” structure!  ")).toBe(
    "describe the fibril structure",
  );
});
