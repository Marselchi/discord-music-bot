import m001 from "./001_init.sql" with { type: "text" };

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Migrations, statically imported (not scanned from disk at runtime).
 * A compiled standalone executable (`bun build --compile`) only embeds
 * what's statically imported — `readdirSync()`-ing this folder at runtime
 * works in `bun run dev` but fails in a compiled binary (there's no real
 * directory to scan anymore, just bundled module code), which is exactly
 * the bug this fixes. Append-only: add a new entry here (and a new
 * NNN_*.sql file) for each future migration; never edit an existing one.
 */
export const MIGRATIONS: Migration[] = [{ name: "001_init.sql", sql: m001 }];
