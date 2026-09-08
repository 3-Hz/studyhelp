import { expect, test } from "bun:test";
import { chooseObjectives, planNextTurn, type GradedTurn, type PlannedObjective } from "./plan";

/** Two objectives, three numbered concepts each: items 11–13 and 21–23. */
const objectives: PlannedObjective[] = [
  { id: 1, lectureId: 1, orderIndex: 0, suspended: false, items: [11, 12, 13].map((id, i) => ({ id, ordinal: i + 1 })) },
  { id: 2, lectureId: 1, orderIndex: 1, suspended: false, items: [21, 22, 23].map((id, i) => ({ id, ordinal: i + 1 })) },
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
    { id: 9, lectureId: 1, orderIndex: 1, suspended: false, items: [] },
    { id: 4, lectureId: 1, orderIndex: 0, suspended: false, items: [] },
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
    lectureId: 1,
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

/** `count` objectives on one lecture, ids `lectureId * 100 + n`. */
function lectureOf(lectureId: number, count: number): PlannedObjective[] {
  return Array.from({ length: count }, (_, i) => ({
    id: lectureId * 100 + i + 1,
    lectureId,
    orderIndex: i,
    suspended: false,
    items: [],
  }));
}

const idsOf = (objectives: PlannedObjective[]) => objectives.map((o) => o.id);

test("chosen lectures share the budget in proportion to their objectives, spaced within each", () => {
  // Six and two objectives, five to cover: 3.75 and 1.25 → 4 and 1 by largest remainder.
  const chosen = chooseObjectives([...lectureOf(1, 6), ...lectureOf(2, 2)], 5);
  expect(idsOf(chosen)).toEqual([101, 201, 103, 104, 106]);
});

test("lectures take turns: the running order alternates while both have objectives left", () => {
  const chosen = chooseObjectives([...lectureOf(1, 3), ...lectureOf(2, 3)], 4);
  expect(idsOf(chosen)).toEqual([101, 201, 103, 203]);
});

test("a budget that covers everything takes every objective, still alternating lectures", () => {
  const chosen = chooseObjectives([...lectureOf(2, 2), ...lectureOf(1, 3)], 10);
  expect(idsOf(chosen)).toEqual([101, 201, 102, 202, 103]);
});

test("a chosen lecture is never left out while the budget covers every lecture", () => {
  // Ten and one, three to cover: 2.73 and 0.27 would round to 3 and 0.
  const chosen = chooseObjectives([...lectureOf(1, 10), ...lectureOf(2, 1)], 3);
  expect(idsOf(chosen)).toEqual([101, 201, 110]);
});

test("a budget smaller than the lecture count covers the larger lectures", () => {
  const chosen = chooseObjectives([...lectureOf(1, 4), ...lectureOf(2, 1), ...lectureOf(3, 1)], 1);
  expect(idsOf(chosen)).toEqual([101]);
});

test("across two lectures, a recall on one is followed by a recall on the other", () => {
  const two = [...lectureOf(1, 2), ...lectureOf(2, 2)];
  const options = { reflected: false, los: 4, perLo: 1 };

  const sequence: number[] = [];
  const graded: GradedTurn[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const next = planNextTurn(two, graded, options);
    if (!next || next.stage !== "lo_recall") break;
    sequence.push(next.loId!);
    graded.push(recalled(next.loId!));
  }

  expect(sequence).toEqual([101, 201, 102, 202]);
});
