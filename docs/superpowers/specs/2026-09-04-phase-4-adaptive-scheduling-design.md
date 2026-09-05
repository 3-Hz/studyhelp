# Phase 4 — History-aware scheduling and adaptive difficulty

Date: 2026-09-04
Status: approved, ready for an implementation plan

## Goal

Make the loop learn from its own history, per `prompt.txt` "Spaced-Repetition
Scheduling", "Adaptive Difficulty", and the Feedback rule that a correction
must "target the missing component". Three things are missing today:

- **The scheduler ignores depth.** Red resets an item to 1 day and yellow to
  2, so red and yellow do return sooner — but an item with four lapses climbs
  1 → 3 → 7 → 14 at the same pace as a fresh one. `lapses` is written on every
  red and read only by selection. Nothing in the code has a notion of mastery,
  so "never mark an LO mastered after one correct response" has no code
  behind it.
- **Difficulty never follows maturity.** The only steer is a one-line bucket
  hint. An item on a 60-day interval gets the same kind of question as one on
  day 1, where the prompt wants application and discrimination "rather than
  identical wording".
- **Misses don't carry forward.** Grading produces `missing`, `incorrect` and
  `correction`, stored in `attempts.feedback` and read back only for the
  debrief. The next question about that item is asked blind.

Scoped in alongside: a badge on each daily turn saying why the question is
shaped as it is, a code-owned record of what each session did to each item,
and a read-only per-lecture concept view — the first surface that shows review
items at all.

## What already exists

- `review_items` carries `intervalDays`, `lapses`, `lastRating`, `dueOn`. Add
  one counter and the mastery state is complete.
- `lib/schedule.ts`: `LADDER`, `nextInterval`, `nextSchedule`, `capRating`.
  The scheduler is already a pure state transition; it stays one.
- `select.ts` assigns each slot a format family by review **kind** (fact,
  mechanism, application) and narrows it for variety. Formats already carry
  one policy; they should not carry a second.
- `PlannedSlot` is frozen on `sessions.plan` at start. A per-slot field added
  there is reproducible and explainable afterward, like `bucket` is now.
- `attempts.feedback` holds the full grade JSON for every graded turn, keyed
  by `reviewItemId` (daily) or `loId` (same-day). The history to carry forward
  is already stored; nothing reads it at ask time.
- `BUCKET_HINT` in `lib/tutor/index.ts` — replaced, not extended.

## Scheduler — `lib/schedule.ts`

### State

One new column, `review_items.streak`: consecutive greens, reset to 0 by red
or yellow. With `intervalDays`, `lapses` and `lastRating`, that is the whole
state.

### Transitions

`nextSchedule(state, rating, today)` keeps its signature; `ScheduleState` and
`ScheduleResult` gain `streak`.

| Rating | Interval | `lapses` | `streak` |
|---|---|---|---|
| green | the next rung above the current interval — on `LADDER` if the item has never lapsed, on `LAPSED_LADDER` if it has; doubling past the top of either | — | +1 |
| yellow | `clamp(floor(interval / 2), 1, 3)` | — | 0 |
| red | 1 | +1 | 0 |
| suspended | unchanged, as now | — | — |

```ts
export const LADDER        = [0, 1, 3, 7, 14, 30, 60] as const;
export const LAPSED_LADDER = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60] as const;
```

`nextInterval(intervalDays, lapses)` picks the ladder. An item that has ever
lapsed climbs a ladder with twice the rungs: slower recovery, never a leech
penalty. Lapses are permanent — "review the full history, not only the latest
colour" — and the cost is a 2× slowdown, nothing steeper.

Yellow halves the interval, held within the prompt's 1–3 day band: a mature
item that was merely incomplete comes back in 3 days, a fragile one tomorrow.
Intervals 0–3 → 1, 4–5 → 2, 6 and above → 3.

### Tier

A pure function of the four fields:

```ts
export type Tier = "new" | "relearning" | "consolidating" | "mature";

export function tierOf(state: {
  lastRating: Rating | null;
  lapses: number;
  streak: number;
  intervalDays: number;
}): Tier;
```

- `new` — `lastRating` is null.
- `relearning` — `lastRating` is red or yellow.
- `mature` — `streak >= 3` and `intervalDays >= 14`.
- `consolidating` — everything else.

A `lastRating` of `suspended` cannot occur (the grade schema forbids it) but
the type allows it; treat it as the green path.

From new, 0 → 1 → 3 → 7 is three greens and still consolidating; the fourth
green reaches 14 and mature. After a lapse at 14, six greens on the lapsed
ladder (1 → 2 → 3 → 5 → 7 → 10 → 14) get back. No single rating produces
mature, by construction.

