import type { Router } from "../router";
import { jsonBody } from "../router";
import * as tracksRepo from "../../db/repositories/tracks";
import * as playlistsRepo from "../../db/repositories/playlists";
import * as queueRepo from "../../db/repositories/queue";
import { scanLocalFolder } from "../../media/localFiles";
import { resolveInput, ensureDownloaded } from "../../media/resolver";
import { getMetadata, getPlaylistMetadata, ytdlpImportPool, type Chapter } from "../../media/ytdlp";
import { sliceTrack, type SliceDefinition } from "../../media/slicer";
import { isCached } from "../../media/cache";
import { bus } from "../../core/bus";
import { createLogger } from "../../core/logger";
import type { AppConfig } from "../../core/config";
import type { Track } from "../../db/repositories/tracks";

const log = createLogger("api/library");

export function registerLibraryRoutes(router: Router, config: AppConfig) {
  router.get("/api/library/search", ({ query }) => {
    const q = query.get("q") ?? "";
    const limit = parseInt(query.get("limit") ?? "50", 10);
    const offset = parseInt(query.get("offset") ?? "0", 10);
    return Response.json({
      tracks: tracksRepo.searchTracks(q, isNaN(limit) ? 50 : limit, isNaN(offset) ? 0 : offset),
    });
  });

  // Inspects a URL or search query and returns metadata + any detected chapters
  // without downloading the full audio file. Useful for slice previewing.
  router.post("/api/library/inspect", async ({ req }) => {
    const body = await jsonBody<{ url?: string; query?: string }>(req);
    const input = body.url ?? body.query;
    if (!input) {
      return Response.json(
        { error: { code: "bad_request", message: "One of url or query is required" } },
        { status: 400 }
      );
    }
    try {
      const meta = await getMetadata(input);
      return Response.json({
        metadata: {
          id: meta.id,
          title: meta.title,
          duration: meta.duration,
          thumbnail: meta.thumbnail,
          url: meta.webpage_url,
          chapters: meta.chapters ?? [],
        },
      });
    } catch (err) {
      return Response.json(
        { error: { code: "bad_request", message: `Failed to inspect URL: ${(err as Error).message}` } },
        { status: 400 }
      );
    }
  });

  // Downloads an entire remote playlist into the library, optionally creating
  // a local Playlist grouping all of its tracks, and begins background caching.
  router.post("/api/library/download-playlist", async ({ req }) => {
    const body = await jsonBody<{ url: string; createPlaylist?: boolean }>(req);
    if (!body.url) {
      return Response.json(
        { error: { code: "bad_request", message: "Playlist url is required" } },
        { status: 400 }
      );
    }

    log.info("POST /api/library/download-playlist", { url: body.url });
    let playlistMeta;
    try {
      playlistMeta = await getPlaylistMetadata(body.url);
    } catch (err) {
      return Response.json(
        { error: { code: "bad_request", message: `Failed to fetch playlist: ${(err as Error).message}` } },
        { status: 400 }
      );
    }

    if (!playlistMeta.entries.length) {
      return Response.json(
        { error: { code: "bad_request", message: "Playlist contains no downloadable entries" } },
        { status: 400 }
      );
    }

    const createdTracks: Track[] = [];
    const baseTime = Date.now();

    for (let i = 0; i < playlistMeta.entries.length; i++) {
      const entry = playlistMeta.entries[i]!;
      const track: Track = {
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
      createdTracks.push(track);
    }

    let localPlaylistId: string | null = null;
    if (body.createPlaylist !== false) {
      const pl = playlistsRepo.createPlaylist(crypto.randomUUID(), playlistMeta.title);
      localPlaylistId = pl.id;
      for (const track of createdTracks) {
        playlistsRepo.addTrackToPlaylist(pl.id, track.id);
      }
      bus.emit("playlists.changed", {});
    }

    // Background download batch with progress
    const jobId = localPlaylistId || `pl_${crypto.randomUUID()}`;
    const total = createdTracks.length;
    let done = 0;
    bus.emit("download.progress", { jobId, done: 0, total });

    void (async () => {
      for (const track of createdTracks) {
        ytdlpImportPool
          .run(async () => {
            try {
              await ensureDownloaded(track);
            } catch (err) {
              log.error("failed downloading playlist track", { trackId: track.id, error: String(err) });
            } finally {
              done++;
              bus.emit("download.progress", { jobId, done, total });
            }
          })
          .catch(() => {});
      }
    })();

    return Response.json(
      {
        ok: true,
        jobId,
        playlistId: localPlaylistId,
        title: playlistMeta.title,
        trackCount: createdTracks.length,
        tracks: createdTracks,
      },
      { status: 202 }
    );
  });

  // Slices a track (either existing trackId or new url) into multiple separate tracks.
  router.post("/api/library/slice", async ({ req }) => {
    const body = await jsonBody<{
      url?: string;
      trackId?: string;
      slices: SliceDefinition[];
      enqueueGuildId?: string;
      createPlaylistName?: string;
    }>(req);

    if (!body.slices || !Array.isArray(body.slices) || body.slices.length === 0) {
      return Response.json(
        { error: { code: "bad_request", message: "At least one slice definition is required" } },
        { status: 400 }
      );
    }

    let parentTrack: Track | null = null;
    if (body.trackId) {
      parentTrack = tracksRepo.getTrack(body.trackId);
      if (!parentTrack) {
        return Response.json(
          { error: { code: "not_found", message: `Track ${body.trackId} not found` } },
          { status: 404 }
        );
      }
    } else if (body.url) {
      parentTrack = await resolveInput(body.url);
    } else {
      return Response.json(
        { error: { code: "bad_request", message: "Either trackId or url must be provided" } },
        { status: 400 }
      );
    }

    log.info("slicing track", { parentId: parentTrack.id, slicesCount: body.slices.length });

    // Ensure parent track is downloaded to disk first
    const parentLocalPath = await ensureDownloaded(parentTrack);
    const slicedTracks = await sliceTrack(parentTrack, parentLocalPath, body.slices);

    // If an enqueueGuildId was requested, add all slices to that guild's queue
    if (body.enqueueGuildId) {
      for (const t of slicedTracks) {
        try {
          queueRepo.enqueue(body.enqueueGuildId, t.id, null);
        } catch (err) {
          log.warn("failed enqueueing slice", { guildId: body.enqueueGuildId, trackId: t.id, error: String(err) });
        }
      }
      bus.emit("queue.changed", { guildId: body.enqueueGuildId });
    }

    // If createPlaylistName was requested, group them into a playlist
    let playlistId: string | null = null;
    if (body.createPlaylistName) {
      const pl = playlistsRepo.createPlaylist(crypto.randomUUID(), body.createPlaylistName);
      playlistId = pl.id;
      for (const t of slicedTracks) {
        playlistsRepo.addTrackToPlaylist(pl.id, t.id);
      }
      bus.emit("playlists.changed", {});
    }

    return Response.json(
      {
        ok: true,
        parentTrackId: parentTrack.id,
        tracks: slicedTracks,
        playlistId,
      },
      { status: 201 }
    );
  });

  // Resolves + downloads a URL/query into the library WITHOUT touching any queue.
  router.post("/api/library/download", async ({ req }) => {
    const body = await jsonBody<{ url?: string; query?: string }>(req);
    const input = body.url ?? body.query;
    if (!input) {
      return Response.json(
        { error: { code: "bad_request", message: "One of url or query is required" } },
        { status: 400 }
      );
    }

    log.info("POST /api/library/download", { input });
    const track = await resolveInput(input);

    ensureDownloaded(track).catch((err) =>
      log.error("background download failed", { trackId: track.id, error: String(err) })
    );

    return Response.json({ track }, { status: 202 });
  });

  router.post("/api/library/scan", async () => {
    if (!config.musicFolder) {
      return Response.json(
        { error: { code: "bad_request", message: "No musicFolder configured in config.json" } },
        { status: 400 }
      );
    }
    const jobId = crypto.randomUUID();
    scanLocalFolder(config.musicFolder, jobId).catch((err) =>
      log.error("local folder scan failed", { error: String(err) })
    );
    return Response.json({ jobId }, { status: 202 });
  });

  // Registered LAST among POST /api/library/* routes because :trackId is a wildcard.
  router.post("/api/library/:trackId", async ({ params }) => {
    const track = tracksRepo.getTrack(params.trackId);
    if (!track) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: `No track with id ${params.trackId} in the library. Resolve it first via POST /api/library/download.`,
          },
        },
        { status: 404 }
      );
    }

    log.info("POST /api/library/:trackId", { trackId: track.id, sourceType: track.sourceType });

    if (track.sourceType === "local") {
      return Response.json({ trackId: track.id, alreadyCached: true });
    }

    const alreadyCached = isCached(track.id);
    if (!alreadyCached) {
      ensureDownloaded(track).catch((err) =>
        log.error("background download failed", { trackId: track.id, error: String(err) })
      );
    }
    return Response.json({ trackId: track.id, alreadyCached }, { status: 202 });
  });

  // Returns chapters for an already-known track if source is YouTube/web
  router.get("/api/tracks/:trackId/chapters", async ({ params }) => {
    const track = tracksRepo.getTrack(params.trackId);
    if (!track) {
      return Response.json({ error: { code: "not_found", message: "Track not found" } }, { status: 404 });
    }

    let chapters: Chapter[] = [];
    if (track.sourceUrl && track.sourceType === "youtube") {
      try {
        const meta = await getMetadata(track.sourceUrl);
        chapters = meta.chapters ?? [];
      } catch (err) {
        log.warn("failed getting chapters for track", { trackId: track.id, error: String(err) });
      }
    }

    return Response.json({
      trackId: track.id,
      title: track.title,
      durationSeconds: track.durationSeconds,
      chapters,
    });
  });

  // Renames a track in the library (and thus anywhere it is referenced in queue/playlists)
  router.patch("/api/tracks/:trackId", async ({ req, params }) => {
    const body = await jsonBody<{ title: string }>(req);
    const newTitle = body?.title?.trim();
    if (!newTitle) {
      return Response.json(
        { error: { code: "bad_request", message: "A non-empty title is required" } },
        { status: 400 }
      );
    }

    const existing = tracksRepo.getTrack(params.trackId);
    if (!existing) {
      return Response.json(
        { error: { code: "not_found", message: `Track ${params.trackId} not found` } },
        { status: 404 }
      );
    }

    const updated = tracksRepo.updateTrackTitle(params.trackId, newTitle);
    log.info("track renamed", { trackId: params.trackId, oldTitle: existing.title, newTitle });

    // Notify connected clients that queue items might have updated titles
    bus.emit("queue.changed", { guildId: "*" });

    return Response.json({ ok: true, track: updated });
  });
}
