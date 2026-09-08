import { expect, test } from "bun:test";
import { LectureExtract } from "./schema";

const concept = {
  label: "Low voltage with thick walls",
  detail: "Thick ventricular walls with low ECG voltage mean infiltration, not hypertrophy.",
  kind: "distinction" as const,
  provenance: "taught" as const,
  relatedObjectiveIndexes: [0],
};

function extractWith(conceptFields: Record<string, unknown>) {
  return {
    title: "Systemic Amyloidosis",
    learningObjectives: [{ text: "Describe amyloid.", slideRefs: [2] }],
    concepts: [{ ...concept, ...conceptFields }],
    practiceQuestions: [],
    commonConfusions: [],
    conflicts: [],
  };
}

test("a concept must say how the lecturer weighted it", () => {
  // A model that forgets the field fails validation and gets a repair turn,
  // rather than silently defaulting to neutral and hiding every cue it missed.
  expect(LectureExtract.safeParse(extractWith({})).success).toBe(false);
});

test("a concept carries the lecturer's cue with its emphasis", () => {
  const parsed = LectureExtract.parse(
    extractWith({
      emphasis: "emphasized",
      emphasisCue: "I will ask about this on the exam, so know it cold.",
    }),
  );
  expect(parsed.concepts[0].emphasis).toBe("emphasized");
  expect(parsed.concepts[0].emphasisCue).toBe(
    "I will ask about this on the exam, so know it cold.",
  );
});

test("emphasis is one of emphasized, neutral, deemphasized", () => {
  for (const emphasis of ["emphasized", "neutral", "deemphasized"]) {
    expect(
      LectureExtract.safeParse(extractWith({ emphasis, emphasisCue: "" })).success,
    ).toBe(true);
  }
  expect(
    LectureExtract.safeParse(extractWith({ emphasis: "important", emphasisCue: "" }))
      .success,
  ).toBe(false);
});
