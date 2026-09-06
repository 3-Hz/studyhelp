# Phase 4 — History-aware scheduling and adaptive difficulty: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scheduler read an item's history, let question difficulty follow mastery, carry each miss into the next review, close every session with the student's own reflection, and show review items for the first time.

**Architecture:** One new counter on `review_items` (`streak`) completes a four-field mastery state that `lib/schedule.ts` turns into an interval and a tier as pure functions. The tier is frozen on the daily plan and steers the tutor's brief; a new `lib/session/prior.ts` reads the last graded attempt per item out of `attempts` at load time. The runner gains a reflection stage, a debrief for both session kinds, and an `outcomes` record; a read-only concept page sits under each lecture.

**Tech Stack:** Bun 1.3, Next.js 16 (App Router — read `node_modules/next/dist/docs/` before touching a page or route), Drizzle ORM on `bun:sqlite`, Zod 4, `bun test`, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-04-phase-4-adaptive-scheduling-design.md`

## Global Constraints

- Bun only. Tests: `bun test`. Types: `bun run typecheck`. Dev server: `bun --bun run dev` (never `bun run dev`). Migrations: `bun run db:generate`, `bun run db:migrate`.
- Before writing Next.js code, read the relevant guide in `node_modules/next/dist/docs/` — this version differs from training data.
- Every task ends with `bun test` and `bun run typecheck` green.
- `LADDER = [0, 1, 3, 7, 14, 30, 60]`; `LAPSED_LADDER = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60]`; both double past the top.
- Yellow interval: `clamp(floor(interval / 2), 1, 3)`. Red: 1 day, `lapses + 1`. Green: `streak + 1`. Yellow and red: `streak = 0`.
- Tiers: `new` (never rated), `relearning` (last red or yellow), `mature` (`streak >= 3 && intervalDays >= 14`), `consolidating` (otherwise).
- Backfill: `last_rating = 'green' AND lapses = 0` → interval ≥60 → 6, ≥30 → 5, ≥14 → 4, ≥7 → 3, ≥3 → 2, ≥1 → 1, else 0.
- Nothing about an item is shown before the answer. The badge rides on the answer response.
- Badge bucket labels: due → *Due for review*, recent → *Recent material*, weak → *Weak spot*, interleaved → *Cumulative*, fill → *Extra practice*.
- Reflection questions (fixed, code-owned):
  - same_day: *Without looking back: what were the key ideas of this lecture, what was the hardest point, what misconception did you correct today, and what are you still unsure of?*
  - daily: *Before the summary: what was the hardest question today, what did you get wrong and what is the correction you would give yourself, and what are you still unsure of?*
- Commit subjects are imperative sentences with no prefix (`Add the lapsed ladder`), body optional, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Prose that persists (README, comments, commit bodies) is concise: cut every word that can go.
- Work on a branch `phase-4` off `main`.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `lib/db/schema.ts` | Tables and enums | `review_items.streak`, `sessions.outcomes`, `reflection` stage |
| `drizzle/0005_*.sql` | Migration | Generated, then the backfill appended |
| `lib/db/migrations.test.ts` | Backfill test | New |
| `lib/schedule.ts` | Interval and tier as pure functions | `LAPSED_LADDER`, yellow band, `streak`, `tierOf` |
| `lib/session/kind.ts` | The strategy interface | `closeOut` removed; `PlannedTurn.tier`; `TurnWhy`, `Outcome`, `explain?` |
| `lib/session/runner.ts` | Shared turn/answer/hint/finish | Reflection turn, pending predicate, debrief for both kinds, `outcomes`, `why` on feedback |
| `lib/session/plan.ts` | Same-day running order | Reflection turn |
| `lib/session/sameDay.ts` | Same-day strategy | Passes `reflected` to `planNextTurn` |
| `lib/session/daily.ts` | Daily strategy | Reflection turn, progress, `priorByItem`, `tier`, `explain` |
| `lib/session/select.ts` | Choosing the day's slots | `Candidate.streak`, `PlannedSlot.tier` |
| `lib/session/candidates.ts` | Candidates from the DB | `streak` |
| `lib/session/prior.ts` | Last graded attempt per planned item | New |
| `lib/tutor/schema.ts` | Output contracts | `DebriefOutput.calibration` |
| `lib/tutor/index.ts` | Prompts | `TIER_BRIEF` replaces `BUCKET_HINT`; `lastAttempt` block; reflection in the debrief |
| `lib/concepts.ts` | Per-lecture concept rows | New |
| `app/lectures/[id]/concepts/page.tsx` | The concept view | New |
| `app/lectures/page.tsx`, `app/dashboard/page.tsx` | Links to the concept view | Links |
| `app/sessions/[id]/SessionTurn.tsx` | The session screen | Reflection turn, badge, outcomes |
| `app/sessions/[id]/Outcomes.tsx` | Promoted / relearning lists | New |
| `app/sessions/[id]/Debrief.tsx` | The debrief | `calibration` |
| `app/sessions/[id]/page.tsx` | Finished-session view | Outcomes |
| `README.md` | Status and layout | Phase 4 |

---

### Task 1: Schema and migration with the streak backfill

**Files:**
- Modify: `lib/db/schema.ts:186-208` (`reviewItems`), `lib/db/schema.ts:210-229` (`sessions`)
- Create: `drizzle/0005_<generated>.sql` (via `bun run db:generate`, then edited)
- Test: `lib/db/migrations.test.ts` (new)

**Interfaces:**
- Produces: `schema.reviewItems.streak: integer not null default 0`; `schema.sessions.outcomes: text json nullable`. Later tasks read `item.streak` and write `session.outcomes`.

- [ ] **Step 1: Write the failing migration test**

Create `lib/db/migrations.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Migration 0005 backfills review_items.streak from the ladder position of
 * items that have only ever gone green. The drizzle migrator applies every
 * file in one go, so this test runs the SQL files itself: everything before
 * 0005, seed rows at each rung, then 0005.
 */
const files = readdirSync("./drizzle")
  .filter((file) => file.endsWith(".sql"))
  .sort();
const BACKFILL = files.find((file) => file.startsWith("0005_"));
const BEFORE = files.filter((file) => file < "0005_");

