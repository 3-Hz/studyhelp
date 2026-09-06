import { expect, test } from "bun:test";
import {
  addDays,
  capRating,
  daysBetween,
  LADDER,
  LAPSED_LADDER,
  nextInterval,
  nextSchedule,
  tierOf,
  todayIso,
  worstByLo,
  worstRating,
  yellowInterval,
  type Tier,
} from "./schedule";
import type { Rating } from "@/lib/db/schema";

const TODAY = "2026-03-01";

test("green walks up the ladder one rung at a time", () => {
  const walked: number[] = [];
  let state = { intervalDays: 0, lapses: 0, streak: 0 };

  for (let i = 0; i < LADDER.length - 1; i++) {
    state = nextSchedule(state, "green", TODAY);
    walked.push(state.intervalDays);
  }

  expect(walked).toEqual([1, 3, 7, 14, 30, 60]);
});

test("green doubles once past the top of the ladder", () => {
  expect(nextInterval(60)).toBe(120);
  expect(nextInterval(120)).toBe(240);
});

test("an interval between rungs advances to the next rung, not past it", () => {
  expect(nextInterval(45)).toBe(60);
});

test("yellow halves the interval, held within the 1–3 day band", () => {
  const result = nextSchedule(
    { intervalDays: 30, lapses: 0, streak: 4 },
    "yellow",
    TODAY,
  );

  expect(result.intervalDays).toBe(3);
  expect(result.dueOn).toBe("2026-03-04");
});

test("yellowInterval at the edges of the band", () => {
  expect(yellowInterval(0)).toBe(1);
  expect(yellowInterval(3)).toBe(1);
  expect(yellowInterval(4)).toBe(2);
  expect(yellowInterval(5)).toBe(2);
  expect(yellowInterval(6)).toBe(3);
  expect(yellowInterval(60)).toBe(3);
});

test("red returns tomorrow and counts a lapse", () => {
  const result = nextSchedule(
    { intervalDays: 14, lapses: 1, streak: 0 },
    "red",
    TODAY,
  );

  expect(result.intervalDays).toBe(1);
  expect(result.dueOn).toBe("2026-03-02");
  expect(result.lapses).toBe(2);
});

test("only red counts a lapse", () => {
  const from = { intervalDays: 3, lapses: 4, streak: 0 };

  expect(nextSchedule(from, "green", TODAY).lapses).toBe(4);
  expect(nextSchedule(from, "yellow", TODAY).lapses).toBe(4);
});

test("suspended leaves the interval and lapses untouched", () => {
  const result = nextSchedule(
    { intervalDays: 30, lapses: 2, streak: 0 },
    "suspended",
    TODAY,
  );

  expect(result.intervalDays).toBe(30);
  expect(result.lapses).toBe(2);
});

test("dueOn is always today plus the stored interval", () => {
  for (const rating of ["green", "yellow", "red", "suspended"] as const) {
    const result = nextSchedule(
      { intervalDays: 7, lapses: 0, streak: 0 },
      rating,
      TODAY,
    );
    expect(result.dueOn).toBe(addDays(TODAY, result.intervalDays));
  }
});

test("hinted recall never scores green", () => {
  expect(capRating("green", true)).toBe("yellow");
  expect(capRating("green", false)).toBe("green");
});

test("hints do not improve a yellow or red", () => {
  expect(capRating("yellow", true)).toBe("yellow");
  expect(capRating("red", true)).toBe("red");
});

test("addDays crosses month and year boundaries", () => {
  expect(addDays("2026-02-27", 3)).toBe("2026-03-02");
  expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
});

test("addDays crosses a leap day", () => {
  expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
});

test("addDays does not shift across a DST transition", () => {
  // US DST began 2026-03-08. A local-midnight parse would land on the 7th.
  expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
  expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
});

test("todayIso reads the local calendar date, not the UTC one", () => {
  // 21:00 on the 1st in a UTC-6 zone is already the 2nd in UTC.
  const evening = new Date(2026, 2, 1, 21, 0, 0);
  expect(todayIso(evening)).toBe("2026-03-01");
});

test("todayIso pads single-digit months and days", () => {
  expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
});

test("the worst rating of a session represents the day", () => {
  expect(worstRating(["green", "red", "green"])).toBe("red");
  expect(worstRating(["green", "yellow"])).toBe("yellow");
  expect(worstRating(["green", "green"])).toBe("green");
});

test("worstRating reports nothing for an untested objective", () => {
  expect(worstRating([])).toBeUndefined();
});

test("worstByLo ignores turns with no loId, the lecture-summary stage", () => {
  const result = worstByLo([
    { loId: null, rating: "red" },
    { loId: 1, rating: "green" },
  ]);
  expect(result.get(1)).toBe("green");
  expect(result.size).toBe(1);
});

test("worstByLo ignores an ungraded turn", () => {
  const result = worstByLo([
    { loId: 1, rating: null },
    { loId: 1, rating: "yellow" },
  ]);
  expect(result.get(1)).toBe("yellow");
});

test("worstByLo takes an objective's worst rating across the sitting", () => {
  const result = worstByLo([
    { loId: 1, rating: "red" },
    { loId: 1, rating: "green" },
  ]);
  expect(result.get(1)).toBe("red");
});

