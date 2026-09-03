# Phase 3 — Daily interleaved retrieval practice

Date: 2026-09-03
Status: approved, ready for an implementation plan

## Goal

A daily 10-question session drawn from every committed lecture, selected
adaptively rather than randomly, per `prompt.txt` "Daily Anki-Like Retrieval
Practice". It is the first thing in the project to *read* the spaced-repetition
scheduler: Phase 2 writes `review_items` due dates that nothing has ever
consumed.

Scoped in alongside it: a top-bar restructure, and a way to suspend an
objective — which matters now that the candidate pool is everything ever
committed rather than one lecture.

## What already exists

- `sessions.type` accepts `"daily"`; nothing writes it.
- `attempts.reviewItemId` and a nullable `attempts.loId` and
  `sessions.lectureId` — hooks Phase 2 left in place.
- `QUESTION_FORMATS`, twelve of them, so format variety can be enforced by
  counting rather than by asking the model to remember.
- `lib/schedule.ts`: the ladder, `capRating`, `worstRating`.

## Architecture

`lib/session/runner.ts` owns what both session flavours do identically: load
the session and its attempts, return the pending question or generate one,
grade through `capRating`, issue a cue and mark the attempt hinted, write the
day, end the session. It knows nothing about lectures or selection.

A `SessionKind` strategy supplies the four things that differ:

```ts
interface SessionKind {
  /** LOs, concepts and lecture titles this session can draw on. */
  loadMaterial(session): Promise<Material>;
  /** The next thing to ask, or null when the session is done. */
  planNext(session, material, attempts): PlannedTurn | null;
  /** What the tutor sees when asking, grading or cueing this turn. */
  turnContext(attempt, material): TurnContext;
  /** Which review items move, and on what rating. */
  itemOutcomes(attempts): Map<number, Rating>;
  /** Optional close-out work. Daily writes a debrief here. */
  closeOut?(session, attempts): Promise<unknown>;
}
```

| | Same-day | Daily |
|---|---|---|
| `loadMaterial` | one lecture's LOs and concepts | the LOs, concepts and lecture titles behind the session's planned items |
| `planNext` | `plan.ts`: recall → summary → elaborate | walk the frozen 10-slot plan |
| `turnContext` | lecture title, one LO's concepts | the item's concept, LO and lecture, plus companions on cumulative slots |
| `itemOutcomes` | every item under a tested LO, on that LO's worst rating | only the item asked, on its own rating |

Layout:

```
lib/session/
  runner.ts    shared turn/answer/hint/finish and the day writer
  kind.ts      the SessionKind interface
  sameDay.ts   strategy; keeps startSameDaySession
  daily.ts     strategy; adds startDailySession
  plan.ts      unchanged
  select.ts    new, pure: candidates in, an ordered plan out
```

`sameDay.ts` shrinks to a strategy. Its public functions move to `runner.ts`,
and the four `/api/sessions/[id]/*` routes stop caring which flavour they drive.

### Schema

Two nullable columns on `sessions`, one migration:

- `plan` (json) — the chosen slots, written once at session start.
- `debrief` (json) — the close-out summary.

The plan is frozen rather than re-derived because it depends on the whole
corpus at start time. Freezing it keeps reloads, tie-breaks and a "4 of 10"
counter stable, and makes the session's reasoning inspectable afterwards.

Adding `"daily"` to `SESSION_STAGES` needs no DDL: drizzle's `text({enum})`
emits plain `text` in SQLite (`drizzle/0001_low_husk.sql:4`), so the enum
constrains TypeScript only.

## Selection — `lib/session/select.ts`

Pure. No database, no clock, no randomness; ties break on review-item id, so a
test can assert an exact plan.

```ts
select(candidates: Candidate[], opts: { today: string; size?: number }): PlannedSlot[]
```

A `Candidate` is one review item flattened with what ranking needs:
`reviewItemId`, `loId`, `lectureId`, `block`, `kind`, `dueOn`, `intervalDays`,
`lapses`, `lastRating`, the LO's `suspended` flag, its lecture's commit date,
and the LO's dashboard colours oldest to newest. Suspended LOs are dropped
first.

