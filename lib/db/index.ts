import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

type Db = BunSQLiteDatabase<typeof schema>;

function dbPath(): string {
  return process.env.DATABASE_URL ?? "./studyhelp.db";
}

/**
 * Next.js dev reloads modules on every edit, which would otherwise open a new
 * SQLite handle each time. Cache connections on globalThis.
 *
 * Keyed by path rather than a single slot: test files each point
 * DATABASE_URL at their own database, and Bun may run them in one process. A
 * single cached handle means the second file silently gets the first one's
 * database — which fails confusingly at migrate() rather than at the point of
 * the mistake.
 */
const globalForDb = globalThis as unknown as {
  __studyhelpDb?: Map<string, Db>;
};

function createDb(path: string): Db {
  const sqlite = new Database(path, { create: true });
  // WAL keeps reads from blocking the writer during a study session.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema });
}

function getDb(): Db {
  const path = dbPath();
  const cache = (globalForDb.__studyhelpDb ??= new Map<string, Db>());

  let instance = cache.get(path);
  if (!instance) {
    instance = createDb(path);
    cache.set(path, instance);
  }
  return instance;
}

/**
 * Lazily-connected database handle.
 *
 * The connection is opened on first *use*, not on import. `next build` spawns
 * ~10 workers that each import every route module to collect page data; with
 * an eager connection they all open the same WAL file at once and the build
 * dies with SQLITE_BUSY_RECOVERY. Nothing here needs a connection at import
 * time, so we don't make one.
 */
export const db = new Proxy({} as Db, {
  get(_target, property, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance as object, property, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export { schema };
