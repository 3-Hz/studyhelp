# Phase 5 — Aligning with the new ChatGPT prompt

Date: 2026-09-07
Status: approved, in implementation

## Context

The app was built from `prompt.txt`, the original ChatGPT system prompt. The
ChatGPT workflow has since been rewritten as `new_prompt.txt`, and the question
is where the app now falls short of it. The first half of this document is the
answer; the second half is the plan to close the gaps, shaped by four decisions
Ed made (see *Decisions*).

The comparison is against `origin/main` (b254514), which has Phase 4 merged.
The local checkout is 15 commits behind it; `.worktrees/phase-4` holds the same
tree. Fetch fails inside the sandbox, but the ref is already local, so before
any work:

```bash
git merge --ff-only origin/main
```

## What changed between the two prompts

- **New artifact: the LO Map.** Lecture, LO, the lecture content for that LO,
  a concept count, and a numbered concept list. The old prompt kept no content.
- **Dashboard gains lecture names and per-concept marks.** The old prompt
  forbade both ("do not add lecture names", "never add concept rows").
- **Scores are 1–5**, not green/yellow/red. Colours survive only on the
  per-concept marks.
- **Time budget** sets how many LOs and how deep, in both session kinds.
- **Question depth is named** first/second/third order and keyed to the LO's
  recent score: poor → first, neutral → second, good → third. Same-day review
  is first-order only.
- **Interleaving means switching lectures, not combining LOs.**
- **Selection is LO-level**: pick LOs, ask several questions on one, score it.
- **Dropped**: the 4/2/2/2 mix, the interval ladder, format variety, the
  summary and elaboration stages, reflection, debrief, cue rules, suspension,
  provenance, conflicts. "Practice questions from the slides" stays.

## How LOs and key information are structured

**In the new prompt (the LO Map sheet).** One row per LO:

| Column | Holds |
|---|---|
| A | Lecture name (repeated for each of its LOs) |
| B | The LO, verbatim |
| C / D | The lecture content that satisfies the LO: the "Key Information" cell, prose from the slides and notes (the prompt calls it the third column, then "Column D") |
| E | How many distinct concepts D contains: terms, mechanisms, relationships, distinctions, clinical applications, each independently testable idea counted once |
| F | Those concepts as a numbered list, in the order they appear in D; the count must equal E |

The example row: lecture "Introduction to Radiology"; LO "describe the imaging
modalities…"; Key Information "Pros of X-rays are easy to obtain, fast, cheap,
highest resolution; cons are 2D, poor soft-tissue contrast, ionizing
radiation…"; so E would be 7 and F would number those seven.

The Dashboard sheet then keys on the same rows: lecture, LO, one column per
date holding the LO's 1–5 score, and from column Y on, the concept numbers
from F coloured green/yellow/red on the dates they were tested.

**In the app today (origin/main).**

- `lectures` — title, block.
- `learning_objectives` — one row per LO: `lecture_id`, `text` verbatim,
  `order_index`, `suspended`.