It is *relearning*, not *weak*: `select.ts` already has a `weak` bucket with a
broader meaning that includes the objective's dashboard history. Selection's
definitions do not change. Bucket says why an item was chosen; tier says how
to treat it.

## Difficulty — `lib/tutor`, `lib/session/daily.ts`, `select.ts`

### Where the tier lives

`Candidate` gains `streak`. `select()` computes `tierOf` for each pick and
writes it on the `PlannedSlot` as `tier`. The plan is frozen at start and the
item row does not change until finish, so the slot's tier is true for the
whole sitting. `dailyKind.planNext` passes it through `PlannedTurn`; a stored
plan without `tier` (a session left open from before the migration) yields
`undefined`, and the brief is omitted.

### The brief

`TurnContext` gains `tier?: Tier`. `BUCKET_HINT` is removed and `TIER_BRIEF`
replaces it, one line each, from the prompt's Adaptive Difficulty section:

- `new` and `relearning` — ask a focused question about one part of the
  concept; let the student work in steps; do not combine it with other
  material.
- `consolidating` — ask for the whole concept, unscaffolded; nothing in the
  wording should narrow it.
- `mature` — test it through application or discrimination in a context the
  lecture did not use; combine it with the related concepts listed; where
  plausible alternatives exist, ask why the wrong ones are wrong.

`bucket` stays on `PlannedTurn` and `TurnContext` for the badge; the prompt no
longer mentions it.

Formats stay governed by kind and the variety rule. Kind decides the shape —
a fact item cannot become a vignette — and tier decides the demand. Putting
both on the format enum would fight `FORMAT_FAMILY`. How demanding a question
is, within a shape, is one place the model's judgement is the point: code sets
the tier, the model shapes the question to it.

### Cues

The hint button stays on every turn (Retrieval Rule 2 applies at every
maturity). A cue on a mature item already caps the rating at yellow, which
resets the streak. The demotion needs no new mechanism.

### Carrying the last miss forward

`dailyKind.loadMaterial` also loads, for each planned item, its most recent
graded attempt (`rating` not null) outside this session: by `reviewItemId` if
the item has been asked directly; otherwise by `loId` for a same-day turn,
which was the item's first exposure and whose misses are the most relevant
thing for the first daily review. Two queries for the whole plan, folded to
the latest per item in TypeScript.

`TurnContext` gains:

```ts
lastAttempt?: {
  daysAgo: number;
  rating: Rating;
  hintsUsed: boolean;
  missing: string[];
  incorrect: string[];
  correction: string;
  /** True when the attempt graded the whole objective, not this concept. */
  aboutObjective: boolean;
};
```

`askQuestion` renders it as a short block — what was missed, what was wrong,
the correction given — and a steer that depends on tier: relearning targets
what was missed; consolidating and mature test the same point through a
different route rather than repeating the wording. Derived from `attempts` at
load time rather than copied onto the item row: one source of truth, nothing
to keep in sync.

Same-day sessions are untouched. Every item is new, the stages are fixed, and
there is no earlier attempt to carry.

## Badge and outcomes — `runner.ts`, `SessionTurn.tsx`

### Badge

`Turn` gains an optional `why`, present on daily turns only:

```ts
why?: {
  bucket: Bucket;
  tier: Tier;
  lapses: number;
  streak: number;
  intervalDays: number;
  dueOn: string;
};
```

Read from the slot and the live item row. `SessionTurn` renders one muted
line under the stage label:

> Due for review · relearning · lapsed 2× · was on a 3-day interval · due
> since Sep 1

Bucket labels: due → *Due for review*, recent → *Recent material*, weak →
*Weak spot*, interleaved → *Cumulative*, fill → *Extra practice*. The lapses
and streak parts are omitted when zero; *due since* becomes *due today* or
*not yet due* as the date warrants.

### Outcomes

`finishSession` already walks every item that moves. It now records what
happened in a new nullable `sessions.outcomes` JSON column, written alongside
`endedAt`:

```ts
type Outcome = {
  reviewItemId: number;
  concept: string;
  rating: Rating;
  tierBefore: Tier;
  tierAfter: Tier;
  dueOn: string;
};
```

Computed for both session kinds at the runner level — the code-owned half of
the close-out, next to the model-owned debrief. `SessionResult` gains
`outcomes`, so the completion response and the reloaded page show the same
thing.

Only the daily completion screen renders it, as two short lists: *Promoted to
mature* (`tierAfter` mature, `tierBefore` not) and *Now relearning*
(`tierAfter` relearning). A same-day session moves every item under every
objective it touched; listing thirty concepts there would be noise.

The concept text is snapshotted in the JSON on purpose: it is the concept as
asked, and the session page needs no join to render a finished session.

