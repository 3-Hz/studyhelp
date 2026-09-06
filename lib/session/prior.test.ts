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

// The expected ["In progress"] was planted two tests earlier, in "a direct
// attempt on the item beats the objective's...", by the openId session's
// graded red. "daysAgo counts calendar days" backdates that same attempt's
// createdAt, but recency here is decided by id (see priorAttempts), not by
// createdAt, so the backdating does not change which attempt is latest.
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
