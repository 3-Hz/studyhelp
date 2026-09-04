import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";

const TEST_DB = `./.test-daily-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("../db");
const { commitLecture } = await import("../commitLecture");
const { todayIso } = await import("../schedule");
const { startDailySession } = await import("./daily");
const { startSameDaySession } = await import("./sameDay");
const { currentTurn, finishSession, submitAnswer } = await import("./runner");
const { FORMAT_FAMILY } = await import("./select");
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
      // Kind varies per objective, not per concept: select() takes one item
      // per objective (ties broken by lowest id), so if every objective's
      // first concept were the same kind, that one format family would
      // absorb most of the session and blow past its cap of two per format.
      // Rotating by objective spreads picks across families, but does not
      // give the fact family headroom: four objectives rotate to fact across
      // the two lectures, and both "fill" slots (select()'s fallback for a
      // corpus smaller than SESSION_SIZE) land on Amyloidosis objective 1,
      // also fact — six fact-kind slots against a budget of exactly six
      // (FORMAT_FAMILY.fact's 3 formats x 2 uses each). Zero slack, not
      // headroom. The test below asserts that budget directly, so a fixture
      // that outgrows it fails on the budget line instead of on a
      // distribution assertion that would implicate the wrong code. A real
      // corpus concentrated in one kind would still exhaust a family and
      // trip the documented "a repeat beats no question" fallback in
      // allowedFormats.
      kind: KINDS[Math.floor(i / 3) % 3],
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
    summariseSession: async () => ({
      heldUp: ["Fibril structure"],
      shaky: ["AL versus ATTR"],
      misconceptions: [],
      focusNext: "Practise distinguishing the two precursor proteins.",
    }),
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

  // Precondition, not luck: the fact family has 3 formats capped at 2 uses
  // each (allowedFormats), a budget of 6. Fail here, with a clear message,
  // if the fixture ever supplies more fact-kind slots than that — rather
  // than in the distribution assertions below, where the failure would look
  // like a bug in allowedFormats instead of a fixture that outgrew its
  // budget.
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  const plannedItemIds = (session!.plan as { reviewItemId: number }[]).map(
    (slot) => slot.reviewItemId,
  );
  const plannedItems = await db.query.reviewItems.findMany({
    where: inArray(schema.reviewItems.id, plannedItemIds),
  });
  const factSlots = plannedItems.filter((item) => item.kind === "fact").length;
  expect(factSlots).toBeLessThanOrEqual(FORMAT_FAMILY.fact.length * 2);

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

  await finishSession(sessionId, { deps: tutor });
});

test("finishing reschedules only the items actually asked", async () => {
  // The whole file shares one database, so earlier tests have already moved
  // items. Compare each item against its own prior state rather than asking
  // which items look touched — the question is what THIS session changed.
  const stateOf = (item: { dueOn: string; intervalDays: number; lapses: number; lastRating: string | null }) =>
    `${item.dueOn}|${item.intervalDays}|${item.lapses}|${item.lastRating}`;

  const before = new Map(
    (await db.query.reviewItems.findMany()).map((item) => [item.id, stateOf(item)]),
  );

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

  const after = await db.query.reviewItems.findMany();
  const changed = new Set(
    after.filter((item) => before.get(item.id) !== stateOf(item)).map((item) => item.id),
  );

  // Exactly the ten asked, and nothing else: daily practice grades concepts one
  // at a time, so a sibling under the same objective must not move with it.
  // The stub grades everything green, so every rescheduled item's interval
  // strictly advances — a moved item cannot land back on its previous state.
  expect(changed).toEqual(asked);
  expect(after.length).toBeGreaterThan(changed.size);
});

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

test("a same-day session and a daily session on one date leave the worst rating", async () => {
  const lectureId = await seedLecture("Tubular disease", 1, "Renal");
  const objective = await db.query.learningObjectives.findFirst({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });

  const sameDayTutor = stubTutor(["red", "green", "green"]);
  const sameDay = await startSameDaySession(lectureId);
  await playThrough(sameDay, sameDayTutor);
  await finishSession(sameDay, { deps: sameDayTutor });

  const dailyTutor = stubTutor(Array(10).fill("green"));
  const daily = await startDailySession();
  await playThrough(daily, dailyTutor);
  const dailyResult = await finishSession(daily, { deps: dailyTutor });

  // Precondition, not luck: the same-day session's red alone already makes
  // the cell below red, so without pinning this the test would stay green
  // even if the daily session stopped picking the Tubular objective at all.
  expect(dailyResult.ratingByLo[objective!.id]).toBeDefined();

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