function apply(sqlite: Database, file: string) {
  const sql = readFileSync(`./drizzle/${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) sqlite.exec(statement);
  }
}

function seedItem(
  sqlite: Database,
  intervalDays: number,
  lastRating: string | null,
  lapses: number,
): number {
  const result = sqlite
    .prepare(
      "INSERT INTO review_items (lo_id, concept, kind, due_on, interval_days, last_rating, lapses) " +
        "VALUES (1, ?, 'fact', '2026-09-04', ?, ?, ?)",
    )
    .run(`${intervalDays}/${lastRating}/${lapses}`, intervalDays, lastRating, lapses);
  return Number(result.lastInsertRowid);
}

function streakOf(sqlite: Database, id: number): number {
  const row = sqlite
    .prepare("SELECT streak FROM review_items WHERE id = ?")
    .get(id) as { streak: number };
  return row.streak;
}

function freshBeforeBackfill(): Database {
  const sqlite = new Database(":memory:");
  for (const file of BEFORE) apply(sqlite, file);
  sqlite.exec("INSERT INTO lectures (title) VALUES ('Amyloidosis')");
  sqlite.exec(
    "INSERT INTO learning_objectives (lecture_id, text, order_index) VALUES (1, 'Describe fibrils.', 0)",
  );
  return sqlite;
}

test("0005 backfills streak from the ladder position of never-lapsed green items", () => {
  expect(BACKFILL).toBeDefined();
  const sqlite = freshBeforeBackfill();

  const rungs = [0, 1, 3, 7, 14, 30, 60, 120].map((interval) =>
    seedItem(sqlite, interval, "green", 0),
  );
  const lapsed = seedItem(sqlite, 14, "green", 1);
  const yellow = seedItem(sqlite, 14, "yellow", 0);
  const untested = seedItem(sqlite, 0, null, 0);

  apply(sqlite, BACKFILL!);

  expect(rungs.map((id) => streakOf(sqlite, id))).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
  // A lapsed item's history is not recoverable, and it cannot be mature yet.
  expect(streakOf(sqlite, lapsed)).toBe(0);
  expect(streakOf(sqlite, yellow)).toBe(0);
  expect(streakOf(sqlite, untested)).toBe(0);
});

test("0005 adds sessions.outcomes", () => {
  const sqlite = freshBeforeBackfill();
  apply(sqlite, BACKFILL!);

  sqlite.exec("INSERT INTO sessions (type, outcomes) VALUES ('daily', '[]')");
  const row = sqlite
    .prepare("SELECT outcomes FROM sessions")
    .get() as { outcomes: string };
  expect(row.outcomes).toBe("[]");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test lib/db/migrations.test.ts`
Expected: FAIL — `expect(BACKFILL).toBeDefined()` fails (no `0005_` file yet).

- [ ] **Step 3: Add the columns to the schema**

In `lib/db/schema.ts`, in `reviewItems`, after the `lapses` line:

```ts
    lapses: integer("lapses").notNull().default(0),
    /**
     * Consecutive greens; red or yellow resets it. With intervalDays, lapses
     * and lastRating this is the whole mastery state — see tierOf.
     */
    streak: integer("streak").notNull().default(0),
```

In `sessions`, after the `debrief` line:

```ts
  /** The close-out summary, written when the session is finished. */
  debrief: text("debrief", { mode: "json" }),
  /**
   * What finishing did to each review item: rating, tier before and after,
   * new due date. The code-owned half of the close-out, beside the
   * model-owned debrief.
   */
  outcomes: text("outcomes", { mode: "json" }),
```

- [ ] **Step 4: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `drizzle/0005_<two words>.sql` and an updated `drizzle/meta/`. Check it:

Run: `cat drizzle/0005_*.sql`
Expected:

```sql
ALTER TABLE `review_items` ADD `streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `outcomes` text;
```

- [ ] **Step 5: Append the backfill**

Edit the generated file so it reads (keep the two generated lines exactly, then add the rest):

```sql
ALTER TABLE `review_items` ADD `streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `outcomes` text;--> statement-breakpoint
UPDATE `review_items` SET `streak` = CASE
	WHEN `interval_days` >= 60 THEN 6
	WHEN `interval_days` >= 30 THEN 5
	WHEN `interval_days` >= 14 THEN 4
	WHEN `interval_days` >= 7 THEN 3
	WHEN `interval_days` >= 3 THEN 2
	WHEN `interval_days` >= 1 THEN 1
	ELSE 0
END
WHERE `last_rating` = 'green' AND `lapses` = 0;
```

Why: an item that has only ever gone green climbed one rung per green from 0, so its rung is its streak. Lapsed, yellow and untested items stay at 0.

- [ ] **Step 6: Run the tests**

Run: `bun test lib/db/migrations.test.ts`
Expected: PASS (2 tests).

Run: `bun test && bun run typecheck`
Expected: all green — every DB-backed test runs `migrate()` and picks up 0005.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts drizzle lib/db/migrations.test.ts
git commit -m "Add review_items.streak and sessions.outcomes, backfilling streak from the ladder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The scheduler — lapsed ladder, yellow band, streak, tier

**Files:**
- Modify: `lib/schedule.ts`
- Modify: `lib/session/runner.ts:296-311` (the `nextSchedule` call and the update)
- Test: `lib/schedule.test.ts`, `lib/session/sameDay.test.ts`

**Interfaces:**
- Produces:
  - `LAPSED_LADDER: readonly number[]`
  - `nextInterval(intervalDays: number, lapses?: number): number`
  - `yellowInterval(intervalDays: number): number`
  - `ScheduleState { intervalDays; lapses; streak }`, `ScheduleResult { dueOn; intervalDays; lapses; streak }`
  - `TIERS`, `type Tier = "new" | "relearning" | "consolidating" | "mature"`
  - `tierOf(state: { lastRating: Rating | null; lapses: number; streak: number; intervalDays: number }): Tier`

- [ ] **Step 1: Update the existing schedule tests and add the new ones**

In `lib/schedule.test.ts`, change the import to:

```ts
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
```

Add `streak: 0` to every state object passed to `nextSchedule` in the existing tests (`{ intervalDays: 0, lapses: 0 }` → `{ intervalDays: 0, lapses: 0, streak: 0 }`, and likewise in the yellow, red, "only red counts a lapse", suspended, and dueOn tests).

Replace the yellow test with:

```ts
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
```

Append:

```ts
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
```

- [ ] **Step 2: Run to see the failures**

Run: `bun test lib/schedule.test.ts`
Expected: FAIL — `LAPSED_LADDER`, `yellowInterval`, `tierOf` undefined; type errors on `streak`.

- [ ] **Step 3: Implement in `lib/schedule.ts`**

Replace everything from the `LADDER` constant through the end of `nextSchedule` with:

```ts
/** The default successful-review sequence. Beyond the last rung, intervals double. */
export const LADDER = [0, 1, 3, 7, 14, 30, 60] as const;

/**
 * The ladder for an item that has ever lapsed: the same span with twice the
 * rungs. Recovery is slower, never punitive. Lapses are permanent, so an item
 * that failed once climbs this ladder from then on — "review the full
 * history, not only the latest colour", in the scheduler's own terms.
 */
export const LAPSED_LADDER = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60] as const;

/** Yellow returns within the prompt's 1–3 day band. */
const YELLOW_MIN = 1;
const YELLOW_MAX = 3;

/** Red returns tomorrow, near the bottom of the ladder but not below it. */
const RED_INTERVAL = 1;

/** Mastery needs repeated retrieval across increasing intervals: three greens, two weeks. */
const MATURE_STREAK = 3;
const MATURE_INTERVAL = 14;
```

Keep `todayIso`, `startOfToday`, `addDays`, `daysBetween`, `capRating` exactly as they are. Then replace `nextInterval` and everything down to (not including) `SEVERITY` with:

```ts
/** The next rung strictly above the current interval; doubling past the top. */
export function nextInterval(intervalDays: number, lapses = 0): number {
  const ladder: readonly number[] = lapses > 0 ? LAPSED_LADDER : LADDER;
  const rung = ladder.find((days) => days > intervalDays);
  return rung ?? intervalDays * 2;
}

/**
 * Yellow halves the interval, held within 1–3 days: a mature item that was
 * merely incomplete comes back in three days, a fragile one tomorrow.
 */
export function yellowInterval(intervalDays: number): number {
  return Math.min(YELLOW_MAX, Math.max(YELLOW_MIN, Math.floor(intervalDays / 2)));
}

export interface ScheduleState {
  intervalDays: number;
  lapses: number;
  /** Consecutive greens. */
  streak: number;
}

export interface ScheduleResult {
  dueOn: string;
  intervalDays: number;
  lapses: number;
  streak: number;
}

/**
 * Where a review item lands after being answered.
 *
 * `dueOn` is always `today + intervalDays`, so the stored interval always
 * describes the gap actually being used rather than a rung the item is not on.
 * Suspended items come back untouched: dark green means do not quiz again
 * until reactivated, so there is nothing to schedule.
 */
export function nextSchedule(
  state: ScheduleState,
  rating: Rating,
  today: string,
): ScheduleResult {
  if (rating === "suspended") {
    return {
      dueOn: addDays(today, state.intervalDays),
      intervalDays: state.intervalDays,
      lapses: state.lapses,
      streak: state.streak,
    };
  }

  const intervalDays =
    rating === "green"
      ? nextInterval(state.intervalDays, state.lapses)
      : rating === "yellow"
        ? yellowInterval(state.intervalDays)
        : RED_INTERVAL;

  return {
    dueOn: addDays(today, intervalDays),
    intervalDays,
    lapses: rating === "red" ? state.lapses + 1 : state.lapses,
    streak: rating === "green" ? state.streak + 1 : 0,
  };
}

export const TIERS = ["new", "relearning", "consolidating", "mature"] as const;
export type Tier = (typeof TIERS)[number];

export interface TierState {
  lastRating: Rating | null;
  lapses: number;
  streak: number;
  intervalDays: number;
}

/**
 * How far an item has come, from the four fields on its row.
 *
 * "relearning", not "weak": select() has a weak bucket with a broader meaning
 * that includes the objective's dashboard history. Bucket says why an item
 * was chosen today; tier says how to treat it. No single rating reaches
 * mature — that takes three greens in a row and a fortnight's interval.
 */
export function tierOf(state: TierState): Tier {
  if (state.lastRating === null) return "new";
  if (state.lastRating === "red" || state.lastRating === "yellow") {
    return "relearning";
  }
  if (state.streak >= MATURE_STREAK && state.intervalDays >= MATURE_INTERVAL) {
    return "mature";
  }
  return "consolidating";
}
```

- [ ] **Step 4: Pass and write `streak` in the runner**

In `lib/session/runner.ts`, in `finishSession`, change the schedule call and update to:

```ts
    const next = nextSchedule(
      { intervalDays: item.intervalDays, lapses: item.lapses, streak: item.streak },
      rating,
      today,
    );

    await db
      .update(schema.reviewItems)
      .set({
        dueOn: next.dueOn,
        intervalDays: next.intervalDays,
        lapses: next.lapses,
        streak: next.streak,
        lastRating: rating,
      })
      .where(eq(schema.reviewItems.id, item.id));
```

- [ ] **Step 5: Assert the streak end-to-end in the same-day test**

In `lib/session/sameDay.test.ts`, in "review items move on to the interval their objective earned", after the existing `expect(redItem.lastRating).toBe("red");` add:

```ts
  expect(greenItem.streak).toBe(1);
  expect(redItem.streak).toBe(0);
```

- [ ] **Step 6: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add lib/schedule.ts lib/schedule.test.ts lib/session/runner.ts lib/session/sameDay.test.ts
git commit -m "Add the lapsed ladder, the yellow band, the streak, and the mastery tier

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Record outcomes on finish

**Files:**
- Modify: `lib/session/kind.ts`, `lib/session/runner.ts` (`SessionResult`, `finishSession`)
- Test: `lib/session/sameDay.test.ts`, `lib/session/daily.test.ts`

**Interfaces:**
- Produces (in `kind.ts`): `interface Outcome { reviewItemId: number; concept: string; rating: Rating; tierBefore: Tier; tierAfter: Tier; dueOn: string }`; `SessionResult.outcomes: Outcome[]`; `sessions.outcomes` holds the same array.

- [ ] **Step 1: Write the failing tests**

In `lib/session/sameDay.test.ts`, extend "review items move on to the interval their objective earned" with (after the streak assertions from Task 2):

```ts
  // What finishing did to each item, in the order the runner walked them.
  expect(result.outcomes).toHaveLength(2);
  const outcomeFor = (id: number) => result.outcomes.find((o) => o.reviewItemId === id);
  expect(outcomeFor(greenItem.id)).toEqual({
    reviewItemId: greenItem.id,
    concept: greenItem.concept,
    rating: "green",
    tierBefore: "new",
    tierAfter: "consolidating",
    dueOn: greenItem.dueOn,
  });
  expect(outcomeFor(redItem.id)?.tierAfter).toBe("relearning");

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect(session!.outcomes).toEqual(result.outcomes);
```

In `lib/session/daily.test.ts`, extend "finishing reschedules only the items actually asked" with, after `expect(after.length).toBeGreaterThan(changed.size);`:

```ts
  // One outcome per item asked, each moved off "new" or "relearning" by a
  // green, and the same array on the session row.
  expect(result.outcomes).toHaveLength(10);
  expect(new Set(result.outcomes.map((o) => o.reviewItemId))).toEqual(asked);
  for (const outcome of result.outcomes) {
    expect(outcome.rating).toBe("green");
    expect(["consolidating", "mature"]).toContain(outcome.tierAfter);
    expect(outcome.concept.length).toBeGreaterThan(0);
  }
  const stored = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect(stored!.outcomes).toEqual(result.outcomes);
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test lib/session/sameDay.test.ts lib/session/daily.test.ts`
Expected: FAIL — `result.outcomes` is undefined.

- [ ] **Step 3: Add the type to `kind.ts`**

In `lib/session/kind.ts`, add after the `PlannedTurn` interface:

```ts
/** What finishing did to one review item. Stored on sessions.outcomes. */
export interface Outcome {
  reviewItemId: number;
  /** Snapshotted: the concept as it was asked, so a finished session needs no join. */
  concept: string;
  rating: Rating;
  tierBefore: Tier;
  tierAfter: Tier;
  dueOn: string;
}
```

and add `import type { Tier } from "@/lib/schedule";` to the imports.

- [ ] **Step 4: Collect and store outcomes in the runner**

In `lib/session/runner.ts`:

Change the schedule import to `import { capRating, nextSchedule, tierOf, todayIso, worstByLo, worstRating } from "@/lib/schedule";` and the kind import to include `Outcome`: `import type { AttemptRow, Outcome, SessionKind, SessionRow, TutorDeps } from "./kind";`.

Add to `SessionResult`:

```ts
  /** One entry per review item that moved, in the order they were walked. */
  outcomes: Outcome[];
```

In `finishSession`, rename the map from `kind.itemOutcomes` and collect:

```ts
  const moves = loaded.kind.itemOutcomes(loaded.attempts, loaded.material);
  const outcomes: Outcome[] = [];

  for (const [itemId, rating] of moves) {
    const item = await db.query.reviewItems.findFirst({
      where: eq(schema.reviewItems.id, itemId),
    });
    if (!item) continue;

    const next = nextSchedule(
      { intervalDays: item.intervalDays, lapses: item.lapses, streak: item.streak },
      rating,
      today,
    );

    await db
      .update(schema.reviewItems)
      .set({
        dueOn: next.dueOn,
        intervalDays: next.intervalDays,
        lapses: next.lapses,
        streak: next.streak,
        lastRating: rating,
      })
      .where(eq(schema.reviewItems.id, item.id));

    outcomes.push({
      reviewItemId: item.id,
      concept: item.concept,
      rating,
      tierBefore: tierOf(item),
      tierAfter: tierOf({ ...next, lastRating: rating }),
      dueOn: next.dueOn,
    });
  }
```

Delete the old `let reviewItemsRescheduled = 0;` and `reviewItemsRescheduled++;` lines. Then in the session update and the return:

```ts
  await db
    .update(schema.sessions)
    .set({ endedAt: now, outcomes, ...(debrief ? { debrief } : {}) })
    .where(eq(schema.sessions.id, sessionId));

  return {
    cellsWritten: testedLoIds.length,
    reviewItemsRescheduled: outcomes.length,
    ratingByLo,
    debrief: (debrief as DebriefOutput) ?? null,
    outcomes,
  };
```

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/session/kind.ts lib/session/runner.ts lib/session/sameDay.test.ts lib/session/daily.test.ts
git commit -m "Record what finishing did to each review item

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: One debrief for both session kinds

**Files:**
- Modify: `lib/session/kind.ts` (remove `closeOut`), `lib/session/daily.ts` (remove `closeOut`), `lib/session/runner.ts` (`finishSession`)
- Test: `lib/session/sameDay.test.ts`

**Interfaces:**
- Consumes: `summariseSession(request: DebriefRequest)` from `lib/tutor`.
- Produces: `finishSession` calls `deps.summariseSession` for any session with at least one graded attempt. `SessionKind` no longer has `closeOut`.

- [ ] **Step 1: Make every same-day `finishSession` call pass its tutor**

The same-day session will now call `summariseSession` on finish. Calls without `deps` would reach the real provider. In `lib/session/sameDay.test.ts`:

Replace the `summariseSession` stub and its comment with:

```ts
    summariseSession: async () => ({
      heldUp: ["Fibril structure"],
      shaky: [],
      misconceptions: [],
      focusNext: "Practise the precursor proteins.",
    }),
```

Then change every `await finishSession(sessionId);` to `await finishSession(sessionId, { deps: tutor });` — in "the worst rating of the session represents the day", "finishing writes one dashboard cell per tested objective", "an objective that was never tested gets no cell at all", "review items move on to the interval their objective earned", and "the summary turn contributes no dashboard cell".

In "a second session the same day keeps the worst rating, not the latest":

```ts
  const first = await startSameDaySession(lectureId);
  const firstTutor = stubTutor(["red", "red", "green", "green", "green"]);
  await playThrough(first, firstTutor);
  await finishSession(first, { deps: firstTutor });

  const second = await startSameDaySession(lectureId);
  expect(second).not.toBe(first);
  const secondTutor = stubTutor(["green", "green", "green"]);
  await playThrough(second, secondTutor);
  await finishSession(second, { deps: secondTutor });
```

In "a finished session cannot be finished again":

```ts
  await playThrough(sessionId, tutor);
  await finishSession(sessionId, { deps: tutor });

  await expect(finishSession(sessionId, { deps: tutor })).rejects.toThrow(/already been finished/i);
```

- [ ] **Step 2: Write the failing test**

Append to `lib/session/sameDay.test.ts`:

```ts
test("a same-day session gets a debrief too", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green", "green"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.debrief?.focusNext).toMatch(/precursor/i);

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect((session!.debrief as { heldUp: string[] }).heldUp).toEqual(["Fibril structure"]);
});
```

- [ ] **Step 3: Run to see it fail**

Run: `bun test lib/session/sameDay.test.ts`
Expected: FAIL on the new test — `result.debrief` is null.

- [ ] **Step 4: Hoist the debrief into the runner**

In `lib/session/kind.ts`, delete the `closeOut?` member and its comment from `SessionKind`.

In `lib/session/daily.ts`, delete the whole `async closeOut({ attempts, deps }) { … }` method (the last member of `dailyKind`).

In `lib/session/runner.ts`, change the tutor import to include the request type:

```ts
import {
  askQuestion,
  gradeAnswer,
  giveHint,
  summariseSession,
  type DebriefOutput,
  type DebriefRequest,
  type QuestionFormat,
} from "@/lib/tutor";
```

Add above `finishSession`:

```ts
/**
 * What the close-out summary sees: every graded turn with what it missed and
 * got wrong. Kind-agnostic — a same-day session and a daily one are debriefed
 * the same way.
 */
function debriefRequest(attempts: AttemptRow[]): DebriefRequest {
  const answered = attempts
    .filter((attempt) => attempt.rating !== null)
    .map((attempt) => {
      const grade = attempt.feedback
        ? (JSON.parse(attempt.feedback) as { missing?: string[]; incorrect?: string[] })
        : {};
      return {
        question: attempt.question,
        rating: attempt.rating as string,
        missing: grade.missing ?? [],
        incorrect: grade.incorrect ?? [],
      };
    });
  return { answered };
}
```

Replace the `let debrief: unknown = null; if (loaded.kind.closeOut) { … }` block with:

```ts
  let debrief: DebriefOutput | null = null;
  const request = debriefRequest(loaded.attempts);
  if (request.answered.length > 0) {
    try {
      debrief = await deps.summariseSession(request);
    } catch (error) {
      // The cells and the schedule are the session's real output. A summary
      // that failed to generate is not worth losing them over.
      console.error("Debrief failed:", error);
    }
  }
```

and in the return, `debrief: (debrief as DebriefOutput) ?? null` becomes `debrief`.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green. `daily.test.ts` "finishing writes a debrief onto the session" still passes through the runner.

- [ ] **Step 6: Commit**

```bash
git add lib/session/kind.ts lib/session/daily.ts lib/session/runner.ts lib/session/sameDay.test.ts
git commit -m "Debrief every session from the runner, the same-day one included

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The reflection turn

**Files:**
- Modify: `lib/db/schema.ts:31-41` (`SESSION_STAGES`), `lib/session/plan.ts`, `lib/session/sameDay.ts` (`planNext`), `lib/session/daily.ts` (`planNext`, `progress`), `lib/session/runner.ts` (`currentTurn`, `toTurn`, `submitAnswer`, `requestHint`)
- Test: `lib/session/plan.test.ts`, `lib/session/sameDay.test.ts`, `lib/session/daily.test.ts`

**Interfaces:**
- Produces: stage `"reflection"`; `planNextTurn(objectives, graded, options?: { reflected: boolean })`; `submitAnswer(): Promise<TurnFeedback | null>` (null for the reflection); `requestHint` throws on the reflection; `REFLECTION_QUESTION: Record<"same_day" | "daily", string>` exported from `runner.ts`; daily `progress.total = plan.length + 1`.
- A pending attempt is now one with `studentAnswer === null`.

- [ ] **Step 1: Write the failing plan tests**

In `lib/session/plan.test.ts`, change the three tests that expect `null`:

```ts
test("a session where everything came back cleanly closes with a reflection", () => {
  const graded = [recalled(1, "green"), recalled(2, "green"), summarised];

  expect(planNextTurn(objectives, graded)).toEqual({
    stage: "reflection",
    loId: null,
  });
  expect(planNextTurn(objectives, graded, { reflected: true })).toBeNull();
});
```

```ts
test("the session ends once every elaboration is graded and the reflection given", () => {
  const graded: GradedTurn[] = [
    recalled(1, "red"),
    recalled(2, "yellow"),
    summarised,
    { stage: "elaboration", loId: 1, rating: "green" },
    { stage: "elaboration", loId: 2, rating: "green" },
  ];

  expect(planNextTurn(objectives, graded)).toEqual({
    stage: "reflection",
    loId: null,
  });
  expect(planNextTurn(objectives, graded, { reflected: true })).toBeNull();
});
```

and in "a lecture whose objectives are all suspended still asks for a summary", change the last line to:

```ts
  expect(planNextTurn(allSuspended, [summarised])).toEqual({
    stage: "reflection",
    loId: null,
  });
  expect(planNextTurn(allSuspended, [summarised], { reflected: true })).toBeNull();
```

Add:

```ts
test("the reflection never comes before recall, summary or elaboration", () => {
  expect(planNextTurn(objectives, [])?.stage).toBe("lo_recall");
  const graded = [recalled(1, "red"), recalled(2, "green"), summarised];
  expect(planNextTurn(objectives, graded)?.stage).toBe("elaboration");
});
```

- [ ] **Step 2: Write the failing session tests**

Append to `lib/session/sameDay.test.ts`:

```ts
test("the session closes with an ungraded reflection turn", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green", "green"]);

  // Two recalls and the summary, all green: nothing to elaborate.
  for (let i = 0; i < 3; i++) {
    await currentTurn(sessionId, tutor);
    await submitAnswer(sessionId, "An answer.", tutor);
  }

  const reflection = await currentTurn(sessionId, tutor);
  expect(reflection?.stage).toBe("reflection");
  expect(reflection?.loId).toBeNull();
  expect(reflection?.question).toMatch(/key ideas/i);

  await expect(requestHint(sessionId, undefined, tutor)).rejects.toThrow(/no cue/i);

  const feedback = await submitAnswer(sessionId, "The precursor was the hardest point.", tutor);
  expect(feedback).toBeNull();
  expect(await currentTurn(sessionId, tutor)).toBeNull();

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
  });
  const last = attempts[attempts.length - 1];
  expect(last.stage).toBe("reflection");
  expect(last.rating).toBeNull();
  expect(last.studentAnswer).toMatch(/precursor/);

  // No cell, no item moved, no question asked of the model for it.
  const result = await finishSession(sessionId, { deps: tutor });
  expect(result.cellsWritten).toBe(2);
  expect(result.reviewItemsRescheduled).toBe(2);
});
```

In `lib/session/daily.test.ts`, change "every turn names the review item it is testing, and formats stay varied" so the attempt assertions read:

```ts
  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
    orderBy: [asc(schema.attempts.id)],
  });

  const daily = attempts.filter((attempt) => attempt.stage === "daily");
  expect(daily).toHaveLength(10);
  expect(daily.every((attempt) => attempt.reviewItemId !== null)).toBe(true);
  // The eleventh turn is the student's own account of the session.
  expect(attempts).toHaveLength(11);
  expect(attempts[10].stage).toBe("reflection");
  expect(attempts[10].reviewItemId).toBeNull();

  const formats = daily.map((attempt) => attempt.format);
