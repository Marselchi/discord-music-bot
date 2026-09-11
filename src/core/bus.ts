/**
 * Internal event bus. This is how modules that shouldn't import each other's
 * internals stay in sync — e.g. `player/` emits `track.started`, `ws/`
 * subscribes and broadcasts it to connected UI tabs, and some future
 * `lyrics/` module could subscribe to the same event without `player/`
 * ever knowing it exists (see doc §10).
 *
 * Additive by construction: add a new member to `AppEvents` for a new
 * feature, never change an existing one's shape.
 */

export interface AppEvents {
  "track.started": { guildId: string; trackId: string };
  "track.ended": { guildId: string; trackId: string; reason: "finished" | "skipped" | "error" };
  "queue.changed": { guildId: string };
  "player.stateChanged": { guildId: string; state: "idle" | "playing" | "paused" };
  "player.positionChanged": { guildId: string; positionSeconds: number; durationSeconds: number | null };
  "player.repeatChanged": { guildId: string; enabled: boolean };
  "download.progress": { jobId: string; done: number; total: number };
  "voice.connected": { guildId: string; channelId: string };
  "voice.disconnected": { guildId: string };
}

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void;

class EventBus {
  private handlers = new Map<keyof AppEvents, Set<Handler<any>>>();

  on<K extends keyof AppEvents>(event: K, handler: Handler<K>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        // A broken subscriber (e.g. a ws client hiccup) must never take down
        // the emitter (e.g. the player finishing a track).
        console.error(`[bus] handler for "${event}" threw:`, err);
      }
    }
  }
}

// Single shared instance for the whole process — this is intentionally a
// singleton; every module imports the same bus.
export const bus = new EventBus();
