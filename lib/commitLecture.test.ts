import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-commit-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("./db");
const { commitLecture } = await import("./commitLecture");
const { todayIso } = await import("./schedule");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

const draft = {
  title: "Amyloidosis",
  learningObjectives: [
    { text: "Describe the structure of amyloid fibrils.", slideRefs: [2] },
    { text: "Compare AL and ATTR amyloidosis.", slideRefs: [5] },
    { text: "Explain Congo red staining.", slideRefs: [7] },
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
      label: "Apple-green birefringence",
      detail: "Congo red under polarised light.",
      kind: "fact" as const,
      provenance: "taught" as const,
      relatedObjectiveIndexes: [2],
    },
    {
      label: "Tafamidis",
      detail: "Stabilises the TTR tetramer. Not covered in this lecture.",
      kind: "application" as const,
      provenance: "supplemental" as const,
      relatedObjectiveIndexes: [1],
    },
  ],
  commonConfusions: ["AL vs ATTR precursor proteins"],
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

async function seedLecture() {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: "Amyloidosis", draftExtract: draft })
    .returning({ id: schema.lectures.id });
  return lecture.id;
}

test("commits approved objectives verbatim and in order", async () => {
  const lectureId = await seedLecture();

  const result = await commitLecture(lectureId, [
    { draftIndex: 0, text: "Describe the structure of amyloid fibrils." },
    { draftIndex: 1, text: "Compare AL and ATTR amyloidosis." },
    { draftIndex: 2, text: "Explain Congo red staining." },
  ]);

  expect(result.objectivesCreated).toBe(3);

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });
  expect(objectives.map((o) => o.orderIndex)).toEqual([0, 1, 2]);
  expect(objectives[1].text).toBe("Compare AL and ATTR amyloidosis.");
});

test("creates review items without creating dashboard rows for concepts", async () => {
  const lectureId = await seedLecture();
  const result = await commitLecture(lectureId, [
    { draftIndex: 0, text: draft.learningObjectives[0].text },
    { draftIndex: 1, text: draft.learningObjectives[1].text },
    { draftIndex: 2, text: draft.learningObjectives[2].text },
  ]);

  // Four concepts become four review items, but only three dashboard rows.
  expect(result.objectivesCreated).toBe(3);
  expect(result.reviewItemsCreated).toBe(4);

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });
  expect(objectives).toHaveLength(3);
});

test("drops concepts whose objectives were all rejected", async () => {
  const lectureId = await seedLecture();

  // Keep only the first objective; concepts tied to indexes 1 and 2 orphan.
  const result = await commitLecture(lectureId, [
    { draftIndex: 0, text: draft.learningObjectives[0].text },
  ]);

  expect(result.objectivesCreated).toBe(1);
  expect(result.reviewItemsCreated).toBe(1);
});

test("preserves supplemental provenance on review items", async () => {
  const lectureId = await seedLecture();
  await commitLecture(lectureId, [
    { draftIndex: 1, text: draft.learningObjectives[1].text },
  ]);

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });
  const items = await db.query.reviewItems.findMany({
    where: eq(schema.reviewItems.loId, objectives[0].id),
  });

  const supplemental = items.filter((i) => i.provenance === "supplemental");
  expect(supplemental).toHaveLength(1);
  expect(supplemental[0].concept).toContain("Tafamidis");
});

test("hand-added objectives commit even though no concept references them", async () => {
  const lectureId = await seedLecture();
  const result = await commitLecture(lectureId, [
    { draftIndex: -1, text: "An objective the deck omitted." },
  ]);

  expect(result.objectivesCreated).toBe(1);
  expect(result.reviewItemsCreated).toBe(0);
});

test("rejects an empty approval set", async () => {
  const lectureId = await seedLecture();
  await expect(commitLecture(lectureId, [])).rejects.toThrow(/at least one/i);
});

test("rejects blank objective text", async () => {
  const lectureId = await seedLecture();
  await expect(
    commitLecture(lectureId, [{ draftIndex: 0, text: "   " }]),
  ).rejects.toThrow(/at least one/i);
});

test("refuses to commit the same lecture twice", async () => {
  const lectureId = await seedLecture();
  await commitLecture(lectureId, [
    { draftIndex: 0, text: draft.learningObjectives[0].text },
  ]);

  await expect(
    commitLecture(lectureId, [
      { draftIndex: 1, text: draft.learningObjectives[1].text },
    ]),
  ).rejects.toThrow(/already been committed/i);
});

test("review items start due today at interval zero", async () => {
  const lectureId = await seedLecture();
  await commitLecture(lectureId, [
    { draftIndex: 0, text: draft.learningObjectives[0].text },
  ]);

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });
  const items = await db.query.reviewItems.findMany({
    where: eq(schema.reviewItems.loId, objectives[0].id),
  });

  expect(items[0].dueOn).toBe(todayIso());
  expect(items[0].intervalDays).toBe(0);
});
