# Lectures without commit: extract and amend any time, one lecture page, resumable reviews

Date: 2026-09-09
Status: approved, in implementation
Base: `main` at b5dc2e3. Branch `lecture-workflow` in a worktree.

## Context

A lecture goes upload → draft → review screen → commit. Commit is the only
thing that creates objective and concept rows, and a committed lecture
refuses new files (`LectureCommittedError`), so a transcript that posts a
week after the deck cannot join it. The Import tab is a separate screen from
the lecture list, a lecture's content is split across `/review` before
commit and `/concepts` after, and the lecturer's emphasis is thrown away at
commit. A review session the student leaves is reachable again only by
re-ticking the same lectures the same day.

Decisions made with Ed:

- **Extraction writes rows directly.** No draft, no commit, no review
  screen. The lecture page's collapsible objectives table is where the
  student checks and suspends what came out. Lost with the review screen,
  and accepted: editing objective wording, adding an objective by hand,
  ticking concepts before they exist, the slide-source disclosure per
  objective. A paraphrased objective is suspended and re-extracted;
  verbatim quality rests on the eval.
- **Amend = re-extract everything and reconcile.** Every extraction re-reads
  all stored files, is told what the lecture already holds so it reuses the
  same wordings, and is reconciled into the existing rows: matches keep
  their id, number, ladder state, marks and suspension; new objectives and
  concepts append with the next number; nothing is deleted or renumbered.
  One code path for first extraction and amend.
- **One lecture page** at `/lectures/[id]`: files, the four upload boxes,
  Extract or Amend, the last extraction's notes, then objectives with their
  concepts. The **LO Map stays** at `/lectures/[id]/concepts` for marks by
  date, minus its Due, Interval and Lapses/streak columns.
- **The Import tab goes.** An Add Lecture button on the Lectures tab
  creates a title-only lecture.
- **Any unfinished review is resumable** from the Lectures tab, with a
  Finish now that records what was graded.
- **De-emphasised concepts start suspended** and can be re-enabled. Suspend
  is the only way to hide a wrong row; no delete.
- The naming rule from the last spec stands: "supplemental" is the
  provenance for outside knowledge; the fourth box stays "Additional
  materials", role `additional`.

## Design

### 1. Schema: two generated migrations

A table that adds and drops columns in one `db:generate` makes drizzle-kit
prompt for a rename, which needs a TTY, so the migrations are adds-only and
drop-only.

**0011, `review_items`:** `label` text not null default `''`, backfilled
from the text before the first ` — ` (else the whole concept): the key an
amend matches on. `emphasis` text enum not null default `neutral`;
`CONCEPT_EMPHASIS` moves from `lib/extract/schema.ts` to `lib/db/schema.ts`
and stops being "draft-time only". `emphasis_cue` text not null default
`''`.

**0012, `lectures`:** drop `committed_at`. The `draft_extract` column keeps
its name; the Drizzle property becomes `lastExtract`, with a comment that
the column name predates amends. `extracted_at` stays and is read at last:
"last extracted" on the lecture page.

Local data: a committed lecture keeps every row, its labels backfill from
the concept text, and its emphasis reads neutral because commit never
stored it. A lecture left as a draft keeps its files and its old extract
but has no objectives, so its page offers Extract.

### 2. Reconcile and apply

`lib/reconcile.ts` is pure: three functions the writer runs in order.

- `reconcileObjectives(existing, extracted)`: key `normaliseKey(text)`
  (`lib/extract/merge.ts`); an empty key is skipped; a repeat within one
  extract collapses onto the first. Unmatched objectives insert with
  `orderIndex = max(existing, pending) + 1` in extract order.
