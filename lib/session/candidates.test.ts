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
