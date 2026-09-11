import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config";

type Level = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(APP_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "app.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB, then rotate once to app.log.1

const SECRET_KEYS = new Set(["discordToken", "token", "x-local-token", "password"]);

function redact(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v);
  }
  return out;
}

function rotateIfNeeded(): void {
  if (!existsSync(LOG_FILE)) return;
  try {
    if (statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    // best-effort; never let logging itself crash the app
  }
}

function write(level: Level, module: string, message: string, context?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module,
    message,
    ...(context ? { context: redact(context) } : {}),
  };
  const line = JSON.stringify(entry);

  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${entry.ts}] ${level.toUpperCase()} (${module}) ${message}`, context ? redact(context) : "");

  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // filesystem issue writing logs shouldn't crash the app
  }
}

export function createLogger(module: string) {
  return {
    debug: (message: string, context?: Record<string, unknown>) => write("debug", module, message, context),
    info: (message: string, context?: Record<string, unknown>) => write("info", module, message, context),
    warn: (message: string, context?: Record<string, unknown>) => write("warn", module, message, context),
    error: (message: string, context?: Record<string, unknown>) => write("error", module, message, context),
  };
}

export type Logger = ReturnType<typeof createLogger>;
