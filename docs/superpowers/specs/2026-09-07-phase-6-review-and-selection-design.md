# Phase 6 — Review chosen lectures ad hoc; rank repetition by the ladder alone

Date: 2026-09-07
Status: implemented

## Context

Phase 5 aligned scores, budgets, the LO Map and question orders with
`new_prompt.txt`. Two parts of the study workflow still followed the old
prompt:

1. **Review Quiz Session.** The prompt quizzes "the LOs from today's
   lectures". The app ran one lecture per session from a per-row *Study*
   button and called it "same-day". The student wants to tick one or more
   committed lectures, any day, and review them in one first-order session
   sized by the minutes given.
2. **Repetition Quiz Session.** The prompt selects LOs "based on time since
   last review and performance history" and interleaves by switching
   lectures. `select()` still ran the old prompt's 4/2/2/2 buckets (due,
   weak, recent, interleaved) with carry, a fill pass and a block
   preference. None of that is in the new prompt or in *Make It Stick*.

## Decisions

- **Keep the concept ladder, drop the buckets.** Item-level expanding
  intervals are the book's Leitner model; the quotas are not. One ranking:
  most overdue concept, then dashboard weakness, then never scored.
- **Review sessions span the chosen lectures and switch lectures between
  objectives**, the same interleaving rule as the repetition quiz. Each
  objective's recall and probes stay together.

## Design

### A. Repetition selection — `lib/session/select.ts`

`select(candidates, { today, los, perLo })` stays pure and keeps its
signature.

- **One comparator** replaces the bucket loop: most overdue concept
  (`max(daysBetween(item.dueOn, today))`, negative when nothing is due yet,
  so such objectives sort last but still fill a thin session), then
  `weakness()` (weakest concept plus the last three dashboard scores by
  band), then never scored. Ties break on id.
- **Per-lecture cap** stays `max(1, ceil(los / 3))`, relaxed only when
  nothing under the cap remains.
- `order()` is unchanged: consecutive objectives from different lectures,
  `perLo` concepts per objective by most overdue, weakest, never asked.
- `PlannedSlot` loses `bucket`; plans frozen earlier carry the field in JSON
  and it is ignored. `LoCandidate` loses `block` and `lectureCommittedOn`,
  which only the buckets read. `bucket` leaves `PlannedTurn`, `TurnWhy`,
  `TurnContext` and the session screen's why-line, which already ends with
  the due status.

### B. Ad-hoc review of chosen lectures

**Schema and migration 0008.** `sessions.type` becomes
`"review" | "daily"`. `sessions.lecture_ids` (JSON `number[]`, null for
daily) replaces `lecture_id`. The migration backfills
`lecture_ids = '[' || lecture_id || ']'` and renames `same_day` rows before
the table is rebuilt without `lecture_id`.

**Start** — `lib/session/review.ts` (moved from `sameDay.ts`).
`startReviewSession(lectureIds, minutes, now)` dedupes and sorts the ids;
every id must name a committed lecture. It rejoins an open review session
started today with the same set; otherwise it inserts one.

**Budget** — `reviewBudget(minutes, activeLoCount)` (was `sameDayBudget`);
`activeLoCount` counts unsuspended objectives across all chosen lectures.

**Plan** — `lib/session/plan.ts`, still pure. `PlannedObjective` gains
`lectureId`. `chooseObjectives(active, los)` groups by lecture in ascending
id, allocates `los` across groups by largest remainder on each group's
active count (at least one per group while `los ≥ groups`), takes a
`spacedSubset` within each group, and round-robins across groups for the
running order. One lecture reduces to the previous behaviour exactly.
`planNextTurn` walks that order; recall → probes → reflection are unchanged.

**Material and context** — `reviewKind.loadMaterial` reads the lectures by
id, drops ids whose lecture is gone and throws only if none remain;
objectives across all of them ordered by lecture then `orderIndex`; items
and practice questions likewise; `turnContext` names the objective's own
lecture, which the session screen shows as the caption above each turn.

**Runner** — `REFLECTION_QUESTION.review`; `kindFor` on `"review"`.

**API** — `POST /api/sessions` takes `{ type: "review", lectureIds, minutes? }`
or `{ type: "daily", minutes? }`. `lectureIds` must be a non-empty array of
integers.

**UI** — `/lectures` gets a checkbox per committed lecture and a bar with the
minutes select and a "Review N lectures" button (`ReviewPicker`); the per-row
*Study* button goes. A review session's heading lists the chosen lectures.

## Assumptions to flip if wrong

- Overdue is counted in calendar days, not relative to the item's interval.
- Objectives with nothing due still fill a session rather than shortening it.
- Review rejoin requires the same lecture set and a start today.
- Chosen lectures round-robin in ascending id order.
- The per-lecture cap stays a third of the objectives covered.
- Question order still reads the objective's latest score only.
