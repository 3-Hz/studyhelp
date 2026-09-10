import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-open-reviews-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("../db");
const { openReviews } = await import("./openReviews");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

beforeAll(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

async function lecture(title: string): Promise<number> {
  const [row] = await db
    .insert(schema.lectures)
    .values({ title })
    .returning({ id: schema.lectures.id });
  return row.id;
}

async function objective(lectureId: number): Promise<number> {
  const [row] = await db
    .insert(schema.learningObjectives)
    .values({ lectureId, text: "An objective.", orderIndex: 0 })
    .returning({ id: schema.learningObjectives.id });
  return row.id;
}

async function session(
  values: Partial<typeof schema.sessions.$inferInsert> & { lectureIds?: number[] | null },
): Promise<number> {
  const [row] = await db
    .insert(schema.sessions)
    .values({ type: "review", minutes: 20, ...values })
    .returning({ id: schema.sessions.id });
  return row.id;
}

async function attempt(sessionId: number, loId: number, score: 1 | 2 | 3 | 4 | 5 | null) {
  await db.insert(schema.attempts).values({
    sessionId,
    stage: "lo_recall",
    loId,
    format: "free_recall",
    question: "Recall it.",
    studentAnswer: score === null ? null : "An answer.",
    score,
  });
}

test("lists unfinished reviews newest first, with their lectures in id order and the answers graded so far", async () => {
  const b = await lecture("Glomerular disease");
  const a = await lecture("Amyloidosis");
  const loA = await objective(a);
  const older = await session({
    lectureIds: [b, a],
    startedAt: new Date("2026-09-07T10:00:00"),
  });
  await attempt(older, loA, 4);
  await attempt(older, loA, 2);
  // Asked but not yet answered: not counted.
  await attempt(older, loA, null);
  const newer = await session({
    lectureIds: [a],
    startedAt: new Date("2026-09-08T10:00:00"),
  });

  const open = await openReviews();

  expect(open.map((review) => review.id)).toEqual([newer, older]);
  expect(open[1]).toEqual({
    id: older,
    startedOn: "2026-09-07",
    minutes: 20,
    lectures: [
      { id: b, title: "Glomerular disease" },
      { id: a, title: "Amyloidosis" },
    ],
    answered: 2,
  });
  expect(open[0].answered).toBe(0);
});

test("a finished review and an open daily session are not offered", async () => {
  const a = await lecture("Finished");
  await session({ lectureIds: [a], endedAt: new Date() });
  await session({ type: "daily", lectureIds: null });

  const open = await openReviews();

  expect(open.some((review) => review.lectures.some((l) => l.id === a))).toBe(false);
  expect(open.every((review) => review.lectures.length > 0)).toBe(true);
});

test("a review whose lectures were all deleted is dropped: nothing could resume or finish it", async () => {
  const gone = await lecture("Deleted later");
  const kept = await lecture("Kept");
  const orphan = await session({ lectureIds: [gone] });
  const survivor = await session({ lectureIds: [gone, kept] });
  await db.delete(schema.lectures).where(eq(schema.lectures.id, gone));

  const open = await openReviews();

  expect(open.some((review) => review.id === orphan)).toBe(false);
  const partial = open.find((review) => review.id === survivor);
  expect(partial?.lectures).toEqual([{ id: kept, title: "Kept" }]);
});