### Weakness

```
weakness = 2·lapses
         + (lastRating: red 3, yellow 1, green 0, never answered 0)
         + the LO's last three colours, red 2 and yellow 1 each
```

This is "review the full LO history, not only the latest color" as arithmetic.
Three reds and then a green still scores 6: one good day does not erase the
record.

### Buckets

Filled in priority order, each drawing only from what earlier buckets left.

| # | Bucket | Pool | Ranked by |
|---|---|---|---|
| 1 | due (4) | `dueOn <= today` | most overdue, then weakness |
| 2 | weak (2) | red or yellow last rating, or `lapses > 0`, or red/yellow among the last three colours — due or not | weakness |
| 3 | recent (2) | lecture committed within `RECENT_DAYS` (7) | never answered first, then newest lecture |
| 4 | interleaved (2) | a lecture not yet represented in this session | same block as the session's modal block first, then the LO with the longest colour history, then the longest interval |

An underfilled bucket hands its slots to the next. A shortfall after bucket 4
draws from everything left, ranked most overdue then weakest. A null `block` on
either side counts as no match, not as a match.

### Constraints

Applied while filling, relaxed only when the pool cannot satisfy them:

- No two items from one LO.
- At most three from one lecture.

Without these, a lecture committed yesterday with forty concepts takes the
whole session.

### Running order

Decided after selection, not during it. The two interleaved slots sit at
positions 5 and 10, where a cumulative question has material behind it. The
rest are arranged to avoid consecutive questions from the same lecture or the
same `kind`. A plan shorter than ten slots puts its interleaved slots last
instead.

### Formats

Each slot carries a format family, fixed at plan time by the item's kind:

| Kind | Family |
|---|---|
| fact | `free_recall`, `short_answer`, `error_correction` |
| mechanism | `mechanism`, `pathway`, `consequence` |
| application | `vignette`, `patient_teaching`, `discrimination` |
| cumulative slots (5 and 10) | `synthesis`, `comparison`, `discrimination` |

The allowed set is narrowed at ask time, when the session's history is known:
drop any format already used twice, and the one used on the previous question.
If narrowing empties the set, fall back to the whole family — a repeat beats no
question.

Enforcement happens in the schema, not the prompt: `QuestionOutput` is built
per slot with `z.enum(allowed)`, so `generateStructured`'s existing validation
and repair retries do the work. Today `usedFormats` is only a suggestion in the
prompt text (`lib/tutor/index.ts:63`), which is the kind of rule the model
should not be able to talk itself out of.

### Degenerate corpora

Fewer than ten eligible items: the session runs as long as the pool allows and
says so. Zero: it cannot start, and `/practice` explains whether nothing is
committed or everything is suspended.

## Session flow

`startDailySession(now)` rejoins today's unfinished daily session if there is
one. Otherwise it builds candidates, runs `select`, and inserts the session with
its plan.

A second session on a day whose first already finished is allowed. Extra
practice is never wrong, and items answered this morning are no longer due, so
selection reaches past them on its own.

The runner then drives it: a pending attempt is returned as is; otherwise the
next unanswered slot is asked and persisted — `stage: "daily"`, with both
`loId` and `reviewItemId` set — before the question is returned, so a reload
shows the same question. Answering and cueing are unchanged from Phase 2.

Finishing writes the day, reschedules only the items actually asked on their
own ratings, generates the debrief, and ends the session. A failed debrief call
does not fail the finish: the cells and the schedule matter, the summary does
not.

## The cell merge

`finishSession` currently writes today's cell with `onConflictDoUpdate` set to
*this session's* worst rating (`lib/session/sameDay.ts:343`). Once two sessions
can run on one date, the second to finish overwrites the first — a red morning
erased by a green afternoon.

