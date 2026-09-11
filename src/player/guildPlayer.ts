import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { bus } from "../core/bus";
import { createLogger } from "../core/logger";
import { openPlaybackStream } from "../media/resolver";
import * as queueRepo from "../db/repositories/queue";
import type { Track } from "../db/repositories/tracks";
import { QueueCursor } from "./queue";
import type { PlaybackState, PlayerState } from "./types";

const log = createLogger("player");

const MAX_CONSECUTIVE_FAILURES = 3;

type EndReason = "finished" | "skipped" | "error";

/**
 * One instance per active guild. Owns that guild's VoiceConnection +
 * AudioPlayer + in-memory queue cursor. See doc §8.
 */
export class GuildPlayer {
  readonly guildId: string;
  private connection: VoiceConnection | null = null;
  private audioPlayer: AudioPlayer;
  private cursor: QueueCursor;
  private state: PlaybackState = "idle";
  private volume = 1.0;
  private repeat = false;
  // Set while playing a track via playAdHoc() - i.e. NOT the queue's
  // current item. Checked first in the Idle handler so an ad-hoc track
  // ending (for any reason) never touches the queue cursor, and playback
  // just resumes wherever the queue already was.
  private adHocTrack: Track | null = null;
  private currentResource: AudioResource<null> | null = null;
  private consecutiveFailures = 0;
  private positionTimer: ReturnType<typeof setInterval> | null = null;

  // Set right before an intentional audioPlayer.stop() (skip / jump-to-position)
  // so the Idle handler can tell "we meant to stop this" apart from "the
  // resource actually ran out", and know what reason/position to use.
  private pendingTransition: { reason: EndReason; explicitPosition?: number } | null = null;

  constructor(guildId: string) {
    this.guildId = guildId;
    this.cursor = new QueueCursor(guildId);
    this.audioPlayer = createAudioPlayer();
    this.wireAudioPlayerEvents();
  }