```

(add `asc` to the `drizzle-orm` import at the top of the file). Then append:

```ts
test("the reflection turn is the eleventh and costs no question call", async () => {
  const sessionId = await startDailySession();
  const contexts: { bucket?: string }[] = [];
  const tutor = recordingTutor(stubTutor([]), contexts);

  for (let i = 0; i < 10; i++) {
    const turn = await currentTurn(sessionId, tutor);
    expect(turn?.stage).toBe("daily");
    expect(turn?.total).toBe(11);
    await submitAnswer(sessionId, "An answer.", tutor);
  }

  const reflection = await currentTurn(sessionId, tutor);
  expect(reflection?.stage).toBe("reflection");
  expect(reflection?.position).toBe(11);
  expect(reflection?.question).toMatch(/hardest question/i);
  expect(contexts).toHaveLength(10);

  expect(await submitAnswer(sessionId, "I got the precursor wrong.", tutor)).toBeNull();
  expect(await currentTurn(sessionId, tutor)).toBeNull();
  await finishSession(sessionId, { deps: tutor });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test lib/session/plan.test.ts lib/session/sameDay.test.ts lib/session/daily.test.ts`
Expected: FAIL — `null` where a reflection is expected; type errors on `"reflection"`.

- [ ] **Step 4: Add the stage**

In `lib/db/schema.ts`:

```ts
/**
 * The same-day review runs lo_recall → summary → elaboration in order
 * (prompt.txt "Same-Day Retrieval Practice"). Daily practice has one graded
 * stage: its variety comes from the question format, not from a running
 * order. Both close with a reflection — the student's own account of the
 * session, ungraded.
 */
export const SESSION_STAGES = [
  "lo_recall",
  "summary",
  "elaboration",
  "daily",
  "reflection",
] as const;
```

- [ ] **Step 5: Plan the reflection in `plan.ts`**

Change the signature and the final return of `planNextTurn`:

```ts
export function planNextTurn(
  objectives: PlannedObjective[],
  graded: GradedTurn[],
  options: { reflected: boolean } = { reflected: false },
): TurnPlan | null {
```

and replace the final `return null;` with:

```ts
  // Every session closes with the student's own account of it (prompt.txt
  // "Elaboration and Reflection": key ideas, hardest point, corrected
  // misconception, remaining uncertainty). It is ungraded, so it is never in
  // `graded`; the caller says whether it has been given.
  if (!options.reflected) return { stage: "reflection", loId: null };
  return null;
}
```

Update the doc comment's first line to: `Order: recall every objective, summarise the lecture, elaborate on whatever did not come back cleanly, then reflect.`

- [ ] **Step 6: Wire the same-day strategy**

In `lib/session/sameDay.ts`, `planNext`:

```ts
  planNext(material, attempts) {
    const graded: GradedTurn[] = attempts
      .filter((attempt) => attempt.rating !== null)
      .map((attempt) => ({
        stage: attempt.stage,
        loId: attempt.loId,
        rating: attempt.rating as Rating,
      }));
    const reflected = attempts.some((attempt) => attempt.stage === "reflection");

    const plan = planNextTurn(material.objectives, graded, { reflected });
    if (!plan) return null;
    return { stage: plan.stage, loId: plan.loId, reviewItemId: null };
  },
```

- [ ] **Step 7: Wire the daily strategy**

In `lib/session/daily.ts`, `planNext`:

```ts
    const next = material.plan.find((slot) => !asked.has(slot.reviewItemId));
    if (!next) {
      // Ten questions, then the student's own account of them.
      if (attempts.some((attempt) => attempt.stage === "reflection")) return null;
      return { stage: "reflection", loId: null, reviewItemId: null };
    }
```

and `progress`:

```ts
  progress(material, attempts) {
    // Answered turns only: the question in hand is the one being counted, not
    // one already behind the student. The reflection is the last position.
    const answered = attempts.filter((attempt) => attempt.studentAnswer !== null).length;
    const total = material.plan.length + 1;
    return { position: Math.min(answered + 1, total), total };
  },
```

- [ ] **Step 8: Teach the runner the reflection**

In `lib/session/runner.ts`, add after `REAL_TUTOR`:

```ts
/**
 * The reflection question, fixed and code-owned: prompt.txt's close-out asked
 * as one turn, at no model cost.
 */
export const REFLECTION_QUESTION: Record<SessionRow["type"], string> = {
  same_day:
    "Without looking back: what were the key ideas of this lecture, what was the hardest point, what misconception did you correct today, and what are you still unsure of?",
  daily:
    "Before the summary: what was the hardest question today, what did you get wrong and what is the correction you would give yourself, and what are you still unsure of?",
};

const REFLECTION_FORMAT = "reflection";
```

In `toTurn`, the reflection has no objective and no item, and the daily strategy's `turnContext` throws for a turn without one:

```ts
  const context =
    attempt.stage === "reflection"
      ? null
      : loaded.kind.turnContext(
          { stage: attempt.stage, loId: attempt.loId, reviewItemId: attempt.reviewItemId },
          loaded.material,
        );
```

and in the returned object: `objective: context?.objective ?? null,` and `lectureTitle: context?.lectureTitle || null,`.

In `currentTurn`, change the pending predicate and add the reflection branch after `if (!planned) return null;`:

```ts
  const pending = loaded.attempts.find((attempt) => attempt.studentAnswer === null);
  if (pending) return toTurn(pending, loaded);

  const planned = loaded.kind.planNext(loaded.material, loaded.attempts);
  if (!planned) return null;

  if (planned.stage === "reflection") {
    const [created] = await db
      .insert(schema.attempts)
      .values({
        sessionId,
        stage: "reflection",
        loId: null,
        reviewItemId: null,
        format: REFLECTION_FORMAT,
        question: REFLECTION_QUESTION[loaded.session.type],
      })
      .returning();
    return toTurn(created, { ...loaded, attempts: [...loaded.attempts, created] });
  }
```

In `submitAnswer`, change the return type to `Promise<TurnFeedback | null>`, the pending predicate to `attempt.studentAnswer === null`, and add before `const context = …`:

```ts
  // The reflection is the student's account of the session: stored, never
  // graded, and the runner's only turn that ends with no feedback.
  if (pending.stage === "reflection") {
    await db
      .update(schema.attempts)
      .set({ studentAnswer: answer })
      .where(eq(schema.attempts.id, pending.id));
    return null;
  }
```

In `requestHint`, change the pending predicate the same way and add after the `if (!pending) throw …` line:

```ts
  if (pending.stage === "reflection") {
    throw new Error("The reflection has no cue — it is your own account of the session.");
  }
```

Add a comment above the first changed predicate in `currentTurn`:

```ts
  // Pending means unanswered, not ungraded: the reflection is answered and
  // never graded, and for every other stage the two are set together.
```

- [ ] **Step 9: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green. If `daily.test.ts` "a same-day session and a daily session on one date" fails on the guard, its `playThrough` guard of 30 covers eleven turns — check the reflection branch returns `toTurn` rather than looping.

- [ ] **Step 10: Commit**

```bash
git add lib/db/schema.ts lib/session/plan.ts lib/session/plan.test.ts lib/session/sameDay.ts lib/session/sameDay.test.ts lib/session/daily.ts lib/session/daily.test.ts lib/session/runner.ts
git commit -m "Close every session with the student's own reflection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The reflection in the debrief, and calibration

**Files:**
- Modify: `lib/tutor/schema.ts` (`DebriefOutput`), `lib/tutor/index.ts` (`DebriefRequest`, `summariseSession`), `lib/session/runner.ts` (`debriefRequest`)
- Test: `lib/tutor/tutor.test.ts`, `lib/session/daily.test.ts`, stubs in `lib/session/sameDay.test.ts` and `lib/session/daily.test.ts`

**Interfaces:**
- Produces: `DebriefRequest.reflection: string | null`; `DebriefOutput.calibration: string` (defaults to `""`).

- [ ] **Step 1: Write the failing tutor tests**

In `lib/tutor/tutor.test.ts`, add `summariseSession` to the import from `./index`, and append:

```ts
test("the student's reflection reaches the debrief prompt and calibration comes back", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"heldUp":["Fibril structure"],"shaky":[],"misconceptions":[],' +
          '"focusNext":"Precursors.","calibration":"You felt sure of the precursor and missed it."}',
      );
    },
  });

  const debrief = await summariseSession(
    {
      answered: [{ question: "Name the precursor.", rating: "red", missing: ["The precursor"], incorrect: [] }],
      reflection: "I think I have the precursors down.",
    },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/own account/i);
  expect(prompts[0]).toMatch(/precursors down/);
  expect(debrief.calibration).toMatch(/felt sure/);
});

test("a debrief without a reflection asks for no calibration, and parses without one", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"heldUp":[],"shaky":["Precursors"],"misconceptions":[],"focusNext":"Precursors."}',
      );
    },
  });

  const debrief = await summariseSession(
    { answered: [{ question: "Q", rating: "yellow", missing: [], incorrect: [] }], reflection: null },
    { profile, model },
  );

  expect(prompts[0]).not.toMatch(/own account/i);
  expect(debrief.calibration).toBe("");
});
```

- [ ] **Step 2: Write the failing runner test**

Append to `lib/session/daily.test.ts`:

```ts
test("the reflection is handed to the debrief", async () => {
  const sessionId = await startDailySession();
  const base = stubTutor([]);
  const requests: { reflection?: string | null }[] = [];
  const tutor: TutorDeps = {
    ...base,
    summariseSession: async (request) => {
      requests.push({ reflection: request.reflection });
      return base.summariseSession(request);
    },
  };

  for (let i = 0; i < 10; i++) {
    await currentTurn(sessionId, tutor);
    await submitAnswer(sessionId, "An answer.", tutor);
  }
  await currentTurn(sessionId, tutor);
  await submitAnswer(sessionId, "Hardest: the precursor.", tutor);
  await finishSession(sessionId, { deps: tutor });

  expect(requests).toHaveLength(1);
  expect(requests[0].reflection).toBe("Hardest: the precursor.");
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test lib/tutor/tutor.test.ts lib/session/daily.test.ts`
Expected: FAIL — `reflection` is not a known property; `calibration` undefined.

- [ ] **Step 4: Extend the contract**

In `lib/tutor/schema.ts`, in `DebriefOutput`, after `focusNext`:

```ts
  calibration: z
    .string()
    .default("")
    .describe(
      "Where the student's own account of the session and the graded record " +
        "disagree — something they think they know that the record says they " +
        "missed, or the reverse — in one sentence. Empty when they agree, or " +
        "when no account was given.",
    ),
```

- [ ] **Step 5: Render the reflection in the prompt**

In `lib/tutor/index.ts`, `DebriefRequest`:

```ts
export interface DebriefRequest {
  answered: {
    question: string;
    rating: string;
    missing: string[];
    incorrect: string[];
  }[];
  /** The student's own account of the session, from the reflection turn. */
  reflection?: string | null;
}
```

In `summariseSession`, build the prompt as:

```ts
  const reflection = request.reflection?.trim();

  const prompt = [
    "Summarise this retrieval session for the student.",
    "Be brief. Do not call anything mastered — that takes repeated independent",
    "retrieval across increasing intervals, not one good answer.",
    "",
    ...request.answered.map((attempt, index) =>
      [
        `${index + 1}. [${attempt.rating}] ${attempt.question}`,
        attempt.missing.length ? `   missing: ${attempt.missing.join("; ")}` : "",
        attempt.incorrect.length ? `   wrong: ${attempt.incorrect.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    ...(reflection
      ? [
          "",
          "The student's own account of the session, in their words:",
          reflection,
          "",
          "Compare it with the graded record above. Where they disagree — something",
          "the student believes they know that the record says they missed, or the",
          "reverse — say so in one sentence as `calibration`. Leave it empty if they agree.",
        ]
      : []),
  ].join("\n");
```

- [ ] **Step 6: Pass the reflection from the runner**

In `lib/session/runner.ts`, `debriefRequest`:

```ts
  const reflection =
    attempts.find((attempt) => attempt.stage === "reflection")?.studentAnswer ?? null;
  return { answered, reflection };
```

- [ ] **Step 7: Fix the stubs**

`DebriefOutput` now has a required output field. In both `lib/session/sameDay.test.ts` and `lib/session/daily.test.ts`, add `calibration: "",` to the object the `summariseSession` stub returns.

- [ ] **Step 8: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add lib/tutor/schema.ts lib/tutor/index.ts lib/tutor/tutor.test.ts lib/session/runner.ts lib/session/sameDay.test.ts lib/session/daily.test.ts
git commit -m "Compare the student's reflection with the graded record in the debrief

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The tier on every planned slot

**Files:**
- Modify: `lib/session/select.ts` (`Candidate`, `PlannedSlot`, `order`), `lib/session/candidates.ts`
- Test: `lib/session/select.test.ts`, `lib/session/candidates.test.ts`

**Interfaces:**
- Produces: `Candidate.streak: number`; `PlannedSlot.tier: Tier` computed by `tierOf(candidate)` at plan time.

- [ ] **Step 1: Write the failing tests**

In `lib/session/select.test.ts`, add `streak: 0,` to the defaults in the `candidate()` helper (after `lapses: 0,`), and append:

```ts
test("each slot carries the item's tier at plan time", () => {
  const candidates = [
    candidate({ reviewItemId: 1, lectureId: 1 }),
    candidate({ reviewItemId: 2, lectureId: 2, lastRating: "red", lapses: 1, intervalDays: 1 }),
    candidate({ reviewItemId: 3, lectureId: 3, lastRating: "green", streak: 1, intervalDays: 1 }),
    candidate({ reviewItemId: 4, lectureId: 4, lastRating: "green", streak: 4, intervalDays: 14 }),
  ];
  const plan = select(candidates, { today: TODAY });

  const tierOf = (id: number) => plan.find((slot) => slot.reviewItemId === id)?.tier;
  expect(tierOf(1)).toBe("new");
  expect(tierOf(2)).toBe("relearning");
  expect(tierOf(3)).toBe("consolidating");
  expect(tierOf(4)).toBe("mature");
});
```

In `lib/session/candidates.test.ts`, in the second test, add `streak: 5,` to the `.set({ … })` on `reviewItems` (after `lapses: 2,`), change the distinctness check to:

```ts
  // The assertion below compares values, not which column produced them, so it
  // can only catch a swapped mapping while these six stay pairwise distinct.
  expect(
    new Set([item!.id, objective!.id, lecture.id, 7, 2, 5]).size,
  ).toBe(6);
```

and add `streak: 5,` to the expected candidate (after `lapses: 2,`).

- [ ] **Step 2: Run to see them fail**

Run: `bun test lib/session/select.test.ts lib/session/candidates.test.ts`
Expected: FAIL — `tier` undefined on slots; `streak` missing from the candidate.

- [ ] **Step 3: Implement**

In `lib/session/select.ts`, change the schedule import to `import { daysBetween, tierOf, type Tier } from "@/lib/schedule";`. In `Candidate`, after `lapses: number;` add `streak: number;`. In `PlannedSlot`, after `bucket: Bucket;` add:

```ts
  /**
   * The item's mastery tier when the plan was made. Frozen with the plan:
   * the row does not change until finish, and a session stays explainable
   * from its plan alone.
   */
  tier: Tier;
```

In `order()`, in the object returned by the final `.map`, after `bucket: pick.bucket,` add `tier: tierOf(pick.candidate),`.

In `lib/session/candidates.ts`, after `lapses: item.lapses,` add `streak: item.streak,`.

- [ ] **Step 4: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add lib/session/select.ts lib/session/select.test.ts lib/session/candidates.ts lib/session/candidates.test.ts
git commit -m "Freeze each item's mastery tier on the daily plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The tier brief replaces the bucket hint

**Files:**
- Modify: `lib/session/kind.ts` (`PlannedTurn`), `lib/session/daily.ts` (`planNext`), `lib/session/runner.ts` (`currentTurn`), `lib/tutor/index.ts` (`TurnContext`, `askQuestion`)
- Test: `lib/tutor/tutor.test.ts`, `lib/session/daily.test.ts`

**Interfaces:**
- Consumes: `PlannedSlot.tier` from Task 7.
- Produces: `PlannedTurn.tier?: Tier`; `TurnContext.tier?: Tier`; `TIER_BRIEF` in the prompt; `BUCKET_HINT` gone.

- [ ] **Step 1: Write the failing tutor tests**

Append to `lib/tutor/tutor.test.ts`:

```ts
test("the tier brief steers the question's demand", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"vignette","question":"A patient presents…"}');
    },
  });

  await askQuestion({ ...context, stage: "daily", tier: "mature" }, { profile, model });
  expect(prompts[0]).toMatch(/application or discrimination/i);
  expect(prompts[0]).toMatch(/wrong ones are wrong/i);

  await askQuestion({ ...context, stage: "daily", tier: "relearning" }, { profile, model });
  expect(prompts[1]).toMatch(/one part of it/i);
  expect(prompts[1]).not.toMatch(/application or discrimination/i);

  await askQuestion({ ...context, stage: "daily", tier: "consolidating" }, { profile, model });
  expect(prompts[2]).toMatch(/whole concept/i);
});

