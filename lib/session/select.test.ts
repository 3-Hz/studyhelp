import { expect, test } from "bun:test";
import {
  allowedFormats,
  FORMAT_FAMILY,
  isDue,
  itemWeakness,
  select,
  weakness,
  type Bucket,
  type ItemCandidate,
  type LoCandidate,
} from "./select";

const TODAY = "2026-09-03";

/** A review item with sensible defaults, so each test states only what it means. */
function item(overrides: Partial<ItemCandidate> & { reviewItemId: number }): ItemCandidate {
  return {
    ordinal: 1,
    kind: "fact",
    dueOn: "2099-01-01",
    intervalDays: 0,
    lapses: 0,
    streak: 0,
    lastRating: null,
    ...overrides,
  };
}

/**
 * An objective with `count` items under it. Item ids derive from the
 * objective's (loId 3 → items 31, 32, …), so a slot can be traced back.
 */
function lo(
  overrides: Partial<LoCandidate> & { loId: number },
  count = 2,
  itemOverrides: (i: number) => Partial<ItemCandidate> = () => ({}),
): LoCandidate {
  return {
    lectureId: overrides.loId,
    block: "Renal",
    suspended: false,
    lectureCommittedOn: "2020-01-01",
    scores: [],
    items: Array.from({ length: count }, (_, i) =>
      item({ reviewItemId: overrides.loId * 10 + i + 1, ordinal: i + 1, ...itemOverrides(i) }),
    ),
    ...overrides,
  };
}

/** n objectives, each on its own lecture unless told otherwise. */
function many(
  count: number,
  overrides: (i: number) => Partial<LoCandidate> = () => ({}),
  itemOverrides: (i: number) => Partial<ItemCandidate> = () => ({}),
): LoCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    lo({ loId: i + 1, lectureId: i + 1, ...overrides(i) }, 2, itemOverrides),
  );
}

/** Twenty minutes: five objectives, two questions each. */
const FIVE_BY_TWO = { today: TODAY, los: 5, perLo: 2 };

function losOf(plan: { loId: number }[]): number[] {
  return [...new Set(plan.map((slot) => slot.loId))];
}

test("itemWeakness counts lapses twice over and the last mark once", () => {
  expect(itemWeakness(item({ reviewItemId: 1, lapses: 3 }))).toBe(6);
  expect(itemWeakness(item({ reviewItemId: 1, lastRating: "red" }))).toBe(3);
  expect(itemWeakness(item({ reviewItemId: 1, lastRating: "yellow" }))).toBe(1);
  expect(itemWeakness(item({ reviewItemId: 1, lastRating: "green" }))).toBe(0);
});

test("weakness reads the objective's last three scores and its weakest item", () => {
  // Last three scores 2, 2, 5: red, red, green — one good day does not erase the record.
  expect(weakness(lo({ loId: 1, scores: [2, 2, 2, 5] }))).toBe(4);
  // No scores yet; the weakest item decides: lapses 1 (2) versus a red last mark (3).
  const scarredItems = lo({ loId: 2 }, 2, (i) => (i === 0 ? { lapses: 1 } : { lastRating: "red" }));
  expect(weakness(scarredItems)).toBe(3);
});

test("an objective is due when any of its items is", () => {
  const partly = lo({ loId: 1 }, 2, (i) => ({ dueOn: i === 0 ? "2099-01-01" : TODAY }));
  expect(isDue(partly, TODAY)).toBe(true);
  expect(isDue(lo({ loId: 2 }), TODAY)).toBe(false);
});

test("suspended objectives never reach the plan", () => {
  const plan = select(many(6, (i) => ({ suspended: i < 5 })), FIVE_BY_TWO);
  expect(losOf(plan)).toEqual([6]);
  expect(plan).toHaveLength(2);
});

test("each chosen objective gets perLo consecutive questions: most overdue items first, then weakest", () => {
  const only = lo({ loId: 1 }, 4, (i) =>
    [
      { dueOn: "2026-09-01" }, // overdue two days
      { dueOn: "2026-08-20" }, // overdue a fortnight
      { lapses: 2 }, // not due, but weak
      {}, // fresh
    ][i],
  );

  const two = select([only], { today: TODAY, los: 5, perLo: 2 });
  expect(two.map((slot) => slot.reviewItemId)).toEqual([12, 11]);

  const three = select([only], { today: TODAY, los: 5, perLo: 3 });
  expect(three.map((slot) => slot.reviewItemId)).toEqual([12, 11, 13]);
  expect(three.map((slot) => slot.slot)).toEqual([1, 2, 3]);
});

