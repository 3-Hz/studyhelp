# Phase 3 — Daily Interleaved Retrieval Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily 10-question session drawn adaptively from every committed lecture, plus the nav restructure and objective suspension that go with it.

**Architecture:** A shared session runner (`lib/session/runner.ts`) drives both session flavours — pending question, grade, cue, write the day — and delegates the four things that differ to a `SessionKind` strategy. Selection is a pure function (`lib/session/select.ts`) that turns candidate review items into an ordered 10-slot plan, frozen on the session row at start.

**Tech Stack:** Bun 1.3+, Next.js 16.2.12 (App Router), React 19, Drizzle ORM over `bun:sqlite`, Zod 4, Vercel AI SDK 7, Tailwind 4. `bun:test` for tests.

**Spec:** `docs/superpowers/specs/2026-09-03-phase-3-daily-practice-design.md`

## Global Constraints

- **Bun only.** No Node. Tests: `bun test`. Types: `bun run typecheck`. Dev server: `bun --bun run dev`. Migrations: `bun run db:generate` then `bun run db:migrate`.
- **Read the bundled Next docs before writing framework code.** `AGENTS.md` requires it: this Next version's APIs may differ from training data. Docs live in `node_modules/next/dist/docs/01-app/`.
- **No new dependencies.**
- **Drizzle `text({enum})` emits plain `text` in SQLite** — enum values are a TypeScript constraint only, and adding one needs no migration.
- **Comment density matches the existing code:** comments explain *why* a rule exists (usually citing `prompt.txt`), never what the line does.
- **Code owns policy, the model owns pedagogy.** Any rule the model could grade or talk its way around belongs in TypeScript.
- Every task ends green on `bun test` and `bun run typecheck` before its commit.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `lib/session/kind.ts` | The `SessionKind` interface and its shared types. No logic. |
| `lib/session/runner.ts` | Turn/answer/hint/finish, flavour-agnostic. Owns the day writer. |
| `lib/session/select.ts` | Pure selection: candidates → ordered plan. Also format narrowing. |
| `lib/session/select.test.ts` | Table-driven tests for selection. |
| `lib/session/candidates.ts` | Database → `Candidate[]`. The only impure half of selection. |
| `lib/session/daily.ts` | The daily strategy and `startDailySession`. |
| `lib/session/daily.test.ts` | End-to-end daily session over a temp database. |
| `app/practice/page.tsx` | Daily Practice: what today holds, start or resume. |
| `app/components/StartDailyButton.tsx` | Client button posting to `/api/sessions`. |
| `app/components/SuspendToggle.tsx` | Client control on each dashboard row. |
| `app/api/objectives/[id]/suspend/route.ts` | Suspend and reactivate one objective. |

**Modified**

| Path | Change |
|---|---|
| `lib/schedule.ts` | Add `daysBetween`. |
| `lib/db/schema.ts` | `"daily"` stage; `sessions.plan`; `sessions.debrief`. |
| `lib/session/sameDay.ts` | Becomes a strategy; its public functions move to the runner. |
| `lib/session/sameDay.test.ts` | One assertion flips in Task 1; imports move in Task 2. |
| `lib/tutor/schema.ts` | Daily brief, `DebriefOutput`, per-slot question schema. |
| `lib/tutor/index.ts` | `allowedFormats`, `targetConcept`, `summariseSession`. |
| `app/components/Nav.tsx` | Four tabs, app name right, underlined active tab. |
| `app/page.tsx` | Becomes a redirect to `/practice`. |
| `app/dashboard/page.tsx` | Suspend control, link fix. |
| `app/sessions/[id]/page.tsx` | Works without a lecture. |
| `app/sessions/[id]/SessionTurn.tsx` | Progress counter, per-question lecture, debrief. |
| `app/api/sessions/route.ts` | Starts a daily session too. |
| `app/api/sessions/[id]/*/route.ts` | Import from the runner. |

**Moved:** `app/page.tsx` → `app/lectures/page.tsx`; `app/lectures/new/` → `app/import/`.

---

### Task 1: Worst-of-day cell merge, and `daysBetween`

Two sessions can land on one date once daily practice exists. The current cell write replaces rather than merges, so the second session to finish erases the first. Fix it before anything can depend on it.

**Files:**
- Modify: `lib/schedule.ts`
- Modify: `lib/session/sameDay.ts:333-350`
- Test: `lib/schedule.test.ts`, `lib/session/sameDay.test.ts:288`

**Interfaces:**
- Consumes: `worstRating(ratings: Rating[]): Rating | undefined` from `lib/schedule.ts`.
- Produces: `daysBetween(from: string, to: string): number` — whole days from one `YYYY-MM-DD` to another, negative when `to` is earlier. Selection uses it for overdueness.

- [ ] **Step 1: Write the failing test for `daysBetween`**

Append to `lib/schedule.test.ts`:

```ts
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
```

Add `daysBetween` to the existing import at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test lib/schedule.test.ts`
Expected: FAIL — `daysBetween is not a function`.

- [ ] **Step 3: Implement `daysBetween`**

In `lib/schedule.ts`, directly below `addDays`:

```ts
/**
 * Whole days from one calendar date to another, negative when `to` is earlier.
 *
 * Parsed as UTC for the same reason addDays is: a daylight-saving boundary
 * between the two dates would otherwise make the difference a fraction and
 * round it to the wrong day.
 */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}
```

- [ ] **Step 4: Confirm it passes**

Run: `bun test lib/schedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Flip the cell-merge test to the correct expectation**

In `lib/session/sameDay.test.ts`, the test currently named `"studying twice in one day updates the cell rather than duplicating it"` asserts `cells[0].rating` is `"green"` after a red session followed by a green one. That is the bug written down as an expectation. Replace the whole test with:

```ts
test("a second session the same day keeps the worst rating, not the latest", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);

  const first = await startSameDaySession(lectureId);
  await playThrough(first, stubTutor(["red", "red", "green", "green", "green"]));
  await finishSession(first);

  const second = await startSameDaySession(lectureId);
  expect(second).not.toBe(first);
  await playThrough(second, stubTutor(["green", "green", "green"]));
  await finishSession(second);

  const cells = await db.query.performances.findMany({
    where: eq(schema.performances.loId, objectives[0].id),
  });

  // Still one cell for the day, and still red: a green that follows a red is
  // recall of the correction just given, whether or not a session boundary
  // falls between them.
  expect(cells).toHaveLength(1);
  expect(cells[0].rating).toBe("red");
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test lib/session/sameDay.test.ts`
Expected: FAIL — expected `"red"`, received `"green"`.

- [ ] **Step 7: Merge instead of replace**

In `lib/session/sameDay.ts`, replace the cell-writing block inside `finishSession` (the `if (testedLoIds.length > 0) { const studyDateId = ... }` block containing `onConflictDoUpdate`) with:

```ts
  if (testedLoIds.length > 0) {
    const studyDateId = await studyDateFor(today);

    for (const loId of testedLoIds) {
      // Merge with whatever is already in today's cell rather than replacing
      // it. Two sessions can share a date — a same-day review and a daily
      // session — and the cell has to describe the whole day.
      const existing = await db.query.performances.findFirst({
        where: and(
          eq(schema.performances.loId, loId),
          eq(schema.performances.studyDateId, studyDateId),
        ),
      });

      const rating =
        worstRating(
          existing ? [existing.rating, ratingByLo[loId]] : [ratingByLo[loId]],
        ) ?? ratingByLo[loId];

      await db
        .insert(schema.performances)
        .values({ loId, studyDateId, rating })
        .onConflictDoUpdate({
          target: [schema.performances.loId, schema.performances.studyDateId],
          set: { rating },
        });
    }
  }
```

`and` and `eq` are already imported in this file.

- [ ] **Step 8: Confirm the whole suite is green**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/schedule.ts lib/schedule.test.ts lib/session/sameDay.ts lib/session/sameDay.test.ts
git commit -m "Keep the worst rating when two sessions share a day"
```

---

### Task 2: Extract the shared runner

Pure refactor. No behaviour changes, and `sameDay.test.ts` must pass untouched apart from its import line — that is the entire safety net for this task.

**Files:**
- Create: `lib/session/kind.ts`, `lib/session/runner.ts`
- Modify: `lib/session/sameDay.ts`, `lib/session/sameDay.test.ts` (imports only), `app/api/sessions/[id]/turn/route.ts`, `app/api/sessions/[id]/answer/route.ts`, `app/api/sessions/[id]/hint/route.ts`, `app/api/sessions/[id]/finish/route.ts`

**Interfaces:**
- Consumes: `capRating`, `nextSchedule`, `todayIso`, `worstRating` from `lib/schedule.ts`; `askQuestion`, `gradeAnswer`, `giveHint`, `ConceptContext`, `TurnContext` from `lib/tutor`.
- Produces, from `lib/session/kind.ts`:
  - `type SessionRow = typeof schema.sessions.$inferSelect`
  - `type AttemptRow = typeof schema.attempts.$inferSelect`
  - `interface TurnRef { stage: SessionStage; loId: number | null; reviewItemId: number | null }`
  - `interface PlannedTurn extends TurnRef { allowedFormats?: QuestionFormat[] }`
  - `interface SessionKind<M>` with `loadMaterial`, `planNext`, `turnContext`, `itemOutcomes`, optional `progress` and `closeOut`
- Produces, from `lib/session/runner.ts`: `currentTurn`, `submitAnswer`, `requestHint`, `finishSession`, `TutorDeps`, `Turn`, `TurnFeedback`, `SessionResult`.
- `lib/session/sameDay.ts` keeps exporting `startSameDaySession` and now also `sameDayKind`.

- [ ] **Step 1: Write `lib/session/kind.ts`**

```ts
import type * as schema from "@/lib/db/schema";
import type { Rating, SessionStage } from "@/lib/db/schema";
import type { QuestionFormat, TurnContext } from "@/lib/tutor";

export type SessionRow = typeof schema.sessions.$inferSelect;
export type AttemptRow = typeof schema.attempts.$inferSelect;

/** Enough to identify what a turn is about, asked or already answered. */
export interface TurnRef {
  stage: SessionStage;
  loId: number | null;
  reviewItemId: number | null;
}

export interface PlannedTurn extends TurnRef {
  /** Formats the model may choose from. Omitted means any. */
  allowedFormats?: QuestionFormat[];
}

/**
 * What differs between the two session flavours. The runner owns everything
 * else: resuming a pending question, capping a hinted rating, writing the day.
 *
 * `M` is the flavour's material — one lecture for the same-day review, a set
 * of items across lectures for daily practice.
 */
export interface SessionKind<M> {
  loadMaterial(session: SessionRow): Promise<M>;

  /** The next thing to ask, or null when the session is complete. */
  planNext(material: M, attempts: AttemptRow[]): PlannedTurn | null;

  /** What the tutor sees, whether asking, grading or cueing. */
  turnContext(turn: TurnRef, material: M): TurnContext;

  /** Which review items move on finishing, and on what rating. */
  itemOutcomes(attempts: AttemptRow[], material: M): Map<number, Rating>;

  /** Where the student is. Omitted when the length is not known in advance. */
  progress?(material: M, attempts: AttemptRow[]): { position: number; total: number | null };