The shared day writer merges instead: the cell becomes
`worstRating([existing, todays])`. A green after a red is recall of a
correction already given, whether or not a session boundary falls between them.

`lib/schedule.ts` gains `daysBetween(from, to)`, which selection needs for
overdueness and which the ladder arithmetic has so far done without.

## Tutor changes

All additive:

- `TurnContext` gains `allowedFormats`, and `lectureTitle` becomes per turn
  rather than per session, since a daily session spans lectures. Cumulative
  slots also carry companion concepts and their lecture names.
- A `daily` entry in `STAGE_BRIEF`, told why the item was picked — due, weak,
  recent, cumulative — so an overdue item gets a different question from a
  brand-new one.
- `summariseSession`, returning `DebriefOutput`: `heldUp[]`, `shaky[]`,
  `misconceptions[]`, `focusNext`. Short arrays, same frozen `TUTOR_SYSTEM`
  prefix.

## UI

```
[Review Lectures] [Daily Practice] [Dashboard] [Import Content]        studyhelp
```

Tabs left, app name right. The active tab gets an underline and heavier weight;
today's colour-only shift is nearly invisible in dark mode.

Routes move: `app/page.tsx` to `app/lectures/page.tsx`, `app/lectures/new` to
`app/import`, and `/` redirects to `/practice`. `/lectures/[id]/review` keeps
Review Lectures lit, and `/import` no longer shares a prefix with it, so no two
tabs light at once.

`/practice` shows what today holds — items due, the objectives and lectures
they span, any session already finished today — and a Start or Resume button,
or an explanation when the pool is empty.

The session page drops its `lectureId !== null` guard
(`app/sessions/[id]/page.tsx:21`), shows "Question 4 of 10", and names the
lecture per question, since it changes. The completion screen shows the colour
tally, the debrief, and how many cells were written.

The dashboard gains a suspend and reactivate control per row, backed by
`POST /api/objectives/[id]/suspend`.

**Suspension is a row state, not a cell.** `prompt.txt` lists dark green among
the cell colours, but writing a suspended cell would claim the objective was
tested that day. The row is marked instead; historical cells keep their
colours; `RATINGS` keeps `"suspended"` for compatibility. A suspended objective
leaves the daily candidate pool and the same-day plan, which already respects
the flag (`lib/session/plan.ts:43`).

## Testing

- `select.test.ts` — table-driven against the pure function: each bucket,
  spillover, the LO and lecture caps, ordering, format narrowing, a
  three-item corpus, an all-suspended corpus.
- `daily.test.ts` — the existing harness of a per-file temp SQLite database,
  `migrate`, and a scripted stub tutor. Start, ten turns, finish; assert cells,
  per-item schedules, and that formats never repeat consecutively or more than
  twice.
- A regression test running a same-day and a daily session on one date,
  asserting the cell holds the worst of both.
- `sameDay.test.ts` passes unchanged through the refactor, which is the whole
  safety net for extracting the runner; it runs green before `daily.ts` is
  written. One test changes earlier, in the merge step: "studying twice in one
  day updates the cell rather than duplicating it" asserts green after a red
  session and a green one, which is the bug stated as an expectation.

## Out of scope

- Confidence ratings and calibration. Needs a widget on every turn and weeks of
  data before it says anything.
- Per-concept suspension. No surface exists for browsing concepts.
- Recording one attempt against several review items or LOs.
- Editing a session's plan once started.

## Build order

1. `daysBetween`, and the cell merge with its regression test.
2. Extract `runner.ts` and `kind.ts`; `sameDay.ts` becomes a strategy;
   `sameDay.test.ts` green.
3. `select.ts` and its tests.
4. The migration adding `sessions.plan` and `sessions.debrief`.
5. `daily.ts`, `startDailySession`, the daily stage brief, the per-slot format
   schema, and `daily.test.ts`.
6. `summariseSession` and debrief storage.
7. Nav, route moves, the `/` redirect.
8. `/practice`.
9. Session page generalisation and the completion screen.
10. The suspend endpoint and the dashboard control.
