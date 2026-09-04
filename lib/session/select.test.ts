import { expect, test } from "bun:test";
import {
  allowedFormats,
  select,
  weakness,
  type Candidate,
} from "./select";

const TODAY = "2026-09-03";

/** A candidate with sensible defaults, so each test states only what it means. */
function candidate(overrides: Partial<Candidate> & { reviewItemId: number }): Candidate {
  return {
    loId: overrides.reviewItemId * 100,
    lectureId: 1,
    block: "Renal",
    kind: "fact",
    dueOn: "2099-01-01",
    intervalDays: 0,
    lapses: 0,
    lastRating: null,
    loSuspended: false,
    lectureCommittedOn: "2020-01-01",
    history: [],
    ...overrides,
  };
}

/** n candidates, each on its own objective and lecture unless told otherwise. */
function many(count: number, overrides: (i: number) => Partial<Candidate> = () => ({})): Candidate[] {
  return Array.from({ length: count }, (_, i) =>
    candidate({ reviewItemId: i + 1, lectureId: i + 1, ...overrides(i) }),
  );
}

test("weakness reads the whole colour history, not just the last rating", () => {
  const fresh = candidate({ reviewItemId: 1, lastRating: "green", history: ["green"] });
  const scarred = candidate({
    reviewItemId: 2,
    lastRating: "green",
    history: ["red", "red", "red", "green"],
  });

  expect(weakness(fresh)).toBe(0);
  // Last three colours are red, red, green: 2 + 2 + 0.
  expect(weakness(scarred)).toBe(4);
});

test("weakness counts lapses twice over", () => {
  expect(weakness(candidate({ reviewItemId: 1, lapses: 3 }))).toBe(6);
});

test("suspended objectives never reach the plan", () => {
  const plan = select(many(12, (i) => ({ loSuspended: i < 11 })), { today: TODAY });
  expect(plan).toHaveLength(1);
});

test("the due bucket takes the most overdue four first", () => {
  const candidates = many(12, (i) => ({ dueOn: `2026-08-${String(i + 10).padStart(2, "0")}` }));
  const plan = select(candidates, { today: TODAY });

  const due = plan.filter((slot) => slot.bucket === "due");
  expect(due).toHaveLength(4);
  // 2026-08-10 is the most overdue, and lives on review item 1.
  expect(due.map((slot) => slot.reviewItemId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
});

test("an underfilled bucket hands its slots on rather than shortening the session", () => {
  // Only two items are due; nothing is weak. The recent bucket must cover it.
  const candidates = many(14, (i) => ({
    dueOn: i < 2 ? "2026-08-01" : "2099-01-01",
    lectureCommittedOn: "2026-09-01",
  }));

  const plan = select(candidates, { today: TODAY });
  expect(plan).toHaveLength(10);
  expect(plan.filter((slot) => slot.bucket === "due")).toHaveLength(2);
});

test("no two slots share an objective while the pool allows it", () => {
  const candidates = many(20, (i) => ({ loId: i < 10 ? 1 : i, lectureId: i }));
  const plan = select(candidates, { today: TODAY });

  const los = plan.map((slot) => slot.loId);
  expect(new Set(los).size).toBe(los.length);
});

test("one lecture cannot take more than three slots while others are available", () => {
  // Both groups are due, so the due bucket has somewhere else to go once the
  // cap binds. With only one lecture due, the documented relaxation would fire
  // and a fourth slot from lecture 1 would be correct.
  const candidates = [
    ...many(8, (i) => ({ lectureId: 1, loId: i + 1, dueOn: "2026-08-01" })),
    ...many(8, (i) => ({
      reviewItemId: i + 9,
      lectureId: i + 2,
      loId: i + 20,
      dueOn: "2026-08-02",
    })),
  ];

  const plan = select(candidates, { today: TODAY });
  const fromLectureOne = plan.filter((slot) => slot.bucket !== "interleaved" && slot.loId <= 8);
  expect(fromLectureOne.length).toBeLessThanOrEqual(3);
});

test("a corpus smaller than the session runs short rather than repeating itself", () => {
  const plan = select(many(3), { today: TODAY });
  expect(plan).toHaveLength(3);
  expect(new Set(plan.map((slot) => slot.reviewItemId)).size).toBe(3);
});

test("an entirely suspended corpus yields no session at all", () => {
  expect(select(many(6, () => ({ loSuspended: true })), { today: TODAY })).toEqual([]);
});

test("cumulative slots land at positions five and ten and carry companions", () => {
  const candidates = many(14, (i) => ({ lectureId: i + 1, dueOn: i < 4 ? "2026-08-01" : "2099-01-01" }));
  const plan = select(candidates, { today: TODAY });

  const cumulative = plan.filter((slot) => slot.bucket === "interleaved");
  expect(cumulative.map((slot) => slot.slot)).toEqual([5, 10]);
  for (const slot of cumulative) {
    expect(slot.companionItemIds.length).toBeGreaterThan(0);
    expect(slot.formatFamily).toContain("synthesis");
  }
});

test("consecutive slots move between lectures where the pool allows", () => {
  const candidates = many(12, (i) => ({ lectureId: (i % 4) + 1, loId: i + 1 }));
  const plan = select(candidates, { today: TODAY });

  const lectureOf = (slot: { reviewItemId: number }) =>
    candidates.find((c) => c.reviewItemId === slot.reviewItemId)!.lectureId;

  // Four lectures are available, so the opening run should touch all four
  // rather than working through one lecture at a time. Slots 5 and 10 are
  // cumulative and placed after this ordering pass, so they are not asserted.
  expect(new Set(plan.slice(0, 4).map(lectureOf)).size).toBe(4);
});

test("a format used twice drops out of the allowed set", () => {
  const family = ["free_recall", "short_answer", "error_correction"] as const;
  const narrowed = allowedFormats([...family], ["free_recall", "free_recall"], undefined);
  expect(narrowed).toEqual(["short_answer", "error_correction"]);
});

test("the previous question's format is not offered again immediately", () => {
  const narrowed = allowedFormats(
    ["mechanism", "pathway", "consequence"],
    ["mechanism"],
    "mechanism",
  );
  expect(narrowed).toEqual(["pathway", "consequence"]);
});

test("narrowing to nothing falls back to the whole family rather than asking nothing", () => {
  const family = ["synthesis", "comparison", "discrimination"] as const;
  const used = [...family, ...family];
  expect(allowedFormats([...family], [...used], "synthesis")).toEqual([...family]);
});