  /** Optional close-out. Whatever it returns is stored on sessions.debrief. */
  closeOut?(args: {
    session: SessionRow;
    attempts: AttemptRow[];
    material: M;
    deps: unknown;
  }): Promise<unknown>;
}
```

- [ ] **Step 2: Write `lib/session/runner.ts`**

Move `TutorDeps`, `REAL_TUTOR`, `Turn`, `TurnFeedback`, `SessionResult`, `currentTurn`, `submitAnswer`, `requestHint`, `finishSession` and `studyDateFor` out of `sameDay.ts` verbatim, then rewrite them against the strategy. The whole file:

```ts
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { capRating, nextSchedule, todayIso, worstRating } from "@/lib/schedule";
import {
  askQuestion,
  gradeAnswer,
  giveHint,
  type QuestionFormat,
} from "@/lib/tutor";
import type { AttemptRow, SessionKind, SessionRow } from "./kind";
import { sameDayKind } from "./sameDay";

/**
 * The parts of a session that do not depend on which flavour it is.
 *
 * Code owns the pacing, the ratings that reach the dashboard, and when items
 * come back. The model only asks, grades and explains — and its rating is
 * advisory until capRating has had the last word.
 */

/** Injectable so tests can run a whole session without a provider. */
export interface TutorDeps {
  askQuestion: typeof askQuestion;
  gradeAnswer: typeof gradeAnswer;
  giveHint: typeof giveHint;
}

const REAL_TUTOR: TutorDeps = { askQuestion, gradeAnswer, giveHint };

export interface Turn {
  attemptId: number;
  stage: AttemptRow["stage"];
  loId: number | null;
  objective: string | null;
  lectureTitle: string | null;
  format: string;
  question: string;
  hintsUsed: boolean;
  position: number;
  /** Null when the session's length is not known in advance. */
  total: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKind = SessionKind<any>;

async function kindFor(session: SessionRow): Promise<AnyKind> {
  if (session.type === "daily") {
    // Imported lazily: daily.ts imports selection, which nothing else needs
    // when a same-day session is running.
    const { dailyKind } = await import("./daily");
    return dailyKind;
  }
  return sameDayKind;
}

interface Loaded {
  session: SessionRow;
  kind: AnyKind;
  material: unknown;
  attempts: AttemptRow[];
}

async function load(sessionId: number): Promise<Loaded> {
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  if (!session) throw new Error(`Session ${sessionId} not found.`);

  const kind = await kindFor(session);
  const material = await kind.loadMaterial(session);

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
    orderBy: [asc(schema.attempts.id)],
  });

  return { session, kind, material, attempts };
}

function toTurn(
  attempt: AttemptRow,
  loaded: Loaded,
): Turn {
  const context = loaded.kind.turnContext(
    {
      stage: attempt.stage,
      loId: attempt.loId,
      reviewItemId: attempt.reviewItemId,
    },
    loaded.material,
  );

  const progress = loaded.kind.progress?.(loaded.material, loaded.attempts) ?? {
    position: loaded.attempts.filter((a) => a.rating !== null).length + 1,
    total: null,
  };

  return {
    attemptId: attempt.id,
    stage: attempt.stage,
    loId: attempt.loId,
    objective: context.objective ?? null,
    lectureTitle: context.lectureTitle || null,
    format: attempt.format,
    question: attempt.question,
    hintsUsed: attempt.hintsUsed,
    position: progress.position,
    total: progress.total,
  };
}

/**
 * The question the student is on, generating it if the session has moved to a
 * new one.
 *
 * A generated question is persisted before it is returned, so refreshing shows
 * the same question rather than quietly swapping it. Null means complete.
 */
export async function currentTurn(
  sessionId: number,
  deps: TutorDeps = REAL_TUTOR,
): Promise<Turn | null> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.rating === null);
  if (pending) return toTurn(pending, loaded);

  const planned = loaded.kind.planNext(loaded.material, loaded.attempts);
  if (!planned) return null;

  const context = loaded.kind.turnContext(planned, loaded.material);

  const question = await deps.askQuestion({
    ...context,
    usedFormats: loaded.attempts.map((a) => a.format as QuestionFormat),
    allowedFormats: planned.allowedFormats,
  });

  const [created] = await db
    .insert(schema.attempts)
    .values({
      sessionId,
      stage: planned.stage,
      loId: planned.loId,
      reviewItemId: planned.reviewItemId,
      format: question.format,
      question: question.question,
    })
    .returning();

  return toTurn(created, { ...loaded, attempts: [...loaded.attempts, created] });
}

export interface TurnFeedback {
  rating: Rating;
  /** The model's rating before capRating. Differs only when a cue was taken. */
  modelRating: Rating;
  grade: Awaited<ReturnType<typeof gradeAnswer>>;
}

export async function submitAnswer(
  sessionId: number,
  answer: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<TurnFeedback> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.rating === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  const context = loaded.kind.turnContext(pending, loaded.material);

  const grade = await deps.gradeAnswer({
    ...context,
    question: pending.question,
    studentAnswer: answer,
    hintsUsed: pending.hintsUsed,
  });

  const rating = capRating(grade.rating, pending.hintsUsed);

  await db
    .update(schema.attempts)
    .set({ studentAnswer: answer, rating, feedback: JSON.stringify(grade) })
    .where(eq(schema.attempts.id, pending.id));

  return { rating, modelRating: grade.rating, grade };
}

/**
 * A cue for the question in hand. Taking one is recorded on the attempt, which
 * is what later caps the rating at yellow.
 */
export async function requestHint(
  sessionId: number,
  partialAnswer?: string,
  deps: TutorDeps = REAL_TUTOR,
): Promise<string> {
  const loaded = await load(sessionId);

  const pending = loaded.attempts.find((attempt) => attempt.rating === null);
  if (!pending) throw new Error("There is no question waiting to be answered.");

  const context = loaded.kind.turnContext(pending, loaded.material);

  const { hint } = await deps.giveHint({
    ...context,
    question: pending.question,
    partialAnswer,
  });

  await db
    .update(schema.attempts)
    .set({ hintsUsed: true })
    .where(eq(schema.attempts.id, pending.id));

  return hint;
}

export interface SessionResult {
  /** One dashboard cell per objective actually tested. */
  cellsWritten: number;
  reviewItemsRescheduled: number;
  ratingByLo: Record<number, Rating>;
}

/**
 * Closes the session and writes the day: one dashboard cell per tested
 * objective, and a new due date for every review item the flavour says moved.
 */
export async function finishSession(
  sessionId: number,
  options: { now?: Date; deps?: TutorDeps } = {},
): Promise<SessionResult> {
  const now = options.now ?? new Date();
  const deps = options.deps ?? REAL_TUTOR;
  const loaded = await load(sessionId);

  if (loaded.session.endedAt) {
    throw new Error("This session has already been finished.");
  }

  const today = todayIso(now);

  // Group the session's graded ratings by objective. A turn with no loId — the
  // lecture summary — assessed the lecture, not an objective, so it earns no
  // cell.
  const ratingsByLo = new Map<number, Rating[]>();
  for (const attempt of loaded.attempts) {
    if (attempt.rating === null || attempt.loId === null) continue;
    const list = ratingsByLo.get(attempt.loId) ?? [];
    list.push(attempt.rating);
    ratingsByLo.set(attempt.loId, list);
  }

  const ratingByLo: Record<number, Rating> = {};
  for (const [loId, ratings] of ratingsByLo) {
    const worst = worstRating(ratings);
    if (worst) ratingByLo[loId] = worst;
  }

  const testedLoIds = Object.keys(ratingByLo).map(Number);

  if (testedLoIds.length > 0) {
    const studyDateId = await studyDateFor(today);

    for (const loId of testedLoIds) {
      // Merge with whatever is already in today's cell rather than replacing
      // it. Two sessions can share a date, and the cell describes the day.
      const existing = await db.query.performances.findFirst({
        where: and(
          eq(schema.performances.loId, loId),
          eq(schema.performances.studyDateId, studyDateId),
        ),
      });

      const rating =
        worstRating(
          existing ? [existing.rating, ratingByLo[loId]] : [ratingByLo[loId]],
        ) ?? ratingByLo[loId];

      await db
        .insert(schema.performances)
        .values({ loId, studyDateId, rating })
        .onConflictDoUpdate({
          target: [schema.performances.loId, schema.performances.studyDateId],
          set: { rating },
        });
    }
  }

  const outcomes = loaded.kind.itemOutcomes(loaded.attempts, loaded.material);
  let reviewItemsRescheduled = 0;

  for (const [itemId, rating] of outcomes) {
    const item = await db.query.reviewItems.findFirst({
      where: eq(schema.reviewItems.id, itemId),
    });
    if (!item) continue;

    const next = nextSchedule(
      { intervalDays: item.intervalDays, lapses: item.lapses },
      rating,
      today,
    );

    await db
      .update(schema.reviewItems)
      .set({
        dueOn: next.dueOn,
        intervalDays: next.intervalDays,
        lapses: next.lapses,
        lastRating: rating,
      })
      .where(eq(schema.reviewItems.id, item.id));

    reviewItemsRescheduled++;
  }

  let debrief: unknown = null;
  if (loaded.kind.closeOut) {
    try {
      debrief = await loaded.kind.closeOut({
        session: loaded.session,
        attempts: loaded.attempts,
        material: loaded.material,
        deps,
      });
    } catch (error) {
      // The cells and the schedule are the session's real output. A summary
      // that failed to generate is not worth losing them over.
      console.error("Debrief failed:", error);
    }
  }

  await db
    .update(schema.sessions)
    .set({ endedAt: now, ...(debrief ? { debrief } : {}) })
    .where(eq(schema.sessions.id, sessionId));

  return {
    cellsWritten: testedLoIds.length,
    reviewItemsRescheduled,
    ratingByLo,
  };
}

/** Today's dashboard column, created only if this is the first study of the day. */
async function studyDateFor(date: string): Promise<number> {
  await db
    .insert(schema.studyDates)
    .values({ date })
    .onConflictDoNothing({ target: schema.studyDates.date });

  const row = await db.query.studyDates.findFirst({
    where: eq(schema.studyDates.date, date),
  });
  if (!row) throw new Error(`Could not resolve a study date for ${date}.`);
  return row.id;
}
```

`sessions.debrief` does not exist until Task 4. Until then the spread `...(debrief ? { debrief } : {})` never fires, because no strategy defines `closeOut` yet — leave the line in place and it starts working when the column lands.

- [ ] **Step 3: Reduce `sameDay.ts` to a strategy**

Keep `startSameDaySession` exactly as it is. Delete everything from `interface SessionContext` to the end of the file and replace it with the material loader plus the strategy object:

```ts
export interface SameDayMaterial {
  lectureTitle: string;
  objectives: (typeof schema.learningObjectives.$inferSelect)[];
  conceptsByLo: Map<number, ConceptContext[]>;
  itemIdsByLo: Map<number, number[]>;
}

