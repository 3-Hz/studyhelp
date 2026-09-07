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

// --- 0006: scores, marks, concept numbers, budgets, practice questions ---

const SCORES = files.find((file) => file.startsWith("0006_"));
const BEFORE_SCORES = files.filter((file) => file < "0006_");

function freshBeforeScores(): Database {
  const sqlite = new Database(":memory:");
  for (const file of BEFORE_SCORES) apply(sqlite, file);
  sqlite.exec("INSERT INTO lectures (title) VALUES ('Amyloidosis')");
  sqlite.exec(
    "INSERT INTO learning_objectives (lecture_id, text, order_index) VALUES " +
      "(1, 'Describe fibrils.', 0), (1, 'Name the stains.', 1)",
  );
  sqlite.exec(
    "INSERT INTO study_dates (date) VALUES ('2026-09-01'), ('2026-09-02'), ('2026-09-03')",
  );
  return sqlite;
}

function count(sqlite: Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("0006 numbers each objective's review items in id order", () => {
  expect(SCORES).toBeDefined();
  const sqlite = freshBeforeScores();

  // Interleaved, so per-objective numbering and global id order differ.
  for (const loId of [1, 2, 1, 2, 1]) {
    sqlite
      .prepare(
        "INSERT INTO review_items (lo_id, concept, kind, due_on) VALUES (?, ?, 'fact', '2026-09-04')",
      )
      .run(loId, `under ${loId}`);
  }

  apply(sqlite, SCORES!);

  const rows = sqlite
    .prepare("SELECT lo_id, ordinal FROM review_items ORDER BY id")
    .all() as { lo_id: number; ordinal: number }[];
  expect(rows).toEqual([
    { lo_id: 1, ordinal: 1 },
    { lo_id: 2, ordinal: 1 },
    { lo_id: 1, ordinal: 2 },
    { lo_id: 2, ordinal: 2 },
    { lo_id: 1, ordinal: 3 },
  ]);
});

test("0006 backfills a 1–5 score from each dashboard cell's colour", () => {
  const sqlite = freshBeforeScores();
  sqlite.exec(
    "INSERT INTO performances (lo_id, study_date_id, rating) VALUES " +
      "(1, 1, 'green'), (1, 2, 'yellow'), (1, 3, 'red')",
  );

  apply(sqlite, SCORES!);

  const rows = sqlite
    .prepare("SELECT score FROM performances ORDER BY study_date_id")
    .all() as { score: number }[];
  expect(rows.map((row) => row.score)).toEqual([5, 4, 2]);
});

test("0006 backfills attempt scores and leaves ungraded attempts alone", () => {
  const sqlite = freshBeforeScores();
  sqlite.exec("INSERT INTO sessions (type) VALUES ('daily')");
  for (const rating of ["green", "yellow", "red", null]) {
    sqlite
      .prepare(
        "INSERT INTO attempts (session_id, stage, format, question, rating) " +
          "VALUES (1, 'daily', 'free_recall', 'q', ?)",
      )
      .run(rating);
  }

  apply(sqlite, SCORES!);

  const rows = sqlite
    .prepare("SELECT score FROM attempts ORDER BY id")
    .all() as { score: number | null }[];
  expect(rows.map((row) => row.score)).toEqual([5, 4, 2, null]);
});

test("0006 adds sessions.minutes and attempts.concept_marks", () => {
  const sqlite = freshBeforeScores();
  apply(sqlite, SCORES!);

  sqlite.exec("INSERT INTO sessions (type, minutes) VALUES ('daily', 20)");
  sqlite.exec(
    "INSERT INTO attempts (session_id, stage, format, question, concept_marks) " +
      `VALUES (1, 'daily', 'free_recall', 'q', '[{"reviewItemId":1,"mark":"green"}]')`,
  );

  const session = sqlite.prepare("SELECT minutes FROM sessions").get() as { minutes: number };
  expect(session.minutes).toBe(20);
  const attempt = sqlite
    .prepare("SELECT concept_marks FROM attempts")
    .get() as { concept_marks: string };
  expect(JSON.parse(attempt.concept_marks)).toEqual([{ reviewItemId: 1, mark: "green" }]);
});

test("0006 creates concept_marks: one mark per item per day", () => {
  const sqlite = freshBeforeScores();
  sqlite.exec(
    "INSERT INTO review_items (lo_id, concept, kind, due_on) VALUES (1, 'c', 'fact', '2026-09-04')",
  );
  apply(sqlite, SCORES!);

  sqlite.exec("INSERT INTO concept_marks (review_item_id, study_date_id, mark) VALUES (1, 1, 'green')");
  expect(() =>
    sqlite.exec("INSERT INTO concept_marks (review_item_id, study_date_id, mark) VALUES (1, 1, 'red')"),
  ).toThrow();
  sqlite.exec("INSERT INTO concept_marks (review_item_id, study_date_id, mark) VALUES (1, 2, 'red')");

  expect(count(sqlite, "concept_marks")).toBe(2);
});

test("0006 creates practice_questions under a lecture, optionally under an objective", () => {
  const sqlite = freshBeforeScores();
  apply(sqlite, SCORES!);

  sqlite.exec(
    "INSERT INTO practice_questions (lecture_id, lo_id, question, answer, slide_refs) " +
      "VALUES (1, 1, 'Which stain?', 'Congo red', '[12]')",
  );
  sqlite.exec(
    "INSERT INTO practice_questions (lecture_id, lo_id, question, answer, slide_refs) " +
      "VALUES (1, NULL, 'What is amyloid?', 'A misfolded protein.', '[]')",
  );

  expect(count(sqlite, "practice_questions")).toBe(2);
});

// --- 0007: the colour columns go ---

const DROP_COLOURS = files.find((file) => file.startsWith("0007_"));
const BEFORE_DROP = files.filter((file) => file < "0007_");

function freshBeforeDrop(): Database {
  const sqlite = new Database(":memory:");
  for (const file of BEFORE_DROP) apply(sqlite, file);
  sqlite.exec("INSERT INTO lectures (title) VALUES ('Amyloidosis')");
  sqlite.exec(
    "INSERT INTO learning_objectives (lecture_id, text, order_index) VALUES (1, 'Describe fibrils.', 0)",
  );
  sqlite.exec(
    "INSERT INTO study_dates (date) VALUES ('2026-09-01'), ('2026-09-02'), ('2026-09-03')",
  );
  return sqlite;
}

function columnsOf(sqlite: Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

test("0007 drops the rating columns and keeps the scores", () => {
  expect(DROP_COLOURS).toBeDefined();
  const sqlite = freshBeforeDrop();
  sqlite.exec(
    "INSERT INTO performances (lo_id, study_date_id, rating, score) VALUES (1, 1, 'green', 5)",
  );
  sqlite.exec("INSERT INTO sessions (type) VALUES ('daily')");
  sqlite.exec(
    "INSERT INTO attempts (session_id, stage, format, question, rating, score) " +
      "VALUES (1, 'daily', 'free_recall', 'q', 'yellow', 4)",
  );

  apply(sqlite, DROP_COLOURS!);

  expect(columnsOf(sqlite, "performances")).not.toContain("rating");
  expect(columnsOf(sqlite, "attempts")).not.toContain("rating");
  expect((sqlite.prepare("SELECT score FROM performances").get() as { score: number }).score).toBe(5);
  expect((sqlite.prepare("SELECT score FROM attempts").get() as { score: number }).score).toBe(4);
});

test("0007 makes a cell's score required, dropping any cell that never had one", () => {
  const sqlite = freshBeforeDrop();
  sqlite.exec(
    "INSERT INTO performances (lo_id, study_date_id, rating, score) VALUES " +
      "(1, 1, 'green', 5), (1, 2, 'suspended', NULL)",
  );

  apply(sqlite, DROP_COLOURS!);

  expect(count(sqlite, "performances")).toBe(1);
  expect(() =>
    sqlite.exec("INSERT INTO performances (lo_id, study_date_id) VALUES (1, 3)"),
  ).toThrow();
});
