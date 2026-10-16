import { dirname, isAbsolute } from "node:path";
import { FFMPEG_PATH, YTDLP_PATH } from "../core/binaries";
import { createLogger } from "../core/logger";
import { trackProcess } from "../core/processRegistry";
import { SpawnPool } from "./concurrency";

const log = createLogger("media/ytdlp");

export const ytdlpPlaybackPool = new SpawnPool(6, "ytdlp-playback");
export const ytdlpImportPool = new SpawnPool(3, "ytdlp-import");

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
}

export interface YtDlpMetadata {
  id: string;
  title: string;
  duration: number | null;
  thumbnail: string | null;
  webpage_url: string;
  chapters?: Chapter[];
}

export interface PlaylistMetadata {
  id: string;
  title: string;
  entries: YtDlpMetadata[];
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
    const chapters: Chapter[] = Array.isArray(json.chapters)
      ? json.chapters.map((c: any) => ({
          title: String(c.title || `Chapter ${c.start_time}`),
          startTime: Math.max(0, Number(c.start_time) || 0),
          endTime: Math.max(0, Number(c.end_time) || 0),
        }))
      : [];

    return {
      id: json.id,
      title: json.title,
      duration: json.duration ?? null,
      thumbnail: json.thumbnail ?? null,
      webpage_url: json.webpage_url ?? url,
      chapters,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * `yt-dlp --flat-playlist -J <url>` — extracts playlist metadata and entries quickly.
 */
export async function getPlaylistMetadata(url: string, timeoutMs = 60_000): Promise<PlaylistMetadata> {
  const proc = Bun.spawn([YTDLP_PATH, "--flat-playlist", "-J", url], {
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
      log.error("yt-dlp playlist metadata lookup failed", { url, exitCode, stderr: stderr.slice(0, 500) });
      throw new Error(`yt-dlp playlist lookup exited ${exitCode} for ${url}`);
    }

    const json = JSON.parse(stdout);
    const rawEntries = Array.isArray(json.entries) ? json.entries : [json];
    const entries: YtDlpMetadata[] = rawEntries
      .filter((e: any) => e && (e.id || e.url))
      .map((e: any) => {
        const id = String(e.id || e.url);
        let webUrl = e.webpage_url || e.url;
        if (!webUrl || !webUrl.startsWith("http")) {
          webUrl = `https://www.youtube.com/watch?v=${id}`;
        }
        let thumbnail = e.thumbnail ?? null;
        if (!thumbnail && Array.isArray(e.thumbnails) && e.thumbnails.length > 0) {
          thumbnail = e.thumbnails[e.thumbnails.length - 1].url;
        }
        return {
          id,
          title: String(e.title || "Untitled"),
          duration: typeof e.duration === "number" ? e.duration : null,
          thumbnail,
          webpage_url: webUrl,
        };
      });

    return {
      id: String(json.id || "playlist"),
      title: String(json.title || "Playlist"),
      entries,
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