test("an objective with fewer items than perLo gives what it has", () => {
  const plan = select([lo({ loId: 1 }, 1)], { today: TODAY, los: 5, perLo: 3 });
  expect(plan).toHaveLength(1);
});

test("the due bucket takes the most overdue objectives first: two of five", () => {
  const candidates = many(8, () => ({}), () => ({}));
  candidates.forEach((candidate, i) => {
    for (const it of candidate.items) it.dueOn = `2026-08-${String(i + 10).padStart(2, "0")}`;
  });

  const plan = select(candidates, FIVE_BY_TWO);
  const due = plan.filter((slot) => slot.bucket === "due");
  expect(losOf(due)).toEqual([1, 2]);
  expect(due).toHaveLength(4);
});

test("an underfilled bucket hands its slots on rather than shortening the session", () => {
  // Two objectives are due; nothing is weak; everything is recent.
  const candidates = many(
    8,
    () => ({ lectureCommittedOn: "2026-09-01" }),
    () => ({}),
  );
  for (const candidate of candidates.slice(0, 2)) {
    for (const it of candidate.items) it.dueOn = "2026-08-01";
  }

  const plan = select(candidates, FIVE_BY_TWO);
  const tally: Record<Bucket, number> = { due: 0, weak: 0, recent: 0, interleaved: 0, fill: 0 };
  for (const loId of losOf(plan)) tally[plan.find((slot) => slot.loId === loId)!.bucket]++;

  // The weak bucket's unfilled slot carries to recent, which is why recent
  // holds two rather than its quota of one — without the carry, fill would
  // have taken it instead.
  expect(tally).toEqual({ due: 2, weak: 0, recent: 2, interleaved: 1, fill: 0 });
  expect(plan).toHaveLength(10);
});

test("no objective appears twice, and consecutive objectives come from different lectures", () => {
  // Objectives arrive clustered by lecture, so only a real reordering alternates them.
  const candidates = [
    lo({ loId: 1, lectureId: 101 }),
    lo({ loId: 2, lectureId: 102 }),
    lo({ loId: 3, lectureId: 201 }),
    lo({ loId: 4, lectureId: 201 }),
    lo({ loId: 5, lectureId: 202 }),
    lo({ loId: 6, lectureId: 202 }),
    lo({ loId: 7, lectureId: 203 }),
    lo({ loId: 8, lectureId: 203 }),
  ];
  const plan = select(candidates, { today: TODAY, los: 6, perLo: 2 });

  const sequence = losOf(plan);
  expect(sequence).toHaveLength(6);
  const lectureOf = (loId: number) => candidates.find((c) => c.loId === loId)!.lectureId;
  for (let i = 1; i < sequence.length; i++) {
    expect(lectureOf(sequence[i])).not.toBe(lectureOf(sequence[i - 1]));
  }
  // And an objective's questions stay together: one objective at a time.
  for (let i = 1; i < plan.length; i += 2) {
    expect(plan[i].loId).toBe(plan[i - 1].loId);
  }
});

test("one lecture takes at most a third of the objectives while others are available", () => {
  const crowd = many(8, () => ({ lectureId: 1 }), () => ({ dueOn: "2026-08-01" }));
  const others = many(
    8,
    (i) => ({ loId: i + 9, lectureId: i + 2 }),
    () => ({ dueOn: "2026-08-02" }),
  ).map((c, i) => ({ ...c, loId: i + 9 }));

  const plan = select([...crowd, ...others], { today: TODAY, los: 6, perLo: 1 });
  const fromLectureOne = losOf(plan).filter((loId) => loId <= 8);
  expect(fromLectureOne.length).toBeLessThanOrEqual(2);
  expect(plan).toHaveLength(6);
});

test("a single-lecture corpus still fills the session by relaxing the cap", () => {
  const plan = select(many(10, () => ({ lectureId: 1 })), FIVE_BY_TWO);
  expect(losOf(plan)).toHaveLength(5);
  expect(plan).toHaveLength(10);
});

test("a corpus smaller than the session runs short rather than repeating itself", () => {
  const plan = select(many(2), FIVE_BY_TWO);
  expect(plan).toHaveLength(4);
  expect(new Set(plan.map((slot) => slot.reviewItemId)).size).toBe(4);
});

