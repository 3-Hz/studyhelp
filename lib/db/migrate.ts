import { sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/**
 * Applies the migrations folder with foreign-key enforcement off for the
 * duration, then checks and restores it.
 *
 * drizzle-kit rebuilds a SQLite table to drop or retype a column: create
 * `__new_x`, copy the rows, DROP TABLE x, rename. The `PRAGMA
 * foreign_keys=OFF` it writes into the file is a no-op inside the
 * migrator's transaction, and with enforcement on, DROP TABLE runs an
 * implicit DELETE that fires ON DELETE actions — migration 0008 would have
 * emptied `attempts` and `messages` this way. Enforcement can only change
 * outside a transaction, so it is switched off here, before the migrator
 * opens one.
 */
export function runMigrations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase<any>,
  migrationsFolder = "./drizzle",
): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    migrate(db, { migrationsFolder });
    const violations = db.all(sql`PRAGMA foreign_key_check`);
    if (violations.length > 0) {
      throw new Error(
        `Foreign key check failed after migrating: ${JSON.stringify(violations)}`,
      );
    }
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
}
