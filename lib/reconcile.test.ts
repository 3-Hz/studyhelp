import { expect, test } from "bun:test";
import { concept, question } from "@/lib/extract/testUtils";
import {
  reconcileConcepts,
  reconcileObjectives,
  reconcileQuestions,
  type ExistingItem,
  type ExistingObjective,
  type ExistingQuestion,
} from "./reconcile";

/**
 * Reconciliation is what lets a lecture be extracted again without losing
 * anything: rows are matched by wording and kept, new ones append with the
 * next number, and nothing is ever deleted or renumbered.
 */

const TODAY = "2026-09-09";

function objectives(...texts: string[]) {
  return texts.map((text) => ({ text, slideRefs: [] as number[] }));
}

function item(
  id: number,
  loId: number,
  ordinal: number,
  label: string,
  emphasis: ExistingItem["emphasis"] = "neutral",
  emphasisCue = "",
): ExistingItem {
  return { id, loId, ordinal, label, emphasis, emphasisCue };
}

// --- objectives ---

test("a first extraction inserts every objective in order and matches none", () => {
  const plan = reconcileObjectives([], objectives("Describe fibrils.", "Compare AL and ATTR."));

  expect(plan.inserts).toEqual([
    { text: "Describe fibrils.", orderIndex: 0, extractIndexes: [0] },
    { text: "Compare AL and ATTR.", orderIndex: 1, extractIndexes: [1] },
  ]);
  expect(plan.matched.size).toBe(0);
});

test("a recorded objective matches on its wording, and a new one appends after the last", () => {
  const existing: ExistingObjective[] = [
    { id: 7, text: "Describe fibrils.", orderIndex: 0 },
    { id: 8, text: "Old and unmentioned.", orderIndex: 1 },
  ];

  const plan = reconcileObjectives(existing, objectives("describe fibrils", "Compare AL and ATTR."));

  expect([...plan.matched]).toEqual([[0, 7]]);
  expect(plan.inserts).toEqual([
    { text: "Compare AL and ATTR.", orderIndex: 2, extractIndexes: [1] },
  ]);
});

test("a repeated objective collapses onto the first, and blank text is skipped", () => {
  const plan = reconcileObjectives([], objectives("Describe fibrils.", "   ", "describe fibrils"));

  expect(plan.inserts).toEqual([
    { text: "Describe fibrils.", orderIndex: 0, extractIndexes: [0, 2] },
  ]);
});

// --- concepts ---

/** Extract objective 0 is row 10, objective 1 is row 11. */
const lo = new Map([
  [0, 10],
  [1, 11],
]);

test("a first extraction numbers concepts under each objective in extract order", () => {
  const plan = reconcileConcepts(
    [],
    [
      concept({ label: "Beta-pleated sheet", relatedObjectiveIndexes: [0] }),
      concept({ label: "AL vs ATTR", relatedObjectiveIndexes: [1] }),
      concept({ label: "Congo red", detail: "Apple-green.", relatedObjectiveIndexes: [0] }),
    ],
    lo,
    TODAY,
  );

  expect(plan.inserts.map((i) => [i.loId, i.ordinal, i.concept])).toEqual([
    [10, 1, "Beta-pleated sheet"],
    [11, 1, "AL vs ATTR"],
    [10, 2, "Congo red — Apple-green."],
  ]);
  expect(plan.inserts[2]).toMatchObject({
    label: "Congo red",
    kind: "fact",
    provenance: "taught",
    emphasis: "neutral",
    emphasisCue: "",
    suspended: false,
    dueOn: TODAY,
    intervalDays: 0,
    extractIndexes: [2],
  });
  expect(plan.matched.size).toBe(0);
  expect(plan.updates).toEqual([]);
});

test("a concept files under the first objective that resolves, and is skipped when none does", () => {
  const plan = reconcileConcepts(
    [],
    [
      concept({ label: "Resolves second", relatedObjectiveIndexes: [5, 1] }),
      concept({ label: "Never resolves", relatedObjectiveIndexes: [5] }),
      concept({ label: "Names none", relatedObjectiveIndexes: [] }),
    ],
    lo,
    TODAY,
  );

  expect(plan.inserts.map((i) => [i.label, i.loId])).toEqual([["Resolves second", 11]]);
});

test("a recorded concept matches on its label and keeps its number; a new one takes the next", () => {
  const existing = [item(1, 10, 1, "Beta-pleated sheet"), item(2, 10, 2, "Congo red")];

  const plan = reconcileConcepts(
    existing,
    [concept({ label: "congo red!" }), concept({ label: "Fibril diameter" })],
    lo,
    TODAY,
  );

  expect([...plan.matched]).toEqual([[0, 2]]);
  expect(plan.inserts.map((i) => [i.label, i.loId, i.ordinal])).toEqual([
    ["Fibril diameter", 10, 3],
  ]);
});

test("the same extract applied again plans nothing", () => {
  const first = [concept({ label: "A" }), concept({ label: "B", relatedObjectiveIndexes: [1] })];
  const existing = [item(1, 10, 1, "A"), item(2, 11, 1, "B")];

  const plan = reconcileConcepts(existing, first, lo, TODAY);

  expect(plan.inserts).toEqual([]);
  expect(plan.updates).toEqual([]);
  expect([...plan.matched]).toEqual([
    [0, 1],
    [1, 2],
  ]);
});

