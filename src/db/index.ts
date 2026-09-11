import { Database } from "bun:sqlite";
import { join } from "node:path";
import { APP_DIR } from "../core/config";
import { createLogger } from "../core/logger";
import { MIGRATIONS } from "./migrations/index";

const log = createLogger("db");

let db: Database | null = null;

/**
 * Opens (or creates) the local SQLite file next to the executable, applies
 * any migrations that haven't run yet, and returns the shared connection.
 * Call once from index.ts; every repository imports `getDb()` after that.
 */
export function initDb(): Database {
  if (db) return db;

  db = new Database(join(APP_DIR, "data.db"), { create: true });

  // Single-writer, low-concurrency local workload -> WAL lets WS/API reader
  // threads and the occasional queue-mutation writer coexist without
  // fighting over a lock (see doc §5).
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  runMigrations(db);
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized — call initDb() first, from index.ts");
  return db;
}

function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const already = new Set(
    database.query("SELECT name FROM _migrations").all().map((row: any) => row.name)
  );

  for (const { name, sql } of MIGRATIONS) {
    if (already.has(name)) continue;
    log.info(`applying migration ${name}`);
    database.transaction(() => {
      database.exec(sql);
      database
        .query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run(name, Date.now());
    })();
  }
}
