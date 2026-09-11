import type { Subprocess } from "bun";
import { FFMPEG_PATH } from "../core/binaries";
import { createLogger } from "../core/logger";
import { trackProcess } from "../core/processRegistry";
import { SpawnPool } from "./concurrency";

const log = createLogger("media/ffmpeg");

export const ffmpegPlaybackPool = new SpawnPool(6, "ffmpeg-playback");

function buildArgs(volume: number): string[] {
  return [
    "-i", "-", // read from stdin
    "-analyzeduration", "0",
    "-loglevel", "warning",
    "-af", `volume=${volume}`,
    // Encode to Opus natively in ffmpeg (fast, C, libopus) instead of
    // handing @discordjs/voice raw PCM and making IT encode to Opus in
    // JS/WASM (opusscript) — that JS encode step is what was causing
    // audible stuttering and slow pause/resume response. Ogg container so
    // prism-media's OggOpus demuxer can just extract already-encoded Opus
    // frames — no encoding OR decoding happens outside ffmpeg at all.
    "-f", "ogg",
    "-c:a", "libopus",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-vbr", "on",
    "-", // write to stdout
  ];
}

/**
 * Spawns ffmpeg (resolved via core/binaries.ts — next to the app if
 * present, falling back to PATH) with the given input readable piped to
 * its stdin and its stdout available to pipe onward to @discordjs/voice.
 * `volume` (0.0-2.0) is baked into this specific spawn via ffmpeg's own
 * volume filter — see player/guildPlayer.ts's setVolume() for why this
 * means volume changes apply to the next track, not one already playing.
 * Never buffers input/output in the JS process — see doc §9.
 */
export function spawnTranscode(input: ReadableStream<Uint8Array> | number, volume = 1.0): Subprocess {
  const proc = Bun.spawn([FFMPEG_PATH, ...buildArgs(volume)], {
    stdin: input as any,
    stdout: "pipe",
    stderr: "pipe",
  });
  trackProcess(proc);

  // Log stderr for debugging without letting it accumulate unbounded in memory.
  void (async () => {
    const reader = proc.stderr as ReadableStream<Uint8Array>;
    for await (const chunk of reader) {
      const text = new TextDecoder().decode(chunk).trim();
      if (text) log.debug("ffmpeg stderr", { line: text.slice(0, 300) });
    }
  })();

  return proc;
}
