import { expect, test } from "bun:test";
import { budgetFor, dailyBudget, DEFAULT_MINUTES, reviewBudget, spacedSubset } from "./budget";

test("twenty minutes is ten questions, two per objective", () => {
  expect(budgetFor(20)).toEqual({ questions: 10, perLo: 2 });
});

test("the default budget is the ten questions of old", () => {
  expect(dailyBudget(DEFAULT_MINUTES).questions).toBe(10);
});

test("depth follows the time: one question per objective under 15 minutes, three from 30", () => {
  expect(budgetFor(10)).toEqual({ questions: 5, perLo: 1 });
  expect(budgetFor(14)).toEqual({ questions: 7, perLo: 1 });
  expect(budgetFor(15)).toEqual({ questions: 7, perLo: 2 });
  expect(budgetFor(30)).toEqual({ questions: 15, perLo: 3 });
  expect(budgetFor(45)).toEqual({ questions: 22, perLo: 3 });
});

test("a budget never asks fewer than one question", () => {
  expect(budgetFor(1).questions).toBe(1);
  expect(budgetFor(0).questions).toBe(1);
});

test("a daily budget covers as many objectives as the questions allow at that depth", () => {
  expect(dailyBudget(20)).toEqual({ questions: 10, perLo: 2, los: 5 });
  expect(dailyBudget(10)).toEqual({ questions: 5, perLo: 1, los: 5 });
  expect(dailyBudget(30)).toEqual({ questions: 15, perLo: 3, los: 5 });
  expect(dailyBudget(2)).toEqual({ questions: 1, perLo: 1, los: 1 });
});

test("a same-day budget prefers breadth: every objective once before any twice", () => {
  // Twelve objectives, five questions: five objectives, one question each.
  expect(reviewBudget(10, 12)).toEqual({ questions: 5, perLo: 1, los: 5 });
  // Twelve objectives, fifteen questions: all twelve, one each.
  expect(reviewBudget(30, 12)).toEqual({ questions: 15, perLo: 1, los: 12 });
  // Four objectives, fifteen questions: all four, three each.
  expect(reviewBudget(30, 4)).toEqual({ questions: 15, perLo: 3, los: 4 });
  // Six objectives, ten questions: all six, one each — never a fraction.
  expect(reviewBudget(20, 6)).toEqual({ questions: 10, perLo: 1, los: 6 });
});

test("a same-day budget never plans more than three questions on one objective", () => {
  expect(reviewBudget(60, 2).perLo).toBe(3);
});

test("a same-day budget for a lecture with no objectives plans nothing", () => {
  expect(reviewBudget(20, 0)).toEqual({ questions: 10, perLo: 1, los: 0 });
});

test("spacedSubset keeps the first and last and spreads the rest evenly", () => {
  expect(spacedSubset([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5)).toEqual([1, 4, 7, 9, 12]);
  expect(spacedSubset([1, 2, 3, 4], 2)).toEqual([1, 4]);
});

test("spacedSubset returns everything when asked for at least as much", () => {
  expect(spacedSubset([1, 2, 3], 5)).toEqual([1, 2, 3]);
  expect(spacedSubset([1, 2, 3], 3)).toEqual([1, 2, 3]);
});

test("spacedSubset of one is the first", () => {
  expect(spacedSubset([7, 8, 9], 1)).toEqual([7]);
  expect(spacedSubset([7, 8, 9], 0)).toEqual([]);
});
