/**
 * Applies migrations from ./drizzle using drizzle-orm's Bun-native migrator.
 *
 * drizzle-kit's own `migrate` command can only connect through better-sqlite3
 * or @libsql/client, neither of which we want in a Bun-only toolchain. Its
 * `generate` command needs no database connection, so that still runs from the
 * CLI (`bun run db:generate`).
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const dbPath = process.env.DATABASE_URL ?? "./studyhelp.db";

const sqlite = new Database(dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
sqlite.close();

console.log(`Migrations applied to ${dbPath}`);