test("daysBetween counts whole calendar days in either direction", () => {
  expect(daysBetween("2026-09-01", "2026-09-04")).toBe(3);
  expect(daysBetween("2026-09-04", "2026-09-01")).toBe(-3);
  expect(daysBetween("2026-09-04", "2026-09-04")).toBe(0);
});

// US DST ends 2026-11-01. Local-time arithmetic would return 2.958… days here
// and round to the wrong integer for anyone doing calendar maths on it.
test("daysBetween is not disturbed by a daylight-saving boundary", () => {
  expect(daysBetween("2026-10-31", "2026-11-03")).toBe(3);
});

test("an item that has lapsed climbs the denser ladder", () => {
  const walked: number[] = [];
  let state = { intervalDays: 1, lapses: 1, streak: 0 };

  for (let i = 0; i < 6; i++) {
    state = nextSchedule(state, "green", TODAY);
    walked.push(state.intervalDays);
  }

  expect(walked).toEqual([2, 3, 5, 7, 10, 14]);
  expect(LAPSED_LADDER).toEqual([0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60]);
});

test("the lapsed ladder also doubles past its top, and advances between rungs", () => {
  expect(nextInterval(60, 1)).toBe(120);
  expect(nextInterval(4, 1)).toBe(5);
  expect(nextInterval(4, 0)).toBe(7);
});

test("green extends the streak; yellow and red reset it", () => {
  const from = { intervalDays: 7, lapses: 0, streak: 2 };

  expect(nextSchedule(from, "green", TODAY).streak).toBe(3);
  expect(nextSchedule(from, "yellow", TODAY).streak).toBe(0);
  expect(nextSchedule(from, "red", TODAY).streak).toBe(0);
});

test("suspended leaves the streak alone", () => {
  const result = nextSchedule(
    { intervalDays: 30, lapses: 2, streak: 5 },
    "suspended",
    TODAY,
  );
  expect(result.streak).toBe(5);
});

test("tierOf reads the four-field state", () => {
  const cases: [Parameters<typeof tierOf>[0], Tier][] = [
    [{ lastRating: null, lapses: 0, streak: 0, intervalDays: 0 }, "new"],
    [{ lastRating: "red", lapses: 1, streak: 0, intervalDays: 1 }, "relearning"],
    [{ lastRating: "yellow", lapses: 0, streak: 0, intervalDays: 2 }, "relearning"],
    [{ lastRating: "green", lapses: 0, streak: 1, intervalDays: 1 }, "consolidating"],
    // Three greens but not yet at 14 days.
    [{ lastRating: "green", lapses: 0, streak: 3, intervalDays: 7 }, "consolidating"],
    // At 14 days but not three greens in a row (a backfilled or lapsed item).
    [{ lastRating: "green", lapses: 1, streak: 2, intervalDays: 14 }, "consolidating"],
    [{ lastRating: "green", lapses: 0, streak: 3, intervalDays: 14 }, "mature"],
    [{ lastRating: "green", lapses: 3, streak: 6, intervalDays: 14 }, "mature"],
    // The grade schema forbids "suspended", but the column type allows it.
    [{ lastRating: "suspended", lapses: 0, streak: 4, intervalDays: 30 }, "mature"],
  ];
  for (const [state, tier] of cases) {
    expect(tierOf(state)).toBe(tier);
  }
});

/** Runs a rating sequence from new, returning the interval and tier after each. */
function replay(ratings: Rating[]): { interval: number; tier: Tier }[] {
  let state = { intervalDays: 0, lapses: 0, streak: 0, lastRating: null as Rating | null };
  const trail: { interval: number; tier: Tier }[] = [];
  for (const rating of ratings) {
    const next = nextSchedule(state, rating, TODAY);
    state = { ...next, lastRating: rating };
    trail.push({ interval: next.intervalDays, tier: tierOf(state) });
  }
  return trail;
}

test("the fourth green from new is mature at 14 days", () => {
  expect(replay(["green", "green", "green", "green"])).toEqual([
    { interval: 1, tier: "consolidating" },
    { interval: 3, tier: "consolidating" },
    { interval: 7, tier: "consolidating" },
    { interval: 14, tier: "mature" },
  ]);
});

test("a lapse at 14 takes six greens to return to mature", () => {
  const trail = replay(["green", "green", "green", "green", "red", "green", "green", "green", "green", "green", "green"]);

  expect(trail[4]).toEqual({ interval: 1, tier: "relearning" });
  expect(trail.slice(5).map((step) => step.interval)).toEqual([2, 3, 5, 7, 10, 14]);
  expect(trail.slice(5, 10).every((step) => step.tier === "consolidating")).toBe(true);
  expect(trail[10].tier).toBe("mature");
});

test("no single rating produces mature", () => {
  for (const rating of ["green", "yellow", "red"] as const) {
    expect(replay([rating])[0].tier).not.toBe("mature");
  }
  // Nor does a single green on an item that was already far up the ladder
  // but has no streak, e.g. after a backfill of a lapsed item.
  expect(
    tierOf({ ...nextSchedule({ intervalDays: 30, lapses: 1, streak: 0 }, "green", TODAY), lastRating: "green" }),
  ).toBe("consolidating");
});
