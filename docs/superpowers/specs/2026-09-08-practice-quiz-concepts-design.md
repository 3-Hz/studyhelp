# Discrete uploads, practice-quiz concepts under LOs, flagged and told to the tutor

Date: 2026-09-08
Status: approved, in implementation
Base: branch `lecturer-cues` (off `phase-6`, both unpushed). New branch
`practice-quiz-concepts` in a worktree.

## Context

A lecture's materials come as up to four things: the slide deck, the lecture
transcript, a practice quiz, and additional materials (handouts, readings,
figures). Today the upload is one box, and the app tells file types apart by
extension only: a quiz PDF, a deck export and a handout all reach the model
as "PDF". Anything the quiz tests is, by construction, a key concept, and the
additional materials can hold key concepts of their own. The app half-handles
this. Extraction already records the questions a lecture poses
(`practiceQuestions`, Phase 5) and the tutor is shown them per objective with
"prefer one when it fits". But nothing links a question to the concepts it
tests, nothing guarantees those concepts are extracted as numbered concepts
under the objective, nothing marks them afterward, and the model is never
told which file is which.

Decisions made with Ed:

- **Four discrete upload boxes**: deck, transcript, practice quiz, additional
  materials. Each file carries its role to the model, so a PDF in the quiz
  box is read as a quiz.
- **Concepts from the additional materials are key concepts**, filed under
  objectives like any other, and subject to the lecturer's cues by the
  normal means. No special flag.
- **Quiz-tested concepts are flagged** on the review screen and the LO Map,
  and the tutor is told which numbered concept each question tests.
  Selection order does not change.
- **A lecturer's cue still wins the starting tick.** A quiz-tested concept
  the lecturer set aside starts unticked, flagged, and can be ticked back.

One naming rule throughout: the word "supplemental" already means *outside
medical knowledge not in the materials* (`PROVENANCE`, both system prompts,
the review copy). The fourth box is therefore "Additional materials" in the
UI, role `additional` in code, and "Additional course material" in what the
model reads. Otherwise the model would be handed a document headed
"Supplemental" and told to label such content as not in the materials.

## Design

### 1. Four boxes, one role per file

- `lib/db/schema.ts`: `SOURCE_ROLES = ["deck", "transcript", "quiz",
  "additional"]`; `lectureSources.role` text enum, not null. `kind` stays
  the format (how a file parses); `role` is what the file is. The same
  word "transcript" appears on both axes; the schema comment says so.
- Migration `drizzle/0010_*.sql`: add `lecture_sources.role` with default
  `additional`, then backfill from kind (`slide` → `deck`, `transcript` →
  `transcript`, else `additional`); add `practice_questions.review_item_ids`
  (§4). Add-only plus an `UPDATE`, hand-added to the generated file as
  Phase 5 did, so `bun run db:generate` needs no TTY.
- `lib/ingest/storeSources.ts`: `IncomingFile.role: SourceRole`; the source
  row stores it. Assets are unchanged: a quiz deck's slides still take
  global slide numbers, so `slideRefs` keep working. `UnsupportedFilesError`
  wording unchanged.
- `lib/ingest/formFiles.ts`: `filesFromForm` reads four fields, `deck`,
  `transcript`, `quiz`, `additional`, each mapped to its role. The
  `files` field goes; both callers change with it.
- `app/api/lectures/route.ts`: the fallback title comes from the first deck
  file, else the first file. `app/api/lectures/[id]/sources/route.ts` needs
  no other change.
- New `app/components/MaterialInputs.tsx`: four labelled file inputs (all
  accept `ACCEPT`), reporting `{ deck, transcript, quiz, additional }` as
  `File[]`, plus `appendMaterials(form, materials)` that writes the four
  fields. Used by `app/import/page.tsx` and
  `app/lectures/[id]/review/LectureFiles.tsx`; submit is enabled when any
  box has a file. `SourceSummary` gains `role`; `describe()` leads with the
  role ("practice quiz · deck · 6 slides", "additional · PDF · 120 KB").
  Page copy explains the four boxes in one sentence.

### 2. The model is told what each document is

