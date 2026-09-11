import * as queueRepo from "../db/repositories/queue";

/**
 * The SQLite `queue` table (src/db/repositories/queue.ts) is the durable,
 * reorderable list — safe across restarts. This class is the *in-memory*
 * cursor into that list for a single guild: "which position are we on right
 * now." On process restart, a GuildPlayer just re-reads position 0 and
 * resumes from the top of the persisted queue (see doc §8).
 */
export class QueueCursor {
  private position = 0;

  constructor(private guildId: string) {}

  current() {
    const queue = queueRepo.getQueue(this.guildId);
    return queue.find((item) => item.position === this.position) ?? null;
  }

  peekNext() {
    const queue = queueRepo.getQueue(this.guildId);
    return queue.find((item) => item.position === this.position + 1) ?? null;
  }

  advance(): void {
    this.position += 1;
  }

  /** Jumps directly to a queue position (used by play-from-position / play-by-trackId). */
  setPosition(position: number): void {
    this.position = position;
  }

  reset(): void {
    this.position = 0;
  }

  get positionIndex(): number {
    return this.position;
  }
}
