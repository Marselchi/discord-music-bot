import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config";

const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

/**
 * Resolves a binary by name: prefer a copy sitting next to the app
 * (APP_DIR — the project root in `bun run dev`, or the folder containing
 * the compiled executable in production), falling back to the bare
 * command name so PATH resolution still works during development if you
 * haven't copied the binary in yet.
 *
 * This exists because a compiled standalone executable
 * (`bun build --compile`) only bundles JS/TS — a binary dependency
 * resolved from node_modules at runtime (like ffmpeg-static's downloaded
 * binary) does NOT get embedded and silently breaks once you ship just
 * the .exe. The fix is shipping the binaries as plain files next to the
 * executable and resolving them from there, which is what this does.
 */
function resolveBinary(name: string): string {
  const localPath = join(APP_DIR, `${name}${EXE_SUFFIX}`);
  if (existsSync(localPath)) return localPath;
  return name;
}

export const FFMPEG_PATH = resolveBinary("ffmpeg");
export const FFPROBE_PATH = resolveBinary("ffprobe");
export const YTDLP_PATH = resolveBinary("yt-dlp");
