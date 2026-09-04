import { expect, test } from "bun:test";
import {
  allowedFormats,
  FORMAT_FAMILY,
  select,
  weakness,
  type Bucket,
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

test("weakness reads the last three colours, not just the last rating", () => {
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
  // The two slots the due bucket could not fill carry to recent, which is why
  // it holds six rather than its default two — a plain length-10 assertion
  // would also pass if the carry logic were deleted and the generic "fill"
  // bucket padded the session out instead.
  expect(plan.filter((slot) => slot.bucket === "recent")).toHaveLength(6);
  expect(plan.filter((slot) => slot.bucket === "fill")).toHaveLength(0);
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
  // Two candidates per lecture, arriving in clustered pairs (201, 201, 202,
  // 202, ...): the pool's natural order does not alternate on its own, so
  // this only passes if interleave() actually rearranges it.
  const candidates = [
    candidate({ reviewItemId: 1, lectureId: 101 }),
    candidate({ reviewItemId: 2, lectureId: 102 }),
    candidate({ reviewItemId: 3, lectureId: 201 }),
    candidate({ reviewItemId: 4, lectureId: 201 }),
    candidate({ reviewItemId: 5, lectureId: 202 }),
    candidate({ reviewItemId: 6, lectureId: 202 }),
    candidate({ reviewItemId: 7, lectureId: 203 }),
    candidate({ reviewItemId: 8, lectureId: 203 }),
    candidate({ reviewItemId: 9, lectureId: 204 }),
    candidate({ reviewItemId: 10, lectureId: 204 }),
  ];
  const plan = select(candidates, { today: TODAY });

  const lectureOf = (slot: { reviewItemId: number }) =>
    candidates.find((c) => c.reviewItemId === slot.reviewItemId)!.lectureId;

  // Cumulative slots (101, 102) are placed by position, not by interleave(),
  // so only the rest of the running order is checked here.
  const rest = plan.filter((slot) => slot.bucket !== "interleaved");
  for (let i = 1; i < rest.length; i++) {
    expect(lectureOf(rest[i])).not.toBe(lectureOf(rest[i - 1]));
  }
});

test("the weak bucket surfaces items with a red-flagged history even when nothing is due", () => {
  const due = many(4, () => ({
    dueOn: "2026-08-01",
    lectureCommittedOn: "2000-01-01",
  }));
  const weak = [
    candidate({
      reviewItemId: 5,
      lectureId: 5,
      dueOn: "2099-01-01",
      lectureCommittedOn: "2000-01-01",
      history: ["red", "red", "red"], // weakness 6
    }),
    candidate({
      reviewItemId: 6,
      lectureId: 6,
      dueOn: "2099-01-01",
      lectureCommittedOn: "2000-01-01",
      lapses: 2, // weakness 4
    }),
    candidate({
      reviewItemId: 7,
      lectureId: 7,
      dueOn: "2099-01-01",
      lectureCommittedOn: "2000-01-01",
      lastRating: "red", // weakness 3
    }),
  ];
  const filler = many(5, (i) => ({
    reviewItemId: i + 8,
    lectureId: i + 8,
    dueOn: "2099-01-01",
    lectureCommittedOn: "2000-01-01",
  }));

  const plan = select([...due, ...weak, ...filler], { today: TODAY });
  const weakSlots = plan.filter((slot) => slot.bucket === "weak");
  // Highest weakness first: item 5 (6), then item 6 (4). Item 7 (3) misses
  // the cut.
  expect(weakSlots.map((slot) => slot.reviewItemId)).toEqual([5, 6]);
});

test("a single-lecture corpus still fills a full session via the relaxation tiers", () => {
  // Ten objectives, one lecture. The per-lecture cap binds well before the
  // session is full, so most slots can only come from relaxing that cap
  // rather than the stricter no-repeat-objective tier.
  const candidates = many(10, (i) => ({ lectureId: 1, loId: i + 1 }));
  const plan = select(candidates, { today: TODAY });
  expect(plan).toHaveLength(10);
});

test("the default mix is four due, two weak, two recent, two interleaved when the corpus supports it", () => {
  const due = many(4, () => ({ dueOn: "2026-08-01" }));
  const weak = many(2, (i) => ({
    reviewItemId: i + 5,
    lectureId: i + 5,
    dueOn: "2099-01-01",
    lastRating: "red", // weakness 3, ranks above the spare below
  }));
  const recent = many(2, (i) => ({
    reviewItemId: i + 7,
    lectureId: i + 7,
    dueOn: "2099-01-01",
    lectureCommittedOn: "2026-08-28",
  }));
  const filler = many(2, (i) => ({
    reviewItemId: i + 9,
    lectureId: i + 9,
    dueOn: "2099-01-01",
  }));
  // A third, weaker weak-eligible candidate. The weak bucket must leave it on
  // the table at quota 2 — its presence is what would catch a quota drifting
  // to 3, which a fixture with exactly two weak candidates cannot.
  const spareWeak = candidate({
    reviewItemId: 11,
    lectureId: 11,
    dueOn: "2099-01-01",
    lastRating: "yellow", // weakness 1
  });
  // A third recent-eligible candidate, committed a day earlier than the two
  // above so it ranks behind them and stays on the table at quota 2. Without
  // it, a recent quota drifting to 3 has nothing extra to take and the tally
  // does not move.
  const spareRecent = candidate({
    reviewItemId: 12,
    lectureId: 12,
    dueOn: "2099-01-01",
    lectureCommittedOn: "2026-08-27",
  });

  const plan = select(
    [...due, ...weak, ...recent, ...filler, spareWeak, spareRecent],
    { today: TODAY },
  );

  const tally: Record<Bucket, number> = {
    due: 0,
    weak: 0,
    recent: 0,
    interleaved: 0,
    fill: 0,
  };
  for (const slot of plan) tally[slot.bucket]++;

  // This is the headline mix from prompt.txt. Due, weak and recent each have
  // somewhere to overfill from (due indirectly, via the carry its unfilled
  // want hands to weak; weak and recent from a spare candidate each keeps on
  // the table at the correct quota) so a quota silently drifting on any of
  // them moves this tally. Interleaved cannot be exercised this way in this
  // fixture: due, weak and recent already consume exactly eight of the ten
  // slots, so its own "want" is capped by the two that remain regardless of
  // its quota constant — a fixture change can't fix that, only a larger
  // session could.
  expect(tally).toEqual({ due: 4, weak: 2, recent: 2, interleaved: 2, fill: 0 });
});

test("adjacent slots avoid repeating kind where the pool allows, and a mechanism item carries the mechanism family", () => {
  const kinds = [
    "fact",
    "fact",
    "fact",
    "fact",
    "mechanism",
    "fact",
    "mechanism",
    "application",
    "fact",
    "mechanism",
  ] as const;
  const candidates = many(10, (i) => ({ kind: kinds[i] }));

  const plan = select(candidates, { today: TODAY });
  const kindOf = (slot: { reviewItemId: number }) =>
    candidates.find((c) => c.reviewItemId === slot.reviewItemId)!.kind;

  // Cumulative slots always carry the synthesis family regardless of the
  // underlying objective's kind, so only the rest of the order is checked.
  const rest = plan.filter((slot) => slot.bucket !== "interleaved");
  for (let i = 1; i < rest.length; i++) {
    expect(kindOf(rest[i])).not.toBe(kindOf(rest[i - 1]));
  }

  const mechanismSlot = plan.find((slot) => slot.reviewItemId === 5)!;
  expect(mechanismSlot.formatFamily).toEqual(FORMAT_FAMILY.mechanism);
});

test("the two cumulative slots reach for different companions", () => {
  const due = many(4, () => ({ dueOn: "2026-08-01" }));
  const rest = many(6, (i) => ({ reviewItemId: i + 5, lectureId: i + 5 }));

  const plan = select([...due, ...rest], { today: TODAY });
  const cumulative = plan.filter((slot) => slot.bucket === "interleaved");

  expect(cumulative).toHaveLength(2);
  expect(cumulative[0].companionItemIds).not.toEqual(
    cumulative[1].companionItemIds,
  );
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

test("exhausting the twice-per-session cap still keeps the just-used format out", () => {
  // Every format in the family has already been used twice, so the strict
  // narrowing (cap + no-immediate-repeat) is empty. The stronger rule — no
  // format twice in a row — outranks the cap, so relaxing the cap still
  // will not hand back "synthesis", the format just asked.
  const family = ["synthesis", "comparison", "discrimination"] as const;
  const used = [...family, ...family];
  expect(allowedFormats([...family], [...used], "synthesis")).toEqual([
    "comparison",
    "discrimination",
  ]);
});

test("only a single-format family falls back to repeating the previous format", () => {
  // With nothing else in the family, even the no-immediate-repeat rule must
  // give way — a repeated format beats no question at all.
  const family = ["synthesis"] as const;
  expect(allowedFormats([...family], [], "synthesis")).toEqual([...family]);
});