- `reconcileConcepts(existing, extracted, loIdByExtractIndex, today)`: a
  concept files under the first related objective index that resolves, as
  commit did; none → skipped. Key `normaliseKey(label)` against every
  existing item in the lecture and every pending insert, not only under
  that objective: a concept the model refiled is matched in place, never
  moved and never duplicated, the rule `mergeExtracts` already uses. Two
  draft concepts with one key collapse onto one row and both indexes link.
  Inserts take `ordinal = max under that objective + 1`, `concept =
  label — detail`, `suspended = emphasis === "deemphasized"`, `dueOn =
  today`. Matched concepts keep id, ordinal, text, ladder fields and
  `suspended`; emphasis and cue update only when the new emphasis outranks
  the stored one (`strongerEmphasis`: neutral < deemphasized <
  emphasized), so an amend can add a cue and a weak run cannot erase one.
- `reconcileQuestions(existing, extracted, loIdByExtractIndex,
  itemIdByExtractIndex)`: key `normaliseKey(question)`. A matched question
  gains newly resolved item ids, append-only. New ones link through
  `conceptIndexes` to matched or inserted items; unknown indexes drop.
- No deletes and no renumbering exist in the plan types.

`lib/applyExtract.ts` replaces `lib/commitLecture.ts`:
`applyExtract(lectureId, extract, today)` loads the three tables, inserts
objectives with `returning id`, completes the objective map from
`extractIndexes`, inserts and updates items, completes the item map, inserts
and updates questions, and returns counts. A zero-objective extract writes
nothing: a lecture that states none is a result, not an error. No
transaction, as nowhere else in the codebase; the raw extract is saved
before apply and apply is idempotent, so a failed write completes on the
next Extract.

Accepted risk: a label the model rewords becomes a second row with the
next number, and the student suspends one. No fuzzy matching: a wrong merge
would fuse two concepts' histories. The anchor block is what makes drift
rare.

### 3. The model is told what exists

- `lib/extract/prior.ts`: `formatPrior(prior)` renders `# Already
  extracted`, then each objective verbatim with its concept labels in
  ordinal order, "(no concepts recorded)" when empty, `""` for no
  objectives. Suspended objectives and items are included: they anchor
  wording, not status.
- `PRIOR_NOTE` in `lib/extract/schema.ts`, fixed text: the lecture was
  extracted before; copy the recorded wording exactly for any recorded
  objective or concept the materials state; record what is not listed
  under the objective it serves with a label of its own; do not rephrase,
  merge or renumber recorded items, and do not list one these materials do
  not state. `EXTRACTION_SYSTEM` is untouched.
- `lib/extract/index.ts`: `ExtractInput.prior`. When present, the note and
  the block form one text part after the lecture text and before the
  instruction, on the single call and on every chunk; documents still ride
  with the first chunk only. Its tokens are reserved from every chunk's
  budget with `documentTokens`.
- `lib/ingest/buildExtractInput.ts` reads the lecture's objectives and
  items into `prior`.

### 4. Ingest and routes

- `createLecture(title)`: a title-only insert; blank rejected.
  `ingestLecture()` and `LectureCommittedError` go.
- `extractLecture(lectureId, files, deps)`: stores any files, allows none
  when the lecture already has a source (a re-run on a better model, or
  recovery after a failed apply), else refuses; runs `runExtraction`; then
  `applyExtract`. The student's title is never overwritten by the model's.
- `POST /api/lectures` takes JSON `{ title }` and returns `{ lectureId }`.
  `POST /api/lectures/[id]/extract` takes the four multipart fields,
  all optional, and returns the stored, skipped, warnings, meta and applied
  counts. The commit and sources routes go.

### 5. Sessions

- `startReviewSession`: every chosen lecture must have at least one
  unsuspended objective with an unsuspended concept, else `"<title>" has
  nothing to review yet: extract its objectives first, or reactivate a
  suspended one.` Same-day rejoin stays.
- `dailyCandidates` drops the committed filter; rows exist only after
  extraction.
- `lib/session/openReviews.ts`: unfinished reviews newest first, with the
  surviving lectures in id order and the count of graded answers. A review
  whose lectures were all deleted is omitted, since neither Resume nor
  Finish could work for it.
