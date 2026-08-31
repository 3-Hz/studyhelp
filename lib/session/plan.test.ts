import { expect, test } from "bun:test";
import { planNextTurn, type GradedTurn, type PlannedObjective } from "./plan";

const objectives: PlannedObjective[] = [
  { id: 1, orderIndex: 0, suspended: false },
  { id: 2, orderIndex: 1, suspended: false },
];

const recalled = (loId: number, rating: GradedTurn["rating"]): GradedTurn => ({
  stage: "lo_recall",
  loId,
  rating,
});

const summarised: GradedTurn = {
  stage: "summary",
  loId: null,
  rating: "green",
};

test("recalls every objective before anything else", () => {
  expect(planNextTurn(objectives, [])).toEqual({
    stage: "lo_recall",
    loId: 1,
  });

  expect(planNextTurn(objectives, [recalled(1, "green")])).toEqual({
    stage: "lo_recall",
    loId: 2,
  });
});

test("follows objective order, not insertion order", () => {
  const reversed: PlannedObjective[] = [
    { id: 9, orderIndex: 1, suspended: false },
    { id: 4, orderIndex: 0, suspended: false },
  ];

  expect(planNextTurn(reversed, [])).toEqual({ stage: "lo_recall", loId: 4 });
});

test("summarises the lecture once recall is done", () => {
  const graded = [recalled(1, "green"), recalled(2, "green")];

  expect(planNextTurn(objectives, graded)).toEqual({
    stage: "summary",
    loId: null,
  });
});

test("elaborates only on objectives that fell short of green", () => {
  const graded = [recalled(1, "green"), recalled(2, "red"), summarised];

  expect(planNextTurn(objectives, graded)).toEqual({
    stage: "elaboration",
    loId: 2,
  });
});

test("a session where everything came back cleanly ends after the summary", () => {
  const graded = [recalled(1, "green"), recalled(2, "green"), summarised];

  expect(planNextTurn(objectives, graded)).toBeNull();
});

test("yellow earns an elaboration turn just as red does", () => {
  const graded = [recalled(1, "yellow"), recalled(2, "green"), summarised];

  expect(planNextTurn(objectives, graded)).toEqual({
    stage: "elaboration",
    loId: 1,
  });
});

test("the session ends once every elaboration is graded", () => {
  const graded: GradedTurn[] = [
    recalled(1, "red"),
    recalled(2, "yellow"),
    summarised,
    { stage: "elaboration", loId: 1, rating: "green" },
    { stage: "elaboration", loId: 2, rating: "green" },
  ];

  expect(planNextTurn(objectives, graded)).toBeNull();
});

test("suspended objectives are never quizzed", () => {
  const withSuspended: PlannedObjective[] = [
    { id: 1, orderIndex: 0, suspended: true },
    { id: 2, orderIndex: 1, suspended: false },
  ];

  expect(planNextTurn(withSuspended, [])).toEqual({
    stage: "lo_recall",
    loId: 2,
  });

  expect(planNextTurn(withSuspended, [recalled(2, "green")])).toEqual({
    stage: "summary",
    loId: null,
  });
});

test("a lecture whose objectives are all suspended still asks for a summary", () => {
  const allSuspended: PlannedObjective[] = [
    { id: 1, orderIndex: 0, suspended: true },
  ];

  expect(planNextTurn(allSuspended, [])).toEqual({
    stage: "summary",
    loId: null,
  });
  expect(planNextTurn(allSuspended, [summarised])).toBeNull();
});

test("planning is stable — the same state yields the same next turn", () => {
  const graded = [recalled(1, "green")];

  expect(planNextTurn(objectives, graded)).toEqual(
    planNextTurn(objectives, graded)!,
  );
});