export const sameDayKind: SessionKind<SameDayMaterial> = {
  async loadMaterial(session) {
    if (session.lectureId === null) {
      throw new Error("This session is not attached to a lecture.");
    }

    const lecture = await db.query.lectures.findFirst({
      where: eq(schema.lectures.id, session.lectureId),
    });
    if (!lecture) throw new Error("The session's lecture no longer exists.");

    const objectives = await db.query.learningObjectives.findMany({
      where: eq(schema.learningObjectives.lectureId, session.lectureId),
      orderBy: [asc(schema.learningObjectives.orderIndex)],
    });

    const conceptsByLo = new Map<number, ConceptContext[]>();
    const itemIdsByLo = new Map<number, number[]>();

    if (objectives.length > 0) {
      const items = await db.query.reviewItems.findMany({
        where: inArray(
          schema.reviewItems.loId,
          objectives.map((objective) => objective.id),
        ),
      });

      for (const item of items) {
        const concepts = conceptsByLo.get(item.loId) ?? [];
        concepts.push({
          concept: item.concept,
          kind: item.kind,
          provenance: item.provenance,
        });
        conceptsByLo.set(item.loId, concepts);

        const ids = itemIdsByLo.get(item.loId) ?? [];
        ids.push(item.id);
        itemIdsByLo.set(item.loId, ids);
      }
    }

    return { lectureTitle: lecture.title, objectives, conceptsByLo, itemIdsByLo };
  },

  planNext(material, attempts) {
    const graded: GradedTurn[] = attempts
      .filter((attempt) => attempt.rating !== null)
      .map((attempt) => ({
        stage: attempt.stage,
        loId: attempt.loId,
        rating: attempt.rating as Rating,
      }));

    const plan = planNextTurn(material.objectives, graded);
    if (!plan) return null;
    return { stage: plan.stage, loId: plan.loId, reviewItemId: null };
  },

  turnContext(turn, material) {
    const objective = material.objectives.find((o) => o.id === turn.loId);

    // The summary stage is about the whole lecture, so it sees every concept.
    const concepts =
      turn.loId === null
        ? [...material.conceptsByLo.values()].flat()
        : (material.conceptsByLo.get(turn.loId) ?? []);

    return {
      stage: turn.stage,
      lectureTitle: material.lectureTitle,
      objective: objective?.text,
      concepts,
    };
  },

  itemOutcomes(attempts, material) {
    // Phase 2 tests objectives, not concepts, so every item under a tested
    // objective moves on that objective's worst rating for the sitting.
    const ratingsByLo = new Map<number, Rating[]>();
    for (const attempt of attempts) {
      if (attempt.rating === null || attempt.loId === null) continue;
      const list = ratingsByLo.get(attempt.loId) ?? [];
      list.push(attempt.rating);
      ratingsByLo.set(attempt.loId, list);
    }

    const outcomes = new Map<number, Rating>();
    for (const [loId, ratings] of ratingsByLo) {
      const worst = worstRating(ratings);
      if (!worst) continue;
      for (const itemId of material.itemIdsByLo.get(loId) ?? []) {
        outcomes.set(itemId, worst);
      }
    }
    return outcomes;
  },
};
```

Its imports become:

```ts
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { worstRating } from "@/lib/schedule";
import type { ConceptContext } from "@/lib/tutor";
import type { SessionKind } from "./kind";
import { planNextTurn, type GradedTurn } from "./plan";
```

- [ ] **Step 4: Point the tests and routes at the runner**

In `lib/session/sameDay.test.ts`, split the dynamic import so the four driving functions come from the runner:

```ts
const { startSameDaySession } = await import("./sameDay");
const {
  currentTurn,
  finishSession,
  requestHint,
  submitAnswer,
} = await import("./runner");
```

Everything below it — every test body — stays byte-for-byte identical. In each of `app/api/sessions/[id]/turn/route.ts`, `answer/route.ts`, `hint/route.ts` and `finish/route.ts`, change `from "@/lib/session/sameDay"` to `from "@/lib/session/runner"`.

- [ ] **Step 5: Confirm the refactor changed nothing**

Run: `bun test && bun run typecheck`
Expected: PASS, with `sameDay.test.ts`'s assertions untouched since Task 1.

- [ ] **Step 6: Commit**

```bash
git add lib/session app/api/sessions
git commit -m "Extract a session runner shared by both study flavours"
```

---

### Task 3: Selection

The heart of Phase 3, and pure: no database, no clock, no randomness. Ties break on review-item id so a test can assert an exact plan.

**Files:**
- Create: `lib/session/select.ts`, `lib/session/select.test.ts`

**Interfaces:**
- Consumes: `daysBetween` from `lib/schedule.ts`; `Rating`, `ReviewKind` from `lib/db/schema.ts`; `QuestionFormat` from `lib/tutor`.
- Produces: `Candidate`, `PlannedSlot`, `Bucket`, `SESSION_SIZE`, `RECENT_DAYS`, `MAX_PER_LECTURE`, `weakness(c: Candidate): number`, `allowedFormats(family, used, previous?): QuestionFormat[]`, `select(candidates: Candidate[], opts: { today: string; size?: number }): PlannedSlot[]`.

- [ ] **Step 1: Write the failing tests**

Create `lib/session/select.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  allowedFormats,
  select,
  weakness,
  type Candidate,
} from "./select";

const TODAY = "2026-09-03";

/** A candidate with sensible defaults, so each test states only what it means. */
function candidate(overrides: Partial<Candidate> & { reviewItemId: number }): Candidate {
  return {
    loId: overrides.reviewItemId * 100,
    lectureId: 1,
    block: "Renal",
    kind: "fact",
    dueOn: "2099-01-01",
    intervalDays: 0,
    lapses: 0,
    lastRating: null,
    loSuspended: false,
    lectureCommittedOn: "2020-01-01",
    history: [],
    ...overrides,
  };
}

/** n candidates, each on its own objective and lecture unless told otherwise. */
function many(count: number, overrides: (i: number) => Partial<Candidate> = () => ({})): Candidate[] {
  return Array.from({ length: count }, (_, i) =>
    candidate({ reviewItemId: i + 1, lectureId: i + 1, ...overrides(i) }),
  );
}

test("weakness reads the whole colour history, not just the last rating", () => {
  const fresh = candidate({ reviewItemId: 1, lastRating: "green", history: ["green"] });
  const scarred = candidate({
    reviewItemId: 2,
    lastRating: "green",
    history: ["red", "red", "red", "green"],
  });

  expect(weakness(fresh)).toBe(0);
  // Last three colours are red, red, green: 2 + 2 + 0.
  expect(weakness(scarred)).toBe(4);
});

test("weakness counts lapses twice over", () => {
  expect(weakness(candidate({ reviewItemId: 1, lapses: 3 }))).toBe(6);
});

test("suspended objectives never reach the plan", () => {
  const plan = select(many(12, (i) => ({ loSuspended: i < 11 })), { today: TODAY });
  expect(plan).toHaveLength(1);
});

