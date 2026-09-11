import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { FFPROBE_PATH } from "../core/binaries";
import * as tracksRepo from "../db/repositories/tracks";
import { bus } from "../core/bus";
import { createLogger } from "../core/logger";
import { processInBatches } from "./concurrency";

const log = createLogger("media/localFiles");
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"]);

interface ProbeResult {
  title: string;
  durationSeconds: number | null;
}

async function probe(path: string): Promise<ProbeResult> {
  const proc = Bun.spawn(
    [FFPROBE_PATH, "-v", "quiet", "-print_format", "json", "-show_format", "-show_entries", "format_tags=title:format=duration", path],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const json = JSON.parse(stdout);
    return {
      title: json.format?.tags?.title ?? path.split("/").pop() ?? path,
      durationSeconds: json.format?.duration ? Math.round(Number(json.format.duration)) : null,
    };
  } catch {
    return { title: path.split("/").pop() ?? path, durationSeconds: null };
  }
}

function idForPath(path: string): string {
  return "local-" + createHash("sha1").update(path).digest("hex").slice(0, 16);
}

/**
 * Scans `folder` for audio files and upserts each into `tracks`, batched
 * and concurrency-limited (limit ~4-8, each ffprobe is a real OS process —
 * see doc §9), with progress persisted incrementally so a crash partway
 * through doesn't lose everything already scanned.
 */
export async function scanLocalFolder(folder: string, jobId: string, concurrency = 6): Promise<number> {
  const entries = await readdir(folder, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => join(folder, e.name));

  let done = 0;
  await processInBatches(files, concurrency, async (path) => {
    try {
      const meta = await probe(path);
      tracksRepo.upsertTrack({
        id: idForPath(path),
        sourceType: "local",
        sourceUrl: null,
        localPath: path,
        title: meta.title,
        durationSeconds: meta.durationSeconds,
        thumbnailUrl: null,
        addedAt: Date.now(),
      });
    } catch (err) {
      log.warn("failed to probe local file, skipping", { path, error: String(err) });
    } finally {
      done++;
      bus.emit("download.progress", { jobId, done, total: files.length });
    }
  });

  return files.length;
}
