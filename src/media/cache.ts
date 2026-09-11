import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { APP_DIR, getConfig } from "../core/config";
import { getDb } from "../db/index";
import { createLogger } from "../core/logger";

const log = createLogger("media/cache");
export const CACHE_DIR = join(APP_DIR, "cache");

const RUNNING_SIZE_KEY = "cache_size_bytes";

export function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function getRunningSize(): number {
  const row = getDb().query("SELECT value FROM settings WHERE key = ?").get(RUNNING_SIZE_KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function setRunningSize(bytes: number): void {
  getDb()
    .query(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(RUNNING_SIZE_KEY, String(bytes));
}

export function recordCacheWrite(bytesAdded: number): void {
  setRunningSize(getRunningSize() + bytesAdded);
}

/** Downloaded/transcoded tracks are saved once as Opus (small, no quality loss on re-encode to Discord's Opus stream). */
export function cachePathFor(trackId: string): string {
  return join(CACHE_DIR, `${trackId}.opus`);
}

export function isCached(trackId: string): boolean {
  return existsSync(cachePathFor(trackId));
}

/**
 * Not walked/checked on every write — cumulative size is tracked
 * incrementally in `settings`, and eviction runs on a periodic interval
 * rather than synchronously per write (see doc §9).
 */
export function evictOldestIfOverBudget(maxBytes: number = getConfig().cacheDirMaxBytes): void {
  const current = getRunningSize();
  if (current <= maxBytes) return;

  const oldest = getDb()
    .query(
      `SELECT t.id FROM tracks t
       LEFT JOIN history h ON h.track_id = t.id
       WHERE t.source_type != 'local'
       GROUP BY t.id
       ORDER BY MAX(h.played_at) ASC
       LIMIT 20`
    )
    .all() as { id: string }[];

  let freed = 0;
  for (const { id } of oldest) {
    const path = cachePathFor(id);
    if (existsSync(path)) {
      const size = statSync(path).size;
      rmSync(path);
      freed += size;
      log.info("evicted cached track", { trackId: id, freedBytes: size });
    }
    if (current - freed <= maxBytes) break;
  }
  setRunningSize(Math.max(0, current - freed));
}
