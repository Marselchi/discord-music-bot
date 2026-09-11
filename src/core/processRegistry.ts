import type { Subprocess } from "bun";
import { createLogger } from "./logger";

const log = createLogger("core/processRegistry");
const tracked = new Set<Subprocess>();

/**
 * Registers a spawned child process (ffmpeg/yt-dlp) so it gets explicitly
 * killed on shutdown (see killAllTrackedProcesses(), called from index.ts's
 * shutdown handler) instead of potentially surviving as an orphan.
 *
 * Why this matters on Windows specifically: closing a console window
 * normally cascades CTRL_CLOSE_EVENT to processes attached to that
 * console, but that's not guaranteed for every spawn configuration, and a
 * process that ignores/mishandles that event (some ffmpeg builds do, in a
 * piped-stdin scenario) can survive its parent, quietly holding memory
 * and a file/network handle open. Explicitly killing everything we
 * spawned on OUR OWN graceful shutdown (Ctrl+C / SIGTERM) closes that gap
 * for the cases within our control.
 */
export function trackProcess(proc: Subprocess): void {
  tracked.add(proc);
  proc.exited.finally(() => tracked.delete(proc)).catch(() => {});
}

export function killAllTrackedProcesses(): void {
  if (tracked.size === 0) return;
  log.info(`killing ${tracked.size} tracked subprocess(es) on shutdown`);
  for (const proc of tracked) {
    try {
      proc.kill();
    } catch (err) {
      log.warn("failed to kill a tracked subprocess", { error: String(err) });
    }
  }
}