test("a concept the model refiled under another objective matches where it already is", () => {
  const existing = [item(1, 10, 1, "Congo red")];

  const plan = reconcileConcepts(
    existing,
    [concept({ label: "Congo red", relatedObjectiveIndexes: [1] })],
    lo,
    TODAY,
  );

  expect([...plan.matched]).toEqual([[0, 1]]);
  expect(plan.inserts).toEqual([]);
});

test("a set-aside concept starts suspended; a matched one is never re-suspended or freed", () => {
  const setAside = concept({
    label: "Fibril diameter",
    emphasis: "deemphasized",
    emphasisCue: "You do not need the diameter.",
  });

  const fresh = reconcileConcepts([], [setAside], lo, TODAY);
  expect(fresh.inserts[0]).toMatchObject({
    suspended: true,
    emphasis: "deemphasized",
    emphasisCue: "You do not need the diameter.",
  });

  const again = reconcileConcepts([item(1, 10, 1, "Fibril diameter")], [setAside], lo, TODAY);
  expect(again.updates).toEqual([
    { id: 1, emphasis: "deemphasized", emphasisCue: "You do not need the diameter." },
  ]);
});

test("emphasis on a matched concept moves up in rank, never down", () => {
  const stressed = item(1, 10, 1, "Congo red", "emphasized", "Know this.");
  const plain = item(1, 10, 1, "Congo red");
  const neutral = concept({ label: "Congo red" });
  const setAside = concept({ label: "Congo red", emphasis: "deemphasized", emphasisCue: "Skip." });
  const emphasized = concept({ label: "Congo red", emphasis: "emphasized", emphasisCue: "Know this." });

  // A run that saw no cue cannot erase one, and set aside does not beat stressed.
  expect(reconcileConcepts([stressed], [neutral], lo, TODAY).updates).toEqual([]);
  expect(reconcileConcepts([stressed], [setAside], lo, TODAY).updates).toEqual([]);
  expect(reconcileConcepts([plain], [emphasized], lo, TODAY).updates).toEqual([
    { id: 1, emphasis: "emphasized", emphasisCue: "Know this." },
  ]);
});

test("duplicate labels within one extract collapse onto one row that both indexes name", () => {
  const plan = reconcileConcepts(
    [],
    [concept({ label: "Congo red" }), concept({ label: "congo red " })],
    lo,
    TODAY,
  );

  expect(plan.inserts).toHaveLength(1);
  expect(plan.inserts[0].extractIndexes).toEqual([0, 1]);
});

test("a draft from before emphasis existed reads as neutral", () => {
  const legacy = { ...concept({ label: "Congo red" }) } as Record<string, unknown>;
  delete legacy.emphasis;
  delete legacy.emphasisCue;

  const plan = reconcileConcepts([], [legacy as never], lo, TODAY);

  expect(plan.inserts[0]).toMatchObject({ emphasis: "neutral", emphasisCue: "", suspended: false });
});

// --- practice questions ---

/** Extract concept 0 is item 100, concept 1 is item 101. */
const items = new Map([
  [0, 100],
  [1, 101],
]);

test("a new question links the concepts it tests, dropping indexes that name no row", () => {
  const plan = reconcileQuestions(
    [],
    [
      question({
        question: "Which stain confirms amyloid?",
        answer: "Congo red.",
        slideRefs: [8],
        conceptIndexes: [1, 0, 9, 1],
        relatedObjectiveIndexes: [5, 1],
      }),
    ],
    lo,
    items,
  );

  expect(plan.inserts).toEqual([
    {
      loId: 11,
      question: "Which stain confirms amyloid?",
      answer: "Congo red.",
      slideRefs: [8],
      reviewItemIds: [101, 100],
    },
  ]);
  expect(plan.updates).toEqual([]);
});

test("a question under no resolving objective is kept, unattached", () => {
  const plan = reconcileQuestions(
    [],
    [question({ question: "Loose?", relatedObjectiveIndexes: [] })],
    lo,
    items,
  );

  expect(plan.inserts[0].loId).toBeNull();
});

test("a recorded question is not inserted again, and gains the links it lacked", () => {
  const existing: ExistingQuestion[] = [
    { id: 5, question: "Which stain confirms amyloid?", reviewItemIds: [100] },
  ];

  const plan = reconcileQuestions(
    existing,
    [question({ question: "which stain confirms amyloid", conceptIndexes: [0, 1] })],
    lo,
    items,
  );

  expect(plan.inserts).toEqual([]);
  expect(plan.updates).toEqual([{ id: 5, reviewItemIds: [100, 101] }]);
});

test("a recorded question whose links are complete is left alone", () => {
  const existing: ExistingQuestion[] = [
    { id: 5, question: "Which stain?", reviewItemIds: [101, 100] },
  ];

  const plan = reconcileQuestions(
    existing,
    [question({ question: "Which stain?", conceptIndexes: [0, 1] })],
    lo,
    items,
  );

  expect(plan.updates).toEqual([]);
});

test("a question from a draft before links existed is inserted unlinked", () => {
  const legacy = { ...question({ question: "Which stain?" }) } as Record<string, unknown>;
  delete legacy.conceptIndexes;

  const plan = reconcileQuestions([], [legacy as never], lo, items);

  expect(plan.inserts[0].reviewItemIds).toBeNull();
});