- `lib/extract/chunk.ts`: `ExtractSlide` and `TranscriptSection` gain
  `role?: SourceRole`, defaulting to deck for a slide and transcript for a
  section, so older callers and the eval's `--deck` path keep working. `buildUnits` heads each run of units from
  `ROLE_HEADING[role]` — "Slide deck", "Lecture transcript", "Practice
  quiz", "Additional course material" — plus the file label, plus
  "(body text and presenter notes)" when the units are slides. The header
  changes on `(role, label)`, not label alone.
- `lib/ingest/buildExtractInput.ts`: copies each source's role onto its
  slides and transcript sections. Before every PDF's or image's parts,
  whatever its role, it pushes a text part `# <role heading>: <filename>`
  and one sentence saying what follows; for a quiz, that its questions are
  practice questions and its answer key gives the answers. Works for native
  and text-extracted PDFs alike. Legacy sources are labelled by the
  backfilled role.

### 3. The extraction contract

`lib/extract/schema.ts`:

- `practiceQuestions[].conceptIndexes: number[]`, `min(1)`: "Indexes into
  concepts (0-based) of the concepts this question tests. At least one: what
  a question tests is a key concept, so it is always among the concepts."
  `min(1)` reaches native providers as `minItems` and the prompted path as a
  repair issue, the same way a missing `emphasis` does today.
- `provenance` description and the prompt's provenance block: "taught =
  stated in any of the lecture's materials — slides, notes, transcript,
  quiz, additional course material"; "supplemental = accurate medical
  knowledge NOT in any of them".
- `EXTRACTION_SYSTEM`:
  - Opening: the materials arrive each headed by what it is: the slide deck
    with presenter notes, the lecture transcript, a practice quiz, and
    additional course material such as handouts, readings and figures.
  - Practice questions: a practice quiz supplied as its own document holds
    practice questions, answers from its answer key; the deck's own quiz
    slides still count.
  - New paragraph: a practice question shows what the course thinks is worth
    testing. Every concept a question tests is a key concept: record it as
    its own concept under the objective it serves, even when the slides
    mention it only in passing or only the quiz does, and name it in the
    question's `conceptIndexes`. A concept only the quiz states is still
    taught. Read the questions before listing concepts, so the concepts they
    test are in the list.
  - New paragraph: additional course material is course material. Extract
    its concepts as taught, under the objectives they serve, weighted like
    the notes. The lecturer's cues apply to them as to anything else, and
    nothing about where a concept came from changes its provenance or
    drops it.
- `CHUNK_NOTE`: a question in this section may test a concept explained in
  another section; extract that concept here too, so the question can name
  it. Merge collapses the duplicate.
- Field order stays objectives → concepts → practiceQuestions.
- Stored drafts predate the field: readers use `item.conceptIndexes ?? []`,
  as they already do for `emphasis`.

`lib/extract/merge.ts`: keep a per-chunk map of local concept index → merged
index (the objectives already do this), remap `conceptIndexes`, union on a
duplicate question, drop indexes that name no concept.

### 4. Commit records the link

`lib/db/schema.ts`: `practiceQuestions.reviewItemIds` JSON `number[]`,
nullable (null on rows from before).

`lib/commitLecture.ts`: review items are inserted first already; take
`.returning({ id })`, build draft concept index → review item id (only
concepts that got an item), and write `reviewItemIds` on each practice row.
A link to a concept under a rejected objective drops out; a link to an
unticked concept stays, since the row exists suspended.

### 5. Review screen

`app/lectures/[id]/review/ReviewForm.tsx`:

- Invert `conceptIndexes` once: draft concept index → the questions naming
  it. A concept card with any gets a "practice quiz" badge, `title` listing
  the questions. Pick a colour not used by marks or provenance
  (`app/components/scores.ts`, `PROVENANCE_STYLE`).
- Each practice-question card lists the labels of the concepts it tests.
- Copy under "Concepts to be scheduled": a concept a practice question tests
  is marked, and starts ticked unless the lecturer set it aside.
- The tick default is unchanged: cue wins.

### 6. LO Map

`lib/concepts.ts`: load the lecture's `practiceQuestions`; `ConceptRow`
gains `practiceQuestions: string[]`, the questions whose `reviewItemIds`
name it. `app/lectures/[id]/concepts/page.tsx`: a small "quiz" badge in the
concept cell, `title` listing them.

