import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Migration 0005 backfills review_items.streak from the ladder position of
 * items that have only ever gone green. The drizzle migrator applies every
 * file in one go, so this test runs the SQL files itself: everything before
 * 0005, seed rows at each rung, then 0005.
 */
const files = readdirSync("./drizzle")
  .filter((file) => file.endsWith(".sql"))
  .sort();
const BACKFILL = files.find((file) => file.startsWith("0005_"));
const BEFORE = files.filter((file) => file < "0005_");

function apply(sqlite: Database, file: string) {
  const sql = readFileSync(`./drizzle/${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) sqlite.exec(statement);
  }
}

function seedItem(
  sqlite: Database,
  intervalDays: number,
  lastRating: string | null,
  lapses: number,
): number {
  const result = sqlite
    .prepare(
      "INSERT INTO review_items (lo_id, concept, kind, due_on, interval_days, last_rating, lapses) " +
        "VALUES (1, ?, 'fact', '2026-09-04', ?, ?, ?)",
    )
    .run(`${intervalDays}/${lastRating}/${lapses}`, intervalDays, lastRating, lapses);
  return Number(result.lastInsertRowid);
}

function streakOf(sqlite: Database, id: number): number {
  const row = sqlite
    .prepare("SELECT streak FROM review_items WHERE id = ?")
    .get(id) as { streak: number };
  return row.streak;
}

function freshBeforeBackfill(): Database {
  const sqlite = new Database(":memory:");
  for (const file of BEFORE) apply(sqlite, file);
  sqlite.exec("INSERT INTO lectures (title) VALUES ('Amyloidosis')");
  sqlite.exec(
    "INSERT INTO learning_objectives (lecture_id, text, order_index) VALUES (1, 'Describe fibrils.', 0)",
  );
  return sqlite;
}

test("0005 backfills streak from the ladder position of never-lapsed green items", () => {
  expect(BACKFILL).toBeDefined();
  const sqlite = freshBeforeBackfill();

  const rungs = [0, 1, 3, 7, 14, 30, 60, 120].map((interval) =>
    seedItem(sqlite, interval, "green", 0),
  );
  const lapsed = seedItem(sqlite, 14, "green", 1);
  const yellow = seedItem(sqlite, 14, "yellow", 0);
  const untested = seedItem(sqlite, 0, null, 0);

  apply(sqlite, BACKFILL!);

  expect(rungs.map((id) => streakOf(sqlite, id))).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
  // A lapsed item's history is not recoverable, and it cannot be mature yet.
  expect(streakOf(sqlite, lapsed)).toBe(0);
  expect(streakOf(sqlite, yellow)).toBe(0);
  expect(streakOf(sqlite, untested)).toBe(0);
});

test("0005 adds sessions.outcomes", () => {
  const sqlite = freshBeforeBackfill();
  apply(sqlite, BACKFILL!);

  sqlite.exec("INSERT INTO sessions (type, outcomes) VALUES ('daily', '[]')");
  const row = sqlite
    .prepare("SELECT outcomes FROM sessions")
    .get() as { outcomes: string };
  expect(row.outcomes).toBe("[]");
});
