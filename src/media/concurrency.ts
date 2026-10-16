/** See doc §9 — used for ffprobe scans and yt-dlp bulk-import lookups. */
export async function processInBatches<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;

  async function next(): Promise<void> {
    const idx = i++;
    if (idx >= items.length) return;
    results[idx] = await worker(items[idx], idx);
    return next();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

/**
 * Two separately configured pools so a background import can never starve
 * the playback spawns the user is actually listening to right now.
 * Playback always wins if both would be busy at once (doc §9).
 */
export class SpawnPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly name: string) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    return () => {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
