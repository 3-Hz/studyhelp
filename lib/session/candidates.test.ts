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

test("a committed lecture contributes one candidate per objective, carrying its scores and its items", async () => {
  // Push the objective ids past the review-item ids. Both are first-row
  // autoincrements otherwise, so loId and reviewItemId would coincide and a
  // swap between them would pass unnoticed.
  const [filler] = await db
    .insert(schema.lectures)
    .values({ title: "Filler, never committed" })
    .returning({ id: schema.lectures.id });

  await db.insert(schema.learningObjectives).values([
    { lectureId: filler.id, text: "Filler A", orderIndex: 0 },
    { lectureId: filler.id, text: "Filler B", orderIndex: 1 },
    { lectureId: filler.id, text: "Filler C", orderIndex: 2 },
  ]);

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

  // Distinct values per field: with commitLecture's defaults, dueOn and
  // lectureCommittedOn are both today and intervalDays and lapses are both 0,
  // so a crossed mapping between them would pass unnoticed.
  await db
    .update(schema.reviewItems)
    .set({
      dueOn: "2026-09-10",
      intervalDays: 7,
      lapses: 2,
      streak: 5,
      lastRating: "yellow",
    })
    .where(eq(schema.reviewItems.loId, objective!.id));

  await db
    .update(schema.lectures)
    .set({ committedAt: new Date("2026-08-20T12:00:00Z") })
    .where(eq(schema.lectures.id, lecture.id));

  // Inserted newest first, to prove the history is sorted by date and not by
  // insertion order.
  await db.insert(schema.performances).values({
    loId: objective!.id,
    studyDateId: later.id,
    score: 5,
  });
  await db.insert(schema.performances).values({
    loId: objective!.id,
    studyDateId: earlier.id,
    score: 2,
  });

  const item = await db.query.reviewItems.findFirst({
    where: eq(schema.reviewItems.loId, objective!.id),
  });

  const candidates = await dailyCandidates();

  expect(candidates).toHaveLength(1);

  // The assertion below compares values, not which column produced them, so it
  // can only catch a swapped mapping while these six stay pairwise distinct.
  expect(
    new Set([item!.id, objective!.id, lecture.id, 7, 2, 5]).size,
  ).toBe(6);

  expect(candidates[0]).toEqual({
    loId: objective!.id,
    lectureId: lecture.id,
    block: "Renal",
    suspended: false,
    lectureCommittedOn: "2026-08-20",
    // Oldest first: red on the 1st, green on the 2nd.
    scores: [2, 5],
    items: [
      {
        reviewItemId: item!.id,
        ordinal: 1,
        kind: "fact",
        dueOn: "2026-09-10",
        intervalDays: 7,
        lapses: 2,
        streak: 5,
        lastRating: "yellow",
      },
    ],
  });
});