test("the bucket no longer reaches the prompt", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"free_recall","question":"Explain."}');
    },
  });

  await askQuestion({ ...context, stage: "daily", bucket: "due" }, { profile, model });
  expect(prompts[0]).not.toMatch(/spaced review/i);
  expect(prompts[0]).not.toMatch(/gone badly/i);
});
```

- [ ] **Step 2: Write the failing session test**

In `lib/session/daily.test.ts`, extend `recordingTutor` to record the tier:

```ts
function recordingTutor(
  base: TutorDeps,
  contexts: { bucket?: string; tier?: string }[],
): TutorDeps {
  return {
    askQuestion: async (context) => {
      contexts.push({ bucket: context.bucket, tier: context.tier });
      return base.askQuestion(context);
    },
    gradeAnswer: base.gradeAnswer,
    giveHint: base.giveHint,
    summariseSession: base.summariseSession,
  };
}
```

and append:

```ts
test("every daily question carries the item's tier, and a red makes it relearning next time", async () => {
  const first = await startDailySession();
  const redTutor = stubTutor(Array(10).fill("red"));
  await playThrough(first, redTutor);
  await finishSession(first, { deps: redTutor });

  const second = await startDailySession();
  const contexts: { bucket?: string; tier?: string }[] = [];
  const tutor = recordingTutor(stubTutor([]), contexts);
  await playThrough(second, tutor);
  await finishSession(second, { deps: tutor });

  expect(contexts).toHaveLength(10);
  expect(contexts.every((context) => context.tier !== undefined)).toBe(true);
  // Ten reds make ten relearning items; the weak bucket alone surfaces two.
  expect(contexts.some((context) => context.tier === "relearning")).toBe(true);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test lib/tutor/tutor.test.ts lib/session/daily.test.ts`
Expected: FAIL — `tier` is not a known property; the mature prompt lacks the brief.

- [ ] **Step 4: Carry the tier to the tutor**

In `lib/session/kind.ts`, in `PlannedTurn`, after `bucket?: Bucket;`:

```ts
  /** The item's mastery tier, from the plan. Absent for same-day turns. */
  tier?: Tier;
```

In `lib/session/daily.ts`, in `planNext`'s returned object, after `bucket: next.bucket,` add `tier: next.tier,`.

In `lib/session/runner.ts`, in `currentTurn`'s `askQuestion` call, after `bucket: planned.bucket,` add `tier: planned.tier,`.

- [ ] **Step 5: Replace the hint with the brief**

In `lib/tutor/index.ts`, change the schedule import line (add one): `import type { Tier } from "@/lib/schedule";`. In `TurnContext`, after `bucket?: Bucket;`:

```ts
  /** The item's mastery tier. Steers how demanding the question is. */
  tier?: Tier;
```

Delete the `BUCKET_HINT` constant and its comment. Add in its place:

```ts
/** A focused question, in steps: prompt.txt "Adaptive Difficulty" for new or weak material. */
const FOCUSED_BRIEF =
  "Ask a focused question about one part of this concept. Let the student work in steps. Do not combine it with other material.";

/**
 * How demanding the question should be, from the item's tier (prompt.txt
 * "Adaptive Difficulty"). Kind decides the question's shape through the
 * format family; tier decides its demand. Code sets the tier; the model
 * shapes the question to it.
 */
const TIER_BRIEF: Record<Tier, string> = {
  new: FOCUSED_BRIEF,
  relearning: `The student missed this last time. ${FOCUSED_BRIEF}`,
  consolidating:
    "The student has retrieved this before. Ask for the whole concept, unscaffolded; nothing in the wording should narrow it.",
  mature:
    "The student has retrieved this reliably across increasing intervals. Test it through application or discrimination in a context the lecture did not use, combine it with the related concepts listed, and where plausible alternatives exist ask why the wrong ones are wrong.",
};
```

In `askQuestion`, replace

```ts
  const bucketHint =
    context.stage === "daily" && context.bucket
      ? BUCKET_HINT[context.bucket]
      : undefined;
```

with

```ts
  const tierBrief = context.tier ? TIER_BRIEF[context.tier] : "";
```

and in the prompt array replace `bucketHint ?? "",` with `tierBrief,`.

- [ ] **Step 6: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green. The existing daily test "a due-bucket slot's context carries the bucket" still passes: `bucket` stays on the context, only the prompt stopped using it.

- [ ] **Step 7: Commit**

```bash
git add lib/session/kind.ts lib/session/daily.ts lib/session/runner.ts lib/tutor/index.ts lib/tutor/tutor.test.ts lib/session/daily.test.ts
git commit -m "Steer question demand by mastery tier instead of bucket

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Carry the last miss into the next question

**Files:**
- Create: `lib/session/prior.ts`
- Modify: `lib/tutor/index.ts` (`PriorAttempt`, `TurnContext.lastAttempt`, `askQuestion`), `lib/session/daily.ts` (`DailyMaterial`, `loadMaterial`, `turnContext`)
- Test: `lib/session/prior.test.ts` (new), `lib/tutor/tutor.test.ts`

**Interfaces:**
- Produces:
  - `interface PriorAttempt { daysAgo: number; rating: Rating; hintsUsed: boolean; missing: string[]; incorrect: string[]; correction: string; aboutObjective: boolean }` (exported from `lib/tutor`)
  - `priorAttempts(sessionId: number, slots: { reviewItemId: number; loId: number }[], today?: string): Promise<Map<number, PriorAttempt>>` in `lib/session/prior.ts`
  - `TurnContext.lastAttempt?: PriorAttempt`; `DailyMaterial.priorByItem: Map<number, PriorAttempt>`

- [ ] **Step 1: Write the failing tutor test**

Append to `lib/tutor/tutor.test.ts`:

```ts
test("the last attempt reaches the prompt, with a steer that depends on tier", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"mechanism","question":"Explain."}');
    },
  });
  const lastAttempt = {
    daysAgo: 3,
    rating: "red" as const,
    hintsUsed: false,
    missing: ["Organ tropism"],
    incorrect: ["Said ATTR comes from light chains"],
    correction: "ATTR is transthyretin.",
    aboutObjective: false,
  };

  await askQuestion(
    { ...context, stage: "daily", tier: "relearning", lastAttempt },
    { profile, model },
  );
  expect(prompts[0]).toMatch(/3 days ago/);
  expect(prompts[0]).toMatch(/Organ tropism/);
  expect(prompts[0]).toMatch(/light chains/);
  expect(prompts[0]).toMatch(/transthyretin/);
  expect(prompts[0]).toMatch(/target what was missed/i);

  await askQuestion(
    {
      ...context,
      stage: "daily",
      tier: "mature",
      lastAttempt: { ...lastAttempt, daysAgo: 1, rating: "green", hintsUsed: true, aboutObjective: true },
    },
    { profile, model },
  );
  expect(prompts[1]).toMatch(/yesterday/);
  expect(prompts[1]).toMatch(/after a cue/);
  expect(prompts[1]).toMatch(/objective as a whole/);
  expect(prompts[1]).toMatch(/different route/i);
  expect(prompts[1]).not.toMatch(/target what was missed/i);
});
```

- [ ] **Step 2: Write the failing prior test**

Create `lib/session/prior.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-prior-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("../db");
const { commitLecture } = await import("../commitLecture");
const { addDays, todayIso } = await import("../schedule");
const { priorAttempts } = await import("./prior");
const { startDailySession } = await import("./daily");
const { startSameDaySession } = await import("./sameDay");
const { currentTurn, finishSession, submitAnswer } = await import("./runner");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

type TutorDeps = NonNullable<Parameters<typeof currentTurn>[1]>;
type Rating = "green" | "yellow" | "red";

/** One lecture, one objective, one concept: every daily plan is this one item. */
const draft = {
  title: "Amyloidosis",
  learningObjectives: [{ text: "Describe the precursor proteins.", slideRefs: [1] }],
  concepts: [
    {
      label: "AL vs ATTR precursor",
      detail: "Light chains versus transthyretin.",
      kind: "mechanism" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [0],
    },
  ],
  commonConfusions: [],
  conflicts: [],
};

/** Grades from a script, and reports the same `missing` on every grade. */
function stubTutor(ratings: Rating[], missing: string[] = []): TutorDeps {
  const queue = [...ratings];
  return {
    askQuestion: async (context) => ({
      format: context.allowedFormats?.[0] ?? "free_recall",
      question: `Question about ${context.targetConcept ?? context.objective ?? "the lecture"}`,
    }),
    gradeAnswer: async () => ({
      rating: queue.shift() ?? "green",
      correct: [],
      missing,
      incorrect: [],
      correction: "A correction.",
      modelAnswer: "A model answer.",
    }),
    giveHint: async () => ({ hint: "A cue." }),
    summariseSession: async () => ({
      heldUp: [],
      shaky: [],
      misconceptions: [],
      focusNext: "",
      calibration: "",
    }),
  } as TutorDeps;
}

async function playThrough(sessionId: number, tutor: TutorDeps) {
  for (let guard = 0; guard < 20; guard++) {
    const turn = await currentTurn(sessionId, tutor);
    if (!turn) return;
    await submitAnswer(sessionId, "An answer.", tutor);
  }
  throw new Error("Session did not terminate.");
}

let lectureId: number;
let slots: { reviewItemId: number; loId: number }[];

beforeAll(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: draft.title, draftExtract: draft })
    .returning({ id: schema.lectures.id });
  lectureId = lecture.id;
  await commitLecture(lectureId, [{ draftIndex: 0, text: draft.learningObjectives[0].text }]);

  const item = await db.query.reviewItems.findFirst();
  slots = [{ reviewItemId: item!.id, loId: item!.loId }];
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

test("an item nobody has attempted carries nothing", async () => {
  expect((await priorAttempts(0, slots)).size).toBe(0);
});

test("a same-day turn on the objective is the fallback, marked as such", async () => {
  const tutor = stubTutor(["red", "green", "green"], ["The precursor protein"]);
  const sessionId = await startSameDaySession(lectureId);
  await playThrough(sessionId, tutor);
  await finishSession(sessionId, { deps: tutor });

  const prior = (await priorAttempts(0, slots)).get(slots[0].reviewItemId);
  // The latest graded turn on the objective is the elaboration, rated green.
  expect(prior).toEqual({
    daysAgo: 0,
    rating: "green",
    hintsUsed: false,
    missing: ["The precursor protein"],
    incorrect: [],
    correction: "A correction.",
    aboutObjective: true,
  });
});

test("a direct attempt on the item beats the objective's, and the current session is excluded", async () => {
  const direct = stubTutor(["yellow"], ["Organ tropism"]);
  const sessionId = await startDailySession();
  await playThrough(sessionId, direct);
  await finishSession(sessionId, { deps: direct });

  const seen = (await priorAttempts(0, slots)).get(slots[0].reviewItemId);
  expect(seen?.aboutObjective).toBe(false);
  expect(seen?.rating).toBe("yellow");
  expect(seen?.missing).toEqual(["Organ tropism"]);

  // A session in progress must not see its own graded turn as "last time".
  const inProgress = stubTutor(["red"], ["In progress"]);
  const openId = await startDailySession();
  await currentTurn(openId, inProgress);
  await submitAnswer(openId, "An answer.", inProgress);

  const fromInside = (await priorAttempts(openId, slots)).get(slots[0].reviewItemId);
  expect(fromInside?.missing).toEqual(["Organ tropism"]);
  const fromOutside = (await priorAttempts(0, slots)).get(slots[0].reviewItemId);
  expect(fromOutside?.missing).toEqual(["In progress"]);

  await playThrough(openId, inProgress);
  await finishSession(openId, { deps: inProgress });
});

test("daysAgo counts calendar days", async () => {
  const latest = await db.query.attempts.findFirst({
    where: eq(schema.attempts.reviewItemId, slots[0].reviewItemId),
    orderBy: (attempts, { desc }) => [desc(attempts.id)],
  });
  await db
    .update(schema.attempts)
    .set({ createdAt: new Date(`${addDays(todayIso(), -2)}T12:00:00`) })
    .where(eq(schema.attempts.id, latest!.id));

  const prior = (await priorAttempts(0, slots)).get(slots[0].reviewItemId);
  expect(prior?.daysAgo).toBe(2);
});

test("the runner hands the last attempt to the tutor", async () => {
  const contexts: { lastAttempt?: { missing: string[]; aboutObjective: boolean } }[] = [];
  const base = stubTutor([]);
  const tutor: TutorDeps = {
    ...base,
    askQuestion: async (context) => {
      contexts.push({ lastAttempt: context.lastAttempt });
      return base.askQuestion(context);
    },
  };

  const sessionId = await startDailySession();
  await currentTurn(sessionId, tutor);

  expect(contexts).toHaveLength(1);
  expect(contexts[0].lastAttempt?.missing).toEqual(["In progress"]);
  expect(contexts[0].lastAttempt?.aboutObjective).toBe(false);

  await playThrough(sessionId, tutor);
  await finishSession(sessionId, { deps: tutor });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test lib/tutor/tutor.test.ts lib/session/prior.test.ts`
Expected: FAIL — `./prior` not found; `lastAttempt` unknown.

- [ ] **Step 4: Add `PriorAttempt` and the prompt block to the tutor**

In `lib/tutor/index.ts`, after `ConceptContext`:

```ts
/** The most recent graded attempt on a concept, from an earlier session. */
export interface PriorAttempt {
  daysAgo: number;
  rating: Rating;
  hintsUsed: boolean;
  missing: string[];
  incorrect: string[];
  correction: string;
  /** True when the attempt graded the whole objective, not this concept. */
  aboutObjective: boolean;
}
```

(add `Rating` to the `@/lib/db/schema` type import). In `TurnContext`, after `tier?: Tier;`:

```ts
  /** What happened last time this concept was tested, if it was. */
  lastAttempt?: PriorAttempt;
```

Add, after `TIER_BRIEF`:

```ts
/**
 * Last time, as the model needs it: what was missed, what was wrong, the
 * correction given — and a steer that depends on tier. Relearning targets the
 * gap (prompt.txt: "target the missing component"); anything more mature
 * tests the same point by another route rather than repeating the wording.
 */
function lastAttemptLines(last: PriorAttempt, tier: Tier | undefined): string {
  const when =
    last.daysAgo === 0 ? "earlier today" : last.daysAgo === 1 ? "yesterday" : `${last.daysAgo} days ago`;
  const about = last.aboutObjective ? "on the objective as a whole" : "on this concept";
  const steer =
    tier === "new" || tier === "relearning"
      ? "Target what was missed."
      : "Do not repeat that wording: test the same point through a different route.";

  return [
    `Last attempt, ${when}, ${about}: rated ${last.rating}${last.hintsUsed ? " after a cue" : ""}.`,
    last.missing.length ? `  Missed: ${last.missing.join("; ")}` : "",
    last.incorrect.length ? `  Wrong: ${last.incorrect.join("; ")}` : "",
    last.correction ? `  Correction given: ${last.correction}` : "",
    steer,
  ]
    .filter(Boolean)
    .join("\n");
}
```

In `askQuestion`, after `const tierBrief = …`:

```ts
  const lastAttempt = context.lastAttempt
    ? lastAttemptLines(context.lastAttempt, context.tier)
    : "";
```

and in the prompt array, after `tierBrief,` add `lastAttempt,`.

- [ ] **Step 5: Create `lib/session/prior.ts`**

```ts
import { and, desc, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { daysBetween, todayIso } from "@/lib/schedule";
import type { PriorAttempt } from "@/lib/tutor";

type AttemptRow = typeof schema.attempts.$inferSelect;

/**
 * The most recent graded attempt on each planned item, from any session but
 * this one: by review item where the item has been asked directly, else by
 * objective — a same-day turn, the item's first exposure, whose misses are
 * the most relevant thing for its first daily review.
 *
 * Read from `attempts` at load time rather than copied onto the item row:
 * one source of truth, nothing to keep in sync.
 */
export async function priorAttempts(
  sessionId: number,
  slots: { reviewItemId: number; loId: number }[],
  today: string = todayIso(),
): Promise<Map<number, PriorAttempt>> {
  if (slots.length === 0) return new Map();

  const itemIds = slots.map((slot) => slot.reviewItemId);
  const loIds = [...new Set(slots.map((slot) => slot.loId))];

  const direct = await db.query.attempts.findMany({
    where: and(
      inArray(schema.attempts.reviewItemId, itemIds),
      isNotNull(schema.attempts.rating),
      ne(schema.attempts.sessionId, sessionId),
    ),
    orderBy: [desc(schema.attempts.id)],
  });

  const onObjective = await db.query.attempts.findMany({
    where: and(
      inArray(schema.attempts.loId, loIds),
      isNull(schema.attempts.reviewItemId),
      isNotNull(schema.attempts.rating),
      ne(schema.attempts.sessionId, sessionId),
    ),
    orderBy: [desc(schema.attempts.id)],
  });

  // Newest first, so the first row seen for a key is the latest.
  const latestByItem = new Map<number, AttemptRow>();
  for (const attempt of direct) {
    if (!latestByItem.has(attempt.reviewItemId!)) {
      latestByItem.set(attempt.reviewItemId!, attempt);
    }
  }
  const latestByLo = new Map<number, AttemptRow>();
  for (const attempt of onObjective) {
    if (!latestByLo.has(attempt.loId!)) latestByLo.set(attempt.loId!, attempt);
  }

  const prior = new Map<number, PriorAttempt>();
  for (const slot of slots) {
    const own = latestByItem.get(slot.reviewItemId);
    const objective = latestByLo.get(slot.loId);
    if (own) prior.set(slot.reviewItemId, toPrior(own, false, today));
    else if (objective) prior.set(slot.reviewItemId, toPrior(objective, true, today));
  }
  return prior;
}

function toPrior(attempt: AttemptRow, aboutObjective: boolean, today: string): PriorAttempt {
  const grade = attempt.feedback
    ? (JSON.parse(attempt.feedback) as {
        missing?: string[];
        incorrect?: string[];
        correction?: string;
      })
    : {};
  return {
    daysAgo: daysBetween(todayIso(attempt.createdAt), today),
    rating: attempt.rating as Rating,
    hintsUsed: attempt.hintsUsed,
    missing: grade.missing ?? [],
    incorrect: grade.incorrect ?? [],
    correction: grade.correction ?? "",
    aboutObjective,
  };
}
```

- [ ] **Step 6: Load and pass it in the daily strategy**

In `lib/session/daily.ts`: import `priorAttempts` from `./prior` and `PriorAttempt` from `@/lib/tutor` (type). In `DailyMaterial`, add `priorByItem: Map<number, PriorAttempt>;`. In `loadMaterial`, before the `return`:

```ts
    const priorByItem = await priorAttempts(session.id, plan);
```

and add `priorByItem,` to the returned object. In `turnContext`, in the returned object after `targetConcept: item?.concept,`:

```ts
      ...(item && material.priorByItem.has(item.id)
        ? { lastAttempt: material.priorByItem.get(item.id) }
        : {}),
```

- [ ] **Step 7: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add lib/session/prior.ts lib/session/prior.test.ts lib/session/daily.ts lib/tutor/index.ts lib/tutor/tutor.test.ts
git commit -m "Carry each concept's last miss into its next question

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The badge data, on the answer response

**Files:**
- Modify: `lib/session/kind.ts` (`TurnWhy`, `explain?`), `lib/session/daily.ts` (`explain`), `lib/session/runner.ts` (`TurnFeedback`, `submitAnswer`)
- Test: `lib/session/daily.test.ts`, `lib/session/sameDay.test.ts`

**Interfaces:**
- Produces: `interface TurnWhy { bucket: Bucket; tier: Tier; lapses: number; streak: number; intervalDays: number; dueOn: string }`; `SessionKind.explain?(turn, material): TurnWhy | undefined`; `TurnFeedback.why?: TurnWhy`. `Turn` (the question) carries no `why`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/session/daily.test.ts`:

```ts
test("the feedback explains the turn; the question does not", async () => {
  const sessionId = await startDailySession();
  const tutor = stubTutor([]);

  const turn = await currentTurn(sessionId, tutor);
  expect(turn).not.toHaveProperty("why");

  const feedback = await submitAnswer(sessionId, "An answer.", tutor);
  expect(feedback?.why).toBeDefined();
  expect(["due", "weak", "recent", "interleaved", "fill"]).toContain(feedback!.why!.bucket);
  expect(["new", "relearning", "consolidating", "mature"]).toContain(feedback!.why!.tier);
  expect(feedback!.why!.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(feedback!.why!.intervalDays).toBeGreaterThanOrEqual(0);

  await playThrough(sessionId, tutor);
  await finishSession(sessionId, { deps: tutor });
});
```

In `lib/session/sameDay.test.ts`, in "taking a cue caps the rating at yellow even when the model says green", after `expect(feedback.rating).toBe("yellow");`:

```ts
  // Same-day turns have no selection story to tell.
  expect(feedback?.why).toBeUndefined();
```

(`feedback` is now `TurnFeedback | null`; change the two existing expectations to `feedback?.modelRating` and `feedback?.rating`.)

- [ ] **Step 2: Run to see them fail**

Run: `bun test lib/session/daily.test.ts lib/session/sameDay.test.ts`
Expected: FAIL — `why` undefined on the daily feedback.

- [ ] **Step 3: Add the type and the hook to `kind.ts`**

In `lib/session/kind.ts`, after `Outcome`:

```ts
/**
 * Why a daily turn was shaped as it was. Shown only after grading: a
 * judgement of learning handed over before the attempt is the anchor the
 * calibration literature wants removed.
 */
export interface TurnWhy {
  bucket: Bucket;
  tier: Tier;
  lapses: number;
  streak: number;
  intervalDays: number;
  dueOn: string;
}
```

In `SessionKind`, after `progress?`:

```ts
  /** The turn's selection story, for the badge. Omitted by kinds without one. */
  explain?(turn: TurnRef, material: M): TurnWhy | undefined;
```

- [ ] **Step 4: Implement `explain` in the daily strategy**

In `lib/session/daily.ts`, import `tierOf` from `@/lib/schedule` (alongside `startOfToday, todayIso`), and add to `dailyKind` after `progress`:

```ts
  explain(turn, material) {
    if (turn.reviewItemId === null) return undefined;
    const slot = material.plan.find((s) => s.reviewItemId === turn.reviewItemId);
    const item = material.itemById.get(turn.reviewItemId);
    if (!slot || !item) return undefined;
    return {
      bucket: slot.bucket,
      // A plan frozen before tiers existed carries none; the row can say.
      tier: slot.tier ?? tierOf(item),
      lapses: item.lapses,
      streak: item.streak,
      intervalDays: item.intervalDays,
      dueOn: item.dueOn,
    };
  },
```

- [ ] **Step 5: Return it from `submitAnswer`**

In `lib/session/runner.ts`, import `TurnWhy` as a type from `./kind`, add to `TurnFeedback`:

```ts
  /** Why the turn was shaped as it was. Daily turns only. */
  why?: TurnWhy;
```

and change the return of `submitAnswer` to:

```ts
  return {
    rating,
    modelRating: grade.rating,
    grade,
    why: loaded.kind.explain?.(pending, loaded.material),
  };
```

- [ ] **Step 6: Run everything**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add lib/session/kind.ts lib/session/daily.ts lib/session/runner.ts lib/session/daily.test.ts lib/session/sameDay.test.ts
git commit -m "Explain a daily turn on its feedback, never on its question

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The session screen — reflection, badge, outcomes, calibration

**Files:**
- Modify: `app/sessions/[id]/SessionTurn.tsx`, `app/sessions/[id]/Debrief.tsx`, `app/sessions/[id]/page.tsx`
- Create: `app/sessions/[id]/Outcomes.tsx`

**Interfaces:**
- Consumes: `TurnWhy`, `Outcome` from `@/lib/session/kind`; `Bucket` from `@/lib/session/select`; `todayIso` from `@/lib/schedule`; `DebriefOutput.calibration`; `POST /api/sessions/[id]/answer` returning `null` for the reflection (the route already serialises whatever `submitAnswer` returns; `NextResponse.json(null)` is a valid body).

Before editing, read `node_modules/next/dist/docs/` on client components and server components — this Next.js differs from training data.

- [ ] **Step 1: Create `app/sessions/[id]/Outcomes.tsx`**

```tsx
import type { Outcome } from "@/lib/session/kind";

/** What the session did to the ladder, as two short lists. */
export function Outcomes({ outcomes }: { outcomes: Outcome[] }) {
  const promoted = outcomes.filter(
    (outcome) => outcome.tierAfter === "mature" && outcome.tierBefore !== "mature",
  );
  const relearning = outcomes.filter((outcome) => outcome.tierAfter === "relearning");
  if (promoted.length === 0 && relearning.length === 0) return null;

  return (
    <div className="mt-6 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
      <List title="Promoted to mature" items={promoted} />
      <List title="Now relearning" items={relearning} />
    </div>
  );
}

function List({ title, items }: { title: string; items: Outcome[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((outcome) => (
          <li key={outcome.reviewItemId}>
            {outcome.concept}{" "}
            <span className="text-stone-500">— due {outcome.dueOn}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Show calibration in `Debrief.tsx`**

After the `Next` block inside the outer `div`:

```tsx
      {debrief.calibration && debrief.calibration.trim().length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Your account versus the record
          </h3>
          <p className="mt-1 text-sm">{debrief.calibration}</p>
        </div>
      )}
```

(Debriefs stored before this phase have no `calibration`; the guard covers them.)

- [ ] **Step 3: Update `SessionTurn.tsx`**

Imports — add:

```tsx
import { todayIso } from "@/lib/schedule";
import type { Outcome, TurnWhy } from "@/lib/session/kind";
import type { Bucket } from "@/lib/session/select";
import { Outcomes } from "./Outcomes";
```

`Turn.stage` becomes `"lo_recall" | "summary" | "elaboration" | "daily" | "reflection"`. `Feedback` gains `why?: TurnWhy;`. `STAGE_LABEL` gains `reflection: "Reflection",`. Add:

```tsx
const BUCKET_LABEL: Record<Bucket, string> = {
  due: "Due for review",
  recent: "Recent material",
  weak: "Weak spot",
  interleaved: "Cumulative",
  fill: "Extra practice",
};

function monthDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** One line: why this question was shaped as it was. Rendered after grading only. */
function whyLine(why: TurnWhy): string {
  const today = todayIso();
  const parts = [BUCKET_LABEL[why.bucket], why.tier];
  if (why.lapses > 0) parts.push(`lapsed ${why.lapses}×`);
  if (why.streak > 0) parts.push(`${why.streak} green in a row`);
  parts.push(why.intervalDays === 0 ? "first review" : `was on a ${why.intervalDays}-day interval`);
  parts.push(
    why.dueOn < today
      ? `due since ${monthDay(why.dueOn)}`
      : why.dueOn === today
        ? "due today"
        : "not yet due",
  );
  return parts.join(" · ");
}
```

The `result` state type and the `finish()` `post<…>` type both gain `outcomes: Outcome[];`.

In `grade()`, the reflection returns no feedback — go straight on:

```tsx
      const result = await post<Feedback | null>(`/api/sessions/${sessionId}/answer`, {
        answer,
      });
      if (result === null) {
        await loadTurn();
        return;
      }
      setFeedback(result);
```

In the `result` (finished) branch, after `<ColorTally … />`:

```tsx
        {sessionType === "daily" && <Outcomes outcomes={result.outcomes} />}
```

In the question header, hide the format for the reflection:

```tsx
        <span className="uppercase tracking-wide">
          {STAGE_LABEL[turn.stage]}
          {turn.stage !== "reflection" && ` · ${turn.format.replace(/_/g, " ")}`}
        </span>
```

In the answer block, the textarea placeholder and the cue controls depend on the stage:

```tsx
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={8}
            autoFocus
            placeholder={
              turn.stage === "reflection"
                ? "In your own words. This is not graded."
                : "Everything you can remember. Write it out before checking."
            }
            className="mt-4 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />

          {error && <ErrorNote message={error} />}

          <div className="mt-4 flex items-center gap-4">
            <button
              type="button"
              onClick={grade}
              disabled={busy !== null || answer.trim().length === 0}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
            >
              {busy === "grading"
                ? turn.stage === "reflection"
                  ? "Saving…"
                  : "Checking…"
                : turn.stage === "reflection"
                  ? "Save and finish"
                  : "Submit answer"}
            </button>

            {turn.stage !== "reflection" && (
              <button
                type="button"
                onClick={cue}
                disabled={busy !== null || turn.hintsUsed}
                className="text-sm text-stone-600 underline disabled:no-underline disabled:opacity-40 dark:text-stone-400"
              >
                {turn.hintsUsed ? "Cue taken" : "I need a cue"}
              </button>
            )}
          </div>

          {turn.stage !== "reflection" && (
            <p className="mt-2 text-xs text-stone-500">
              A cue caps this answer at yellow — hinted recall is not independent
              recall.
            </p>
          )}
```

In `FeedbackPanel`, before the rating row:

```tsx
      {feedback.why && (
        <p className="mb-3 text-xs text-stone-500">{whyLine(feedback.why)}</p>
      )}
```

- [ ] **Step 4: Show outcomes on the finished-session page**

In `app/sessions/[id]/page.tsx`, import `Outcome` (type) from `@/lib/session/kind` and `Outcomes` from `./Outcomes`. In the `session.endedAt` branch:

```tsx
    const debrief = session.debrief as DebriefOutput | null;
    const outcomes = session.outcomes as Outcome[] | null;
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          This session is finished. Today&rsquo;s results are on the{" "}
          <Link href="/dashboard" className="underline">
            dashboard
          </Link>
          .
        </p>
        {session.type === "daily" && outcomes && <Outcomes outcomes={outcomes} />}
        {debrief && <Debrief debrief={debrief} />}
      </div>
    );
```

- [ ] **Step 5: Typecheck and build**

Run: `bun run typecheck`
Expected: clean.

Run: `bun --bun run build`
Expected: builds. (If the sandbox blocks the build's font fetch, run it with the sandbox disabled — see the project memory note.)

- [ ] **Step 6: Smoke the screen (if a tutor provider is configured)**

Start the dev server with the `studyhelp-dev` launch configuration, open `/practice`, start a daily session, answer one question and confirm the muted "why" line appears at the top of the feedback and not on the question; continue to the eleventh turn, confirm it reads *Reflection* with no cue button and *Save and finish*; save, finish, and confirm the *Promoted to mature* / *Now relearning* lists render when either applies. Without a provider, skip this step: the runner is covered by tests and the build passed.

- [ ] **Step 7: Commit**

```bash
git add app/sessions
git commit -m "Show the reflection turn, the badge after grading, and what the session did to the ladder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The concept view

**Files:**
- Create: `lib/concepts.ts`, `lib/concepts.test.ts`, `app/lectures/[id]/concepts/page.tsx`
- Modify: `app/lectures/page.tsx`, `app/dashboard/page.tsx`

**Interfaces:**
- Produces: `lectureConcepts(lectureId: number, today?: string): Promise<LectureConcepts | null>` with `LectureConcepts { id; title; committedAt: Date | null; objectives: { id; text; suspended; items: ConceptRow[] }[] }` and `ConceptRow { id; concept; kind; provenance; tier; intervalDays; lapses; streak; lastRating; dueOn; dueIn }`.

- [ ] **Step 1: Write the failing test**

Create `lib/concepts.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-concepts-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("./db");
const { commitLecture } = await import("./commitLecture");
const { lectureConcepts } = await import("./concepts");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

const TODAY = "2026-09-04";

const draft = {
  title: "Amyloidosis",
  learningObjectives: [
    { text: "Describe the structure of amyloid fibrils.", slideRefs: [2] },
    { text: "Compare AL and ATTR amyloidosis.", slideRefs: [5] },
  ],
  concepts: [
    {
      label: "Beta-pleated sheet",
      detail: "Cross-beta conformation.",
      kind: "fact" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [0],
    },
    {
      label: "Congo red",
      detail: "Apple-green birefringence.",
      kind: "fact" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [0],
    },
    {
      label: "AL vs ATTR precursor",
      detail: "Light chains versus transthyretin.",
      kind: "mechanism" as const,
      provenance: "supplemental" as const,
      relatedObjectiveIndexes: [1],
    },
  ],
  commonConfusions: [],
  conflicts: [],
};

let lectureId: number;
let draftId: number;

beforeAll(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: draft.title, draftExtract: draft })
    .returning({ id: schema.lectures.id });
  lectureId = lecture.id;
  await commitLecture(lectureId, [
    { draftIndex: 0, text: draft.learningObjectives[0].text },
    { draftIndex: 1, text: draft.learningObjectives[1].text },
  ]);

  const [uncommitted] = await db
    .insert(schema.lectures)
    .values({ title: "Draft only", draftExtract: draft })
    .returning({ id: schema.lectures.id });
  draftId = uncommitted.id;

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
    orderBy: [schema.learningObjectives.orderIndex],
  });
  await db
    .update(schema.learningObjectives)
    .set({ suspended: true })
    .where(eq(schema.learningObjectives.id, objectives[1].id));

  const items = await db.query.reviewItems.findMany({
    orderBy: [schema.reviewItems.id],
  });
  // Overdue and mature; due tomorrow and relearning; the third untouched.
  await db
    .update(schema.reviewItems)
    .set({ dueOn: "2026-09-01", intervalDays: 14, lapses: 0, streak: 4, lastRating: "green" })
    .where(eq(schema.reviewItems.id, items[0].id));
  await db
    .update(schema.reviewItems)
    .set({ dueOn: "2026-09-05", intervalDays: 1, lapses: 2, streak: 0, lastRating: "red" })
    .where(eq(schema.reviewItems.id, items[1].id));
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

test("lists every objective in order with its items, suspended ones included", async () => {
  const view = await lectureConcepts(lectureId, TODAY);

  expect(view?.title).toBe("Amyloidosis");
  expect(view?.committedAt).not.toBeNull();
  expect(view?.objectives.map((o) => o.text)).toEqual([
    "Describe the structure of amyloid fibrils.",
    "Compare AL and ATTR amyloidosis.",
  ]);
  expect(view?.objectives[1].suspended).toBe(true);
  expect(view?.objectives[0].items).toHaveLength(2);
  expect(view?.objectives[1].items).toHaveLength(1);
  expect(view?.objectives[1].items[0].provenance).toBe("supplemental");
});

test("each item carries its state, its tier, and a signed days-until-due", async () => {
  const view = await lectureConcepts(lectureId, TODAY);
  const [overdue, tomorrow] = view!.objectives[0].items;

  expect(overdue).toMatchObject({
    concept: "Beta-pleated sheet — Cross-beta conformation.",
    kind: "fact",
    tier: "mature",
    intervalDays: 14,
    lapses: 0,
    streak: 4,
    lastRating: "green",
    dueOn: "2026-09-01",
    dueIn: -3,
  });
  expect(tomorrow).toMatchObject({ tier: "relearning", lapses: 2, dueIn: 1 });

  const untouched = view!.objectives[1].items[0];
  expect(untouched.tier).toBe("new");
  expect(untouched.dueIn).toBeGreaterThanOrEqual(0);
});

test("an uncommitted lecture has no objectives yet", async () => {
  const view = await lectureConcepts(draftId, TODAY);
  expect(view?.committedAt).toBeNull();
  expect(view?.objectives).toEqual([]);
});

test("an unknown lecture is null", async () => {
  expect(await lectureConcepts(9_999, TODAY)).toBeNull();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test lib/concepts.test.ts`
Expected: FAIL — `./concepts` not found.

- [ ] **Step 3: Create `lib/concepts.ts`**

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Provenance, Rating, ReviewKind } from "@/lib/db/schema";
import { daysBetween, tierOf, todayIso, type Tier } from "@/lib/schedule";

export interface ConceptRow {
  id: number;
  concept: string;
  kind: ReviewKind;
  provenance: Provenance;
  tier: Tier;
  intervalDays: number;
  lapses: number;
  streak: number;
  lastRating: Rating | null;
  dueOn: string;
  /** Days until due; negative when overdue. */
  dueIn: number;
}

export interface ObjectiveConcepts {
  id: number;
  text: string;
  suspended: boolean;
  items: ConceptRow[];
}

export interface LectureConcepts {
  id: number;
  title: string;
  committedAt: Date | null;
  objectives: ObjectiveConcepts[];
}

/**
 * A lecture's objectives and the review items under each, with the state the
 * scheduler works from. The first surface that shows review items at all;
 * read-only, and never a dashboard row.
 */
export async function lectureConcepts(
  lectureId: number,
  today: string = todayIso(),
): Promise<LectureConcepts | null> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });
  if (!lecture) return null;

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
    orderBy: [asc(schema.learningObjectives.orderIndex)],
  });

  const items =
    objectives.length === 0
      ? []
      : await db.query.reviewItems.findMany({
          where: inArray(
            schema.reviewItems.loId,
            objectives.map((objective) => objective.id),
          ),
          orderBy: [asc(schema.reviewItems.id)],
        });

  const itemsByLo = new Map<number, ConceptRow[]>();
  for (const item of items) {
    const rows = itemsByLo.get(item.loId) ?? [];
    rows.push({
      id: item.id,
      concept: item.concept,
      kind: item.kind,
      provenance: item.provenance,
      tier: tierOf(item),
      intervalDays: item.intervalDays,
      lapses: item.lapses,
      streak: item.streak,
      lastRating: item.lastRating,
      dueOn: item.dueOn,
      dueIn: daysBetween(today, item.dueOn),
    });
    itemsByLo.set(item.loId, rows);
  }

  return {
    id: lecture.id,
    title: lecture.title,
    committedAt: lecture.committedAt,
    objectives: objectives.map((objective) => ({
      id: objective.id,
      text: objective.text,
      suspended: objective.suspended,
      items: itemsByLo.get(objective.id) ?? [],
    })),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test lib/concepts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the page**

Read `node_modules/next/dist/docs/` on dynamic route params first. Create `app/lectures/[id]/concepts/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Rating } from "@/lib/db/schema";
import { lectureConcepts, type ConceptRow } from "@/lib/concepts";

export const dynamic = "force-dynamic";

const SWATCH: Record<Rating, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
  suspended: "bg-emerald-900",
};

function dueLabel(dueIn: number): string {
  if (dueIn < 0) return `overdue ${-dueIn}d`;
  if (dueIn === 0) return "due today";
  return `due in ${dueIn}d`;
}

export default async function ConceptsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lectureId = Number(id);
  if (!Number.isInteger(lectureId)) notFound();

  const view = await lectureConcepts(lectureId);
  if (!view) notFound();

  if (!view.committedAt) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          Nothing to show until the objectives are committed.{" "}
          <Link href={`/lectures/${view.id}/review`} className="underline">
            Review the draft
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
      <p className="mt-1 text-sm text-stone-500">
        Every concept the scheduler tracks under each objective, and where it stands.
      </p>

      {view.objectives.map((objective) => (
        <section key={objective.id} className="mt-8">
          <h2
            className={`text-base font-medium ${
              objective.suspended ? "text-stone-400 dark:text-stone-600" : ""
            }`}
          >
            {objective.suspended && (
              <span
                title="Suspended — not quizzed until reactivated"
                className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${SWATCH.suspended} align-middle`}
              />
            )}
            {objective.text}
            {objective.suspended && (
              <span className="ml-2 text-xs font-normal text-stone-400">not in play</span>
            )}
          </h2>

          {objective.items.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">No concepts were extracted for this objective.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500">
                    <th className="px-3 py-2 font-medium">Concept</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Last</th>
                    <th className="px-3 py-2 font-medium">Interval</th>
                    <th className="px-3 py-2 font-medium">Lapses / streak</th>
                    <th className="px-3 py-2 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {objective.items.map((item) => (
                    <ConceptLine key={item.id} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function ConceptLine({ item }: { item: ConceptRow }) {
  return (
    <tr className="border-t border-stone-200 dark:border-stone-800">
      <td className="px-3 py-2">
        {item.concept}
        {item.provenance !== "taught" && (
          <span className="ml-2 text-xs text-stone-400">{item.provenance}</span>
        )}
      </td>
      <td className="px-3 py-2 text-stone-500">{item.kind}</td>
      <td className="px-3 py-2">{item.tier}</td>
      <td className="px-3 py-2">
        {item.lastRating ? (
          <span
            title={item.lastRating}
            className={`inline-block h-4 w-4 rounded-sm ${SWATCH[item.lastRating]}`}
          />
        ) : (
          <span className="text-stone-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-stone-500">{item.intervalDays}d</td>
      <td className="px-3 py-2 text-stone-500">
        {item.lapses} / {item.streak}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {item.dueOn}{" "}
        <span className={item.dueIn < 0 ? "text-red-600 dark:text-red-400" : "text-stone-500"}>
          ({dueLabel(item.dueIn)})
        </span>
      </td>
    </tr>
  );
}
```

- [ ] **Step 6: Link from the lecture list and the dashboard**

In `app/lectures/page.tsx`, replace the committed-title branch:

```tsx
                  {lecture.committedAt ? (
                    <Link
                      href={`/lectures/${lecture.id}/concepts`}
                      className="font-medium hover:underline"
                    >
                      {lecture.title}
                    </Link>
                  ) : (
```

In `app/dashboard/page.tsx`, the lecture label above each objective becomes a link:

```tsx
                    <Link
                      href={`/lectures/${objective.lectureId}/concepts`}
                      className="block text-[10px] uppercase tracking-wide text-stone-400 hover:underline"
                    >
                      {lectureTitleById.get(objective.lectureId)}
                    </Link>
```

(`Link` is already imported there.)

- [ ] **Step 7: Typecheck, test, build**

Run: `bun test && bun run typecheck`
Expected: all green.

Run: `bun --bun run build`
Expected: builds, listing `/lectures/[id]/concepts`.

- [ ] **Step 8: Commit**

```bash
git add lib/concepts.ts lib/concepts.test.ts "app/lectures/[id]/concepts/page.tsx" app/lectures/page.tsx app/dashboard/page.tsx
git commit -m "Add a read-only concept view under each lecture

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: README

**Files:**
- Modify: `README.md` (the "Choosing a model" table, "Status", "Layout")

- [ ] **Step 1: Update the tutor row**

In the roles table, change `Quiz and grading loop (Phases 2–3)` to `Quiz and grading loop (Phases 2–4)`.

- [ ] **Step 2: Add the Phase 4 status**

After the Phase 3 paragraph in **Status**, add:

```markdown
**Phase 4 (history-aware scheduling and adaptive difficulty) is implemented.**

The scheduler reads an item's history, not only its latest colour. An item
that has ever lapsed climbs a ladder with twice the rungs; yellow halves the
interval within a 1–3 day band; and every item carries a mastery tier — new,
relearning, consolidating, mature — that takes three greens in a row and a
fortnight's interval to reach. The tier steers how demanding the next
question is, and each question also carries what was missed last time. Every
session closes with an ungraded reflection turn — the student's own account,
which the debrief compares with the graded record. Why a question was shaped
as it was is shown after grading, never before; a read-only concept view
under each lecture shows where every item stands.
```

- [ ] **Step 3: Update the layout listing**

Add these lines in their sorted positions:

```
  lectures/[id]/concepts/   every review item under a lecture, and where it stands
```

under `app/`, and under `lib/`:

```
  concepts.ts               a lecture's objectives and review items, with tier and due state
  schedule.ts               the ladders, the yellow band, the hint cap, worst-of-day, the tier
  session/prior.ts          the last graded attempt on each planned item
```

(replace the existing `schedule.ts` line).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document Phase 4 as implemented in README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `bun test` — every file green.
- [ ] `bun run typecheck` — clean.
- [ ] `bun --bun run build` — builds.
- [ ] `git log --oneline main..phase-4` — thirteen commits, one per task.
- [ ] Then hand over with `superpowers:finishing-a-development-branch`.
