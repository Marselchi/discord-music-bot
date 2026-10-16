import { statSync } from "node:fs";
import { FFMPEG_PATH } from "../core/binaries";
import { createLogger } from "../core/logger";
import { trackProcess } from "../core/processRegistry";
import * as tracksRepo from "../db/repositories/tracks";
import type { Track } from "../db/repositories/tracks";
import { CACHE_DIR, cachePathFor, ensureCacheDir, recordCacheWrite, evictOldestIfOverBudget } from "./cache";

const log = createLogger("media/slicer");

export interface SliceDefinition {
  title: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
}

/**
 * Extracts a segment of an existing audio file into an independent cached track.
 */
export async function sliceAudioFile(
  sourcePath: string,
  targetPath: string,
  startTime: number,
  duration: number
): Promise<void> {
  // Try stream copy first (instantaneous).
  const copyArgs = [
    FFMPEG_PATH,
    "-y",
    "-ss",
    String(startTime),
    "-i",
    sourcePath,
    "-t",
    String(duration),
    "-c:a",
    "copy",
    targetPath,
  ];

  let proc = Bun.spawn(copyArgs, { stdout: "pipe", stderr: "pipe" });
  trackProcess(proc);
  let [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (exitCode !== 0) {
    log.warn("stream copy slice failed, falling back to libopus transcode", {
      stderr: stderr.slice(0, 300),
    });
    // Fallback: transcode with libopus
    const transcodeArgs = [
      FFMPEG_PATH,
      "-y",
      "-ss",
      String(startTime),
      "-i",
      sourcePath,
      "-t",
      String(duration),
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
      targetPath,
    ];
    proc = Bun.spawn(transcodeArgs, { stdout: "pipe", stderr: "pipe" });
    trackProcess(proc);
    [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      log.error("slice transcode failed", { stderr: stderr.slice(0, 500) });
      throw new Error(`FFmpeg slice exited ${exitCode}`);
    }
  }
}

/**
 * Slices a source track into multiple independent tracks registered in SQLite and cache.
 */
export async function sliceTrack(
  parentTrack: Track,
  parentLocalPath: string,
  slices: SliceDefinition[]
): Promise<Track[]> {
  ensureCacheDir();
  const createdTracks: Track[] = [];
  const baseTimestamp = Date.now();

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!;
    const duration = Math.max(0.1, slice.endTime - slice.startTime);
    // Unique ID for the slice track
    const sliceId = `${parentTrack.id}_s${i + 1}_${baseTimestamp}`;
    const targetPath = cachePathFor(sliceId);

    log.info("slicing track segment", {
      parentTrackId: parentTrack.id,
      sliceId,
      startTime: slice.startTime,
      duration,
      title: slice.title,
    });

    await sliceAudioFile(parentLocalPath, targetPath, slice.startTime, duration);

    try {
      const stats = statSync(targetPath);
      recordCacheWrite(stats.size);
      evictOldestIfOverBudget();
    } catch (err) {
      log.warn("failed to record cache write for slice", { sliceId, error: String(err) });
    }

    const track: Track = {
      id: sliceId,
      sourceType: parentTrack.sourceType,
      sourceUrl: parentTrack.sourceUrl ? `${parentTrack.sourceUrl}#t=${Math.floor(slice.startTime)}` : null,
      localPath: null,
      title: slice.title.trim() || `${parentTrack.title} (Part ${i + 1})`,
      durationSeconds: Math.round(duration),
      thumbnailUrl: parentTrack.thumbnailUrl,
      addedAt: baseTimestamp + i,
    };

    tracksRepo.upsertTrack(track);
    createdTracks.push(track);
  }

  return createdTracks;
}
