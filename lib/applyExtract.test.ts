import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import { concept, extract, question } from "@/lib/extract/testUtils";

const TEST_DB = `./.test-apply-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("./db");
const { applyExtract } = await import("./applyExtract");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

beforeAll(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

const draft = extract({
  title: "Amyloidosis",
  learningObjectives: [
    { text: "Describe the structure of amyloid fibrils.", slideRefs: [2] },
    { text: "Explain Congo red staining.", slideRefs: [7] },
  ],
  concepts: [
    concept({
      label: "Beta-pleated sheet",
      detail: "Cross-beta conformation.",
      relatedObjectiveIndexes: [0],
    }),
    concept({
      label: "Fibril diameter",
      detail: "Seven to ten nanometres.",
      emphasis: "deemphasized",
      emphasisCue: "You do not need the diameter.",
      relatedObjectiveIndexes: [0],
    }),
    concept({
      label: "Congo red",
      detail: "Apple-green birefringence.",
      kind: "application",
      emphasis: "emphasized",
      emphasisCue: "This comes up every year.",
      relatedObjectiveIndexes: [1],
    }),
  ],
  practiceQuestions: [
    question({
      question: "Which stain confirms amyloid?",
      answer: "Congo red.",
      slideRefs: [8],
      conceptIndexes: [2],
      relatedObjectiveIndexes: [1],
    }),
  ],
});

async function newLecture(): Promise<number> {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: "Amyloidosis" })
    .returning({ id: schema.lectures.id });
  return lecture.id;
}

async function objectivesOf(lectureId: number) {
  return db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
    orderBy: [asc(schema.learningObjectives.orderIndex)],
  });
}

/** In insertion order, so old rows come before rows an amend added. */
async function itemsOf(lectureId: number) {
  const objectives = await objectivesOf(lectureId);
  if (objectives.length === 0) return [];
  return db.query.reviewItems.findMany({
    where: inArray(
      schema.reviewItems.loId,
      objectives.map((o) => o.id),
    ),
    orderBy: [asc(schema.reviewItems.id)],
  });
}

async function questionsOf(lectureId: number) {
  return db.query.practiceQuestions.findMany({
    where: eq(schema.practiceQuestions.lectureId, lectureId),
    orderBy: [asc(schema.practiceQuestions.id)],
  });
}

test("a first extraction writes objectives, numbered concepts with their cues, and linked questions", async () => {
  const lectureId = await newLecture();

  const result = await applyExtract(lectureId, draft, "2026-09-09");

  expect(result).toEqual({
    objectivesCreated: 2,
    objectivesMatched: 0,
    reviewItemsCreated: 3,
    reviewItemsMatched: 0,
    reviewItemsRefreshed: 0,
    practiceQuestionsCreated: 1,
  });

  const objectives = await objectivesOf(lectureId);
  expect(objectives.map((o) => [o.text, o.orderIndex])).toEqual([
    ["Describe the structure of amyloid fibrils.", 0],
    ["Explain Congo red staining.", 1],
  ]);

  const items = await itemsOf(lectureId);
  expect(
    items.map((i) => [i.loId, i.ordinal, i.label, i.emphasis, i.suspended, i.dueOn, i.intervalDays]),
  ).toEqual([
    [objectives[0].id, 1, "Beta-pleated sheet", "neutral", false, "2026-09-09", 0],
    // Set aside by the lecturer: recorded with its number, and suspended.
    [objectives[0].id, 2, "Fibril diameter", "deemphasized", true, "2026-09-09", 0],
    [objectives[1].id, 1, "Congo red", "emphasized", false, "2026-09-09", 0],
  ]);
  expect(items[2].concept).toBe("Congo red — Apple-green birefringence.");
  expect(items[2].kind).toBe("application");
  expect(items[2].emphasisCue).toBe("This comes up every year.");

  const questions = await questionsOf(lectureId);
  expect(questions.map((q) => [q.loId, q.question, q.reviewItemIds])).toEqual([
    [objectives[1].id, "Which stain confirms amyloid?", [items[2].id]],
  ]);
});

test("applying the same extract again adds nothing", async () => {
  const lectureId = await newLecture();
  await applyExtract(lectureId, draft, "2026-09-09");
  const before = await itemsOf(lectureId);

  const result = await applyExtract(lectureId, draft, "2026-09-10");

  expect(result).toEqual({
    objectivesCreated: 0,
    objectivesMatched: 2,
    reviewItemsCreated: 0,
    reviewItemsMatched: 3,
    reviewItemsRefreshed: 0,
    practiceQuestionsCreated: 0,
  });
  expect(await itemsOf(lectureId)).toEqual(before);
  expect(await questionsOf(lectureId)).toHaveLength(1);
});

test("an amend keeps every old row's id, number, ladder, marks and suspension, and appends the rest", async () => {
  const lectureId = await newLecture();
  await applyExtract(lectureId, draft, "2026-09-09");
  const [objective1, objective2] = await objectivesOf(lectureId);
  const [sheet, diameter, congo] = await itemsOf(lectureId);

  // Study happened since: the sheet climbed the ladder and earned a mark,
  // and the student reactivated the diameter by hand.
  await db
    .update(schema.reviewItems)
    .set({ dueOn: "2026-09-16", intervalDays: 7, lastRating: "green", streak: 2, lapses: 1 })
    .where(eq(schema.reviewItems.id, sheet.id));
  await db
    .update(schema.reviewItems)
    .set({ suspended: false })
    .where(eq(schema.reviewItems.id, diameter.id));
  const [date] = await db
    .insert(schema.studyDates)
    .values({ date: "2026-09-09" })
    .returning({ id: schema.studyDates.id });
  await db
    .insert(schema.conceptMarks)
    .values({ reviewItemId: sheet.id, studyDateId: date.id, mark: "green" });

  const amended = extract({
    ...draft,
    learningObjectives: [
      ...draft.learningObjectives,
      { text: "Outline treatment of AL amyloidosis.", slideRefs: [20] },
    ],
    concepts: [
      // The sheet again, its detail reworded and a cue found this time.
      concept({
        label: "Beta-pleated sheet",
        detail: "Reworded detail.",
        emphasis: "emphasized",
        emphasisCue: "Know the conformation.",
        relatedObjectiveIndexes: [0],
      }),
      // Still set aside by the lecturer; the student's reactivation must hold.
      draft.concepts[1],
      draft.concepts[2],
      concept({ label: "Serum amyloid P", detail: "In every deposit.", relatedObjectiveIndexes: [0] }),
      concept({
        label: "Bortezomib",
        detail: "Proteasome inhibition.",
        kind: "application",
        relatedObjectiveIndexes: [2],
      }),
    ],
    practiceQuestions: [
      draft.practiceQuestions[0],
      question({
        question: "Which drug targets the clone?",
        answer: "Bortezomib.",
        conceptIndexes: [4, 0],
        relatedObjectiveIndexes: [2],
      }),
    ],
  });

  const result = await applyExtract(lectureId, amended, "2026-09-20");

  expect(result).toEqual({
    objectivesCreated: 1,
    objectivesMatched: 2,
    reviewItemsCreated: 2,
    reviewItemsMatched: 3,
    reviewItemsRefreshed: 1,
    practiceQuestionsCreated: 1,
  });

  const objectives = await objectivesOf(lectureId);
  expect(objectives.map((o) => [o.id, o.orderIndex])).toEqual([
    [objective1.id, 0],
    [objective2.id, 1],
    [objectives[2].id, 2],
  ]);
  expect(objectives[2].text).toBe("Outline treatment of AL amyloidosis.");

  const after = await itemsOf(lectureId);
  expect(after[0]).toMatchObject({
    id: sheet.id,
    ordinal: 1,
    concept: "Beta-pleated sheet — Cross-beta conformation.",
    dueOn: "2026-09-16",
    intervalDays: 7,
    lastRating: "green",
    streak: 2,
    lapses: 1,
    emphasis: "emphasized",
    emphasisCue: "Know the conformation.",
  });
  expect(after[1]).toMatchObject({ id: diameter.id, ordinal: 2, suspended: false });
  expect(after[2]).toMatchObject({ id: congo.id, ordinal: 1, loId: objective2.id });
  expect(after.slice(3).map((i) => [i.loId, i.ordinal, i.label, i.dueOn])).toEqual([
    [objective1.id, 3, "Serum amyloid P", "2026-09-20"],
    [objectives[2].id, 1, "Bortezomib", "2026-09-20"],
  ]);

  const marks = await db.query.conceptMarks.findMany({
    where: eq(schema.conceptMarks.reviewItemId, sheet.id),
  });
  expect(marks).toHaveLength(1);

  const questions = await questionsOf(lectureId);
  expect(questions.map((q) => [q.loId, q.question, q.reviewItemIds])).toEqual([
    [objective2.id, "Which stain confirms amyloid?", [congo.id]],
    [objectives[2].id, "Which drug targets the clone?", [after[4].id, sheet.id]],
  ]);
});

test("an extract with no objectives writes nothing", async () => {
  const lectureId = await newLecture();

  const result = await applyExtract(lectureId, extract({ title: "Empty" }), "2026-09-09");

  expect(result).toEqual({
    objectivesCreated: 0,
    objectivesMatched: 0,
    reviewItemsCreated: 0,
    reviewItemsMatched: 0,
    reviewItemsRefreshed: 0,
    practiceQuestionsCreated: 0,
  });
  expect(await objectivesOf(lectureId)).toEqual([]);
});

test("an unknown lecture is refused", async () => {
  await expect(applyExtract(999_999, draft)).rejects.toThrow(/not found/);
});
