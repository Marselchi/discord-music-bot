import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config";

const TOKEN_PATH = join(APP_DIR, ".token");

/**
 * One shared local token, generated on first run and stored next to the
 * executable. This is a *local machine* secret (one user, one box), not a
 * multi-tenant credential — see doc §9/§11 for why that's an appropriate
 * trust model here.
 */
export function getOrCreateLocalToken(): string {
  if (existsSync(TOKEN_PATH)) {
    const existing = readFileSync(TOKEN_PATH, "utf-8").trim();
    if (existing) return existing;
  }
  const token = crypto.randomUUID();
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

/** Constant-time-ish comparison to avoid trivial timing side channels. */
export function tokensMatch(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
