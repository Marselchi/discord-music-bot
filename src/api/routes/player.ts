import type { Router } from "../router";
import { jsonBody } from "../router";
import { getOrCreatePlayer, getPlayer } from "../../player/manager";
import { getBotClient } from "../../bot/client";
import * as queueRepo from "../../db/repositories/queue";
import * as tracksRepo from "../../db/repositories/tracks";
import { createLogger } from "../../core/logger";
import { ChannelType } from "discord.js";

const log = createLogger("api/player");

function noPlayerResponse(guildId: string) {
  log.warn("route hit but no player exists yet for this guild", { guildId });
  return Response.json(
    {
      error: {
        code: "not_found",
        message: "No active player for this guild yet — call POST /api/player/:guildId/join first.",
      },
    },
    { status: 404 }
  );
}

export function registerPlayerRoutes(router: Router) {
  router.post("/api/player/:guildId/join", async ({ req, params }) => {
    const { channelId } = await jsonBody<{ channelId: string }>(req);
    log.info("POST join", { guildId: params.guildId, channelId });

    const client = getBotClient();
    const guild = client.guilds.cache.get(params.guildId);
    if (!guild) {
      log.warn("join failed: bot is not in that guild", { guildId: params.guildId });
      return Response.json({ error: { code: "not_found", message: "Bot is not in that guild" } }, { status: 404 });
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      log.warn("join failed: channelId is not a voice channel in that guild", { guildId: params.guildId, channelId });
      return Response.json(
        { error: { code: "bad_request", message: "channelId is not a voice channel in that guild" } },
        { status: 400 }
      );
    }

    const player = getOrCreatePlayer(params.guildId);
    try {
      await player.join(channelId, params.guildId, guild.voiceAdapterCreator);
    } catch (err) {
      log.error("join failed: voice connection error", { guildId: params.guildId, channelId, error: String(err) });
      return Response.json(
        { error: { code: "join_failed", message: err instanceof Error ? err.message : "Failed to join voice channel" } },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, guildId: params.guildId, channelId });
  });

  router.get("/api/player/:guildId", ({ params }) => {
    const player = getPlayer(params.guildId);
    if (!player) {
      return Response.json({
        guildId: params.guildId,
        state: "idle",
        currentTrackId: null,
        positionSeconds: 0,
        durationSeconds: null,
        volume: 1,
        repeat: false,
        updatedAt: Date.now(),
      });
    }
    return Response.json(player.getState());
  });

  // Body is optional. `{}` (or no body) resumes/starts at the current
  // cursor position — the original behavior. `{ "position": N }` jumps to
  // that queue position first. This is one endpoint, not two, because
  // "start playing" and "start playing from here" are the same operation
  // with an optional parameter, not two different actions.
  router.post("/api/player/:guildId/play", async ({ req, params }) => {
    let body: { position?: number } = {};
    try {
      body = await jsonBody<{ position?: number }>(req);
    } catch {
      // empty body is fine here — jsonBody throws on truly invalid JSON,
      // but POST with no body at all should still work.
    }
    log.info("POST play", { guildId: params.guildId, body });

    if (typeof body.position === "number") {
      const queue = queueRepo.getQueue(params.guildId);
      if (body.position < 0 || body.position >= queue.length) {
        log.warn("play failed: position out of range", { guildId: params.guildId, position: body.position, queueLength: queue.length });
        return Response.json(
          { error: { code: "bad_request", message: `position ${body.position} is out of range (queue has ${queue.length} item(s))` } },
          { status: 400 }
        );
      }
      const player = getOrCreatePlayer(params.guildId);
      player.playFromPosition(body.position);
      return Response.json({ ok: true });
    }

    const player = getOrCreatePlayer(params.guildId);
    void player.playCurrent();
    return Response.json({ ok: true });
  });

  // Alternative to `play` with a position: resolve a trackId to its
  // current position in this guild's queue and play from there. Errors
  // (rather than silently no-oping) if that track isn't actually queued —
  // this endpoint doesn't enqueue anything itself. If you want to play a
  // track that ISN'T in the queue without changing the queue at all, use
  // play-adhoc below instead.
  router.post("/api/player/:guildId/play-track", async ({ req, params }) => {
    const { trackId } = await jsonBody<{ trackId: string }>(req);
    log.info("POST play-track", { guildId: params.guildId, trackId });

    const queue = queueRepo.getQueue(params.guildId);
    const match = queue.find((item) => item.trackId === trackId);
    if (!match) {
      log.warn("play-track failed: trackId not found in this guild's queue", { guildId: params.guildId, trackId });
      return Response.json(
        {
          error: {
            code: "not_found",
            message: `trackId ${trackId} is not in this guild's queue. If you want to play it without adding it to (or reordering) the queue, use POST /api/player/${params.guildId}/play-adhoc instead.`,
          },
        },
        { status: 404 }
      );
    }

    const player = getOrCreatePlayer(params.guildId);
    player.playFromPosition(match.position);
    return Response.json({ ok: true, position: match.position });
  });

  // Plays a track that is NOT in (and never gets added to) the queue.
  // The queue and its order are completely untouched — when this track
  // ends, playback resumes exactly where the queue already was. Use this
  // for previews / one-off plays; use play-track above for actual queue
  // items.
  router.post("/api/player/:guildId/play-adhoc", async ({ req, params }) => {
    const { trackId } = await jsonBody<{ trackId: string }>(req);
    log.info("POST play-adhoc", { guildId: params.guildId, trackId });

    const track = tracksRepo.getTrack(trackId);
    if (!track) {
      log.warn("play-adhoc failed: trackId not found in the library", { guildId: params.guildId, trackId });
      return Response.json(
        {
          error: {
            code: "not_found",
            message: `No track with id ${trackId} in the library. Resolve it first via POST /api/library/download, or add it to the queue via POST /api/queue/:guildId.`,
          },
        },
        { status: 404 }
      );
    }

    const player = getOrCreatePlayer(params.guildId);
    try {
      await player.playAdHoc(track);
    } catch (err) {
      return Response.json(
        {
          error: {
            code: "playback_failed",
            message: err instanceof Error ? err.message : "Failed to start ad-hoc playback",
          },
        },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, trackId });
  });

  router.post("/api/player/:guildId/pause", ({ params }) => {
    log.info("POST pause", { guildId: params.guildId });
    const player = getPlayer(params.guildId);
    if (!player) return noPlayerResponse(params.guildId);
    player.pause();
    return Response.json({ ok: true });
  });

  router.post("/api/player/:guildId/resume", ({ params }) => {
    log.info("POST resume", { guildId: params.guildId });
    const player = getPlayer(params.guildId);
    if (!player) return noPlayerResponse(params.guildId);
    player.resume();
    return Response.json({ ok: true });
  });

  router.post("/api/player/:guildId/skip", ({ params }) => {
    log.info("POST skip", { guildId: params.guildId });
    const player = getPlayer(params.guildId);
    if (!player) return noPlayerResponse(params.guildId);
    player.skip();
    return Response.json({ ok: true });
  });

  router.post("/api/player/:guildId/seek", async ({ req, params }) => {
    const { seconds } = await jsonBody<{ seconds: number }>(req);
    log.info("POST seek", { guildId: params.guildId, seconds });
    const player = getPlayer(params.guildId);
    if (!player) return noPlayerResponse(params.guildId);
    player.seek(seconds);
    return Response.json({ ok: true });
  });

  router.post("/api/player/:guildId/volume", async ({ req, params }) => {
    const { level } = await jsonBody<{ level: number }>(req);
    log.info("POST volume", { guildId: params.guildId, level });
    const player = getPlayer(params.guildId);
    if (!player) return noPlayerResponse(params.guildId);
    player.setVolume(level);
    return Response.json({ ok: true });
  });

  // Repeat-current-track. Uses getOrCreatePlayer (not getPlayer) since
  // setting this before anything's playing yet is reasonable — unlike
  // pause/skip/etc, which need an existing playback session to act on.
  router.post("/api/player/:guildId/repeat", async ({ req, params }) => {
    const { enabled } = await jsonBody<{ enabled: boolean }>(req);
    log.info("POST repeat", { guildId: params.guildId, enabled });
    const player = getOrCreatePlayer(params.guildId);
    player.setRepeat(enabled);
    return Response.json({ ok: true, enabled });
  });

  router.post("/api/player/:guildId/leave", ({ params }) => {
    log.info("POST leave", { guildId: params.guildId });
    const player = getPlayer(params.guildId);
    if (!player) return noPlayerResponse(params.guildId);
    player.leave();
    return Response.json({ ok: true });
  });
}
