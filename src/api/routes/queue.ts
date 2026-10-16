import type { Router } from "../router";
import { jsonBody } from "../router";
import * as queueRepo from "../../db/repositories/queue";
import * as tracksRepo from "../../db/repositories/tracks";
import * as playlistsRepo from "../../db/repositories/playlists";
import { bus } from "../../core/bus";
import { resolveInput, ensureDownloaded } from "../../media/resolver";
import { createLogger } from "../../core/logger";

const log = createLogger("api/queue");

export function registerQueueRoutes(router: Router) {
  router.get("/api/queue/:guildId", ({ params }) => {
    return Response.json({ queue: queueRepo.getQueue(params.guildId) });
  });

  router.post("/api/queue/:guildId", async ({ req, params }) => {
    const body = await jsonBody<{ query?: string; url?: string; trackId?: string; requestedBy?: string }>(req);

    let trackId = body.trackId;
    if (!trackId) {
      const input = body.url ?? body.query;
      if (!input) {
        return Response.json({ error: { code: "bad_request", message: "One of query, url, or trackId is required" } }, { status: 400 });
      }
      const resolved = await resolveInput(input);
      trackId = resolved.id;
    }

    const position = queueRepo.enqueue(params.guildId, trackId, body.requestedBy ?? null);
    bus.emit("queue.changed", { guildId: params.guildId });

    // Pre-download in the background so playback usually finds it already
    // cached by the time the queue reaches it, instead of stalling on it.
    // openPlaybackStream() will still safely await this same download if
    // playback gets there first (see media/resolver.ts's in-flight dedupe).
    const track = tracksRepo.getTrack(trackId);
    if (track && track.sourceType !== "local") {
      ensureDownloaded(track).catch((err) =>
        log.error("background pre-download failed", { trackId, error: String(err) })
      );
    }

    log.info("track enqueued", { guildId: params.guildId, trackId, position });
    return Response.json({ position, trackId }, { status: 201 });
  });

  router.post("/api/queue/:guildId/playlist", async ({ req, params }) => {
    const body = await jsonBody<{ url?: string; playlistId?: string; requestedBy?: string }>(req);

    if (body.playlistId) {
      const pl = playlistsRepo.getPlaylist(body.playlistId);
      const tracks = playlistsRepo.getPlaylistTracks(body.playlistId);
      if (!tracks.length) {
        return Response.json({ error: { code: "bad_request", message: "Playlist has no tracks" } }, { status: 400 });
      }

      let count = 0;
      for (const track of tracks) {
        try {
          queueRepo.enqueue(params.guildId, track.id, body.requestedBy ?? null);
          count++;
          if (track.sourceType !== "local") {
            ensureDownloaded(track).catch((err) =>
              log.error("background pre-download failed", { trackId: track.id, error: String(err) })
            );
          }
        } catch (err) {
          log.warn("could not enqueue all playlist tracks (max length reached?)", { error: String(err) });
          break;
        }
      }

      bus.emit("queue.changed", { guildId: params.guildId });
      log.info("local playlist enqueued", { guildId: params.guildId, count, playlistTitle: pl?.name });
      return Response.json({ ok: true, count, title: pl?.name ?? "Playlist" }, { status: 201 });
    }

    if (!body.url) {
      return Response.json({ error: { code: "bad_request", message: "Playlist url or playlistId is required" } }, { status: 400 });
    }

    const { getPlaylistMetadata } = await import("../../media/ytdlp");

    const playlistMeta = await getPlaylistMetadata(body.url);
    if (!playlistMeta.entries.length) {
      return Response.json({ error: { code: "bad_request", message: "No tracks found in playlist" } }, { status: 400 });
    }

    const baseTime = Date.now();
    let count = 0;
    for (let i = 0; i < playlistMeta.entries.length; i++) {
      const entry = playlistMeta.entries[i]!;
      const track: tracksRepo.Track = {
        id: entry.id,
        sourceType: "youtube",
        sourceUrl: entry.webpage_url,
        localPath: null,
        title: entry.title,
        durationSeconds: entry.duration,
        thumbnailUrl: entry.thumbnail,
        addedAt: baseTime + i,
      };
      tracksRepo.upsertTrack(track);
      try {
        queueRepo.enqueue(params.guildId, track.id, body.requestedBy ?? null);
        count++;
        ensureDownloaded(track).catch((err) =>
          log.error("background pre-download failed", { trackId: track.id, error: String(err) })
        );
      } catch (err) {
        log.warn("could not enqueue all playlist tracks (max length reached?)", { error: String(err) });
        break;
      }
    }

    bus.emit("queue.changed", { guildId: params.guildId });
    log.info("playlist enqueued", { guildId: params.guildId, count, playlistTitle: playlistMeta.title });
    return Response.json({ ok: true, count, title: playlistMeta.title }, { status: 201 });
  });

  router.delete("/api/queue/:guildId/:position", ({ params }) => {
    queueRepo.removeAt(params.guildId, Number(params.position));
    bus.emit("queue.changed", { guildId: params.guildId });
    return Response.json({ ok: true });
  });

  router.post("/api/queue/:guildId/reorder", async ({ req, params }) => {
    const { from, to } = await jsonBody<{ from: number; to: number }>(req);
    queueRepo.reorder(params.guildId, from, to);
    bus.emit("queue.changed", { guildId: params.guildId });
    return Response.json({ ok: true });
  });

  router.post("/api/queue/:guildId/clear", ({ params }) => {
    queueRepo.clearQueue(params.guildId);
    bus.emit("queue.changed", { guildId: params.guildId });
    return Response.json({ ok: true });
  });
}