  private wireAudioPlayerEvents(): void {
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      const transition = this.pendingTransition;
      this.pendingTransition = null;
      this.currentResource = null;

      if (this.adHocTrack) {
        const adHocTrack = this.adHocTrack;
        this.adHocTrack = null;
        const reason = transition?.reason ?? "finished";
        log.info("ad-hoc track ended", { guildId: this.guildId, trackId: adHocTrack.id, reason });
        if (reason === "finished") {
          queueRepo.recordHistory(this.guildId, adHocTrack.id);
        }
        bus.emit("track.ended", { guildId: this.guildId, trackId: adHocTrack.id, reason });

        // Only an explicit jump (play/play-track called while the ad-hoc
        // track was playing) changes the cursor. Otherwise it's untouched —
        // the queue just resumes exactly where it already was, in its
        // existing order, per doc.md's play-adhoc section.
        if (transition?.explicitPosition !== undefined) {
          this.cursor.setPosition(transition.explicitPosition);
        }
        void this.playCurrent();
        return;
      }

      const finished = this.cursor.current();
      if (finished) {
        const reason = transition?.reason ?? "finished";
        log.info("track ended", { guildId: this.guildId, trackId: finished.trackId, reason });
        if (reason !== "error") {
          queueRepo.recordHistory(this.guildId, finished.trackId);
        }
        bus.emit("track.ended", { guildId: this.guildId, trackId: finished.trackId, reason });
      }

      if (transition?.explicitPosition !== undefined) {
        this.cursor.setPosition(transition.explicitPosition);
      } else if ((transition?.reason ?? "finished") === "finished" && this.repeat) {
        // Track ended on its own (not skipped/jumped) and repeat is on —
        // replay the same position rather than advancing. A manual skip
        // still moves on regardless of repeat; only a natural end loops.
        log.info("repeat is enabled, replaying the same track", { guildId: this.guildId, cursorPosition: this.cursor.positionIndex });
      } else {
        this.cursor.advance();
      }
      void this.playCurrent();
    });

    this.audioPlayer.on("error", (err) => {
      log.error("audio player error, skipping track", { guildId: this.guildId, error: String(err) });
      // The Idle event still fires after "error" in @discordjs/voice — mark
      // this as an error transition so the Idle handler above reports it
      // correctly instead of claiming the track "finished".
      this.pendingTransition = { reason: "error" };
    });
  }

  async join(channelId: string, guildIdForAdapter: string, adapterCreator: any): Promise<void> {
    log.info("joining voice channel", { guildId: this.guildId, channelId });

    this.connection = joinVoiceChannel({
      channelId,
      guildId: guildIdForAdapter,
      adapterCreator,
    });

    this.wireConnectionEvents(this.connection, channelId);

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      log.error("voice connection never reached Ready", { guildId: this.guildId, channelId, error: String(err) });
      this.connection.destroy();
      this.connection = null;
      throw err;
    }

    this.connection.subscribe(this.audioPlayer);
    log.info("voice connection ready", { guildId: this.guildId, channelId });
    bus.emit("voice.connected", { guildId: this.guildId, channelId });
  }

  /**
   * Wires the connection so voice.disconnected is emitted after the voice
   * state *actually* changes — a mod kicking the bot, a Discord voice
   * server hiccup, or someone dragging the bot to another channel — not
   * just on an explicit leave() call. See @discordjs/voice's documented
   * reconnection pattern: Disconnected can mean "reconnecting" (e.g. a
   * channel move) or "actually gone" (kicked / network loss); we wait
   * briefly to tell those apart before declaring it disconnected.
   */
  private wireConnectionEvents(connection: VoiceConnection, channelId: string): void {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        log.info("voice connection recovering from a transient disconnect", { guildId: this.guildId });
      } catch {
        log.info("voice connection actually dropped, cleaning up", { guildId: this.guildId, channelId });
        connection.destroy();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection === connection) this.connection = null;
      this.setState("idle");
      this.stopPositionTimer();
      bus.emit("voice.disconnected", { guildId: this.guildId });
    });

    connection.on("error", (err) => {
      log.error("voice connection error", { guildId: this.guildId, channelId, error: String(err) });
    });
  }

  /** Triggers connection.destroy(); voice.disconnected is emitted by the Destroyed listener above, not here directly. */
  leave(): void {
    log.info("leave() called", { guildId: this.guildId, hadConnection: !!this.connection });
    this.connection?.destroy();
  }

  private setState(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    bus.emit("player.stateChanged", { guildId: this.guildId, state });

    if (state === "playing") this.startPositionTimer();
    else this.stopPositionTimer();
  }

  private startPositionTimer(): void {
    this.stopPositionTimer();
    this.positionTimer = setInterval(() => {
      const item = this.cursor.current();
      bus.emit("player.positionChanged", {
        guildId: this.guildId,
        positionSeconds: this.getPositionSeconds(),
        durationSeconds: item?.track.durationSeconds ?? null,
      });
    }, 1000);
  }

  private stopPositionTimer(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }

  private getPositionSeconds(): number {
    // AudioResource.playbackDuration is milliseconds of audio actually
    // played so far, and — per @discordjs/voice — pauses counting while
    // the player is paused, so this is accurate across pause/resume without
    // us tracking timestamps ourselves.
    if (!this.currentResource) return 0;
    return Math.floor(this.currentResource.playbackDuration / 1000);
  }

  /**
   * Starts (or resumes) playback of whatever the cursor currently points
   * to. This is the single place that actually creates an AudioResource
   * and calls AudioPlayer.play() — every log line here exists so a "click
   * play, nothing happens" report can be diagnosed from server logs alone:
   * is the queue empty? did the download fail? did createAudioResource
   * throw? did play() get called at all?
   */
  async playCurrent(): Promise<void> {
    const item = this.cursor.current();
    if (!item) {
      log.info("playCurrent: nothing at the cursor position, going idle", {
        guildId: this.guildId,
        cursorPosition: this.cursor.positionIndex,
      });
      this.setState("idle");
      return;
    }

    if (!this.connection) {
      log.warn("playCurrent: no active voice connection — call POST /api/player/:guildId/join first", {
        guildId: this.guildId,
        trackId: item.trackId,
      });
      // Deliberately still attempt below rather than bailing: the
      // AudioPlayer can be created/played without a connection (it just
      // won't be heard), and failing loudly here would hide the real
      // "you're not in a voice channel" UX case behind a generic error.
      // The log line above is the signal to look for.
    }

    log.info("playCurrent: starting track", {
      guildId: this.guildId,
      trackId: item.trackId,
      title: item.track.title,
      sourceType: item.track.sourceType,
      cursorPosition: this.cursor.positionIndex,
    });

    try {
      const stream = await openPlaybackStream(item.track, this.volume);
      log.info("playCurrent: playback stream opened (download/cache resolved, ffmpeg piping pre-encoded Opus)", {
        guildId: this.guildId,
        trackId: item.trackId,
      });

      // OggOpus, not Raw: ffmpeg now encodes to Opus itself (see
      // media/ffmpeg.ts) instead of handing @discordjs/voice raw PCM to
      // encode in JS — that JS encode step was the source of stuttering.
      // inlineVolume isn't used for the same reason: there's no PCM stage
      // left to hook a gain transform into once the input is pre-encoded.
      // Volume is baked into the ffmpeg spawn above instead — see setVolume().
      const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
      this.currentResource = resource;

      this.audioPlayer.play(resource);
      log.info("playCurrent: AudioPlayer.play() called", { guildId: this.guildId, trackId: item.trackId });

      this.consecutiveFailures = 0;
      this.setState("playing");
      bus.emit("track.started", { guildId: this.guildId, trackId: item.trackId });
    } catch (err) {
      this.consecutiveFailures++;
      log.error("playCurrent: failed to start playback", {
        guildId: this.guildId,
        trackId: item.trackId,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });

      bus.emit("track.ended", { guildId: this.guildId, trackId: item.trackId, reason: "error" });

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.error("playCurrent: too many consecutive failures, stopping instead of looping through the rest of the queue", {
          guildId: this.guildId,
        });
        this.consecutiveFailures = 0;
        this.setState("idle");
        return;
      }

      this.cursor.advance();
      void this.playCurrent();
    }
  }

  /**
   * Plays a track immediately WITHOUT touching the queue: no cursor
   * movement, no reordering, no insertion into the persisted queue table.
   * Whatever's currently playing is stopped; when this ad-hoc track ends
   * (for any reason — natural end, a later skip, or an error), playback
   * resumes exactly where the queue already was. See the Idle handler's
   * `adHocTrack` branch above, and doc.md's play-adhoc section.
   *
   * Unlike playCurrent(), failures here are NOT retried against "the next
   * queue item" — there is no queue context to advance through. The
   * caller (the play-adhoc route) surfaces the failure directly.
   */
  async playAdHoc(track: Track): Promise<void> {
    log.info("playAdHoc: starting ad-hoc track (not part of the queue)", {
      guildId: this.guildId,
      trackId: track.id,
      title: track.title,
      sourceType: track.sourceType,
    });

    if (!this.connection) {
      log.warn("playAdHoc: no active voice connection — call POST /api/player/:guildId/join first", {
        guildId: this.guildId,
        trackId: track.id,
      });
    }

    this.adHocTrack = track;
    try {
      const stream = await openPlaybackStream(track, this.volume);
      log.info("playAdHoc: playback stream opened", { guildId: this.guildId, trackId: track.id });

      const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
      this.currentResource = resource;

      this.audioPlayer.play(resource);
      log.info("playAdHoc: AudioPlayer.play() called", { guildId: this.guildId, trackId: track.id });

      this.setState("playing");
      bus.emit("track.started", { guildId: this.guildId, trackId: track.id });
    } catch (err) {
      this.adHocTrack = null;
      log.error("playAdHoc: failed to start playback", {
        guildId: this.guildId,
        trackId: track.id,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      bus.emit("track.ended", { guildId: this.guildId, trackId: track.id, reason: "error" });
      throw err;
    }
  }

  pause(): void {
    const status = this.audioPlayer.state.status;
    log.info("pause() called", { guildId: this.guildId, audioPlayerStatus: status, mirroredState: this.state });
    if (status !== AudioPlayerStatus.Playing && status !== AudioPlayerStatus.Buffering && status !== AudioPlayerStatus.AutoPaused) {
      log.warn("pause() called but nothing is actually playing - ignoring", { guildId: this.guildId, audioPlayerStatus: status });
      return;
    }
    this.audioPlayer.pause();
    this.setState("paused");
  }

  /**
   * Unpauses if something is actually paused. If nothing was ever loaded
   * (AudioPlayerStatus.Idle — e.g. the frontend calls "resume" as its
   * generic play/pause toggle without ever having called play/play-track),
   * this starts playback from the cursor instead of pretending to resume a
   * resource that doesn't exist. That distinction matters: blindly calling
   * audioPlayer.unpause() + setState("playing") when there's no resource
   * loaded reports "playing" with total silence — which is exactly what
   * happened before this fix (see the mirroredState log below vs the real
   * AudioPlayerStatus).
   */
  resume(): void {
    const status = this.audioPlayer.state.status;
    log.info("resume() called", { guildId: this.guildId, audioPlayerStatus: status, mirroredState: this.state });

    if (status === AudioPlayerStatus.Idle) {
      log.info("resume() called with nothing loaded - starting playback from the cursor instead", { guildId: this.guildId });
      void this.playCurrent();
      return;
    }

    this.audioPlayer.unpause();
    this.setState("playing");
  }

  /** Skips to the next item in the queue (cursor + 1). */
  skip(): void {
    const status = this.audioPlayer.state.status;
    log.info("skip() called", { guildId: this.guildId, cursorPosition: this.cursor.positionIndex, audioPlayerStatus: status });
    if (status === AudioPlayerStatus.Idle) {
      // Nothing is actually loaded/playing to stop — calling .stop() here
      // wouldn't fire the Idle event (no state transition happens), so the
      // cursor would never advance. Advance and play directly instead.
      this.cursor.advance();
      void this.playCurrent();
      return;
    }
    this.pendingTransition = { reason: "skipped" };
    this.audioPlayer.stop(true);
  }

  /**
   * Jumps directly to an arbitrary queue position and plays it — this is
   * what backs both POST /api/player/:guildId/play with a `position` body
   * and POST /api/player/:guildId/play-track (which first resolves a
   * trackId to a position). Route-layer bounds-checking against the
   * current queue length happens before this is called.
   */
  playFromPosition(position: number): void {
    const status = this.audioPlayer.state.status;
    log.info("playFromPosition() called", { guildId: this.guildId, targetPosition: position, audioPlayerStatus: status });
    if (status === AudioPlayerStatus.Idle) {
      this.cursor.setPosition(position);
      void this.playCurrent();
      return;
    }
    this.pendingTransition = { reason: "skipped", explicitPosition: position };
    this.audioPlayer.stop(true);
  }

  /**
   * Toggles repeat-current-track. Only affects a track that ends
   * naturally — see the Idle handler above. A manual skip() or
   * playFromPosition() always moves on regardless of this setting.
   */
  setRepeat(enabled: boolean): void {
    log.info("setRepeat() called", { guildId: this.guildId, enabled });
    this.repeat = enabled;
    bus.emit("player.repeatChanged", { guildId: this.guildId, enabled });
  }

  seek(_seconds: number): void {
    // ffmpeg-level seeking (re-spawn with -ss) belongs in media/, plumbed
    // through here once resolver.ts exposes a seek-capable stream opener.
    log.warn("seek not yet implemented", { guildId: this.guildId });
  }

  /**
   * Sets the volume for the NEXT track that starts (this one, if nothing's
   * playing right now). It can't apply live to a track already playing:
   * since ffmpeg now encodes straight to Opus (see media/ffmpeg.ts — this
   * is what fixed the stuttering caused by JS-side Opus encoding),
   * @discordjs/voice never sees raw PCM, so there's no inline volume
   * transform left to hook into for an in-flight resource.
   */
  setVolume(level: number): void {
    log.info("setVolume() called - applies to the next track started, not the one currently playing", {
      guildId: this.guildId,
      level,
    });
    this.volume = level;
  }

  getState(): PlayerState {
    const current = this.cursor.current();
    const activeTrack = this.adHocTrack ?? current?.track ?? null;
    return {
      guildId: this.guildId,
      state: this.state,
      currentTrackId: activeTrack?.id ?? null,
      positionSeconds: this.getPositionSeconds(),
      durationSeconds: activeTrack?.durationSeconds ?? null,
      volume: this.volume,
      repeat: this.repeat,
      updatedAt: Date.now(),
    };
  }
}