## Concept view — `lib/concepts.ts`, `app/lectures/[id]/concepts/page.tsx`

### Data

`lectureConcepts(lectureId, today)`: the lecture; its objectives in order with
`text` and `suspended`; under each, its review items with `concept`, `kind`,
`provenance`, `tier`, `intervalDays`, `lapses`, `streak`, `lastRating`,
`dueOn`, and `dueIn = daysBetween(today, dueOn)` — negative when overdue, so
the page can say *overdue 3d* or *due in 5d*. Same pattern as
`lib/lectures.ts`: the read lives in `lib`, the page is thin, and the
function is what the test exercises.

### Page

Server component, `force-dynamic` like the dashboard. A heading with the
lecture title, then one block per objective: the objective text, greyed with
the suspended marker when suspended, matching the dashboard; and a table of
its items — concept, kind, tier, last rating as a colour swatch, interval,
lapses / streak, due. Items under a suspended objective still show their
state, marked as not in play. A lecture that is not committed gets a one-line
message and a link to the review screen instead of the table. Read-only.

### Links

On the lecture list, a committed lecture's title — plain text today — links
to its concept page. On the dashboard, the lecture label above each objective
links there too. Nothing in the top bar: this is a drill-down, not a screen.

## Schema

Two columns, one migration (`0005`, generated with `bun run db:generate` and
then edited to add the backfill, as `0003` was):

- `review_items.streak integer not null default 0`
- `sessions.outcomes text` — JSON, nullable

### Backfill

Existing items have climbed the ladder one rung per green from 0, so for an
item with `last_rating = 'green'` and `lapses = 0` the ladder position is the
streak: interval 1 → 1, 3 → 2, 7 → 3, 14 → 4, 30 → 5, 60 and above → 6.
Without this every existing item would sit in `consolidating` for three more
greens — months, at the upper rungs — for no reason.

One imprecision: an item at interval 3 may have got there by yellow → green
(streak 1) rather than green → green (streak 2). The backfill assumes the
latter; the tier does not care at that rung. Lapsed items stay at 0 — their
history is not recoverable, and they cannot be mature yet in any case.

## Testing

- `schedule.test.ts` — `LAPSED_LADDER` climbing and doubling past the top;
  each transition's effect on interval, lapses and streak; the yellow band at
  its edges; `tierOf` as a table; trajectory replays: "the fourth green from
  new is mature at 14d", "a lapse at 14 takes six greens to return", "no
  single rating produces mature".
- `select.test.ts` — slots carry the tier.
- `tutor.test.ts` — the tier brief and the last-attempt block reach the
  prompt; `BUCKET_HINT`'s old strings do not.
- `daily.test.ts` — the turn carries `why`; two sessions on consecutive days,
  the second's `askQuestion` receiving `lastAttempt` from the first; a
  same-day session's misses reaching the item's first daily review through
  the `loId` fallback; `finishSession` writing `outcomes` with the right
  before and after tiers.
- `sameDay.test.ts` — finish writes `streak` and `outcomes`.
- `concepts.test.ts` — `lectureConcepts` shape, the sign of `dueIn`,
  suspended objectives still listed, an uncommitted lecture handled.
- A migration test — applies the SQL files through `0004` directly, seeds
  items at each rung, applies `0005`, asserts the streaks. The first backfill
  test in the repo; `0003`'s went untested.

## Out of scope

- Same-session revisit on red. The daily plan is frozen at start; Phase 3
  chose that deliberately, and reopening it buys little.
- Confidence ratings and calibration. Still a widget on every turn and weeks
  of data before it says anything.
- Per-item suspension. The concept view is the surface it was waiting on;
  decide after using the view.
- Tier-driven selection. `select.ts` keeps its own `weakness` and `isWeak`.
- Format narrowing by tier.
- Lapse decay.

## Build order

1. `streak` on `ScheduleState`, `LAPSED_LADDER`, the yellow band, `tierOf`,
   and the trajectory tests. Pure; nothing else moves yet.
2. The migration with its backfill, and the migration test.
3. `runner.finishSession` writes `streak` and `outcomes`; `SessionResult`
   gains `outcomes`. `sameDay.test.ts` and `daily.test.ts` green.
4. `Candidate.streak`, `PlannedSlot.tier`, and the slot test.
5. `TurnContext.tier`, `TIER_BRIEF` replacing `BUCKET_HINT`, the tutor test.
6. `lastAttempt`: the two queries in `loadMaterial`, the prompt block, the
   two-session test and the `loId` fallback test.
7. `Turn.why` and the badge; the outcomes lists on the daily completion
   screen.
8. `lib/concepts.ts` and its test; the page; the two links.
9. README: the Status section and the layout listing.