- Resume is a link: the review plan is re-derived per request and
  `currentTurn` returns the pending question on reload. Finish now posts
  the existing finish route, which already skips ungraded attempts.

### 6. Screens

- **Nav:** Lectures, Daily Practice, Dashboard.
- **Lectures tab:** an unfinished-reviews panel above the list (titles,
  started on, answered, minutes, Resume, Finish now); the list with a tick
  box for any lecture with an objective, the title linking to the lecture
  page and a subtitle of "N objectives · M concepts", "K files, not
  extracted yet" or "No materials yet"; Add Lecture between the list and
  the start bar, and alone in the empty state.
- **Lecture page** `/lectures/[id]`: title and "last extracted"; the file
  list with roles and the four boxes, one button reading Extract with no
  objectives and Amend otherwise; a disclosure with the last extraction's
  meta, warnings, conflicts and common confusions; the objectives table:
  one open disclosure per objective with the text, counts and suspended
  state, the objective's Suspend beside it, and inside it the concepts
  with number, `label — detail`, the emphasis badge with the cue quoted,
  the practice-quiz badge, kind, provenance when not taught, and Suspend.
  A link to the LO Map.
- **LO Map:** the Due, Interval and Lapses/streak columns go; the emphasis
  badge joins the quiz badge; the "not committed" stub becomes "No
  objectives yet" linking to the lecture page. The dashboard keeps linking
  here: a score row's drill-down is marks by date.

## Tasks, in order

Each lands with its tests; `bun test` and `bun run typecheck` stay green
between tasks.

1. Branch and this spec.
2. Migration 0011 and the schema columns; `commitLecture` writes them.
3. The anchor block: `prior.ts`, `PRIOR_NOTE`, `index.ts`,
   `buildExtractInput.ts`.
4. `reconcile.ts` and `applyExtract.ts`, coexisting with `commitLecture`.
5. Re-seed the session, concepts and prior tests through `applyExtract`.
6. `createLecture`, `extractLecture`, the two routes; delete the sources
   route.
7. The lecture page and its components; `lectureConcepts` gains label,
   emphasis and cue.
8. The Lectures tab, `openReviews`, the nav; delete the import and review
   screens, the commit route and `commitLecture`.
9. Migration 0012, `lastExtract`, and the last `committedAt` readers: the
   list, the LO Map data, daily candidates, the review guard.
10. The LO Map columns and badge.
11. README, this spec's Results, the production build.

Tasks 3 and 4 are independent once 2 is in; 7 and 8 once 6 is in.

## Assumptions to flip if wrong

- A concept matches on its label anywhere in the lecture, not only under
  the objective the model chose this time.
- Emphasis on a matched concept moves only upward in rank.
- Objective sections on the lecture page start open.
- Extract with no new files is allowed when the lecture already has
  sources.
- The student's title wins; the model's is ignored. No rename control.
- Finish now records the cells on the day it is pressed.
- The dashboard's lecture link stays on the LO Map.
- No "apply last extraction" endpoint: Amend with no files covers a failed
  apply at the cost of one model run.

## Verification

1. `bun test` and `bun run typecheck` after every task; `bun --bun run
   build` at the end (sandbox off).
2. Migrations against a copy of `studyhelp.db`: the committed lecture's
   items carry a label, neutral emphasis and an empty cue; `committed_at`
   is gone; attempts and messages survive the rebuild.
3. End to end on the dev server with the synthetic fixture: add a lecture,
   extract the deck and transcript, check the badges and the suspended
   set-aside concept; amend with the quiz deck and handout and check that
   every earlier id and ordinal is unchanged while the new concepts append;
   suspend and reactivate an objective and a concept; start a review,
   answer once, resume it from the Lectures tab, finish it, and see the
   score on the dashboard.

## Results

Filled in after verification.
