import { expect, test } from "bun:test";
import { mergeExtracts, normaliseKey } from "./merge";
import type { LectureExtract } from "./schema";

function extract(partial: Partial<LectureExtract>): LectureExtract {
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

test("unions practice questions across chunks, deduped on the question", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      practiceQuestions: [
        {
          question: "Which stain confirms amyloid?",
          answer: "Congo red.",
          slideRefs: [8],
          relatedObjectiveIndexes: [0],
          conceptIndexes: [],
        },
      ],
    }),
    extract({
      learningObjectives: [{ text: "Objective B", slideRefs: [12] }],
      practiceQuestions: [
        // The same question, seen again on a recap slide in the next chunk.
        {
          question: "which stain confirms amyloid",
          answer: "Congo red, with apple-green birefringence.",
          slideRefs: [20],
          relatedObjectiveIndexes: [0],
          conceptIndexes: [],
        },
        {
          question: "What is the normal free light chain ratio?",
          answer: "0.26 to 1.65.",
          slideRefs: [21],
          relatedObjectiveIndexes: [0],
          conceptIndexes: [],
        },
      ],
    }),
  ]);

  expect(merged.practiceQuestions).toHaveLength(2);
  // First wording and answer survive; slide references and objective links union.
  expect(merged.practiceQuestions[0].question).toBe("Which stain confirms amyloid?");
  expect(merged.practiceQuestions[0].answer).toBe("Congo red.");
  expect(merged.practiceQuestions[0].slideRefs).toEqual([8, 20]);
  expect(merged.practiceQuestions[0].relatedObjectiveIndexes).toEqual([0, 1]);
  // The second chunk's local objective 0 is merged objective 1.
  expect(merged.practiceQuestions[1].relatedObjectiveIndexes).toEqual([1]);
});

test("an empty merge carries no practice questions", () => {
  expect(mergeExtracts([]).practiceQuestions).toEqual([]);
});

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
          emphasis: "neutral",
          emphasisCue: "",
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
          emphasis: "neutral",
          emphasisCue: "",
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
          emphasis: "neutral",
          emphasisCue: "",
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
          emphasis: "neutral",
          emphasisCue: "",
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
          emphasis: "neutral",
          emphasisCue: "",
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

/** A concept literal with the fields a merge test rarely cares about filled in. */
function concept(
  overrides: Partial<LectureExtract["concepts"][number]> & { label: string },
): LectureExtract["concepts"][number] {
  return {
    detail: "",
    kind: "fact",
    provenance: "taught",
    emphasis: "neutral",
    emphasisCue: "",
    relatedObjectiveIndexes: [0],
    ...overrides,
  };
}

test("a cue heard in a later chunk outranks the neutral reading of an earlier one", () => {
  // Slides are packed before the transcript, so the slide that teaches a
  // concept and the moment the lecturer waves it off usually land in
  // different chunks. First-wins would lose the cue.
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [concept({ label: "V122I variant" })],
    }),
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        concept({
          label: "v122i variant",
          emphasis: "deemphasized",
          emphasisCue: "You do not need to memorise the V122I variant.",
        }),
      ],
    }),
  ]);

  expect(merged.concepts).toHaveLength(1);
  expect(merged.concepts[0].emphasis).toBe("deemphasized");
  expect(merged.concepts[0].emphasisCue).toBe(
    "You do not need to memorise the V122I variant.",
  );
});

test("emphasized outranks deemphasized when chunks disagree", () => {
  // Wrongly keeping a concept costs a few questions; wrongly cutting one
  // costs an exam item. The stronger claim wins regardless of chunk order.
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        concept({
          label: "Apple-green birefringence",
          emphasis: "deemphasized",
          emphasisCue: "Just for interest.",
        }),
      ],
    }),
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        concept({
          label: "Apple-green birefringence",
          emphasis: "emphasized",
          emphasisCue: "This comes up every year.",
        }),
      ],
    }),
  ]);

  expect(merged.concepts[0].emphasis).toBe("emphasized");
  expect(merged.concepts[0].emphasisCue).toBe("This comes up every year.");
});

test("a neutral reading in a later chunk leaves an earlier cue in place", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [
        concept({
          label: "Lag phase",
          emphasis: "deemphasized",
          emphasisCue: "I won't test you on the kinetics.",
        }),
      ],
    }),
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [concept({ label: "Lag phase" })],
    }),
  ]);

  expect(merged.concepts[0].emphasis).toBe("deemphasized");
  expect(merged.concepts[0].emphasisCue).toBe("I won't test you on the kinetics.");
});

function plainConcept(label: string, objectives: number[]): LectureExtract["concepts"][number] {
  return {
    label,
    detail: "",
    kind: "fact",
    provenance: "taught",
    emphasis: "neutral",
    emphasisCue: "",
    relatedObjectiveIndexes: objectives,
  };
}

function question(text: string, conceptIndexes: number[]): LectureExtract["practiceQuestions"][number] {
  return { question: text, answer: "", slideRefs: [], relatedObjectiveIndexes: [0], conceptIndexes };
}

test("remaps a question's concept indexes onto merged positions", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [plainConcept("Cross-beta sheet", [0]), plainConcept("Congo red", [0])],
    }),
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [9] }],
      concepts: [plainConcept("Transthyretin", [0])],
      practiceQuestions: [question("Which precursor forms ATTR?", [0])],
    }),
  ]);

  // The second chunk's local concept 0 is merged concept 2.
  expect(merged.concepts.map((c) => c.label)).toEqual([
    "Cross-beta sheet",
    "Congo red",
    "Transthyretin",
  ]);
  expect(merged.practiceQuestions[0].conceptIndexes).toEqual([2]);
});

test("a question keeps its link when its concept was merged into an earlier chunk's", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [plainConcept("Cross-beta sheet", [0]), plainConcept("Congo red", [0])],
    }),
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [9] }],
      concepts: [plainConcept("congo red", [0])],
      practiceQuestions: [question("Which stain?", [0])],
    }),
  ]);

  expect(merged.concepts).toHaveLength(2);
  expect(merged.practiceQuestions[0].conceptIndexes).toEqual([1]);
});

test("a duplicate question unions its concept links", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [plainConcept("Congo red", [0])],
      practiceQuestions: [question("Which stain, and what do you see?", [0])],
    }),
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [9] }],
      concepts: [plainConcept("Apple-green birefringence", [0])],
      practiceQuestions: [question("Which stain, and what do you see?", [0])],
    }),
  ]);

  expect(merged.practiceQuestions).toHaveLength(1);
  expect(merged.practiceQuestions[0].conceptIndexes).toEqual([0, 1]);
});

test("a question's link to a concept that was never emitted is dropped", () => {
  const merged = mergeExtracts([
    extract({
      learningObjectives: [{ text: "Objective A", slideRefs: [1] }],
      concepts: [plainConcept("Congo red", [0])],
      practiceQuestions: [question("Which stain?", [0, 7])],
    }),
    extract({ learningObjectives: [{ text: "Objective B", slideRefs: [2] }] }),
  ]);

  expect(merged.practiceQuestions[0].conceptIndexes).toEqual([0]);
});
