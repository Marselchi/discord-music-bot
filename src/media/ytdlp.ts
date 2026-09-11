import { dirname, isAbsolute } from "node:path";
import { FFMPEG_PATH, YTDLP_PATH } from "../core/binaries";
import { createLogger } from "../core/logger";
import { trackProcess } from "../core/processRegistry";
import { SpawnPool } from "./concurrency";

const log = createLogger("media/ytdlp");

export const ytdlpPlaybackPool = new SpawnPool(6, "ytdlp-playback");
export const ytdlpImportPool = new SpawnPool(3, "ytdlp-import");

export interface YtDlpMetadata {
  id: string;
  title: string;
  duration: number | null;
  thumbnail: string | null;
  webpage_url: string;
}

/**
 * `yt-dlp -J <url>` — metadata as JSON on stdout. Always an argv array,
 * never a shell string, so a malicious/malformed URL can't be used for
 * shell injection (see doc §8).
 */
export async function getMetadata(url: string, timeoutMs = 30_000): Promise<YtDlpMetadata> {
  const proc = Bun.spawn([YTDLP_PATH, "-J", "--no-playlist", url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  trackProcess(proc);

  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      log.error("yt-dlp metadata lookup failed", { url, exitCode, stderr: stderr.slice(0, 500) });
      throw new Error(`yt-dlp exited ${exitCode} for ${url}`);
    }

    const json = JSON.parse(stdout);
    return {
      id: json.id,
      title: json.title,
      duration: json.duration ?? null,
      thumbnail: json.thumbnail ?? null,
      webpage_url: json.webpage_url ?? url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Spawns `yt-dlp -o - <url>` streaming raw bytes to stdout, for piping
 * straight into ffmpeg. Caller owns the returned process (and must not
 * buffer its stdout into memory — pipe it onward). Kept as a fallback path;
 * normal playback now goes through downloadAudio() + a cached file instead.
 */
export function spawnStream(url: string) {
  const proc = Bun.spawn([YTDLP_PATH, "-o", "-", "--no-playlist", url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  trackProcess(proc);
  return proc;
}

/**
 * Downloads and extracts audio to `<outputDir>/<trackId>.opus`, once.
 * This is the "download and save so we never re-fetch it" path (see doc
 * §9 in doc.md) — the queue/player only ever re-download if the cached
 * file was evicted or deleted.
 */
export async function downloadAudio(url: string, outputDir: string, trackId: string, timeoutMs = 10 * 60_000): Promise<string> {
  const outputTemplate = `${outputDir}/${trackId}.%(ext)s`;
  const args = [
    YTDLP_PATH,
    "-x",
    "--audio-format",
    "opus",
    "--audio-quality",
    "0",
    "--no-playlist",
  ];

  // Only point yt-dlp at a specific ffmpeg if we actually resolved a local
  // one (see core/binaries.ts) — if FFMPEG_PATH fell back to the bare
  // "ffmpeg" name, dirname() of that would be "." (nonsense), so instead
  // just let yt-dlp search PATH itself in that case.
  if (isAbsolute(FFMPEG_PATH)) {
    args.push("--ffmpeg-location", dirname(FFMPEG_PATH));
  }

  args.push("-o", outputTemplate, url);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  trackProcess(proc);

  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      log.error("yt-dlp download failed", { url, exitCode, stderr: stderr.slice(0, 500) });
      throw new Error(`yt-dlp download exited ${exitCode} for ${url}`);
    }
    // --audio-format opus guarantees the post-processed extension is .opus,
    // so this matches media/cache.ts's cachePathFor(trackId) exactly.
    return `${outputDir}/${trackId}.opus`;
  } finally {
    clearTimeout(timeout);
  }
}
