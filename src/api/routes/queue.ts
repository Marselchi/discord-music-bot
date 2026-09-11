import type { Router } from "../router";
import { jsonBody } from "../router";
import * as queueRepo from "../../db/repositories/queue";
import * as tracksRepo from "../../db/repositories/tracks";
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
