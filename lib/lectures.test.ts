import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const TEST_DB = `./.test-lectures-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("./db");
const { listLectures } = await import("./lectures");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

beforeAll(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [first] = await db
    .insert(schema.lectures)
    .values({ title: "Amyloidosis", committedAt: new Date() })
    .returning({ id: schema.lectures.id });

  const [second] = await db
    .insert(schema.lectures)
    .values({ title: "Uncommitted draft" })
    .returning({ id: schema.lectures.id });

  // Four objectives on the first lecture, none on the second.
  await db.insert(schema.learningObjectives).values(
    ["A", "B", "C", "D"].map((text, index) => ({
      lectureId: first.id,
      text,
      orderIndex: index,
    })),
  );

  // A third lecture with a single objective, to catch a count that is
  // accidentally constant across rows.
  const [third] = await db
    .insert(schema.lectures)
    .values({ title: "One objective", committedAt: new Date() })
    .returning({ id: schema.lectures.id });
  await db
    .insert(schema.learningObjectives)
    .values({ lectureId: third.id, text: "Only one", orderIndex: 0 });

  void second;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

test("counts objectives per lecture independently", async () => {
  // Regression: a raw correlated subquery here rendered its columns
  // unqualified, so SQLite resolved both sides against learning_objectives
  // (which has its own `id`). Every lecture got the same wrong count.
  const lectures = await listLectures();
  const byTitle = new Map(lectures.map((l) => [l.title, l.objectiveCount]));

  expect(byTitle.get("Amyloidosis")).toBe(4);
  expect(byTitle.get("One objective")).toBe(1);
  expect(byTitle.get("Uncommitted draft")).toBe(0);
});

test("counts are not identical across lectures", async () => {
  const counts = (await listLectures()).map((l) => l.objectiveCount);
  expect(new Set(counts).size).toBeGreaterThan(1);
});

test("returns every lecture, including ones with no objectives", async () => {
  const lectures = await listLectures();
  expect(lectures).toHaveLength(3);
});

test("orders newest first", async () => {
  const lectures = await listLectures();
  const times = lectures.map((l) => l.createdAt.getTime());
  expect([...times].sort((a, b) => b - a)).toEqual(times);
});

test("distinguishes committed lectures from drafts", async () => {
  const lectures = await listLectures();
  const draft = lectures.find((l) => l.title === "Uncommitted draft");
  expect(draft?.committedAt).toBeNull();
  expect(lectures.find((l) => l.title === "Amyloidosis")?.committedAt).not.toBeNull();
});
