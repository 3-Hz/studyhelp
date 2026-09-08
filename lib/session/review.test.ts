import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";

const TEST_DB = `./.test-session-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("../db");
const { commitLecture } = await import("../commitLecture");
const { addDays, todayIso } = await import("../schedule");
const { startReviewSession } = await import("./review");
const {
  currentTurn,
  finishSession,
  requestHint,
  submitAnswer,
} = await import("./runner");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

type TutorDeps = NonNullable<Parameters<typeof currentTurn>[1]>;
type Score = 1 | 2 | 3 | 4 | 5;
type Mark = "green" | "yellow" | "red";
/** A scripted grade: a bare score marks nothing; an object marks the numbered concepts given. */
type Scripted = Score | { score: Score; marks: { number: number; mark: Mark }[] };

/** Objective 0 has one concept (#1); objective 1 has two (#1, #2) and a practice question. */
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
    {
      label: "Organ tropism",
      detail: "AL takes kidney and heart together; wild-type ATTR is mostly cardiac.",
      kind: "distinction" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [1],
    },
  ],
  practiceQuestions: [
    {
      question: "Name the precursor protein in AL amyloidosis.",
      answer: "Immunoglobulin light chain.",
      slideRefs: [5],
      relatedObjectiveIndexes: [1],
    },
  ],
  commonConfusions: [],
  conflicts: [],
};

/**
 * A tutor that grades from a script rather than a model, so the flow can be
 * driven deterministically. Grades are consumed in the order given; the
 * script running out means 5 with no marks.
 */
function stubTutor(script: Scripted[]): TutorDeps {
  const queue = [...script];
  return {
    askQuestion: async (context) => ({
      format: context.allowedFormats?.[0] ?? ("free_recall" as const),
      question: `Question for ${context.stage}/${context.targetConcept ?? context.objective ?? "lecture"}`,
    }),
    gradeAnswer: async () => {
      const next = queue.shift() ?? 5;
      const { score, marks } = typeof next === "number" ? { score: next, marks: [] } : next;
      return {
        score,
        conceptMarks: marks,
        correct: [],
        missing: [],
        incorrect: [],
        correction: "A correction.",
        modelAnswer: "A model answer.",
      };
    },
    giveHint: async () => ({ hint: "Think about the precursor protein." }),
    summariseSession: async () => ({
      heldUp: ["Fibril structure"],
      shaky: [],
      misconceptions: [],
      focusNext: "Practise the precursor proteins.",
      calibration: "",
    }),
  };
}

beforeAll(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

async function seedCommittedLecture(title: string = draft.title): Promise<number> {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title, draftExtract: draft })
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

async function itemsOf(loId: number) {
  return db.query.reviewItems.findMany({
    where: eq(schema.reviewItems.loId, loId),
    orderBy: [asc(schema.reviewItems.ordinal)],
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

/** The session's turns as the student met them: stage, objective, concept. */
async function turnsOf(sessionId: number) {
  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
    orderBy: [asc(schema.attempts.id)],
  });
  return attempts.map((a) => ({ stage: a.stage, loId: a.loId, reviewItemId: a.reviewItemId }));
}

test("refuses to study a lecture whose objectives were never committed", async () => {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: "Uncommitted", draftExtract: draft })
    .returning({ id: schema.lectures.id });

  await expect(startReviewSession([lecture.id])).rejects.toThrow(/commit/i);
});

test("rejoins an unfinished session rather than starting a second", async () => {
  const lectureId = await seedCommittedLecture();

  const first = await startReviewSession([lectureId]);
  const second = await startReviewSession([lectureId]);

  expect(second).toBe(first);
});

test("recalls each objective, then probes what the recall left untested, one objective at a time", async () => {
  const lectureId = await seedCommittedLecture();
  const [first, second] = await objectivesOf(lectureId);
  const [firstItem] = await itemsOf(first.id);
  const [precursor, tropism] = await itemsOf(second.id);
  const sessionId = await startReviewSession([lectureId]);

  // Twenty minutes on two objectives is three questions each: a recall with
  // no marks leaves every concept untested, so the probes follow in order.
  await playThrough(sessionId, stubTutor([]));

  expect(await turnsOf(sessionId)).toEqual([
    { stage: "lo_recall", loId: first.id, reviewItemId: null },
    { stage: "lo_probe", loId: first.id, reviewItemId: firstItem.id },
    { stage: "lo_recall", loId: second.id, reviewItemId: null },
    { stage: "lo_probe", loId: second.id, reviewItemId: precursor.id },
    { stage: "lo_probe", loId: second.id, reviewItemId: tropism.id },
    { stage: "reflection", loId: null, reviewItemId: null },
  ]);
});

test("a recall that marks a concept green needs no probe on it", async () => {
  const lectureId = await seedCommittedLecture();
  const [first, second] = await objectivesOf(lectureId);
  const [, tropism] = await itemsOf(second.id);
  const sessionId = await startReviewSession([lectureId]);

  await playThrough(
    sessionId,
    stubTutor([
      { score: 5, marks: [{ number: 1, mark: "green" }] },
      { score: 4, marks: [{ number: 1, mark: "green" }, { number: 2, mark: "yellow" }] },
    ]),
  );

  expect(await turnsOf(sessionId)).toEqual([
    { stage: "lo_recall", loId: first.id, reviewItemId: null },
    { stage: "lo_recall", loId: second.id, reviewItemId: null },
    { stage: "lo_probe", loId: second.id, reviewItemId: tropism.id },
    { stage: "reflection", loId: null, reviewItemId: null },
  ]);
});

test("a short budget covers a subset, stores its minutes, and a rejoin keeps them", async () => {
  const lectureId = await seedCommittedLecture();
  const [first] = await objectivesOf(lectureId);
  const sessionId = await startReviewSession([lectureId], 2);

  expect(await startReviewSession([lectureId], 60)).toBe(sessionId);
  const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.id, sessionId) });
  expect(session?.minutes).toBe(2);

  // Two minutes is one question: one objective, recall only.
  await playThrough(sessionId, stubTutor([]));
  expect(await turnsOf(sessionId)).toEqual([
    { stage: "lo_recall", loId: first.id, reviewItemId: null },
    { stage: "reflection", loId: null, reviewItemId: null },
  ]);
});

test("the same question survives a reload instead of being regenerated", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);
  const tutor = stubTutor([]);

  const first = await currentTurn(sessionId, tutor);
  const again = await currentTurn(sessionId, tutor);

  expect(again?.attemptId).toBe(first!.attemptId);

  const attempts = await db.query.attempts.findMany({
    where: eq(schema.attempts.sessionId, sessionId),
  });
  expect(attempts).toHaveLength(1);
});

test("taking a cue caps a 5 at 4 and a green mark at yellow, whatever the model says", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);
  const tutor = stubTutor([{ score: 5, marks: [{ number: 1, mark: "green" }] }]);

  await currentTurn(sessionId, tutor);
  const hint = await requestHint(sessionId, "Something about sheets", tutor);
  expect(hint).toMatch(/precursor/i);

  const feedback = await submitAnswer(sessionId, "An answer.", tutor);
  expect(feedback?.modelScore).toBe(5);
  expect(feedback?.score).toBe(4);
  expect(feedback?.marks.map((m) => [m.ordinal, m.mark])).toEqual([[1, "yellow"]]);
  // Review turns have no selection story to tell.
  expect(feedback?.why).toBeUndefined();
});

test("the lowest score of the sitting is the objective's score for the day", async () => {
  const lectureId = await seedCommittedLecture();
  const [first, second] = await objectivesOf(lectureId);
  const sessionId = await startReviewSession([lectureId]);
  // Objective 0 scores 2 on recall, then 5 on its probe.
  const tutor = stubTutor([2, 5, 5, 5, 5]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.scoreByLo[first.id]).toBe(2);
  expect(result.scoreByLo[second.id]).toBe(5);
});

test("a probe's score reaches its objective's cell", async () => {
  const lectureId = await seedCommittedLecture();
  const [first, second] = await objectivesOf(lectureId);
  const sessionId = await startReviewSession([lectureId]);
  // Objective 0: recall 5, probe 2.
  const tutor = stubTutor([5, 2, 5, 5, 5]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.cellsWritten).toBe(2);
  expect(result.scoreByLo[first.id]).toBe(2);
  expect(result.scoreByLo[second.id]).toBe(5);
});

test("finishing writes one dashboard cell per tested objective, with its score", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);
  // Objective 1's recall scores 4.
  const tutor = stubTutor([5, 5, 4, 5, 5]);

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
  expect(cell?.score).toBe(4);
});

test("an objective that was never tested gets no cell at all", async () => {
  const lectureId = await seedCommittedLecture();
  const objectives = await objectivesOf(lectureId);

  // Suspend the second objective so the session never reaches it.
  await db
    .update(schema.learningObjectives)
    .set({ suspended: true })
    .where(eq(schema.learningObjectives.id, objectives[1].id));

  const sessionId = await startReviewSession([lectureId]);
  const tutor = stubTutor([]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.cellsWritten).toBe(1);

  const cells = await db.query.performances.findMany({
    where: eq(schema.performances.loId, objectives[1].id),
  });
  expect(cells).toHaveLength(0);
});

test("each concept the sitting marked moves on the ladder and is recorded for the day; an untested one stays put", async () => {
  const lectureId = await seedCommittedLecture();
  const [first, second] = await objectivesOf(lectureId);
  const [sheet] = await itemsOf(first.id);
  const [precursor, tropism] = await itemsOf(second.id);
  // Eight minutes: two objectives, two questions each, so one probe at most.
  const sessionId = await startReviewSession([lectureId], 8);
  // Objective 0's recall marks its concept green; objective 1's recall marks
  // nothing and scores 2, so its first concept is probed and fails.
  const tutor = stubTutor([{ score: 5, marks: [{ number: 1, mark: "green" }] }, 2, 2]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.reviewItemsRescheduled).toBe(2);

  const [sheetAfter] = await itemsOf(first.id);
  const [precursorAfter, tropismAfter] = await itemsOf(second.id);

  // Green walks 0 -> 1; red returns tomorrow and counts a lapse.
  expect(sheetAfter).toMatchObject({ intervalDays: 1, streak: 1, lapses: 0, lastRating: "green" });
  expect(precursorAfter).toMatchObject({ intervalDays: 1, streak: 0, lapses: 1, lastRating: "red" });
  // Never marked, never moved.
  expect(tropismAfter).toMatchObject({ intervalDays: 0, lapses: 0, lastRating: null, dueOn: todayIso() });

  // What finishing did to each item, and the same array on the session row.
  const outcomeFor = (id: number) => result.outcomes.find((o) => o.reviewItemId === id);
  expect(outcomeFor(sheet.id)).toEqual({
    reviewItemId: sheet.id,
    concept: sheet.concept,
    mark: "green",
    tierBefore: "new",
    tierAfter: "consolidating",
    dueOn: sheetAfter.dueOn,
  });
  expect(outcomeFor(precursor.id)?.tierAfter).toBe("relearning");
  expect(outcomeFor(tropism.id)).toBeUndefined();
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect(session!.outcomes).toEqual(result.outcomes);

  // The day's concept marks: the LO Map's coloured numbers.
  const studyDate = await db.query.studyDates.findFirst({
    where: eq(schema.studyDates.date, todayIso()),
  });
  const marks = await db.query.conceptMarks.findMany({
    where: eq(schema.conceptMarks.studyDateId, studyDate!.id),
  });
  const markFor = (id: number) => marks.find((m) => m.reviewItemId === id)?.mark;
  expect(markFor(sheet.id)).toBe("green");
  expect(markFor(precursor.id)).toBe("red");
  expect(markFor(tropism.id)).toBeUndefined();
});

test("a second session the same day keeps the lowest score and the worst mark, not the latest", async () => {
  const lectureId = await seedCommittedLecture();
  const [first] = await objectivesOf(lectureId);
  const [sheet] = await itemsOf(first.id);

  const one = await startReviewSession([lectureId]);
  // The recall scores 2 and marks the concept red; its probe then goes green.
  const oneTutor = stubTutor([{ score: 2, marks: [{ number: 1, mark: "red" }] }, 5, 5, 5, 5]);
  await playThrough(one, oneTutor);
  await finishSession(one, { deps: oneTutor });

  const two = await startReviewSession([lectureId]);
  expect(two).not.toBe(one);
  const twoTutor = stubTutor([
    { score: 5, marks: [{ number: 1, mark: "green" }] },
    { score: 5, marks: [{ number: 1, mark: "green" }, { number: 2, mark: "green" }] },
  ]);
  await playThrough(two, twoTutor);
  await finishSession(two, { deps: twoTutor });

  const cells = await db.query.performances.findMany({
    where: eq(schema.performances.loId, first.id),
  });
  // Still one cell for the day, and still 2: a 5 that follows a 2 is recall
  // of the correction just given, whether or not a session boundary falls
  // between them.
  expect(cells).toHaveLength(1);
  expect(cells[0].score).toBe(2);

  const marks = await db.query.conceptMarks.findMany({
    where: eq(schema.conceptMarks.reviewItemId, sheet.id),
  });
  expect(marks).toHaveLength(1);
  expect(marks[0].mark).toBe("red");
});

test("a finished session cannot be finished again", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);
  const tutor = stubTutor([]);

  await playThrough(sessionId, tutor);
  await finishSession(sessionId, { deps: tutor });

  await expect(finishSession(sessionId, { deps: tutor })).rejects.toThrow(/already been finished/i);
});

test("answering when nothing was asked is an error, not a silent no-op", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);

  await expect(
    submitAnswer(sessionId, "An answer.", stubTutor([])),
  ).rejects.toThrow(/no question/i);
});

test("the session closes with an ungraded reflection turn", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);
  const tutor = stubTutor([]);

  let reflection = await currentTurn(sessionId, tutor);
  for (let guard = 0; reflection && reflection.stage !== "reflection" && guard < 10; guard++) {
    await submitAnswer(sessionId, "An answer.", tutor);
    reflection = await currentTurn(sessionId, tutor);
  }

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
  expect(last.score).toBeNull();
  expect(last.studentAnswer).toMatch(/precursor/);

  // No cell, no item moved, no question asked of the model for it.
  const result = await finishSession(sessionId, { deps: tutor });
  expect(result.cellsWritten).toBe(2);
  expect(result.reviewItemsRescheduled).toBe(3);
});

test("a review session gets a debrief too", async () => {
  const lectureId = await seedCommittedLecture();
  const sessionId = await startReviewSession([lectureId]);
  const tutor = stubTutor([]);

  await playThrough(sessionId, tutor);
  const result = await finishSession(sessionId, { deps: tutor });

  expect(result.debrief?.focusNext).toMatch(/precursor/i);

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  expect((session!.debrief as { heldUp: string[] }).heldUp).toEqual(["Fibril structure"]);
});

test("the tutor sees each objective's numbered concepts, its practice questions, and a first-order probe", async () => {
  const lectureId = await seedCommittedLecture();
  const [, second] = await objectivesOf(lectureId);
  const sessionId = await startReviewSession([lectureId]);

  const contexts: Parameters<TutorDeps["askQuestion"]>[0][] = [];
  const base = stubTutor([]);
  const tutor: TutorDeps = {
    ...base,
    askQuestion: async (context) => {
      contexts.push(context);
      return base.askQuestion(context);
    },
  };
  await playThrough(sessionId, tutor);

  const recall = contexts.find((c) => c.stage === "lo_recall" && c.objective === second.text)!;
  expect(recall.concepts.map((c) => [c.ordinal, c.concept.split(" — ")[0]])).toEqual([
    [1, "AL vs ATTR precursor"],
    [2, "Organ tropism"],
  ]);
  expect(recall.practiceQuestions?.[0].question).toBe("Name the precursor protein in AL amyloidosis.");
  expect(recall.order).toBeUndefined();

  const probe = contexts.find((c) => c.stage === "lo_probe" && c.objective === second.text)!;
  expect(probe.targetConcept).toMatch(/^AL vs ATTR precursor/);
  expect(probe.order).toBe("first");
  expect(probe.allowedFormats).toEqual(["mechanism", "pathway", "consequence"]);
});

/** A committed lecture with `count` objectives of one concept each. */
async function seedLectureWith(title: string, count: number): Promise<number> {
  const wide = {
    title,
    learningObjectives: Array.from({ length: count }, (_, i) => ({
      text: `${title} objective ${i + 1}`,
      slideRefs: [i + 1],
    })),
    concepts: Array.from({ length: count }, (_, i) => ({
      label: `${title} concept ${i + 1}`,
      detail: `Detail ${i + 1}.`,
      kind: "fact" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [i],
    })),
    practiceQuestions: [],
    commonConfusions: [],
    conflicts: [],
  };
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title, draftExtract: wide })
    .returning({ id: schema.lectures.id });
  await commitLecture(
    lecture.id,
    wide.learningObjectives.map((objective, index) => ({ draftIndex: index, text: objective.text })),
  );
  return lecture.id;
}

test("refuses an empty set of lectures", async () => {
  await expect(startReviewSession([])).rejects.toThrow(/at least one/i);
});

test("refuses a set in which any lecture is uncommitted, naming it", async () => {
  const committed = await seedCommittedLecture();
  const [draftOnly] = await db
    .insert(schema.lectures)
    .values({ title: "Still a draft", draftExtract: draft })
    .returning({ id: schema.lectures.id });

  await expect(startReviewSession([committed, draftOnly.id])).rejects.toThrow(/Still a draft/);
});

test("a review of two lectures takes turns between them, every turn first-order", async () => {
  const a = await seedCommittedLecture("Amyloidosis");
  const b = await seedCommittedLecture("Glomerular disease");
  const [a1, a2] = await objectivesOf(a);
  const [b1, b2] = await objectivesOf(b);
  const sessionId = await startReviewSession([b, a]);

  const contexts: Parameters<TutorDeps["askQuestion"]>[0][] = [];
  const base = stubTutor([]);
  const tutor: TutorDeps = {
    ...base,
    askQuestion: async (context) => {
      contexts.push(context);
      return base.askQuestion(context);
    },
  };
  // Twenty minutes on four objectives: two questions each, a recall and a probe.
  await playThrough(sessionId, tutor);

  const turns = await turnsOf(sessionId);
  expect(turns.map((turn) => [turn.stage, turn.loId])).toEqual([
    ["lo_recall", a1.id],
    ["lo_probe", a1.id],
    ["lo_recall", b1.id],
    ["lo_probe", b1.id],
    ["lo_recall", a2.id],
    ["lo_probe", a2.id],
    ["lo_recall", b2.id],
    ["lo_probe", b2.id],
    ["reflection", null],
  ]);

  // The caption above each question names the objective's own lecture.
  expect(contexts.map((context) => context.lectureTitle)).toEqual([
    "Amyloidosis", "Amyloidosis",
    "Glomerular disease", "Glomerular disease",
    "Amyloidosis", "Amyloidosis",
    "Glomerular disease", "Glomerular disease",
  ]);
  expect(contexts.every((context) => context.order === undefined || context.order === "first")).toBe(true);

  const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.id, sessionId) });
  expect(session?.type).toBe("review");
  expect(session?.lectureIds).toEqual([a, b]);
});

test("a short budget across unequal lectures shares in proportion, never leaving a lecture out", async () => {
  const wide = await seedLectureWith("Wide", 6);
  const narrow = await seedLectureWith("Narrow", 2);
  const w = await objectivesOf(wide);
  const n = await objectivesOf(narrow);
  // Ten minutes is five questions over eight objectives: recall only, four
  // from the wide lecture spaced through it and one from the narrow one.
  const sessionId = await startReviewSession([wide, narrow], 10);

  await playThrough(sessionId, stubTutor([]));

  const recalls = (await turnsOf(sessionId)).filter((turn) => turn.stage === "lo_recall");
  expect(recalls.map((turn) => turn.loId)).toEqual([w[0].id, n[0].id, w[2].id, w[3].id, w[5].id]);
});

test("rejoin needs the same set of lectures, in any order", async () => {
  const a = await seedCommittedLecture();
  const b = await seedCommittedLecture();

  const both = await startReviewSession([a, b]);
  expect(await startReviewSession([b, a, a])).toBe(both);

  const alone = await startReviewSession([a]);
  expect(alone).not.toBe(both);
});

test("a review started yesterday is not rejoined today", async () => {
  const lectureId = await seedCommittedLecture();
  const stale = await startReviewSession([lectureId]);

  const yesterdayNoon = new Date(`${addDays(todayIso(), -1)}T12:00:00`);
  await db
    .update(schema.sessions)
    .set({ startedAt: yesterdayNoon })
    .where(eq(schema.sessions.id, stale));

  expect(await startReviewSession([lectureId])).not.toBe(stale);
});

test("a lecture deleted mid-review drops out; the rest carry on", async () => {
  const a = await seedCommittedLecture("Kept");
  const b = await seedCommittedLecture("Deleted");
  const sessionId = await startReviewSession([a, b]);
  const kept = await objectivesOf(a);

  await db.delete(schema.lectures).where(inArray(schema.lectures.id, [b]));

  await playThrough(sessionId, stubTutor([]));
  const turns = await turnsOf(sessionId);
  const loIds = new Set(turns.map((turn) => turn.loId).filter((id) => id !== null));
  expect([...loIds].sort()).toEqual(kept.map((o) => o.id).sort());
});

test("a suspended concept is neither probed nor shown to the grader, and finishing leaves it alone", async () => {
  const lectureId = await seedCommittedLecture();
  const [, second] = await objectivesOf(lectureId);
  const [precursor, tropism] = await itemsOf(second.id);
  await db
    .update(schema.reviewItems)
    .set({ suspended: true })
    .where(eq(schema.reviewItems.id, tropism.id));

  const sessionId = await startReviewSession([lectureId]);
  const contexts: Parameters<TutorDeps["askQuestion"]>[0][] = [];
  const base = stubTutor([]);
  const tutor: TutorDeps = {
    ...base,
    askQuestion: async (context) => {
      contexts.push(context);
      return base.askQuestion(context);
    },
  };
  await playThrough(sessionId, tutor);

  const probes = (await turnsOf(sessionId)).filter((turn) => turn.stage === "lo_probe");
  expect(probes.map((turn) => turn.reviewItemId)).toContain(precursor.id);
  expect(probes.map((turn) => turn.reviewItemId)).not.toContain(tropism.id);

  // The grader marks by number, so the suspended concept must not be listed.
  const recall = contexts.find((c) => c.stage === "lo_recall" && c.objective === second.text)!;
  expect(recall.concepts.map((c) => c.ordinal)).toEqual([1]);

  await finishSession(sessionId, { deps: tutor });
  const untouched = await db.query.reviewItems.findFirst({
    where: eq(schema.reviewItems.id, tropism.id),
  });
  expect(untouched!.lastRating).toBeNull();
  expect(untouched!.dueOn).toBe(tropism.dueOn);
});
