import { expect, test } from "bun:test";
import { planNextTurn, type GradedTurn, type PlannedObjective } from "./plan";

/** Two objectives, three numbered concepts each: items 11–13 and 21–23. */
const objectives: PlannedObjective[] = [
  { id: 1, orderIndex: 0, suspended: false, items: [11, 12, 13].map((id, i) => ({ id, ordinal: i + 1 })) },
  { id: 2, orderIndex: 1, suspended: false, items: [21, 22, 23].map((id, i) => ({ id, ordinal: i + 1 })) },
];

const recalled = (loId: number, marks: GradedTurn["marks"] = []): GradedTurn => ({
  stage: "lo_recall",
  loId,
  reviewItemId: null,
  marks,
});

const probed = (loId: number, reviewItemId: number, mark: GradedTurn["marks"][number]["mark"] = "green"): GradedTurn => ({
  stage: "lo_probe",
  loId,
  reviewItemId,
  marks: [{ reviewItemId, mark }],
});

/** Twenty minutes on a two-objective lecture: both objectives, three questions each. */
const FULL = { reflected: false, los: 2, perLo: 3 };

test("recalls each objective before probing it", () => {
  expect(planNextTurn(objectives, [], FULL)).toEqual({
    stage: "lo_recall",
    loId: 1,
    reviewItemId: null,
  });
});

test("follows objective order, not insertion order", () => {
  const reversed: PlannedObjective[] = [
    { id: 9, orderIndex: 1, suspended: false, items: [] },
    { id: 4, orderIndex: 0, suspended: false, items: [] },
  ];

  expect(planNextTurn(reversed, [], FULL)?.loId).toBe(4);
});

test("after the recall, probes the concept the recall left untested, lowest number first", () => {
  const graded = [recalled(1, [{ reviewItemId: 11, mark: "green" }])];

  expect(planNextTurn(objectives, graded, FULL)).toEqual({
    stage: "lo_probe",
    loId: 1,
    reviewItemId: 12,
  });
});

test("an untested concept is probed before a red one, and a red before a yellow", () => {
  const graded = [
    recalled(1, [
      { reviewItemId: 11, mark: "yellow" },
      { reviewItemId: 12, mark: "red" },
    ]),
  ];
  expect(planNextTurn(objectives, graded, FULL)?.reviewItemId).toBe(13);

  const allMarked = [
    recalled(1, [
      { reviewItemId: 11, mark: "yellow" },
      { reviewItemId: 12, mark: "red" },
      { reviewItemId: 13, mark: "green" },
    ]),
  ];
  expect(planNextTurn(objectives, allMarked, FULL)?.reviewItemId).toBe(12);
});

test("a concept the recall marked green is never probed", () => {
  const graded = [
    recalled(1, [
      { reviewItemId: 11, mark: "green" },
      { reviewItemId: 12, mark: "green" },
      { reviewItemId: 13, mark: "green" },
    ]),
  ];

  // Nothing left to probe on objective 1: straight on to objective 2.
  expect(planNextTurn(objectives, graded, FULL)).toEqual({
    stage: "lo_recall",
    loId: 2,
    reviewItemId: null,
  });
});

test("probes stop at perLo minus one per objective, and never repeat a concept", () => {
  const graded = [recalled(1), probed(1, 11, "red"), probed(1, 12, "red")];

  // Two probes is the most a perLo of three allows, however badly they went.
  expect(planNextTurn(objectives, graded, FULL)?.loId).toBe(2);

  // With one probe done and room for another, the probed concept is not offered again.
  const oneProbe = [recalled(1), probed(1, 11, "red")];
  expect(planNextTurn(objectives, oneProbe, FULL)?.reviewItemId).toBe(12);
});

test("a perLo of one means recall only", () => {
  const graded = [recalled(1)];
  expect(planNextTurn(objectives, graded, { reflected: false, los: 2, perLo: 1 })?.loId).toBe(2);
});

test("a short budget covers a spaced subset of the objectives, first and last included", () => {
  const five: PlannedObjective[] = [1, 2, 3, 4, 5].map((id, i) => ({
    id,
    orderIndex: i,
    suspended: false,
    items: [],
  }));

  const sequence: number[] = [];
  const graded: GradedTurn[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const next = planNextTurn(five, graded, { reflected: false, los: 3, perLo: 1 });
    if (!next || next.stage !== "lo_recall") break;
    sequence.push(next.loId!);
    graded.push(recalled(next.loId!));
  }

  expect(sequence).toEqual([1, 3, 5]);
});

test("one objective at a time: the second objective waits for the first's probes", () => {
  const graded = [recalled(1), probed(1, 11)];
  expect(planNextTurn(objectives, graded, FULL)).toEqual({
    stage: "lo_probe",
    loId: 1,
    reviewItemId: 12,
  });
});

test("suspended objectives are never quizzed", () => {
  const withSuspended: PlannedObjective[] = [
    { ...objectives[0], suspended: true },
    objectives[1],
  ];

  expect(planNextTurn(withSuspended, [], FULL)?.loId).toBe(2);
});

test("a lecture whose objectives are all suspended goes straight to the reflection", () => {
  const allSuspended: PlannedObjective[] = [{ ...objectives[0], suspended: true }];

  expect(planNextTurn(allSuspended, [], FULL)).toEqual({
    stage: "reflection",
    loId: null,
    reviewItemId: null,
  });
  expect(planNextTurn(allSuspended, [], { ...FULL, reflected: true })).toBeNull();
});

test("the session closes with the reflection once every objective is done", () => {
  const graded = [
    recalled(1, [11, 12, 13].map((reviewItemId) => ({ reviewItemId, mark: "green" as const }))),
    recalled(2, [21, 22, 23].map((reviewItemId) => ({ reviewItemId, mark: "green" as const }))),
  ];

  expect(planNextTurn(objectives, graded, FULL)).toEqual({
    stage: "reflection",
    loId: null,
    reviewItemId: null,
  });
  expect(planNextTurn(objectives, graded, { ...FULL, reflected: true })).toBeNull();
});

test("planning is stable: the same state yields the same next turn", () => {
  const graded = [recalled(1)];
  expect(planNextTurn(objectives, graded, FULL)).toEqual(planNextTurn(objectives, graded, FULL)!);
});
