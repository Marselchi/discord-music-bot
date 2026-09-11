import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AppConfig {
  port: number;
  frontendOrigin: string;
  discordToken: string | null;
  musicFolder: string | null;
  cacheDirMaxBytes: number;
  importConcurrency: number;
  playbackConcurrency: number;
  maxQueueLength: number;
  spawnTimeoutMs: number;
}

const DEFAULTS: AppConfig = {
  port: 21000,
  frontendOrigin: "https://www.cozyfireplace.online",
  discordToken: null,
  musicFolder: null,
  cacheDirMaxBytes: 2 * 1024 * 1024 * 1024, // 2GB
  importConcurrency: 3,
  playbackConcurrency: 6,
  maxQueueLength: 500,
  spawnTimeoutMs: 30_000,
};

// Directory the compiled binary lives in (or cwd when running from source).
// config.json, logs/, bin/, and the sqlite file all live next to the executable
// so a non-technical user can just unzip-and-run.
export const APP_DIR = process.cwd();
const CONFIG_PATH = join(APP_DIR, "config.json");
const TOKEN_FILE_PATH = join(APP_DIR, "DISCORD_TOKEN.env");

function readConfigFile(): Partial<AppConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    console.error(`[config] Failed to parse config.json, ignoring it: ${err}`);
    return {};
  }
}

/**
 * Reads the bot token from DISCORD_TOKEN.env next to the executable, so a
 * single built binary can be handed to different users/deployments without
 * rebuilding — each of them just drops their own token in this file. Works
 * identically in `bun run dev` and in the compiled standalone binary,
 * since both resolve APP_DIR the same way (process.cwd()).
 *
 * Accepts either dotenv-style content (`DISCORD_TOKEN=abc123`, optionally
 * quoted, blank lines/`#` comments ignored) or the raw token as the file's
 * entire contents with nothing else in it — whichever is easier to drop in.
 */
function readTokenFile(): string | null {
  if (!existsSync(TOKEN_FILE_PATH)) return null;
  try {
    const raw = readFileSync(TOKEN_FILE_PATH, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^DISCORD_TOKEN\s*=\s*(.*)$/);
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
    // No `DISCORD_TOKEN=` line found — treat non-empty file content as the raw token.
    const wholeFile = raw.trim();
    return wholeFile.length > 0 ? wholeFile : null;
  } catch (err) {
    console.error(
      `[config] Failed to read DISCORD_TOKEN.env, ignoring it: ${err}`,
    );
    return null;
  }
}

function parseCliFlags(): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([a-zA-Z-]+)=(.+)$/);
    if (!match) continue;
    const [, rawKey, value] = match;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "port") out.port = Number(value);
    else if (key === "frontendOrigin") out.frontendOrigin = value;
    else if (key === "musicFolder") out.musicFolder = value;
  }
  return out;
}

let resolvedConfig: AppConfig | null = null;

/**
 * Read-only access to the already-loaded config, for modules deep in the
 * call graph (e.g. media/cache.ts) that shouldn't each thread `config`
 * through their whole call chain. Only valid after loadConfig() has run
 * once from index.ts.
 */
export function getConfig(): AppConfig {
  if (!resolvedConfig)
    throw new Error(
      "Config not loaded yet — call loadConfig() first, from index.ts",
    );
  return resolvedConfig;
}

/**
 * Priority (highest wins) for most settings: CLI flags > env vars >
 * config.json > defaults. The Discord token specifically is resolved
 * separately and never lives in config.json (see writeConfigFile) —
 * its own priority is: DISCORD_TOKEN env var > DISCORD_TOKEN.env file
 * > (legacy) discordToken in an old config.json, kept only for
 * backward compatibility with configs written before this file existed.
 * Unknown/future keys in config.json are silently ignored rather than
 * failing validation, so an older config file never breaks a newer binary.
 */
export function loadConfig(): AppConfig {
  const fromFile = readConfigFile();
  const fromCli = parseCliFlags();
  const tokenFromFile = readTokenFile();

  const config: AppConfig = {
    ...DEFAULTS,
    ...fromFile,
    port: Number(process.env.PORT ?? fromFile.port ?? DEFAULTS.port),
    frontendOrigin:
      process.env.FRONTEND_ORIGIN ??
      fromFile.frontendOrigin ??
      DEFAULTS.frontendOrigin,
    discordToken:
      process.env.DISCORD_TOKEN ??
      tokenFromFile ??
      fromFile.discordToken ??
      null,
    musicFolder: fromFile.musicFolder ?? DEFAULTS.musicFolder,
    ...fromCli,
  };

  // Fail fast, don't half-start, if the one truly required secret is missing.
  // Throws rather than calling process.exit() directly so index.ts's single
  // top-level catch handles the "print it clearly, keep the window open,
  // then exit" sequence uniformly for every kind of fatal startup error,
  // not just this one.
  if (!config.discordToken) {
    throw new Error(
      "No Discord bot token found. Create a DISCORD_TOKEN.env file " +
        "next to the executable containing DISCORD_TOKEN=<your bot token>, " +
        "or set the DISCORD_TOKEN environment variable.",
    );
  }

  // Persist a config.json on first run so subsequent runs need no flags/env
  // for everything else (port, frontendOrigin, musicFolder, ...). The token
  // itself is deliberately excluded — see writeConfigFile.
  if (!existsSync(CONFIG_PATH)) {
    writeConfigFile(config);
  }

  resolvedConfig = config;
  return config;
}

export function writeConfigFile(config: AppConfig): void {
  // The Discord token is never written to config.json. It's managed
  // exclusively via DISCORD_TOKEN.env (or the env var) precisely so the
  // same built binary/config.json can be reused across different users —
  // swap DISCORD_TOKEN.env, not config.json, and nothing else changes.
  const { discordToken, ...persisted } = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2));
}