test("the order comes from the objective's latest score and the tier from the item", () => {
  const candidates = [
    lo({ loId: 1, scores: [] }, 1),
    lo({ loId: 2, scores: [5, 4] }, 1, () => ({ lastRating: "yellow", intervalDays: 2 })),
    lo({ loId: 3, scores: [2, 5] }, 1, () => ({ lastRating: "green", streak: 4, intervalDays: 14 })),
    lo({ loId: 4, scores: [3] }, 1, () => ({ lastRating: "red", lapses: 1, intervalDays: 1 })),
  ];
  const plan = select(candidates, { today: TODAY, los: 4, perLo: 1 });
  const slotFor = (loId: number) => plan.find((slot) => slot.loId === loId)!;

  expect(slotFor(1).order).toBe("first");
  expect(slotFor(1).tier).toBe("new");
  expect(slotFor(2).order).toBe("second");
  expect(slotFor(2).tier).toBe("relearning");
  expect(slotFor(3).order).toBe("third");
  expect(slotFor(3).tier).toBe("mature");
  expect(slotFor(4).order).toBe("first");
  expect(slotFor(4).tier).toBe("relearning");
});

test("no slot combines lectures: every slot's family is its own item's kind", () => {
  const kinds = ["fact", "mechanism", "application", "distinction", "relationship"] as const;
  const candidates = many(5, () => ({}), (i) => ({ kind: kinds[i] }));
  const plan = select(candidates, FIVE_BY_TWO);

  expect(plan).toHaveLength(10);
  for (const slot of plan) {
    const owner = candidates.find((c) => c.loId === slot.loId)!;
    const it = owner.items.find((i) => i.reviewItemId === slot.reviewItemId)!;
    expect(slot.formatFamily).toEqual(FORMAT_FAMILY[it.kind]);
    expect(slot.formatFamily).not.toContain("synthesis");
  }
});

test("the default mix at five objectives is two due, one weak, one recent, one interleaved", () => {
  const due = many(2, () => ({}), () => ({ dueOn: "2026-08-01" }));
  const weak = lo({ loId: 3 }, 2, () => ({ lastRating: "red" })); // weakness 3
  const recent = lo({ loId: 4, lectureCommittedOn: "2026-08-28" });
  const filler = [lo({ loId: 5 }), lo({ loId: 6 })];
  // A weaker weak-eligible objective and an older recent one: each stays on
  // the table at the correct quota, so a quota drifting up would move the tally.
  const spareWeak = lo({ loId: 7 }, 2, () => ({ lastRating: "yellow" })); // weakness 1
  const spareRecent = lo({ loId: 8, lectureCommittedOn: "2026-08-27" });

  const plan = select([...due, weak, recent, ...filler, spareWeak, spareRecent], FIVE_BY_TWO);

  const bucketOf = new Map(plan.map((slot) => [slot.loId, slot.bucket]));
  const tally: Record<Bucket, number> = { due: 0, weak: 0, recent: 0, interleaved: 0, fill: 0 };
  for (const bucket of bucketOf.values()) tally[bucket]++;

  expect(tally).toEqual({ due: 2, weak: 1, recent: 1, interleaved: 1, fill: 0 });
  expect(bucketOf.get(3)).toBe("weak");
  expect(bucketOf.get(4)).toBe("recent");
});

test("the weak bucket surfaces an objective with a red history even when nothing of it is due", () => {
  const due = many(2, () => ({ lectureCommittedOn: "2000-01-01" }), () => ({ dueOn: "2026-08-01" }));
  const scarred = lo({ loId: 5, scores: [2, 2, 2], lectureCommittedOn: "2000-01-01" }); // weakness 6
  const lapsed = lo({ loId: 6, lectureCommittedOn: "2000-01-01" }, 2, () => ({ lapses: 2 })); // 4
  const red = lo({ loId: 7, lectureCommittedOn: "2000-01-01" }, 2, () => ({ lastRating: "red" })); // 3
  const filler = many(3, (i) => ({ loId: i + 8, lectureId: i + 8, lectureCommittedOn: "2000-01-01" }));

  const plan = select([...due, scarred, lapsed, red, ...filler], FIVE_BY_TWO);
  const weakLos = losOf(plan.filter((slot) => slot.bucket === "weak"));
  expect(weakLos).toEqual([5]);
});

test("ties break on ids, so the same corpus always gives the same plan", () => {
  const candidates = many(8);
  const first = select(candidates, FIVE_BY_TWO);
  const again = select([...candidates].reverse(), FIVE_BY_TWO);
  expect(again).toEqual(first);
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