### 7. Tutor and sessions

- `lib/tutor/index.ts`: `PracticeQuestionContext.conceptOrdinals?: number[]`.
  `practiceLines` prints `(tests concept 3)` or `(tests concepts 2, 5)` after
  each question, lists questions that test the target concept first, and
  says so in the lead-in.
- `lib/session/review.ts` and `lib/session/daily.ts`: when building
  `practiceByLo`, map `reviewItemIds` to the ordinals of that objective's
  unsuspended items. A link to a suspended item yields no number.

### 8. Eval

- `lib/fixtures/syntheticLecture.ts`:
  - `syntheticQuizDeck()`: a three-slide deck built with `buildPptx`: a
    title slide, a questions slide, an answer-key slide (answers on the
    following slide, not in notes, so the answer-key path is what gets
    tested). Two questions: one tests a taught concept (keyword
    `transthyretin`), one tests a concept found nowhere in the lecture or
    transcript (light-chain isotype, keyword `lambda`).
  - `syntheticHandout()`: a short reading as plain text with one fact found
    nowhere else (the dFLC threshold, keyword `dFLC`), in service of
    objective 4. It catches the confusion the naming rule guards against, a
    model labelling handout content "supplemental", and it serves an
    objective on purpose: Gemini dropped an earlier, unrelated fact (SAP
    scintigraphy) because the prompt files concepts under the objectives
    they serve, which is the right behaviour.
  - `GroundTruth` gains `quizTested: { question, concept }[]` and
    `additionalOnlyConcepts: string[]`. The quiz questions stay out of
    `practiceQuestions`, which the fixture tests hold to questions posed on
    the deck's own slides with answers in its notes.
- `lib/eval/score.ts`: `quizConceptsMissed: string[]` — the question not
  found; found but no linked concept mentions the keyword (say whether the
  concept exists unlinked or is absent). `additionalMissed: string[]` — the
  keyword absent, or present but labelled `supplemental`.
- `scripts/eval.ts`: label the lecture deck `lecture.pptx` / role `deck`
  and the transcript role `transcript`; parse the quiz deck and append its
  slides with `sourceLabel: "practice-quiz.pptx"`, role `quiz`, ordinals
  continuing after the lecture deck; chunk the handout as a transcript
  section with role `additional`. Add `QUIZ` and `ADDL` columns (honoured /
  planted) and detail lines. The `--deck` path is unchanged.
- Fixture tests: the quiz deck parses to three slides; each quiz question
  appears on a slide with its answer only on the answer slide; the
  quiz-only and handout-only concepts are absent from the lecture deck and
  transcript; everything together still fits one long-context call.

### 9. Docs

- Task 1 copies this design to
  `docs/superpowers/specs/2026-09-08-practice-quiz-concepts-design.md`, as
  Phase 5 did.
- `README.md` Status, after the lecturer-cues paragraph under Phase 1: the
  upload takes the deck, the transcript, the practice quiz and any
  additional materials in their own boxes, and each reaches the model
  labelled; every concept a quiz question tests is extracted under its
  objective and marked on the review screen and the LO Map; the tutor is
  told which numbered concept each question tests; concepts from the
  additional materials are taught material under the usual cues; a cue
  still decides the starting tick. Layout gains `components/MaterialInputs`.

## Tasks, in order

Each lands with its tests; `bun test` and `bun run typecheck` stay green
between tasks. Existing test files named below already hold the patterns to
copy (temporary SQLite per file, `MockLanguageModelV4` prompt capture).

1. **Branch and spec.** Worktree off `lecturer-cues`; add the spec file.
2. **Schema and migration 0010.** `lib/db/schema.ts`, the generated SQL
   with the backfill, `lib/db/migrations.test.ts`: an old slide source
   reads `deck`, an old transcript `transcript`, an old PDF `additional`;
   `review_item_ids` is null on an old row.
3. **Upload roles.** `storeSources.ts`, `formFiles.ts`, both routes,
   `MaterialInputs.tsx`, `app/import/page.tsx`, `LectureFiles.tsx`. Tests
   in `lib/ingest/storeSources.test.ts` (a file keeps the role it was
   uploaded with) and a new `formFiles.test.ts` (each field yields its
   role; an empty form yields nothing).
