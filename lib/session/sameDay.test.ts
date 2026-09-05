import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";

const TEST_DB = `./.test-session-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("../db");
const { commitLecture } = await import("../commitLecture");
const { todayIso } = await import("../schedule");
const { startSameDaySession } = await import("./sameDay");
const {
  currentTurn,
  finishSession,
  requestHint,
  submitAnswer,
} = await import("./runner");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

type Rating = "green" | "yellow" | "red";
type TutorDeps = Parameters<typeof currentTurn>[1];

const draft = {
  title: "Amyloidosis",
  learningObjectives: [
    { text: "Describe the structure of amyloid fibrils.", slideRefs: [2] },
    { text: "Compare AL and ATTR amyloidosis.", slideRefs: [5] },
  ],
  concepts: [
    {
      label: "Beta-pleated sheet",
      detail: "Amyloid fibrils adopt a cross-beta sheet conformation.",
      kind: "fact" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [0],
    },
    {
      label: "AL vs ATTR precursor",
      detail: "AL derives from light chains; ATTR from transthyretin.",
      kind: "mechanism" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [1],
    },
  ],
  commonConfusions: [],
  conflicts: [],
};

/**
 * A tutor that grades from a script rather than a model, so the flow can be
 * driven deterministically. Ratings are consumed in the order given.
 */
function stubTutor(ratings: Rating[]): TutorDeps {
  const queue = [...ratings];
  return {
    askQuestion: async (context) => ({
      format: "free_recall" as const,
      question: `Question for ${context.stage}/${context.objective ?? "lecture"}`,
    }),
    gradeAnswer: async () => ({
      rating: queue.shift() ?? "green",
      correct: [],
      missing: [],
      incorrect: [],
      correction: "A correction.",
      modelAnswer: "A model answer.",
    }),
    giveHint: async () => ({ hint: "Think about the precursor protein." }),
    summariseSession: async () => ({
      heldUp: ["Fibril structure"],
      shaky: [],
      misconceptions: [],
      focusNext: "Practise the precursor proteins.",
    }),
  } as TutorDeps;
}

beforeAll(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

async function seedCommittedLecture(): Promise<number> {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: draft.title, draftExtract: draft })
    .returning({ id: schema.lectures.id });

  await commitLecture(lecture.id, [
    { draftIndex: 0, text: draft.learningObjectives[0].text },
    { draftIndex: 1, text: draft.learningObjectives[1].text },
  ]);

  return lecture.id;
}

async function objectivesOf(lectureId: number) {
  return db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
    orderBy: [schema.learningObjectives.orderIndex],
  });
}

/** Drives the session to completion, answering every question. */
async function playThrough(sessionId: number, tutor: TutorDeps) {
  for (let guard = 0; guard < 20; guard++) {
    const turn = await currentTurn(sessionId, tutor);
    if (!turn) return;
    await submitAnswer(sessionId, "An answer.", tutor);
  }
  throw new Error("Session did not terminate.");
}

test("refuses to study a lecture whose objectives were never committed", async () => {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: "Uncommitted", draftExtract: draft })
    .returning({ id: schema.lectures.id });

  await expect(startSameDaySession(lecture.id)).rejects.toThrow(/commit/i);
});

test("rejoins an unfinished session rather than starting a second", async () => {
  const lectureId = await seedCommittedLecture();

  const first = await startSameDaySession(lectureId);
  const second = await startSameDaySession(lectureId);

  expect(second).toBe(first);
});

test("asks about each objective in order, then the lecture summary", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green"]);

  const first = await currentTurn(sessionId, tutor);
  expect(first?.stage).toBe("lo_recall");
  expect(first?.loId).toBe(objectives[0].id);
  await submitAnswer(sessionId, "An answer.", tutor);

  const second = await currentTurn(sessionId, tutor);
  expect(second?.loId).toBe(objectives[1].id);
  await submitAnswer(sessionId, "An answer.", tutor);

  const third = await currentTurn(sessionId, tutor);
  expect(third?.stage).toBe("summary");
  expect(third?.loId).toBeNull();
});

test("the same question survives a reload instead of being regenerated", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor([]);

  const first = await currentTurn(sessionId, tutor);
  const again = await currentTurn(sessionId, tutor);

  expect(again?.attemptId).toBe(first!.attemptId);

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
  });
  expect(attempts).toHaveLength(1);
});

test("taking a cue caps the rating at yellow even when the model says green", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green"]);

  await currentTurn(sessionId, tutor);
  const hint = await requestHint(sessionId, "Something about sheets", tutor);
  expect(hint).toMatch(/precursor/i);

  const feedback = await submitAnswer(sessionId, "An answer.", tutor);
  expect(feedback?.modelRating).toBe("green");
  expect(feedback?.rating).toBe("yellow");
});

test("an objective that scored red earns an elaboration turn; a green one does not", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);
  const sessionId = await startSameDaySession(lectureId);
  // objective 0 red, objective 1 green, then the summary.
  const tutor = stubTutor(["red", "green", "green"]);

  for (let i = 0; i < 3; i++) {
    await currentTurn(sessionId, tutor);
    await submitAnswer(sessionId, "An answer.", tutor);
  }

  const fourth = await currentTurn(sessionId, tutor);
  expect(fourth?.stage).toBe("elaboration");
  expect(fourth?.loId).toBe(objectives[0].id);
});

test("the worst rating of the session represents the day", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);
  const sessionId = await startSameDaySession(lectureId);
  // Objective 0 goes red on recall, then green on elaboration.
  const tutor = stubTutor(["red", "green", "green", "green"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.ratingByLo[objectives[0].id]).toBe("red");
  expect(result.ratingByLo[objectives[1].id]).toBe("green");
});

test("finishing writes one dashboard cell per tested objective", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "yellow", "green", "green"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.cellsWritten).toBe(2);

  const studyDate = await db.query.studyDates.findFirst({
    where: eq(schema.studyDates.date, todayIso()),
  });
  expect(studyDate).toBeDefined();

  const objectives = await objectivesOf(lectureId);
  const cell = await db.query.performances.findFirst({
    where: and(
      eq(schema.performances.loId, objectives[1].id),
      eq(schema.performances.studyDateId, studyDate!.id),
    ),
  });
  expect(cell?.rating).toBe("yellow");
});

test("an objective that was never tested gets no cell at all", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);

  // Suspend the second objective so the session never reaches it.
  await db
    .update(schema.learningObjectives)
    .set({ suspended: true })
    .where(eq(schema.learningObjectives.id, objectives[1].id));

  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.cellsWritten).toBe(1);

  const cells = await db.query.performances.findMany({
    where: eq(schema.performances.loId, objectives[1].id),
  });
  expect(cells).toHaveLength(0);
});

test("review items move on to the interval their objective earned", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);
  const sessionId = await startSameDaySession(lectureId);
  // Objective 0 green, objective 1 red, summary green, elaboration on 1 green.
  const tutor = stubTutor(["green", "red", "green", "green"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.reviewItemsRescheduled).toBe(2);

  const [greenItem] = await db.query.reviewItems.findMany({
    where: eq(schema.reviewItems.loId, objectives[0].id),
  });
  const [redItem] = await db.query.reviewItems.findMany({
    where: eq(schema.reviewItems.loId, objectives[1].id),
  });

  // Green walks 0 -> 1; red returns tomorrow and counts a lapse.
  expect(greenItem.intervalDays).toBe(1);
  expect(greenItem.lastRating).toBe("green");
  expect(redItem.intervalDays).toBe(1);
  expect(redItem.lapses).toBe(1);
  expect(redItem.lastRating).toBe("red");
  expect(greenItem.streak).toBe(1);
  expect(redItem.streak).toBe(0);

  // What finishing did to each item, in the order the runner walked them.
  expect(result.outcomes).toHaveLength(2);
  const outcomeFor = (id: number) => result.outcomes.find((o) => o.reviewItemId === id);
  expect(outcomeFor(greenItem.id)).toEqual({
    reviewItemId: greenItem.id,
    concept: greenItem.concept,
    rating: "green",
    tierBefore: "new",
    tierAfter: "consolidating",
    dueOn: greenItem.dueOn,
  });
  expect(outcomeFor(redItem.id)?.tierAfter).toBe("relearning");

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect(session!.outcomes).toEqual(result.outcomes);
});

test("a second session the same day keeps the worst rating, not the latest", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);

  const first = await startSameDaySession(lectureId);
  const firstTutor = stubTutor(["red", "red", "green", "green", "green"]);
  await playThrough(first, firstTutor);
  await finishSession(first, { deps: firstTutor });

  const second = await startSameDaySession(lectureId);
  expect(second).not.toBe(first);
  const secondTutor = stubTutor(["green", "green", "green"]);
  await playThrough(second, secondTutor);
  await finishSession(second, { deps: secondTutor });

  const cells = await db.query.performances.findMany({
    where: eq(schema.performances.loId, objectives[0].id),
  });

  // Still one cell for the day, and still red: a green that follows a red is
  // recall of the correction just given, whether or not a session boundary
  // falls between them.
  expect(cells).toHaveLength(1);
  expect(cells[0].rating).toBe("red");
});

test("a finished session cannot be finished again", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green", "green"]);

  await playThrough(sessionId, tutor);
  await finishSession(sessionId, { deps: tutor });

  await expect(finishSession(sessionId, { deps: tutor })).rejects.toThrow(/already been finished/i);
});

test("answering when nothing was asked is an error, not a silent no-op", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);

  await expect(
    submitAnswer(sessionId, "An answer.", stubTutor([])),
  ).rejects.toThrow(/no question/i);
});

test("the summary turn contributes no dashboard cell", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green", "red"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  // The summary scored red, but it names no objective, so only the two
  // green recall turns reach the dashboard.
  expect(result.cellsWritten).toBe(2);
  expect(Object.values(result.ratingByLo)).toEqual(["green", "green"]);
});

test("the session closes with an ungraded reflection turn", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green", "green"]);

  // Two recalls and the summary, all green: nothing to elaborate.
  for (let i = 0; i < 3; i++) {
    await currentTurn(sessionId, tutor);
    await submitAnswer(sessionId, "An answer.", tutor);
  }

  const reflection = await currentTurn(sessionId, tutor);
  expect(reflection?.stage).toBe("reflection");
  expect(reflection?.loId).toBeNull();
  expect(reflection?.question).toMatch(/key ideas/i);

  await expect(requestHint(sessionId, undefined, tutor)).rejects.toThrow(/no cue/i);

  const feedback = await submitAnswer(sessionId, "The precursor was the hardest point.", tutor);
  expect(feedback).toBeNull();
  expect(await currentTurn(sessionId, tutor)).toBeNull();

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
  });
  const last = attempts[attempts.length - 1];
  expect(last.stage).toBe("reflection");
  expect(last.rating).toBeNull();
  expect(last.studentAnswer).toMatch(/precursor/);

  // No cell, no item moved, no question asked of the model for it.
  const result = await finishSession(sessionId, { deps: tutor });
  expect(result.cellsWritten).toBe(2);
  expect(result.reviewItemsRescheduled).toBe(2);
});

test("a same-day session gets a debrief too", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startSameDaySession(lectureId);
  const tutor = stubTutor(["green", "green", "green"]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.debrief?.focusNext).toMatch(/precursor/i);

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect((session!.debrief as { heldUp: string[] }).heldUp).toEqual(["Fibril structure"]);
});