- `review_items` — the concepts, one row each: `lo_id`, `concept` (the
  extract's `label — detail`), `kind`, `provenance`, plus the ladder state
  (`due_on`, `interval_days`, `lapses`, `streak`, `last_rating`). Extraction
  emits concepts as a flat lecture-level list, each pointing at the LOs it
  serves; commit files each under the first of those LOs that survived
  review. There is no prose "Key Information" cell: the concept rows *are*
  the content, and `/lectures/[id]/concepts` shows them under each LO.
- `performances` — `lo_id` × `study_date_id` → rating: the dashboard cell.

So column B is `learning_objectives.text`, column F is the `review_items`
under that LO, column E is their count, and column D has no counterpart.

**After this plan.** `review_items.ordinal` gives each concept its number
within the LO (column F's numbering); the concept view shows the count
(column E); `concept_marks` records `review_item × date → mark` (columns Y+);
`performances` holds the 1–5 score; `practice_questions` keeps the slides'
own questions and answers. Column D stays unrepresented as prose: the
numbered concepts carry the content, which is what the sessions read from.

## Gap analysis

Status: **met**, **partial**, **missing**, or **conflicts** (the app does the
opposite on purpose).

### Lecture processing and the LO Map

| # | New prompt | Status | Where |
|---|---|---|---|
| 1 | LOs come from a slide titled "Learning Objectives", "Objectives", "Session Learning Objectives" or similar | partial | `lib/extract/schema.ts:71` asks for "every explicitly stated Learning Objective" verbatim but never names the slide. One-line prompt change. |
| 2 | Map content to each LO: concepts, mechanisms, relationships, distinctions, clinical applications | partial | Flat `concepts[]` typed `fact\|mechanism\|application` with `relatedObjectiveIndexes` (`lib/extract/schema.ts:29-49`); commit attaches each to its first surviving LO (`lib/commitLecture.ts:62-79`). No relationship or distinction kind; `commonConfusions` is extracted but never stored. |
| 3 | Never invent facts; never attribute outside knowledge to the lecture | met | `lib/extract/schema.ts:75-80`, plus provenance (stricter than the new prompt). |
| 4 | Use practice questions from the slides and their note-based answers | missing | Nothing in the extract schema, the parser, or the tutor. |
| 5 | Per-LO content ("Key Information") | partial | The review items under each LO are the content, shown on `/lectures/[id]/concepts` (`lib/concepts.ts`). No prose cell. |
| 6 | Concept count and a numbered list in content order | missing | No ordinal on `review_items`; the concept view lists by id. Count is only `array.length` at ingest. |

### Dashboard

| # | New prompt | Status | Where |
|---|---|---|---|
| 7 | Lecture, LO, one column per date, a score per cell | met | `app/dashboard/page.tsx`. Lecture is a caption above each LO, not a grouping column. |
| 8 | Colour the concept numbers tested each date; leave untested ones alone | missing | `performances` is LO × date only (`lib/db/schema.ts:165-182`); `review_items` keeps one `lastRating`. Same-day turns carry no `reviewItemId` and push the LO's worst rating onto every item under it (`lib/session/sameDay.ts:124-134`). Daily attempts do record item and rating, so a partial history is recoverable from `attempts`. The schema comment cites the old prompt's ban. |

### Review quiz session (same-day)

| # | New prompt | Status | Where |
|---|---|---|---|
| 9 | Quiz today's lectures' LOs | met | One lecture per session, `lib/session/sameDay.ts`. |
| 10 | Time budget sets quantity and depth | missing | Every unsuspended LO, then summary, then elaboration for anything below green, then reflection (`lib/session/plan.ts:37-74`). Unbounded. |
| 11 | Same-day questions are first-order | conflicts | `lo_recall` is first-order; the summary and elaboration stages are not (`lib/tutor/index.ts:88-93`). |

### Repetition quiz session (daily)

| # | New prompt | Status | Where |
|---|---|---|---|
| 12 | Time budget sets how many LOs and how deep | missing | `SESSION_SIZE = 10` (`lib/session/select.ts:15`); no caller passes a size. |
| 13 | Pick by time since last review and performance history | met | Concept-level: due date from the ladder, weakness from LO history and lapses (`lib/session/select.ts:87-125`, `lib/schedule.ts`). |
| 14 | Interleave by switching lectures, never combining LOs | conflicts | Order alternates lectures (`select.ts:392-418`, cap 3 per lecture). Slots 5 and 10 are cumulative and combine concepts from other lectures (`select.ts:63-68`, `427-442`; `lib/session/daily.ts:190-199`). |
| 15 | First-order for recent poor, second for neutral, third for good | partial | `TIER_BRIEF` (`lib/tutor/index.ts:105-112`) has the same three rungs but keys on the item's tier: last rating, streak, interval. Mature needs three greens and a 14-day interval, so "good" rarely reaches third-order. |
| 16 | One LO at a time; several questions, then one score per LO | partial | Same-day: one LO per turn, one or two questions. Daily: one question per concept, and `select()` never takes two items from one LO (`select.ts:225-230`). |

### Facilitation and scoring

| # | New prompt | Status | Where |
|---|---|---|---|
| 17 | Correct, missing, inaccurate | met | `GradeOutput`, `lib/tutor/schema.ts:64-93`. |
| 18 | Major gaps vs wording; never call a flawed answer correct; stay short | met | `TUTOR_SYSTEM`, `lib/tutor/schema.ts:132-151`. |
| 19 | Record the LO's score for today | met | `finishSession`, `lib/session/runner.ts:318-428`; worst of the day. |
| 20 | 1–5 scale: 5 unaided, 4 with help or mostly right, 3 partial with a big mistake, 2 wrong, 1 no idea | conflicts | Ratings are `green\|yellow\|red\|suspended` (`lib/db/schema.ts:17`). A cue caps green to yellow (`lib/schedule.ts:86-89`), which is the 5-vs-4 line; 4-vs-3 and 2-vs-1 cannot be stored. |
| 21 | Open by loading the Dashboard and LO Map | n/a | SQLite; each page reads what it needs. |

### In the app, not in the new prompt

Summary and elaboration stages, the reflection turn, the debrief with
calibration, cues and the rating cap, suspension, provenance and conflicts,
format variety, the 4/2/2/2 mix, cumulative slots, tiers and the lapsed
ladder, the badge after grading.

## Decisions

1. **Extras stay unless they conflict.** Drop the same-day summary and
   elaboration stages and the cumulative cross-lecture slots. Keep the rest.
2. **Scores are 1–5 end to end.** The grader returns 1–5; the dashboard,
   scheduler and difficulty key off it. Colours survive as concept marks.
3. **Sessions take a time budget** in minutes at start, for both kinds.
4. **Daily sessions are LO-centred.** Select LOs; ask one to three concept
   questions per LO; the LO's score is the worst of them; each concept asked
   gets its own mark.

## Design

Two levels, matching the new prompt: the **LO** carries a score 1–5 per date
(the dashboard); each **concept** under it carries a mark green/yellow/red per
date (the LO Map's coloured numbers) and rides the existing ladder on that mark.

### Types (`lib/db/schema.ts`, `lib/schedule.ts`)

- `Score = 1 | 2 | 3 | 4 | 5`. Replaces `Rating` on `performances` and
  `attempts`.
- `Mark = "green" | "yellow" | "red"`. Replaces `Rating` on `review_items`
  and as the ladder's input. `"suspended"` leaves the enum: suspension is
  already `learningObjectives.suspended`, and nothing writes it as a rating.
- `band(score): Mark` — 5 green, 4 yellow, 1–3 red. One function, used for
  the dashboard cell colour, the LO's question order, and the fallback mark
  for a target concept the grader failed to mark. Reasoning: the rubric's 3
  includes "a big mistake", which is what the old red meant, and the new
  prompt's yellow is "minor error".
- `capScore(score, hinted)`: 5 → 4 (the rubric's "correctly with help").
  `capMark(mark, hinted)`: green → yellow. Both stay in code, as `capRating`
  is now.
- `nextSchedule` keeps its transitions on `Mark`; the `suspended` branch goes.
  `worstRating` becomes `worstMark`; `worstByLo` becomes `minScoreByLo`.
- `QuestionOrder = "first" | "second" | "third"`, `orderFor(latestLoScore)`:
  null or ≤3 → first, 4 → second, 5 → third.

### Budget (`lib/session/budget.ts`, new, pure)

`budgetFor(minutes)` → `{ questions, perLo }`, with `MINUTES_PER_QUESTION = 2`
and `perLo` 1 under 15 min, 2 under 30, 3 from 30. Twenty minutes reproduces
today's ten questions.

- Daily: `los = max(1, floor(questions / perLo))`.
- Same-day: breadth first. `los = min(activeLoCount, questions)`, then
  `perLo = clamp(floor(questions / los), 1, 3)`. A short session takes LOs
  evenly spaced through the lecture's order so coverage spans the lecture.

`sessions.minutes` stores the budget; rejoining an open session ignores a new
value, since the plan was frozen.

### Selection (`lib/session/select.ts`, `candidates.ts`)

`dailyCandidates()` returns `LoCandidate[]`: one per objective, carrying
`lectureId`, `block`, `suspended`, `lectureCommittedOn`, `scores` (its
dashboard scores oldest first), `latestScore`, and `items` (today's item-level
`Candidate` shape, minus the cumulative fields).

`select(candidates, { today, los, perLo })` stays pure and keeps the bucket
idea at LO level: due 40 %, weak 20 %, recent 20 %, interleaved 20 % of `los`,
carry as now, fill last. An LO is due if any item is; its weakness is the max
of its items' weakness with the LO's last three scores weighted by band; the
`interleaved` bucket still means "a lecture not yet represented" and no longer
attaches companions. `MAX_PER_LECTURE` becomes a third of `los`, minimum one.

Within a chosen LO, take `perLo` items: most overdue, then weakest, then
never asked, ties on id. Order the LOs so consecutive LOs come from different
lectures (`interleave()` on LO groups); an LO's questions stay consecutive, so
the student sees one LO at a time.

`PlannedSlot` becomes `{ slot, loId, reviewItemId, bucket, order, tier,
formatFamily }`. `order` is frozen from the LO's latest score; `tier` stays for
the badge. `CUMULATIVE_FAMILY` and `companionsFor` are deleted.

### Same-day plan (`lib/session/plan.ts`)

`planNextTurn(objectives, graded, { reflected, los, perLo, marksByLo })`:

1. Choose the LO subset once from `los` (evenly spaced, deterministic).
2. For each LO in order: one `lo_recall` turn (the broad recall that exists
   today, first-order). Then up to `perLo − 1` `lo_probe` turns, each on one
   concept the recall left unmarked or non-green, untouched first. Nothing
   remains → move on.
3. Reflection, as now.

`summary` and `elaboration` leave `SESSION_STAGES`; `lo_probe` joins it.
Rows from finished sessions may carry the retired stages; they are only read
at finish time, never re-rendered.

### Tutor (`lib/tutor/schema.ts`, `index.ts`)

- Concept lines are numbered by ordinal within the LO:
  `3. [mechanism, taught] …`. Daily and `lo_probe` turns name the target
  concept by number.
- `GradeOutput`: `score` (int 1–5, with the rubric verbatim in the
  description), `conceptMarks: { number, mark }[]` for concepts the answer
  actually tested, and the existing `correct`, `missing`, `incorrect`,
  `correction`, `modelAnswer`, `followUp`. Code guarantees the target concept
  is marked: absent → `band(score)`.
- `TUTOR_SYSTEM`: replace the colour rubric with the 1–5 one; add "mark each
  concept the answer tested; leave the rest out"; keep the rest.
- `ORDER_BRIEF` replaces `TIER_BRIEF`: first = one part, in steps, direct
  recall as taught; second = the whole concept, unscaffolded, why and how;
  third = application in a context the lecture did not use, discrimination,
  why the alternatives are wrong. The last-attempt steer keys on order:
  first → "target what was missed", else → "a different route".
- The ask prompt lists the LO's practice questions when any exist: "prefer
  one, or a close variant, when it tests the target concept".
- `DebriefRequest.answered[].rating` becomes `score`.

### Extraction (`lib/extract/schema.ts`, `merge.ts`, `commitLecture.ts`)

- `EXTRACTION_SYSTEM` names the objective slide titles from the new prompt.
- `kind` gains `relationship` and `distinction` (`REVIEW_KINDS` too), with
  format families: relationship → mechanism, comparison, consequence;
  distinction → discrimination, comparison, error_correction. The prompt asks
  for concepts "in the order the lecture presents them" and for every
  independently testable idea as its own concept. Type-level enum, no
  migration.
- `practiceQuestions: { question, answer, slideRefs, relatedObjectiveIndexes }[]`
  joins `LectureExtract`: questions the lecture itself poses, answers from the
  notes or the following slide, empty if none. `mergeExtracts` dedupes on the
  normalised question.
- Commit assigns `review_items.ordinal` per LO in draft order and writes
  `practice_questions`.
- `lib/fixtures/syntheticLecture.ts` gains one quiz slide with a notes
  answer; `lib/eval/score.ts` reports `practiceQuestionsFound`.

### Schema and migration 0006

- `review_items.ordinal` int not null default 0; backfill
  `ROW_NUMBER() OVER (PARTITION BY lo_id ORDER BY id)`.
- `performances.score` int; backfill green→5, yellow→4, red→2; drop `rating`.
- `attempts.score` int and `attempts.concept_marks` JSON; backfill; drop
  `rating`.
- `sessions.minutes` int.
- `concept_marks` (review_item_id, study_date_id, mark, unique on the pair):
  the per-date concept record, mirroring `performances`.
- `practice_questions` (lecture_id, lo_id nullable, question, answer,
  slide_refs JSON).
- `review_items.last_rating` keeps its name; its TypeScript type is `Mark`.

Drizzle rebuilds a table to drop a column; the backfill statements go before
the rebuild in the generated file, and a test in the style of
`lib/db/migrations.test.ts` seeds each colour and asserts the score.

### Runner and finish (`lib/session/runner.ts`, `kind.ts`, `daily.ts`, `sameDay.ts`)

- Start takes `minutes`; both kinds store it and plan from `budgetFor`.
- `submitAnswer` applies `capScore` to the score and `capMark` to every mark,
  stores `score` and `concept_marks` on the attempt.
- `finishSession`: one `performances` row per tested LO with the minimum
  score of the sitting, merged with an existing cell by minimum; one
  `concept_marks` row per marked item with the worst mark, merged the same
  way; `nextSchedule` per marked item on that mark; outcomes as now. Items
  never marked do not move, which is the new prompt's "leave untested concept
  numbers unchanged". `itemOutcomes` leaves `SessionKind`: both kinds now
  derive it from marks.
- `TurnWhy` gains `order`.

### UI

- Start buttons (`StartDailyButton`, `StartSessionButton`): a minutes select
  (10, 20, 30, 45, 60; default 20), posted with the start request.
- `SessionTurn`: score badge 1–5 with band colour and the rubric line; the
  concept marks the grader gave, by number; the cue note says "caps this
  answer at 4"; the why-line shows the order; the tally counts scores.
- `/practice`: copy describes the budget instead of "ten questions".
- `/dashboard`: the cell shows the number on its band colour; legend is the
  rubric.
- `/lectures/[id]/concepts` (the LO Map): a number column, "N concepts" per
  LO, and a marks strip with one column per date the lecture was tested.
- `/lectures/[id]/review`: concepts grouped and numbered under their LO, plus
  the practice questions found.
- `Outcomes`, `Debrief`: types follow.

### Docs

Commit `new_prompt.txt`; keep `prompt.txt`, since the retained extras cite
it. README's *Status* gains a Phase 5 paragraph naming which prompt governs
what. Copy this design to `docs/superpowers/specs/2026-09-07-phase-5-new-prompt-design.md`.

## Tasks, in order

Each task lands with its tests; `bun test` and `bun run typecheck` stay green
between tasks.

1. **Fast-forward and file the design.** `git merge --ff-only origin/main`;
   add the spec under `docs/superpowers/specs/`.
2. **Types and scheduler.** `Score`, `Mark`, `band`, `orderFor`, `capScore`,
   `capMark`, `worstMark`, `minScoreByLo`; `nextSchedule` without
   `suspended`. Files: `lib/db/schema.ts`, `lib/schedule.ts`,
   `lib/schedule.test.ts`.
3. **Schema and migration 0006** with the backfill test. Files:
   `lib/db/schema.ts`, `drizzle/0006_*.sql`, `lib/db/migrations.test.ts`.
4. **Budget.** `lib/session/budget.ts` and its test.
5. **Extraction.** Prompt, kinds, practice questions, merge, commit ordinal
   and practice rows, fixture and eval. Files: `lib/extract/schema.ts`,
   `lib/extract/merge.ts`, `lib/commitLecture.ts`,
   `lib/fixtures/syntheticLecture.ts`, `lib/eval/score.ts`, and their tests.
6. **Tutor contracts and prompts.** `GradeOutput`, `TUTOR_SYSTEM`,
   `ORDER_BRIEF`, numbered concept lines, practice questions in the ask
   prompt. Files: `lib/tutor/schema.ts`, `lib/tutor/index.ts`,
   `lib/tutor/tutor.test.ts`.
7. **LO-centred selection.** `LoCandidate`, `select`, `order`, no companions.
   Files: `lib/session/candidates.ts`, `lib/session/select.ts`, tests.
8. **Same-day plan.** Budgeted LO subset, `lo_recall` + `lo_probe`, retired
   stages. Files: `lib/session/plan.ts`, `plan.test.ts`.
9. **Runner and kinds.** Minutes at start, marks through grading and finish,
   `concept_marks` writes, `TurnWhy.order`. Files: `lib/session/runner.ts`,
   `kind.ts`, `daily.ts`, `sameDay.ts`, `prior.ts`, tests.
10. **API and UI.** `app/api/sessions/route.ts`, the two start buttons,
    `SessionTurn.tsx`, `Outcomes.tsx`, `Debrief.tsx`, `app/practice/page.tsx`,
    `app/dashboard/page.tsx`, `app/lectures/[id]/concepts/page.tsx` with
    `lib/concepts.ts`, `app/lectures/[id]/review/ReviewForm.tsx`.
11. **Docs.** README status and layout; commit `new_prompt.txt`.

Tasks 4, 5 and 6 are independent of each other once 2 and 3 are in.

## Assumptions to flip if wrong

Each is one constant or function.

- `band`: 3 counts as red. Change in `lib/schedule.ts`.
- `orderFor` reads only the LO's latest score.
- `MINUTES_PER_QUESTION = 2`; `perLo` bands at 15 and 30 minutes.
- Same-day prefers breadth: every LO once before any LO twice.
- The LO's daily score is the minimum of its questions, as the dashboard cell
  is today.

## Verification

1. `bun test` and `bun run typecheck` after every task; `bun run build` at the
   end (needs the sandbox off).
2. Migration: copy `studyhelp.db`, run `bun run db:migrate` against the copy,
   check `performances.score` and `review_items.ordinal` by hand.
3. End to end with the dev server (`bun --bun run dev`, sandbox off) and the
   synthetic deck from `lib/fixtures/pptxBuilder.ts`: import → review shows
   numbered concepts per LO and the quiz slide's question → commit → same-day
   session at 10 minutes covers a subset of LOs, first-order only, and grading
   shows a 1–5 score with concept marks → dashboard cell shows the number →
   the concept view shows the numbers coloured for today → daily session at
   20 minutes groups questions by LO, alternates lectures, never combines
   them, and the badge names the order.
4. Rejoin: reload mid-session and confirm the same question and the same
   budget.
