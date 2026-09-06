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

Scoped in alongside: a badge on each daily turn saying why the question was
shaped as it was, a code-owned record of what each session did to each item, a
read-only per-lecture concept view — the first surface that shows review items
at all — and a reflection turn closing every session.

The reflection turn comes from reviewing the design against *Make It Stick*
rather than against `prompt.txt`. The book treats reflection as retrieval the
learner does; today the debrief is the model summarising the student, and the
same-day session has no close at all. The badge is shown after grading for a
related reason: a judgement of learning handed over before the attempt is the
anchor the book's chapter on calibration wants removed.

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
- `dailyKind.closeOut` builds a `DebriefRequest` from graded attempts and
  calls `summariseSession`. Nothing in it is daily-specific; it moves to the
  runner and runs for both kinds.
- `SESSION_STAGES` is a type-level enum — no CHECK constraint in the
  migrations — so a new stage needs no migration.

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

`TurnFeedback` — the answer response — gains an optional `why`, present for
daily turns only:

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

Read from the slot and the live item row in `submitAnswer`. It rides on the
feedback, not the question, on purpose: *mature · was on a 60-day interval*
before the attempt is a judgement of learning handed to the student before
they make their own, and *relearning · lapsed 2×* is the same anchor in the
other direction. After grading, the same line explains why the question was
shaped as it was, which is all it is for. Nothing about the item is shown
before the answer — not even the bucket.

`SessionTurn` renders it as one muted line at the top of the feedback:

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

## Reflection — `runner.ts`, `plan.ts`, `daily.ts`, `lib/tutor`

Every session ends with one ungraded free-text turn before the debrief. It is
the student's account of the sitting, produced by the student: the book's
reflection, and the prompt's missing same-day close (key ideas, hardest point,
corrected misconception, remaining uncertainty).

### Stage

`SESSION_STAGES` gains `reflection`. The attempt has `loId` and
`reviewItemId` null, `format` `"reflection"`, and never a rating. `worstByLo`
and both `itemOutcomes` already skip attempts with no objective and no
rating, so it earns no cell and moves no item.

### Planning

Both kinds return the reflection turn once everything else is done and no
reflection attempt exists yet, and `null` after that: `planNextTurn` after
the last elaboration, `dailyKind.planNext` after the tenth item. The question
is fixed text owned by code, one per kind, so the turn costs no model call:

- Same-day: *Without looking back: what were the key ideas of this lecture,
  what was the hardest point, what misconception did you correct today, and
  what are you still unsure of?*
- Daily: *Before the summary: what was the hardest question today, what did
  you get wrong and what is the correction you would give yourself, and what
  are you still unsure of?*

`currentTurn` inserts it like any other attempt, skipping `askQuestion` when
the planned stage is `reflection`.

### Answering

`submitAnswer` on a reflection turn stores `studentAnswer` and returns
`null`: no grade, no feedback, no badge. The runner's notion of a pending
attempt changes from `rating === null` to `studentAnswer === null`. For graded
stages the two are equivalent — `submitAnswer` sets both in one update — and
for the reflection turn only the second is ever true. `requestHint` rejects a
reflection turn; the UI hides the hint button for it.

`dailyKind.progress` counts the reflection turn: `total` is `plan.length + 1`
and the reflection turn is the last position.

### Debrief

`closeOut` leaves `SessionKind`. `finishSession` builds the `DebriefRequest`
from the graded attempts — the code now in `dailyKind.closeOut` — adds
`reflection: string | null` from the reflection attempt, and calls
`summariseSession` for both kinds. The same-day session gets a debrief for
the first time; the completion screen already renders one when present.

`summariseSession` renders the reflection after the graded record as *The
student's own account of the session*, and `DebriefOutput` gains
`calibration: string` — where the student's account and the graded record
disagree, in one sentence; empty when they agree or no reflection was given.
The `Debrief` component shows it under `focusNext` when non-empty.

### UI

`SessionTurn` shows the reflection turn with the stage label *Reflection*, a
textarea, no hint button, and no rating. Submitting advances straight to the
completion state; there is no feedback screen between.

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

The `reflection` stage is a TypeScript enum member only. `attempts.stage` has
no CHECK constraint, so no migration.

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
  prompt; `BUCKET_HINT`'s old strings do not; the reflection reaches the
  debrief prompt and `calibration` comes back.
- `plan.test.ts` — the reflection turn follows the last elaboration and
  precedes `null`; a session with nothing to elaborate still gets one.
- `daily.test.ts` — the feedback carries `why` and the turn does not; two
  sessions on consecutive days, the second's `askQuestion` receiving
  `lastAttempt` from the first; a same-day session's misses reaching the
  item's first daily review through the `loId` fallback; the reflection turn
  is the eleventh, `askQuestion` is not called for it, submitting it returns
  `null`, and a hint on it is refused; `finishSession` writing `outcomes` with
  the right before and after tiers and passing the reflection to
  `summariseSession`.
- `sameDay.test.ts` — the reflection turn closes the session; finish writes
  `streak` and `outcomes`, and a debrief now exists.
- `concepts.test.ts` — `lectureConcepts` shape, the sign of `dueIn`,
  suspended objectives still listed, an uncommitted lecture handled.
- A migration test — applies the SQL files through `0004` directly, seeds
  items at each rung, applies `0005`, asserts the streaks. The first backfill
  test in the repo; `0003`'s went untested.

## Out of scope

- Same-session revisit on red. The daily plan is frozen at start; Phase 3
  chose that deliberately, and reopening it buys little.
- Confidence ratings per turn. Still a widget on every question and weeks of
  data before it says anything; the reflection turn is the first step toward
  calibration without one.
- Hiding the model answer after a green. It invites rereading, but it is a
  UI change with no bookkeeping behind it; Phase 5.
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
4. The debrief hoisted into the runner for both kinds; `closeOut` removed
   from `SessionKind`. `sameDay.test.ts` asserts a debrief.
5. The reflection stage: the pending predicate, the fixed questions, both
   `planNext`s, `submitAnswer` returning `null`, `requestHint` refusing,
   `progress`, the reflection in the debrief prompt, `calibration`.
6. `Candidate.streak`, `PlannedSlot.tier`, and the slot test.
7. `TurnContext.tier`, `TIER_BRIEF` replacing `BUCKET_HINT`, the tutor test.
8. `lastAttempt`: the two queries in `loadMaterial`, the prompt block, the
   two-session test and the `loId` fallback test.
9. `TurnFeedback.why` and the badge; the reflection turn and `calibration`
   in the UI; the outcomes lists on the daily completion screen.
10. `lib/concepts.ts` and its test; the page; the two links.
11. README: the Status section and the layout listing.