test("the due bucket takes the most overdue four first", () => {
  const candidates = many(12, (i) => ({ dueOn: `2026-08-${String(i + 10).padStart(2, "0")}` }));
  const plan = select(candidates, { today: TODAY });

  const due = plan.filter((slot) => slot.bucket === "due");
  expect(due).toHaveLength(4);
  // 2026-08-10 is the most overdue, and lives on review item 1.
  expect(due.map((slot) => slot.reviewItemId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
});

test("an underfilled bucket hands its slots on rather than shortening the session", () => {
  // Only two items are due; nothing is weak. The recent bucket must cover it.
  const candidates = many(14, (i) => ({
    dueOn: i < 2 ? "2026-08-01" : "2099-01-01",
    lectureCommittedOn: "2026-09-01",
  }));

  const plan = select(candidates, { today: TODAY });
  expect(plan).toHaveLength(10);
  expect(plan.filter((slot) => slot.bucket === "due")).toHaveLength(2);
});

test("no two slots share an objective while the pool allows it", () => {
  const candidates = many(20, (i) => ({ loId: i < 10 ? 1 : i, lectureId: i }));
  const plan = select(candidates, { today: TODAY });

  const los = plan.map((slot) => slot.loId);
  expect(new Set(los).size).toBe(los.length);
});

test("one lecture cannot take more than three slots while others are available", () => {
  const candidates = [
    ...many(8, (i) => ({ lectureId: 1, loId: i + 1, dueOn: "2026-08-01" })),
    ...many(8, (i) => ({ reviewItemId: i + 9, lectureId: i + 2, loId: i + 20 })),
  ];

  const plan = select(candidates, { today: TODAY });
  const fromLectureOne = plan.filter((slot) => slot.bucket !== "interleaved" && slot.loId <= 8);
  expect(fromLectureOne.length).toBeLessThanOrEqual(3);
});

test("a corpus smaller than the session runs short rather than repeating itself", () => {
  const plan = select(many(3), { today: TODAY });
  expect(plan).toHaveLength(3);
  expect(new Set(plan.map((slot) => slot.reviewItemId)).size).toBe(3);
});

test("an entirely suspended corpus yields no session at all", () => {
  expect(select(many(6, () => ({ loSuspended: true })), { today: TODAY })).toEqual([]);
});

test("cumulative slots land at positions five and ten and carry companions", () => {
  const candidates = many(14, (i) => ({ lectureId: i + 1, dueOn: i < 4 ? "2026-08-01" : "2099-01-01" }));
  const plan = select(candidates, { today: TODAY });

  const cumulative = plan.filter((slot) => slot.bucket === "interleaved");
  expect(cumulative.map((slot) => slot.slot)).toEqual([5, 10]);
  for (const slot of cumulative) {
    expect(slot.companionItemIds.length).toBeGreaterThan(0);
    expect(slot.formatFamily).toContain("synthesis");
  }
});

test("consecutive slots move between lectures where the pool allows", () => {
  const candidates = many(12, (i) => ({ lectureId: (i % 4) + 1, loId: i + 1 }));
  const plan = select(candidates, { today: TODAY });

  const lectureOf = (slot: { reviewItemId: number }) =>
    candidates.find((c) => c.reviewItemId === slot.reviewItemId)!.lectureId;

  // Four lectures are available, so the opening run should touch all four
  // rather than working through one lecture at a time. Slots 5 and 10 are
  // cumulative and placed after this ordering pass, so they are not asserted.
  expect(new Set(plan.slice(0, 4).map(lectureOf)).size).toBe(4);
});

test("a format used twice drops out of the allowed set", () => {
  const family = ["free_recall", "short_answer", "error_correction"] as const;
  const narrowed = allowedFormats([...family], ["free_recall", "free_recall"], undefined);
  expect(narrowed).toEqual(["short_answer", "error_correction"]);
});

test("the previous question's format is not offered again immediately", () => {
  const narrowed = allowedFormats(
    ["mechanism", "pathway", "consequence"],
    ["mechanism"],
    "mechanism",
  );
  expect(narrowed).toEqual(["pathway", "consequence"]);
});

test("narrowing to nothing falls back to the whole family rather than asking nothing", () => {
  const family = ["synthesis", "comparison", "discrimination"] as const;
  const used = [...family, ...family];
  expect(allowedFormats([...family], [...used], "synthesis")).toEqual([...family]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test lib/session/select.test.ts`
Expected: FAIL — cannot resolve `./select`.

- [ ] **Step 3: Implement `lib/session/select.ts`**

```ts
import type { Rating, ReviewKind } from "@/lib/db/schema";
import { daysBetween } from "@/lib/schedule";
import type { QuestionFormat } from "@/lib/tutor";

/**
 * Choosing the day's ten questions, per prompt.txt "Daily Anki-Like Retrieval
 * Practice": four due for spaced review, two from recent material, two weak or
 * previously missed, two interleaved or cumulative.
 *
 * Pure by design — no database, no clock, no randomness. Ties break on review
 * item id, so a test can assert an exact plan and a session can be explained
 * after the fact.
 */

export const SESSION_SIZE = 10;
/** A lecture counts as recent for a week after it reaches the dashboard. */
export const RECENT_DAYS = 7;
/** Without a cap, one freshly committed lecture takes the whole session. */
export const MAX_PER_LECTURE = 3;

export type Bucket = "due" | "weak" | "recent" | "interleaved" | "fill";

export interface Candidate {
  reviewItemId: number;
  loId: number;
  lectureId: number;
  block: string | null;
  kind: ReviewKind;
  dueOn: string;
  intervalDays: number;
  lapses: number;
  lastRating: Rating | null;
  loSuspended: boolean;
  lectureCommittedOn: string;
  /** The objective's dashboard colours, oldest first. */
  history: Rating[];
}

export interface PlannedSlot {
  /** 1-based position in the running order. */
  slot: number;
  bucket: Bucket;
  loId: number;
  reviewItemId: number;
  /** Concepts from other lectures a cumulative question should reach for. */
  companionItemIds: number[];
  formatFamily: QuestionFormat[];
}

export const FORMAT_FAMILY: Record<ReviewKind, QuestionFormat[]> = {
  fact: ["free_recall", "short_answer", "error_correction"],
  mechanism: ["mechanism", "pathway", "consequence"],
  application: ["vignette", "patient_teaching", "discrimination"],
};

/** Cumulative slots ask the student to connect or distinguish, never to recite. */
export const CUMULATIVE_FAMILY: QuestionFormat[] = [
  "synthesis",
  "comparison",
  "discrimination",
];

const LAST_RATING_WEIGHT: Record<Rating, number> = {
  red: 3,
  yellow: 1,
  green: 0,
  suspended: 0,
};

const HISTORY_WEIGHT: Record<Rating, number> = {
  red: 2,
  yellow: 1,
  green: 0,
  suspended: 0,
};

/**
 * How badly an item has been going.
 *
 * Reads the last three dashboard colours rather than only the latest rating,
 * per prompt.txt: "Review the full LO history, not only the latest color."
 * Three reds and then a green still scores 4 — one good day does not erase the
 * record.
 */
export function weakness(candidate: Candidate): number {
  const recent = candidate.history.slice(-3);
  return (
    2 * candidate.lapses +
    (candidate.lastRating ? LAST_RATING_WEIGHT[candidate.lastRating] : 0) +
    recent.reduce((sum, rating) => sum + HISTORY_WEIGHT[rating], 0)
  );
}

function isWeak(candidate: Candidate): boolean {
  return (
    candidate.lastRating === "red" ||
    candidate.lastRating === "yellow" ||
    candidate.lapses > 0 ||
    candidate.history.slice(-3).some((r) => r === "red" || r === "yellow")
  );
}

/**
 * The formats the model may pick from for one slot.
 *
 * Narrowed from the slot's family by what the session has already used: no
 * format twice in a row, none more than twice in a session. Falling back to
 * the whole family when narrowing empties it — a repeated format beats no
 * question at all.
 */
export function allowedFormats(
  family: QuestionFormat[],
  used: QuestionFormat[],
  previous?: QuestionFormat,
): QuestionFormat[] {
  const counts = new Map<QuestionFormat, number>();
  for (const format of used) {
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }

  const narrowed = family.filter(
    (format) => (counts.get(format) ?? 0) < 2 && format !== previous,
  );
  return narrowed.length > 0 ? narrowed : family;
}

type Comparator = (a: Candidate, b: Candidate) => number;

/** Ties always break on review item id, which keeps selection reproducible. */
function compose(...comparators: Comparator[]): Comparator {
  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b);
      if (result !== 0) return result;
    }
    return a.reviewItemId - b.reviewItemId;
  };
}

const highestFirst =
  (score: (c: Candidate) => number): Comparator =>
  (a, b) =>
    score(b) - score(a);

interface Pick {
  candidate: Candidate;
  bucket: Bucket;
}

export function select(
  candidates: Candidate[],
  opts: { today: string; size?: number },
): PlannedSlot[] {
  const { today } = opts;
  const size = opts.size ?? SESSION_SIZE;

  // Dark green means do not quiz until reactivated.
  const pool = candidates.filter((candidate) => !candidate.loSuspended);

  const picks: Pick[] = [];
  const takenItems = new Set<number>();
  const takenLos = new Set<number>();
  const perLecture = new Map<number, number>();

  const overdueBy = (c: Candidate) => daysBetween(c.dueOn, today);
  const lectureAge = (c: Candidate) => daysBetween(c.lectureCommittedOn, today);

  function represented(): Set<number> {
    return new Set(picks.map((pick) => pick.candidate.lectureId));
  }

  /** The block most of the session already sits in, if there is one. */
  function modalBlock(): string | null {
    const counts = new Map<string, number>();
    for (const pick of picks) {
      const block = pick.candidate.block;
      if (block) counts.set(block, (counts.get(block) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [block, count] of counts) {
      if (count > bestCount) {
        best = block;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * The best remaining option, relaxing the diversity rules only as far as it
   * must: lecture cap first, since breaching it still varies the objective.
   */
  function pick(options: Candidate[], compare: Comparator): Candidate | undefined {
    const strict = options.filter(
      (c) =>
        !takenLos.has(c.loId) &&
        (perLecture.get(c.lectureId) ?? 0) < MAX_PER_LECTURE,
    );
    const loose = options.filter((c) => !takenLos.has(c.loId));

    for (const list of [strict, loose, options]) {
      if (list.length > 0) return [...list].sort(compare)[0];
    }
    return undefined;
  }

  function take(
    bucket: Bucket,
    want: number,
    eligible: (c: Candidate) => boolean,
    compare: () => Comparator,
  ): number {
    let filled = 0;
    while (filled < want && picks.length < size) {
      const options = pool.filter(
        (c) => !takenItems.has(c.reviewItemId) && eligible(c),
      );
      const chosen = pick(options, compare());
      if (!chosen) break;

      picks.push({ candidate: chosen, bucket });
      takenItems.add(chosen.reviewItemId);
      takenLos.add(chosen.loId);
      perLecture.set(
        chosen.lectureId,
        (perLecture.get(chosen.lectureId) ?? 0) + 1,
      );
      filled++;
    }
    return filled;
  }

  const buckets: {
    bucket: Bucket;
    quota: number;
    eligible: (c: Candidate) => boolean;
    compare: () => Comparator;
  }[] = [
    {
      bucket: "due",
      quota: 4,
      eligible: (c) => c.dueOn <= today,
      compare: () => compose(highestFirst(overdueBy), highestFirst(weakness)),
    },
    {
      bucket: "weak",
      quota: 2,
      eligible: isWeak,
      compare: () => compose(highestFirst(weakness), highestFirst(overdueBy)),
    },
    {
      bucket: "recent",
      quota: 2,
      eligible: (c) => lectureAge(c) <= RECENT_DAYS,
      compare: () =>
        compose(
          highestFirst((c) => (c.lastRating === null ? 1 : 0)),
          (a, b) => lectureAge(a) - lectureAge(b),
        ),
    },
    {
      bucket: "interleaved",
      quota: 2,
      eligible: (c) => !represented().has(c.lectureId),
      compare: () => {
        const block = modalBlock();
        return compose(
          highestFirst((c) => (block !== null && c.block === block ? 1 : 0)),
          highestFirst((c) => c.history.length),
          highestFirst((c) => c.intervalDays),
        );
      },
    },
  ];

  // An underfilled bucket hands its slots to the next one rather than
  // shortening the session: practising something not yet owed costs a little
  // efficiency, and nothing else.
  let carry = 0;
  for (const spec of buckets) {
    // Interleaving is worth exactly two slots. Handing it a large carry would
    // turn a thin day into six cumulative questions, so its overflow goes to
    // the fallback fill below instead.
    const quota =
      spec.bucket === "interleaved" ? spec.quota : spec.quota + carry;
    const want = Math.min(quota, size - picks.length);
    const filled = take(spec.bucket, want, spec.eligible, spec.compare);
    if (spec.bucket !== "interleaved") carry = want - filled;
  }

  if (picks.length < size) {
    take(
      "fill",
      size - picks.length,
      () => true,
      () => compose(highestFirst(overdueBy), highestFirst(weakness)),
    );
  }

  return order(picks);
}

/**
 * The running order, decided after selection.
 *
 * Cumulative questions go at positions 5 and 10, where there is material
 * behind them. The rest avoid consecutive questions from one lecture or of one
 * kind, which is what interleaving is for.
 */
function order(picks: Pick[]): PlannedSlot[] {
  const total = picks.length;
  if (total === 0) return [];

  const cumulative = picks.filter((pick) => pick.bucket === "interleaved");
  const rest = picks.filter((pick) => pick.bucket !== "interleaved");

  const positions =
    total >= SESSION_SIZE
      ? [5, total].slice(0, cumulative.length)
      : cumulative.map((_, index) => total - cumulative.length + index + 1);

  const sequence: (Pick | undefined)[] = new Array(total).fill(undefined);
  cumulative.forEach((pick, index) => {
    const position = positions[index];
    if (position !== undefined) sequence[position - 1] = pick;
  });

  const spread = interleave(rest);
  let cursor = 0;
  for (let index = 0; index < total; index++) {
    if (sequence[index]) continue;
    sequence[index] = spread[cursor++];
  }

  return sequence
    .filter((pick): pick is Pick => pick !== undefined)
    .map((pick, index) => {
      const isCumulative = pick.bucket === "interleaved";
      return {
        slot: index + 1,
        bucket: pick.bucket,
        loId: pick.candidate.loId,
        reviewItemId: pick.candidate.reviewItemId,
        companionItemIds: isCumulative ? companionsFor(pick, picks) : [],
        formatFamily: isCumulative
          ? CUMULATIVE_FAMILY
          : FORMAT_FAMILY[pick.candidate.kind],
      };
    });
}

/** Greedy: take the next item that shares neither lecture nor kind with the last. */
function interleave(picks: Pick[]): Pick[] {
  const remaining = [...picks];
  const out: Pick[] = [];
  let previous: Pick | undefined;

  while (remaining.length > 0) {
    let index = 0;
    if (previous) {
      const differsInBoth = remaining.findIndex(
        (pick) =>
          pick.candidate.lectureId !== previous!.candidate.lectureId &&
          pick.candidate.kind !== previous!.candidate.kind,
      );
      const differsInLecture = remaining.findIndex(
        (pick) => pick.candidate.lectureId !== previous!.candidate.lectureId,
      );
      index = differsInBoth >= 0 ? differsInBoth : Math.max(differsInLecture, 0);
    }

    previous = remaining[index];
    out.push(previous);
    remaining.splice(index, 1);
  }

  return out;
}

/** Up to two concepts from other lectures, for a question that spans them. */
function companionsFor(pick: Pick, picks: Pick[]): number[] {
  return picks
    .filter(
      (other) =>
        other.candidate.reviewItemId !== pick.candidate.reviewItemId &&
        other.candidate.lectureId !== pick.candidate.lectureId,
    )
    .slice(0, 2)
    .map((other) => other.candidate.reviewItemId);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/session/select.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/session/select.ts lib/session/select.test.ts
git commit -m "Add the daily selection algorithm"
```

---

### Task 4: The schema for a planned session

**Files:**
- Modify: `lib/db/schema.ts`
- Create: a generated file under `drizzle/`

**Interfaces:**
- Produces: `sessions.plan` (json, nullable) holding `PlannedSlot[]`; `sessions.debrief` (json, nullable); `"daily"` in `SESSION_STAGES`.

- [ ] **Step 1: Extend the stage list**

In `lib/db/schema.ts`, replace the `SESSION_STAGES` declaration and its comment with:

```ts
/**
 * The same-day review runs lo_recall → summary → elaboration in order
 * (prompt.txt "Same-Day Retrieval Practice"). Daily practice has one stage:
 * its variety comes from the question format, not from a running order.
 */
export const SESSION_STAGES = [
  "lo_recall",
  "summary",
  "elaboration",
  "daily",
] as const;
```

- [ ] **Step 2: Add the two session columns**

In the `sessions` table, after `lectureId`:

```ts
  /**
   * The daily session's chosen slots, frozen at start. Selection depends on
   * the whole corpus at that moment, so freezing it keeps a reload, a tie
   * break and the "4 of 10" counter stable — and leaves the session's
   * reasoning readable afterwards.
   */
  plan: text("plan", { mode: "json" }),
  /** The close-out summary, written when the session is finished. */
  debrief: text("debrief", { mode: "json" }),
```

- [ ] **Step 3: Generate and apply the migration**

```bash
bun run db:generate
bun run db:migrate
```

Expected: a new `drizzle/0002_*.sql` adding two nullable columns. Read it before applying: it must be two `ALTER TABLE ... ADD COLUMN` statements and nothing else. A table rebuild here would mean something else drifted, and should be investigated rather than applied.

- [ ] **Step 4: Confirm nothing broke**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts drizzle
git commit -m "Add the daily stage and the session plan and debrief columns"
```

---

### Task 5: Candidates from the database

The impure half of selection, kept in its own file so `select.ts` stays testable without a database.

**Files:**
- Create: `lib/session/candidates.ts`, `lib/session/candidates.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `lib/session/select.ts`; `todayIso` from `lib/schedule.ts`.
- Produces: `dailyCandidates(): Promise<Candidate[]>`.

- [ ] **Step 1: Write the failing test**

Create `lib/session/candidates.test.ts`:

```ts
import { beforeAll, afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-candidates-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("../db");
const { commitLecture } = await import("../commitLecture");
const { dailyCandidates } = await import("./candidates");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

const draft = {
  title: "Amyloidosis",
  learningObjectives: [{ text: "Describe amyloid fibrils.", slideRefs: [1] }],
  concepts: [
    {
      label: "Beta-pleated sheet",
      detail: "Cross-beta conformation.",
      kind: "fact" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [0],
    },
  ],
  commonConfusions: [],
  conflicts: [],
};

beforeAll(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

test("an uncommitted lecture contributes no candidates", async () => {
  await db.insert(schema.lectures).values({ title: "Draft only", draftExtract: draft });

  expect(await dailyCandidates()).toEqual([]);
});

test("a committed lecture contributes one candidate per review item, carrying its objective's colours", async () => {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: draft.title, block: "Renal", draftExtract: draft })
    .returning({ id: schema.lectures.id });

  await commitLecture(lecture.id, [{ draftIndex: 0, text: draft.learningObjectives[0].text }]);

  const objective = await db.query.learningObjectives.findFirst({
    where: eq(schema.learningObjectives.lectureId, lecture.id),
  });

  const [earlier] = await db
    .insert(schema.studyDates)
    .values({ date: "2026-09-01" })
    .returning({ id: schema.studyDates.id });
  const [later] = await db
    .insert(schema.studyDates)
    .values({ date: "2026-09-02" })
    .returning({ id: schema.studyDates.id });

  // Inserted newest first, to prove the history is sorted by date and not by
  // insertion order.
  await db.insert(schema.performances).values({
    loId: objective!.id,
    studyDateId: later.id,
    rating: "green",
  });
  await db.insert(schema.performances).values({
    loId: objective!.id,
    studyDateId: earlier.id,
    rating: "red",
  });

  const candidates = await dailyCandidates();

  expect(candidates).toHaveLength(1);
  expect(candidates[0].loId).toBe(objective!.id);
  expect(candidates[0].block).toBe("Renal");
  expect(candidates[0].kind).toBe("fact");
  expect(candidates[0].history).toEqual(["red", "green"]);
  expect(candidates[0].loSuspended).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test lib/session/candidates.test.ts`
Expected: FAIL — cannot resolve `./candidates`.

- [ ] **Step 3: Implement `lib/session/candidates.ts`**

```ts
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { todayIso } from "@/lib/schedule";
import type { Candidate } from "./select";

/**
 * Everything the daily session could ask about, flattened for selection.
 *
 * Read as whole tables and assembled here rather than joined in SQL: this is
 * one student's local file, a few hundred rows at most, and the shape the
 * selector wants — an objective's colours as an ordered array — is clearer in
 * TypeScript than in a query.
 */
export async function dailyCandidates(): Promise<Candidate[]> {
  const lectures = await db.query.lectures.findMany();
  const committed = new Map(
    lectures.filter((lecture) => lecture.committedAt).map((l) => [l.id, l]),
  );
  if (committed.size === 0) return [];

  const objectives = await db.query.learningObjectives.findMany();
  const items = await db.query.reviewItems.findMany();
  const performances = await db.query.performances.findMany();
  const studyDates = await db.query.studyDates.findMany();

  const dateById = new Map(studyDates.map((date) => [date.id, date.date]));

  const historyByLo = new Map<number, Rating[]>();
  const chronological = [...performances].sort((a, b) =>
    (dateById.get(a.studyDateId) ?? "").localeCompare(
      dateById.get(b.studyDateId) ?? "",
    ),
  );
  for (const performance of chronological) {
    const colours = historyByLo.get(performance.loId) ?? [];
    colours.push(performance.rating);
    historyByLo.set(performance.loId, colours);
  }

  const objectiveById = new Map(objectives.map((o) => [o.id, o]));
  const candidates: Candidate[] = [];

  for (const item of items) {
    const objective = objectiveById.get(item.loId);
    if (!objective) continue;

    const lecture = committed.get(objective.lectureId);
    // Objectives only reach the dashboard on commit, so an uncommitted
    // lecture has nothing to practise.
    if (!lecture?.committedAt) continue;

    candidates.push({
      reviewItemId: item.id,
      loId: objective.id,
      lectureId: lecture.id,
      block: lecture.block,
      kind: item.kind,
      dueOn: item.dueOn,
      intervalDays: item.intervalDays,
      lapses: item.lapses,
      lastRating: item.lastRating,
      loSuspended: objective.suspended,
      lectureCommittedOn: todayIso(lecture.committedAt),
      history: historyByLo.get(objective.id) ?? [],
    });
  }

  return candidates;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/session/candidates.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/session/candidates.ts lib/session/candidates.test.ts
git commit -m "Assemble daily practice candidates from the database"
```

---

### Task 6: The daily session

**Files:**
- Modify: `lib/tutor/schema.ts`, `lib/tutor/index.ts`
- Create: `lib/session/daily.ts`, `lib/session/daily.test.ts`

**Interfaces:**
- Consumes: `select`, `allowedFormats`, `PlannedSlot` from `lib/session/select.ts`; `dailyCandidates` from `lib/session/candidates.ts`; `SessionKind` from `lib/session/kind.ts`.
- Produces: `startDailySession(now?: Date): Promise<number>`, `dailyKind: SessionKind<DailyMaterial>`; `questionSchemaFor(allowed?: QuestionFormat[])` in `lib/tutor/schema.ts`; `TurnContext.allowedFormats`, `TurnContext.targetConcept` and `ConceptContext.lectureTitle` in `lib/tutor/index.ts`.

- [ ] **Step 1: Let a question's format be constrained by schema**

In `lib/tutor/schema.ts`, below `QuestionOutput`:

```ts
/**
 * The question contract for one slot.
 *
 * Narrowing the enum is how format variety is enforced — prompt.txt's "Do not
 * ask 10 questions in the same format" is a rule about the session, not a
 * judgement about the question, so the model gets no say in it. Validation and
 * repair are already handled by generateStructured.
 */
export function questionSchemaFor(allowed?: QuestionFormat[]) {
  if (!allowed || allowed.length === 0) return QuestionOutput;
  return QuestionOutput.extend({
    format: z.enum(allowed as [QuestionFormat, ...QuestionFormat[]]),
  });
}
```

Then add a `daily` entry to `STAGE_BRIEF` in `lib/tutor/index.ts`:

```ts
  daily: `This is daily retrieval practice, mixing material from several lectures. Ask about the target concept named below and nothing else. The student has met this material before, so do not re-teach it — ask them to retrieve it. Where concepts from other lectures are listed, the question should make the student distinguish or connect them rather than recite either one.`,
```

- [ ] **Step 2: Carry the target, the companions and the allowed formats**

In `lib/tutor/index.ts`, extend the two context types:

```ts
/** A review item, flattened to what the tutor needs to see. */
export interface ConceptContext {
  concept: string;
  kind: string;
  provenance: string;
  /** Set only for concepts pulled in from another lecture. */
  lectureTitle?: string;
}

export interface TurnContext {
  stage: SessionStage;
  lectureTitle: string;
  /** The objective under test. Absent for the whole-lecture summary stage. */
  objective?: string;
  concepts: ConceptContext[];
  /** Which concept this turn is about. Daily practice targets exactly one. */
  targetConcept?: string;
  /** Formats already used this session, so the next question varies. */
  usedFormats?: QuestionFormat[];
  /** The formats this turn may use. Enforced through the output schema. */
  allowedFormats?: QuestionFormat[];
}
```

Update `conceptLines` so a borrowed concept says where it came from:

```ts
function conceptLines(concepts: ConceptContext[]): string {
  if (concepts.length === 0) return "(no concepts were extracted for this objective)";
  return concepts
    .map((c) => {
      const source = c.lectureTitle ? `, from ${c.lectureTitle}` : "";
      return `- [${c.kind}, ${c.provenance}${source}] ${c.concept}`;
    })
    .join("\n");
}
```

And in `askQuestion`, name the target and use the narrowed schema:

```ts
  const prompt = [
    STAGE_BRIEF[context.stage],
    "",
    `Lecture: ${context.lectureTitle}`,
    context.objective ? `Objective: ${context.objective}` : "",
    context.targetConcept ? `Target concept: ${context.targetConcept}` : "",
    "",
    "Concepts available to build from:",
    conceptLines(context.concepts),
    used,
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await generateStructured({
    profile,
    model: options.model,
    schema: questionSchemaFor(context.allowedFormats),
    schemaName: "question",
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
```

Add `questionSchemaFor` to the import from `./schema`.

- [ ] **Step 3: Write the failing daily-session test**

Create `lib/session/daily.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-daily-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("../db");
const { commitLecture } = await import("../commitLecture");
const { todayIso } = await import("../schedule");
const { startDailySession } = await import("./daily");
const { startSameDaySession } = await import("./sameDay");
const { currentTurn, finishSession, submitAnswer } = await import("./runner");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

type TutorDeps = Parameters<typeof currentTurn>[1];
type Rating = "green" | "yellow" | "red";

const KINDS = ["fact", "mechanism", "application"] as const;

/** A lecture with `objectives` objectives, each carrying three concepts. */
function draftFor(title: string, objectives: number) {
  return {
    title,
    learningObjectives: Array.from({ length: objectives }, (_, i) => ({
      text: `${title} objective ${i + 1}`,
      slideRefs: [i + 1],
    })),
    concepts: Array.from({ length: objectives * 3 }, (_, i) => ({
      label: `${title} concept ${i + 1}`,
      detail: `Detail ${i + 1}.`,
      kind: KINDS[i % 3],
      provenance: "taught" as const,
      relatedObjectiveIndexes: [Math.floor(i / 3)],
    })),
    commonConfusions: [],
    conflicts: [],
  };
}

async function seedLecture(title: string, objectives: number, block: string) {
  const draft = draftFor(title, objectives);
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title, block, draftExtract: draft })
    .returning({ id: schema.lectures.id });

  await commitLecture(
    lecture.id,
    draft.learningObjectives.map((objective, index) => ({
      draftIndex: index,
      text: objective.text,
    })),
  );

  return lecture.id;
}

/** A tutor that always picks the first format it is allowed to. */
function stubTutor(ratings: Rating[]): TutorDeps {
  const queue = [...ratings];
  return {
    askQuestion: async (context) => ({
      format: context.allowedFormats?.[0] ?? "free_recall",
      question: `Question about ${context.targetConcept ?? context.objective ?? "the lecture"}`,
    }),
    gradeAnswer: async () => ({
      rating: queue.shift() ?? "green",
      correct: [],
      missing: [],
      incorrect: [],
      correction: "A correction.",
      modelAnswer: "A model answer.",
    }),
    giveHint: async () => ({ hint: "A cue." }),
  } as TutorDeps;
}

async function playThrough(sessionId: number, tutor: TutorDeps) {
  for (let guard = 0; guard < 30; guard++) {
    const turn = await currentTurn(sessionId, tutor);
    if (!turn) return;
    await submitAnswer(sessionId, "An answer.", tutor);
  }
  throw new Error("Session did not terminate.");
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });
  await seedLecture("Amyloidosis", 4, "Renal");
  await seedLecture("Glomerular disease", 4, "Renal");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

test("a daily session plans ten slots across both lectures", async () => {
  const sessionId = await startDailySession();
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });

  const plan = session!.plan as { reviewItemId: number; loId: number; slot: number }[];
  expect(plan).toHaveLength(10);
  expect(new Set(plan.map((slot) => slot.reviewItemId)).size).toBe(10);
  expect(plan.map((slot) => slot.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
});

test("every turn names the review item it is testing, and formats stay varied", async () => {
  const sessionId = await startDailySession();
  const tutor = stubTutor([]);
  await playThrough(sessionId, tutor);

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
  });

  expect(attempts).toHaveLength(10);
  expect(attempts.every((attempt) => attempt.reviewItemId !== null)).toBe(true);
  expect(attempts.every((attempt) => attempt.stage === "daily")).toBe(true);

  const formats = attempts.map((attempt) => attempt.format);
  for (let index = 1; index < formats.length; index++) {
    expect(formats[index]).not.toBe(formats[index - 1]);
  }
  for (const format of new Set(formats)) {
    expect(formats.filter((f) => f === format).length).toBeLessThanOrEqual(2);
  }

  await finishSession(sessionId);
});

test("finishing reschedules only the items actually asked", async () => {
  const sessionId = await startDailySession();
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  const asked = new Set(
    (session!.plan as { reviewItemId: number }[]).map((slot) => slot.reviewItemId),
  );

  const tutor = stubTutor([]);
  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.reviewItemsRescheduled).toBe(10);

  const items = await db.query.reviewItems.findMany();
  const moved = items.filter((item) => item.lastRating !== null).map((item) => item.id);

  // Exactly the ten asked, and nothing else: daily practice grades concepts
  // one at a time, so a sibling under the same objective must not move with it.
  expect(new Set(moved)).toEqual(asked);
  expect(items.length).toBeGreaterThan(moved.length);
});

test("a same-day session and a daily session on one date leave the worst rating", async () => {
  const lectureId = await seedLecture("Tubular disease", 1, "Renal");
  const objective = await db.query.learningObjectives.findFirst({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });

  const sameDay = await startSameDaySession(lectureId);
  await playThrough(sameDay, stubTutor(["red", "green", "green"]));
  await finishSession(sameDay);

  const daily = await startDailySession();
  await playThrough(daily, stubTutor(Array(10).fill("green")));
  await finishSession(daily);

  const studyDate = await db.query.studyDates.findFirst({
    where: eq(schema.studyDates.date, todayIso()),
  });
  const cells = await db.query.performances.findMany({
    where: eq(schema.performances.loId, objective!.id),
  });

  expect(studyDate).toBeDefined();
  expect(cells).toHaveLength(1);
  expect(cells[0].rating).toBe("red");
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `bun test lib/session/daily.test.ts`
Expected: FAIL — cannot resolve `./daily`.

- [ ] **Step 5: Implement `lib/session/daily.ts`**

```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { todayIso } from "@/lib/schedule";
import type { ConceptContext, QuestionFormat } from "@/lib/tutor";
import type { SessionKind } from "./kind";
import { dailyCandidates } from "./candidates";
import { allowedFormats, select, type PlannedSlot } from "./select";

/**
 * Daily interleaved practice: ten questions across every committed lecture,
 * chosen by select() and frozen on the session row.
 *
 * Unlike the same-day review, this tests concepts rather than objectives — one
 * review item per question — so only the item asked moves on the ladder.
 */

type ReviewItemRow = typeof schema.reviewItems.$inferSelect;
type ObjectiveRow = typeof schema.learningObjectives.$inferSelect;

export interface DailyMaterial {
  plan: PlannedSlot[];
  itemById: Map<number, ReviewItemRow>;
  objectiveById: Map<number, ObjectiveRow>;
  lectureTitleById: Map<number, string>;
  siblingsByLo: Map<number, ReviewItemRow[]>;
}

export async function startDailySession(now: Date = new Date()): Promise<number> {
  // Rejoin an unfinished session rather than starting a parallel one, so a
  // closed tab does not split a sitting in two.
  const open = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.type, "daily"),
      isNull(schema.sessions.endedAt),
    ),
  });
  if (open) return open.id;

  const plan = select(await dailyCandidates(), { today: todayIso(now) });
  if (plan.length === 0) {
    throw new Error(
      "Nothing to practise yet. Commit a lecture's objectives, or reactivate a suspended one.",
    );
  }

  const [created] = await db
    .insert(schema.sessions)
    .values({ type: "daily", plan })
    .returning({ id: schema.sessions.id });

  return created.id;
}

export const dailyKind: SessionKind<DailyMaterial> = {
  async loadMaterial(session) {
    const plan = (session.plan ?? []) as PlannedSlot[];
    if (plan.length === 0) {
      throw new Error("This daily session has no plan.");
    }

    const wanted = new Set<number>();
    for (const slot of plan) {
      wanted.add(slot.reviewItemId);
      for (const companion of slot.companionItemIds) wanted.add(companion);
    }

    const planned = await db.query.reviewItems.findMany({
      where: inArray(schema.reviewItems.id, [...wanted]),
    });

    const loIds = [...new Set(plan.map((slot) => slot.loId))];
    const objectives = await db.query.learningObjectives.findMany({
      where: inArray(schema.learningObjectives.id, loIds),
    });

    // Siblings give a question its surrounding context without becoming its
    // target: the slot asks about one concept, not the whole objective.
    const siblings = await db.query.reviewItems.findMany({
      where: inArray(schema.reviewItems.loId, loIds),
    });

    const lectures = await db.query.lectures.findMany({
      where: inArray(
        schema.lectures.id,
        [...new Set(objectives.map((objective) => objective.lectureId))],
      ),
    });

    const siblingsByLo = new Map<number, ReviewItemRow[]>();
    for (const item of siblings) {
      const list = siblingsByLo.get(item.loId) ?? [];
      list.push(item);
      siblingsByLo.set(item.loId, list);
    }

    return {
      plan,
      itemById: new Map([...planned, ...siblings].map((item) => [item.id, item])),
      objectiveById: new Map(objectives.map((objective) => [objective.id, objective])),
      lectureTitleById: new Map(lectures.map((lecture) => [lecture.id, lecture.title])),
      siblingsByLo,
    };
  },

  planNext(material, attempts) {
    const asked = new Set(
      attempts
        .map((attempt) => attempt.reviewItemId)
        .filter((id): id is number => id !== null),
    );

    const next = material.plan.find((slot) => !asked.has(slot.reviewItemId));
    if (!next) return null;

    const used = attempts.map((attempt) => attempt.format as QuestionFormat);

    return {
      stage: "daily",
      loId: next.loId,
      reviewItemId: next.reviewItemId,
      allowedFormats: allowedFormats(
        next.formatFamily,
        used,
        used[used.length - 1],
      ),
    };
  },

  turnContext(turn, material) {
    const objective = turn.loId === null ? undefined : material.objectiveById.get(turn.loId);
    const item = turn.reviewItemId === null ? undefined : material.itemById.get(turn.reviewItemId);
    const slot = material.plan.find((s) => s.reviewItemId === turn.reviewItemId);

    const flatten = (row: ReviewItemRow, lectureTitle?: string): ConceptContext => ({
      concept: row.concept,
      kind: row.kind,
      provenance: row.provenance,
      ...(lectureTitle ? { lectureTitle } : {}),
    });

    const siblings = (objective ? material.siblingsByLo.get(objective.id) ?? [] : []).filter(
      (row) => row.id !== item?.id,
    );

    const companions = (slot?.companionItemIds ?? [])
      .map((id) => material.itemById.get(id))
      .filter((row): row is ReviewItemRow => row !== undefined)
      .map((row) => {
        const owner = material.objectiveById.get(row.loId);
        const title = owner ? material.lectureTitleById.get(owner.lectureId) : undefined;
        return flatten(row, title ?? "another lecture");
      });

    const lectureTitle = objective
      ? (material.lectureTitleById.get(objective.lectureId) ?? "")
      : "";

    return {
      stage: "daily",
      lectureTitle,
      objective: objective?.text,
      targetConcept: item?.concept,
      concepts: [
        ...(item ? [flatten(item)] : []),
        ...siblings.map((row) => flatten(row)),
        ...companions,
      ],
    };
  },

  itemOutcomes(attempts) {
    // One question, one item: the concept asked is the concept that moves.
    const outcomes = new Map<number, Rating>();
    for (const attempt of attempts) {
      if (attempt.rating === null || attempt.reviewItemId === null) continue;
      outcomes.set(attempt.reviewItemId, attempt.rating);
    }
    return outcomes;
  },

  progress(material, attempts) {
    // Graded attempts only: the question in hand is the one being counted, not
    // one already behind the student.
    const answered = attempts.filter((attempt) => attempt.rating !== null).length;
    return {
      position: Math.min(answered + 1, material.plan.length),
      total: material.plan.length,
    };
  },
};
```

- [ ] **Step 6: Run the tests**

Run: `bun test && bun run typecheck`
Expected: PASS, including the whole existing suite.

- [ ] **Step 7: Commit**

```bash
git add lib/session/daily.ts lib/session/daily.test.ts lib/tutor
git commit -m "Add the daily interleaved practice session"
```

---

### Task 7: The end-of-session debrief

**Files:**
- Modify: `lib/tutor/schema.ts`, `lib/tutor/index.ts`, `lib/session/kind.ts`, `lib/session/runner.ts`, `lib/session/daily.ts`, `lib/session/daily.test.ts`

**Interfaces:**
- Produces: `DebriefOutput` and `summariseSession(request, options?)` in `lib/tutor`; `TutorDeps` moves to `lib/session/kind.ts` and gains `summariseSession`; `SessionResult.debrief: DebriefOutput | null`.

- [ ] **Step 1: Add the debrief contract**

In `lib/tutor/schema.ts`, after `HintOutput`:

```ts
/**
 * The close-out summary (prompt.txt "Session Completion").
 *
 * Short arrays, not paragraphs: the student has just done ten retrievals, and
 * a wall of text at the end invites rereading instead of recall.
 */
export const DebriefOutput = z.object({
  heldUp: z.array(z.string()).describe("What the student retrieved well."),
  shaky: z.array(z.string()).describe("What was partial or needed cues."),
  misconceptions: z
    .array(z.string())
    .describe("Specific wrong beliefs the session surfaced. Empty if none did."),
  focusNext: z
    .string()
    .describe("The single most useful thing to work on next, in one sentence."),
});

export type DebriefOutput = z.infer<typeof DebriefOutput>;
```

- [ ] **Step 2: Add the call**

In `lib/tutor/index.ts`, at the end:

```ts
export interface DebriefRequest {
  answered: {
    question: string;
    rating: string;
    missing: string[];
    incorrect: string[];
  }[];
}

/**
 * The session's close-out. Never marks anything mastered: one correct answer
 * is not mastery, and saying so would undo the point of the ladder.
 */
export async function summariseSession(
  request: DebriefRequest,
  options: TutorOptions = {},
): Promise<DebriefOutput> {
  const profile = options.profile ?? profileFor("tutor");

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
  ].join("\n");

  const { value } = await generateStructured({
    profile,
    model: options.model,
    schema: DebriefOutput,
    schemaName: "debrief",
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  return value;
}
```

Add `DebriefOutput` to the import from `./schema`.

- [ ] **Step 3: Move `TutorDeps` to `kind.ts` so a strategy can use it**

In `lib/session/kind.ts`, add the import and the interface, and type `closeOut`'s deps properly:

```ts
import type {
  askQuestion,
  gradeAnswer,
  giveHint,
  summariseSession,
} from "@/lib/tutor";

/** Injectable so tests can run a whole session without a provider. */
export interface TutorDeps {
  askQuestion: typeof askQuestion;
  gradeAnswer: typeof gradeAnswer;
  giveHint: typeof giveHint;
  summariseSession: typeof summariseSession;
}
```

and change `closeOut`'s argument type from `deps: unknown` to `deps: TutorDeps`.

In `lib/session/runner.ts`, delete the local `TutorDeps` interface, import it from `./kind`, re-export it (`export type { TutorDeps } from "./kind";`), and add `summariseSession` to `REAL_TUTOR`.

- [ ] **Step 4: Have the runner return what it stored**

In `lib/session/runner.ts`, add to `SessionResult`:

```ts
  /** Null when the session has no close-out, or the summary call failed. */
  debrief: DebriefOutput | null;
```

and return `debrief: (debrief as DebriefOutput) ?? null` from `finishSession`.

- [ ] **Step 5: Write the daily strategy's `closeOut`**

Append to `dailyKind` in `lib/session/daily.ts`:

```ts
  async closeOut({ attempts, deps }) {
    const answered = attempts
      .filter((attempt) => attempt.rating !== null)
      .map((attempt) => {
        const grade = attempt.feedback
          ? (JSON.parse(attempt.feedback) as {
              missing?: string[];
              incorrect?: string[];
            })
          : {};
        return {
          question: attempt.question,
          rating: attempt.rating as string,
          missing: grade.missing ?? [],
          incorrect: grade.incorrect ?? [],
        };
      });

    if (answered.length === 0) return null;
    return deps.summariseSession({ answered });
  },
```

- [ ] **Step 6: Add the debrief to the daily test's stub and assert it lands**

In `lib/session/daily.test.ts`, add to `stubTutor`'s returned object:

```ts
    summariseSession: async () => ({
      heldUp: ["Fibril structure"],
      shaky: ["AL versus ATTR"],
      misconceptions: [],
      focusNext: "Practise distinguishing the two precursor proteins.",
    }),
```

and append a test:

```ts
test("finishing writes a debrief onto the session", async () => {
  const sessionId = await startDailySession();
  const tutor = stubTutor([]);
  await playThrough(sessionId, tutor);

  const result = await finishSession(sessionId, { deps: tutor });
  expect(result.debrief?.focusNext).toMatch(/precursor/i);

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect((session!.debrief as { heldUp: string[] }).heldUp).toEqual(["Fibril structure"]);
});
```

- [ ] **Step 7: Inject the tutor everywhere the daily test finishes a session**

`finishSession` now calls `closeOut`, which calls the model. Every
`finishSession(...)` call in `lib/session/daily.test.ts` must pass the stub —
find each one and give it `{ deps: tutor }`:

```ts
  await finishSession(sessionId, { deps: tutor });
```

The failure this prevents is quiet rather than red: `closeOut` is wrapped in a
try/catch, so an un-injected call makes a real network request, slows the suite
and passes anyway. `sameDay.test.ts` needs no change — the same-day strategy
has no `closeOut`.

- [ ] **Step 8: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS. Watch the suite's duration: a jump of several seconds means a
`finishSession` call is still reaching a provider.

- [ ] **Step 9: Commit**

```bash
git add lib/tutor lib/session
git commit -m "Summarise a finished daily session"
```

---

### Task 8: The top bar

**Files:**
- Move: `app/page.tsx` → `app/lectures/page.tsx`; `app/lectures/new/` → `app/import/`
- Create: `app/page.tsx`
- Modify: `app/components/Nav.tsx`, `app/dashboard/page.tsx:56`

**Interfaces:** No exported changes. `/` becomes a redirect to `/practice`.

- [ ] **Step 1: Move the two pages**

```bash
git mv app/page.tsx app/lectures/page.tsx
git mv app/lectures/new app/import
```

`app/lectures/` already holds `[id]/`; adding `page.tsx` beside it gives the segment its own index. In the moved `app/lectures/page.tsx`, change the `/lectures/new` link to `/import`. In `app/dashboard/page.tsx`, change the `/lectures/new` link to `/import`. In `app/import/page.tsx`, leave the post-upload `router.push` alone: it already goes to `/lectures/${id}/review`.

- [ ] **Step 2: Redirect the root**

Create `app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

/**
 * The daily session is what most days start with, so bare / goes there rather
 * than to the lecture list.
 */
export default function HomePage() {
  redirect("/practice");
}
```

- [ ] **Step 3: Rewrite the nav**

Replace `app/components/Nav.tsx` entirely:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/lectures", label: "Review Lectures" },
  { href: "/practice", label: "Daily Practice" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/import", label: "Import Content" },
];

const base = "border-b-2 pb-1 text-sm transition-colors";
const inactive =
  "border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100";
const active =
  "border-stone-900 font-medium text-stone-900 dark:border-stone-100 dark:text-stone-100";

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
      <div className="flex items-center gap-6">
        {tabs.map(({ href, label }) => {
          // No tab owns /sessions: a session can be reached from either
          // Review Lectures or Daily Practice, and guessing would be wrong
          // half the time.
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`${base} ${isActive ? active : inactive}`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <Link href="/" className="font-semibold tracking-tight">
        studyhelp
      </Link>
    </nav>
  );
}
```

- [ ] **Step 4: Check it by eye**

Run: `bun --bun run dev`, then open http://localhost:3000. Expected: `/` lands on `/practice` (which 404s until Task 9 — that is correct at this point), `/lectures` lists lectures with Review Lectures underlined, `/import` shows the upload form with Import Content underlined and Review Lectures *not* underlined, `/dashboard` underlines Dashboard. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add app
git commit -m "Restructure the top bar around the four screens"
```

---

### Task 9: Daily Practice

**Files:**
- Create: `app/practice/page.tsx`, `app/components/StartDailyButton.tsx`
- Modify: `app/api/sessions/route.ts`

**Interfaces:**
- Consumes: `dailyCandidates`, `startDailySession`, `todayIso`.
- Produces: `POST /api/sessions` accepts `{ type: "daily" }` as well as `{ lectureId }`.

- [ ] **Step 1: Let the endpoint start a daily session**

Replace the body of `POST` in `app/api/sessions/route.ts`:

```ts
    const body = (await request.json()) as { lectureId?: number; type?: string };

    if (body.type === "daily") {
      const sessionId = await startDailySession();
      return NextResponse.json({ sessionId });
    }

    const lectureId = Number(body.lectureId);
    if (!Number.isInteger(lectureId)) {
      return NextResponse.json({ error: "Bad lecture id." }, { status: 400 });
    }

    const sessionId = await startSameDaySession(lectureId);
    return NextResponse.json({ sessionId });
```

and add `import { startDailySession } from "@/lib/session/daily";`.

- [ ] **Step 2: Write the start button**

Create `app/components/StartDailyButton.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StartDailyButton({ resuming }: { resuming: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "daily" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start.");
      router.push(`/sessions/${data.sessionId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
      >
        {busy ? "Starting…" : resuming ? "Resume today's session" : "Start today's session"}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Write the page**

Create `app/practice/page.tsx`:

```tsx
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { StartDailyButton } from "@/app/components/StartDailyButton";
import { db, schema } from "@/lib/db";
import { todayIso } from "@/lib/schedule";
import { dailyCandidates } from "@/lib/session/candidates";

export const dynamic = "force-dynamic";

export default async function PracticePage() {
  const today = todayIso();
  const candidates = await dailyCandidates();
  const eligible = candidates.filter((candidate) => !candidate.loSuspended);

  const due = eligible.filter((candidate) => candidate.dueOn <= today);
  const objectives = new Set(eligible.map((candidate) => candidate.loId));
  const lectures = new Set(eligible.map((candidate) => candidate.lectureId));

  const open = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.type, "daily"), isNull(schema.sessions.endedAt)),
  });

  const finished = (
    await db.query.sessions.findMany({ where: eq(schema.sessions.type, "daily") })
  ).filter((session) => session.endedAt && todayIso(session.endedAt) === today);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Daily practice</h1>

      {eligible.length === 0 ? (
        <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
          {candidates.length === 0 ? (
            <>
              Nothing to practise yet.{" "}
              <Link href="/import" className="underline">
                Import a lecture
              </Link>{" "}
              and approve its objectives first.
            </>
          ) : (
            <>
              Every objective is suspended. Reactivate one on the{" "}
              <Link href="/dashboard" className="underline">
                dashboard
              </Link>{" "}
              to practise again.
            </>
          )}
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
            {due.length} concept{due.length === 1 ? "" : "s"} due today, from{" "}
            {objectives.size} objective{objectives.size === 1 ? "" : "s"} across{" "}
            {lectures.size} lecture{lectures.size === 1 ? "" : "s"}.
          </p>

          {eligible.length < 10 && (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Only {eligible.length} concepts exist so far, so today&rsquo;s
              session will be that long rather than ten questions.
            </p>
          )}

          <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
            Ten questions: four due for review, two weak, two from recent
            material, and two that cross lectures. Nothing due yet is practised
            early rather than skipped.
          </p>

          <StartDailyButton resuming={open !== undefined} />

          {finished.length > 0 && (
            <p className="mt-6 text-xs text-stone-500">
              {finished.length} session{finished.length === 1 ? "" : "s"} already
              finished today. Another is fine — today&rsquo;s dashboard cell keeps
              the worst rating of them all.
            </p>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Check it by eye**

Run: `bun --bun run dev`, open http://localhost:3000 — it should land on Daily Practice with a real due count. Do not start a session yet; the session page is Task 10. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add app
git commit -m "Add the Daily Practice screen"
```

---

### Task 10: A session page that is not about one lecture

**Files:**
- Modify: `app/sessions/[id]/page.tsx`, `app/sessions/[id]/SessionTurn.tsx`

**Interfaces:** `SessionTurn` takes `{ sessionId: number; heading: string }` instead of `{ sessionId, objectiveCount }`.

- [ ] **Step 1: Put the debrief in its own file**

Both the finished-session page (a server component) and `SessionTurn` (a client
one) render it. It cannot live in `page.tsx`: importing it from a `"use client"`
module would pull that whole file — and with it Drizzle and the database — into
the browser bundle.

Create `app/sessions/[id]/Debrief.tsx`:

```tsx
import type { DebriefOutput } from "@/lib/tutor/schema";

export function Debrief({ debrief }: { debrief: DebriefOutput }) {
  return (
    <div className="mt-6 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
      <List title="Held up" items={debrief.heldUp} />
      <List title="Shaky" items={debrief.shaky} />
      <List title="Misconceptions to fix" items={debrief.misconceptions} />
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Next
        </h3>
        <p className="mt-1 text-sm">{debrief.focusNext}</p>
      </div>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Let the page render a lecture-less session**

Replace `app/sessions/[id]/page.tsx`:

```tsx
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/lib/db";
import type { DebriefOutput } from "@/lib/tutor/schema";
import { Debrief } from "./Debrief";
import SessionTurn from "./SessionTurn";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) notFound();

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  if (!session) notFound();

  let heading = "Daily practice";
  if (session.lectureId !== null) {
    const lecture = await db.query.lectures.findFirst({
      where: eq(schema.lectures.id, session.lectureId),
    });
    if (!lecture) notFound();
    heading = lecture.title;
  }

  if (session.endedAt) {
    const debrief = session.debrief as DebriefOutput | null;
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
        {debrief && <Debrief debrief={debrief} />}
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
      <SessionTurn sessionId={sessionId} heading={heading} />
    </div>
  );
}
```

- [ ] **Step 3: Teach `SessionTurn` about daily turns**

In `app/sessions/[id]/SessionTurn.tsx`, make these edits.

The `Turn` interface and stage label gain the daily stage, and turns now carry their own lecture and position:

```tsx
interface Turn {
  attemptId: number;
  stage: "lo_recall" | "summary" | "elaboration" | "daily";
  loId: number | null;
  objective: string | null;
  lectureTitle: string | null;
  format: string;
  question: string;
  hintsUsed: boolean;
  position: number;
  total: number | null;
}

const STAGE_LABEL: Record<Turn["stage"], string> = {
  lo_recall: "Objective recall",
  summary: "Lecture summary",
  elaboration: "Elaboration",
  daily: "Daily practice",
};
```

The props change, and the finish response is kept so the debrief can be shown:

```tsx
export default function SessionTurn({
  sessionId,
  heading,
}: {
  sessionId: number;
  heading: string;
}) {
```

Delete the `graded` state and its `setGraded` call — `turn.position` replaces it. Add, beside the other state:

```tsx
  const [result, setResult] = useState<
    { cellsWritten: number; debrief: DebriefOutput | null } | null
  >(null);
```

with `import type { DebriefOutput } from "@/lib/tutor/schema";` and `import { Debrief } from "./Debrief";` at the top.

`finish` keeps its result instead of navigating away:

```tsx
  async function finish() {
    setBusy("finishing");
    setError(null);
    try {
      const finished = await post<{
        cellsWritten: number;
        debrief: DebriefOutput | null;
      }>(`/api/sessions/${sessionId}/finish`, {});
      setResult(finished);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finish.");
    } finally {
      setBusy(null);
    }
  }
```

Add a completion branch immediately above the existing `if (done)` block:

```tsx
  if (result) {
    return (
      <div className="mt-8">
        <h2 className="text-lg font-medium">Recorded.</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          {result.cellsWritten} dashboard cell
          {result.cellsWritten === 1 ? "" : "s"} written for today.
        </p>
        {result.debrief && <Debrief debrief={result.debrief} />}
        <Link href="/dashboard" className="mt-6 inline-block text-sm underline">
          Back to the dashboard
        </Link>
      </div>
    );
  }
```

with `import Link from "next/link";` at the top. The `done` branch's copy is written for a lecture, so make it fit both:

```tsx
        <h2 className="text-lg font-medium">
          {heading === "Daily practice" ? "That is today's ten." : "That is the whole lecture."}
        </h2>
```

Finally, replace the progress line in the question header:

```tsx
        <span>
          {turn.total ? `${turn.position} of ${turn.total}` : `Question ${turn.position}`}
        </span>
```

and show the lecture above the objective, since it changes from question to question:

```tsx
      {turn.lectureTitle && (
        <p className="mt-3 text-[10px] uppercase tracking-wide text-stone-400">
          {turn.lectureTitle}
        </p>
      )}
```

`router` is now unused in this component — delete the `useRouter` import and the `const router = useRouter()` line.

- [ ] **Step 4: Run a real session end to end**

Run: `bun --bun run dev`. From `/practice`, start a session and answer two or three questions. Expected: each question shows "1 of 10", names its lecture, and grades. Finish it and check the debrief renders and the dashboard shows today's column. Stop the server.

- [ ] **Step 5: Confirm nothing regressed**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app
git commit -m "Run daily sessions through the session screen"
```

---

### Task 11: Suspending an objective

**Files:**
- Create: `app/api/objectives/[id]/suspend/route.ts`, `app/components/SuspendToggle.tsx`
- Modify: `app/dashboard/page.tsx`

**Interfaces:**
- Produces: `POST /api/objectives/[id]/suspend` with body `{ suspended: boolean }`, returning `{ suspended: boolean }`.

- [ ] **Step 1: Write the endpoint**

Create `app/api/objectives/[id]/suspend/route.ts`:

```ts
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";

/**
 * Dark green: stop quizzing this objective until it is reactivated.
 *
 * A row state, not a dashboard cell — writing a cell would claim the objective
 * was tested that day, and untested cells stay blank by construction.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const loId = Number(id);
    if (!Number.isInteger(loId)) {
      return NextResponse.json({ error: "Bad objective id." }, { status: 400 });
    }

    const body = (await request.json()) as { suspended?: boolean };
    const suspended = body.suspended === true;

    const [updated] = await db
      .update(schema.learningObjectives)
      .set({ suspended })
      .where(eq(schema.learningObjectives.id, loId))
      .returning({ suspended: schema.learningObjectives.suspended });

    if (!updated) {
      return NextResponse.json({ error: "No such objective." }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update the objective.";
    console.error("Suspend failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 2: Write the control**

Create `app/components/SuspendToggle.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SuspendToggle({
  objectiveId,
  suspended,
}: {
  objectiveId: number;
  suspended: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await fetch(`/api/objectives/${objectiveId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: !suspended }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={
        suspended
          ? "Reactivate: this objective can be quizzed again"
          : "Suspend: stop quizzing this objective"
      }
      className="text-[10px] uppercase tracking-wide text-stone-400 underline hover:text-stone-700 disabled:opacity-40 dark:hover:text-stone-200"
    >
      {suspended ? "Reactivate" : "Suspend"}
    </button>
  );
}
```

- [ ] **Step 3: Put it on every row**

In `app/dashboard/page.tsx`, import the control (`import { SuspendToggle } from "@/app/components/SuspendToggle";`) and replace the contents of the row header cell:

```tsx
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-r border-stone-200 bg-inherit px-4 py-3 text-left font-normal dark:border-stone-800"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="block text-[10px] uppercase tracking-wide text-stone-400">
                      {lectureTitleById.get(objective.lectureId)}
                    </span>
                    <SuspendToggle
                      objectiveId={objective.id}
                      suspended={objective.suspended}
                    />
                  </span>
                  <span
                    className={
                      objective.suspended ? "text-stone-400 dark:text-stone-600" : ""
                    }
                  >
                    {objective.suspended && (
                      <span
                        title="Suspended — not quizzed until reactivated"
                        className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-emerald-900 align-middle"
                      />
                    )}
                    {objective.text}
                  </span>
                </th>
```

Then fix the legend, which currently implies dark green is a cell colour. Replace the `suspended` entry in `CELL_LABEL` usage by rendering the legend from the three real cell colours and adding a separate note:

```tsx
      <div className="mt-6 flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-400">
        {(["green", "yellow", "red"] as Rating[]).map((rating) => (
          <span key={rating} className="flex items-center gap-1.5">
            <span
              className={`inline-block h-3 w-3 rounded-sm ${CELL_STYLE[rating]}`}
            />
            {CELL_LABEL[rating]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-emerald-900" />
          Suspended — marks the objective, not a day
        </span>
      </div>
```

Also change the empty-state link from `/lectures/new` to `/import` if Task 8 has not already.

- [ ] **Step 4: Check the whole loop by hand**

Run: `bun --bun run dev`. On `/dashboard`, suspend an objective; expect the row to grey with a dark-green marker. Go to `/practice` and confirm the due count dropped by that objective's concepts. Reactivate it and confirm the count returns. Stop the server.

- [ ] **Step 5: Confirm the suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app
git commit -m "Suspend and reactivate objectives from the dashboard"
```

---

## Finishing

After Task 11, update `README.md`: change the status section so Phase 3 reads as implemented rather than planned, and add `select.ts`, `candidates.ts`, `daily.ts`, `runner.ts` and `kind.ts` to the layout tree. Commit that separately.