4. **Model input.** `chunk.ts`, `buildExtractInput.ts`. Tests in
   `chunk.test.ts` (each role gets its own heading; a quiz deck and a
   lecture deck with the same filename stay separate) and
   `buildExtractInput.test.ts` (a quiz PDF is announced before its content;
   roles reach the slides and transcript sections).
5. **Extraction contract and merge.** `schema.ts`, `merge.ts`. Tests in
   `schema.test.ts` (a question must name a concept) and `merge.test.ts`
   (indexes remap across chunks; a deduped concept keeps its links; unknown
   indexes drop).
6. **Commit.** `commitLecture.ts`. Tests: links become review item ids; a
   link under a rejected objective drops; an unticked concept stays linked;
   a draft without `conceptIndexes` commits with null links.
7. **Review screen.** `ReviewForm.tsx`.
8. **LO Map.** `concepts.ts`, the page, `concepts.test.ts`.
9. **Tutor and sessions.** `tutor/index.ts`, `review.ts`, `daily.ts`.
   Tests in `tutor.test.ts` (numbers appear; the target's question is
   first), `review.test.ts` and `daily.test.ts` (ordinals resolve; a
   suspended link has none).
10. **Eval.** Fixture, ground truth, scorer, `scripts/eval.ts`, and their
    tests.
11. **README.**

Tasks 7, 8 and 9 are independent once 6 is in; 10 needs 4 and 5.

## Assumptions to flip if wrong

Each is one line or one constant.

- Concepts from the additional materials are `taught`. One prompt sentence.
- `conceptIndexes` is `min(1)`. Relax to `min(0)` if a weak local model
  thrashes in repair.
- Every box accepts every type in `ACCEPT`; a PDF transcript goes in the
  transcript box and is read as one.
- An old PDF source backfills to `additional`, the closest honest default.
- The tutor sorts target-testing questions first rather than filtering to
  them.

## Verification

1. `bun test` and `bun run typecheck` after every task; `bun --bun run
   build` at the end (sandbox off, per memory).
2. Migration: copy `studyhelp.db`, `bun run db:migrate` against the copy,
   check every old source's `role` matches its kind and
   `practice_questions.review_item_ids` is null.
3. `bun run eval --profiles local` (Ollama, `qwen3:8b`): the `QUIZ` and
   `ADDL` columns show the links and handout concepts honoured, and the
   detail lines name any missed.
4. End to end on the dev server (sandbox off; `preview_start` serves the
   main checkout, so run the server from the worktree per memory). Import
   the synthetic deck in the deck box, the transcript in its box,
   `syntheticQuizDeck()` bytes as the quiz and `syntheticHandout()` as
   additional material: the file list shows each role; the review screen
   shows "practice quiz" on the concepts the quiz tests, the light-chain
   and SAP concepts appear under their objectives labelled taught, each
   question card names its concepts; commit; the LO Map shows the "quiz"
   badge; start a review of that lecture and confirm (via the tutor test's
   prompt capture, or a temporary log) the ask prompt reads
   `(tests concept N)`.
5. Add-files path: on an uncommitted lecture, add a quiz file through the
   quiz box on the review page and confirm the re-extraction carries the
   quiz heading (the draft's practice questions grow).

## Results (2026-09-09)

`bun run eval` on the fixture, both profiles alone (two extractions at once
time each other out on the local model):

| Profile | Verbatim | Prov | Cues | Quiz links | Handout | Path |
|---|---|---|---|---|---|---|
| gemini-3.7-flash | 4/4 | 0 | 3/4 | 2/2 | 1/1 | native, 20 s |
| qwen3:8b (8k ctx) | 4/4 | 0 | 3/4 | 1/2 | 1/1 | 2 chunks + repair, 168 s |

The cue both miss ("low voltage") predates this branch. The 8B model links
the quiz question on a taught concept but does not extract the quiz-only
concept; the frontier model does both. End to end on the dev server with
qwen3:8b: four files stored with their roles, the model input headed per
role, three practice questions each linked to concepts, the review screen
and LO Map badges, and commit writing the review-item links.
