import * as tracksRepo from "../db/repositories/tracks";
import type { Track } from "../db/repositories/tracks";
import { getMetadata, downloadAudio } from "./ytdlp";
import { spawnTranscode } from "./ffmpeg";
import { CACHE_DIR, cachePathFor, ensureCacheDir, isCached, recordCacheWrite, evictOldestIfOverBudget } from "./cache";
import { bus } from "../core/bus";
import { createLogger } from "../core/logger";
import { statSync } from "node:fs";
import { Readable } from "node:stream";

const log = createLogger("media/resolver");

export interface SourceHandler {
  name: string;
  canHandle(input: string): boolean;
  resolve(input: string): Promise<Track>;
}

/**
 * Registry, not an if/else chain (see doc §10). Adding a new source is
 * "write one file implementing SourceHandler, register it below" — never
 * a change to player/ or api/.
 */
const handlers: SourceHandler[] = [];

export function registerSource(handler: SourceHandler): void {
  handlers.push(handler);
}

const youtubeSource: SourceHandler = {
  name: "youtube",
  canHandle: (input) => /youtube\.com|youtu\.be/.test(input) || !input.startsWith("http"),
  async resolve(input) {
    const meta = await getMetadata(input);
    const track: Track = {
      id: meta.id,
      sourceType: "youtube",
      sourceUrl: meta.webpage_url,
      localPath: null,
      title: meta.title,
      durationSeconds: meta.duration,
      thumbnailUrl: meta.thumbnail,
      addedAt: Date.now(),
    };
    tracksRepo.upsertTrack(track);
    return track;
  },
};

const soundcloudSource: SourceHandler = {
  name: "soundcloud",
  canHandle: (input) => /soundcloud\.com/.test(input),
  async resolve(input) {
    // Same yt-dlp extraction path works for SoundCloud URLs.
    const meta = await getMetadata(input);
    const track: Track = {
      id: meta.id,
      sourceType: "soundcloud",
      sourceUrl: meta.webpage_url,
      localPath: null,
      title: meta.title,
      durationSeconds: meta.duration,
      thumbnailUrl: meta.thumbnail,
      addedAt: Date.now(),
    };
    tracksRepo.upsertTrack(track);
    return track;
  },
};

registerSource(youtubeSource);
registerSource(soundcloudSource);
// Local files are added directly via media/localFiles.ts's scan, not through
// resolveInput (a bare filesystem path isn't a safe/expected user input
// here) — see doc §8.

/**
 * Given a raw query or URL (e.g. from POST /api/queue/:guildId), decides
 * which registered source handles it, and returns a persisted Track.
 * If the input already matches a cached track by id, that's the caller's
 * job (api/routes/queue.ts checks body.trackId first).
 */
export async function resolveInput(input: string): Promise<Track> {
  const handler = handlers.find((h) => h.canHandle(input));
  if (!handler) {
    throw new Error(`No source handler could resolve: ${input}`);
  }
  log.info("resolving input", { input, handler: handler.name });
  return handler.resolve(input);
}

// In-flight downloads keyed by track id, so a track requested twice while
// its download is still running (e.g. queued, then immediately re-queued
// by someone else) shares one yt-dlp process instead of starting two.
const inFlightDownloads = new Map<string, Promise<string>>();

/**
 * Downloads a remote track to the cache exactly once and returns its local
 * path. If it's already cached, returns immediately without touching the
 * network (this is the "don't re-download it every time" behavior). Local
 * tracks just return their existing path — nothing to download.
 */
export async function ensureDownloaded(track: Track): Promise<string> {
  if (track.sourceType === "local") {
    if (!track.localPath) throw new Error(`Local track ${track.id} has no localPath`);
    return track.localPath;
  }

  if (isCached(track.id)) {
    return cachePathFor(track.id);
  }

  const existing = inFlightDownloads.get(track.id);
  if (existing) return existing;

  if (!track.sourceUrl) throw new Error(`Track ${track.id} has no sourceUrl`);

  const promise = (async () => {
    ensureCacheDir();
    log.info("downloading track to cache", { trackId: track.id, title: track.title });
    const path = await downloadAudio(track.sourceUrl!, CACHE_DIR, track.id);
    recordCacheWrite(statSync(path).size);
    evictOldestIfOverBudget();
    bus.emit("download.progress", { jobId: track.id, done: 1, total: 1 });
    return path;
  })();

  inFlightDownloads.set(track.id, promise);
  try {
    return await promise;
  } finally {
    inFlightDownloads.delete(track.id);
  }
}

/**
 * Opens the playback pipeline for a track and returns ffmpeg's stdout as a
 * Node.js Readable, ready to hand to @discordjs/voice's
 * createAudioResource() with inputType: StreamType.OggOpus (ffmpeg encodes
 * to Opus itself now — see media/ffmpeg.ts). Remote tracks are downloaded
 * once (see ensureDownloaded) and then always played from that local file —
 * never re-fetched from the source on subsequent plays. Bun.file().stream()
 * -> ffmpeg either way; ffmpeg never sees a buffered blob, just a pipe (see
 * doc §9).
 *
 * `volume` is baked into this ffmpeg spawn (its own volume filter) since
 * the audio arrives at @discordjs/voice pre-encoded — there's no PCM stage
 * left for @discordjs/voice's inline volume transform to hook into. See
 * player/guildPlayer.ts's setVolume().
 *
 * IMPORTANT: Bun.spawn()'s stdout is a WHATWG (web) ReadableStream, not a
 * Node.js Readable. @discordjs/voice's createAudioResource() is built on
 * Node stream APIs and does not accept a web ReadableStream — passing one
 * directly compiles fine (both are typed loosely) but produces a resource
 * that never actually emits audio to Discord. Readable.fromWeb() converts
 * it properly. This bit us once already; don't remove the conversion.
 */
export async function openPlaybackStream(track: Track, volume = 1.0): Promise<Readable> {
  const localPath = await ensureDownloaded(track);
  const fileStream = Bun.file(localPath).stream();
  const ffmpeg = spawnTranscode(fileStream, volume);
  return Readable.fromWeb(ffmpeg.stdout as any);
}
