import { expect, test } from "bun:test";
import {
  addDays,
  capRating,
  daysBetween,
  LADDER,
  nextInterval,
  nextSchedule,
  todayIso,
  worstByLo,
  worstRating,
} from "./schedule";

const TODAY = "2026-03-01";

test("green walks up the ladder one rung at a time", () => {
  const walked: number[] = [];
  let state = { intervalDays: 0, lapses: 0 };

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

test("yellow drops to the 1-3 day band however far the item had got", () => {
  const result = nextSchedule({ intervalDays: 30, lapses: 0 }, "yellow", TODAY);

  expect(result.intervalDays).toBe(2);
  expect(result.dueOn).toBe("2026-03-03");
});

test("red returns tomorrow and counts a lapse", () => {
  const result = nextSchedule({ intervalDays: 14, lapses: 1 }, "red", TODAY);

  expect(result.intervalDays).toBe(1);
  expect(result.dueOn).toBe("2026-03-02");
  expect(result.lapses).toBe(2);
});

test("only red counts a lapse", () => {
  const from = { intervalDays: 3, lapses: 4 };

  expect(nextSchedule(from, "green", TODAY).lapses).toBe(4);
  expect(nextSchedule(from, "yellow", TODAY).lapses).toBe(4);
});

test("suspended leaves the interval and lapses untouched", () => {
  const result = nextSchedule(
    { intervalDays: 30, lapses: 2 },
    "suspended",
    TODAY,
  );

  expect(result.intervalDays).toBe(30);
  expect(result.lapses).toBe(2);
});

test("dueOn is always today plus the stored interval", () => {
  for (const rating of ["green", "yellow", "red", "suspended"] as const) {
    const result = nextSchedule({ intervalDays: 7, lapses: 0 }, rating, TODAY);
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
