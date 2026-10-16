import type { ServerWebSocket } from "bun";
import { bus, type AppEvents } from "../core/bus";
import { tokensMatch } from "../core/auth";
import { createLogger } from "../core/logger";

const log = createLogger("ws");

interface WsData {
  authenticated: boolean;
  guildIds: Set<string>;
}

const RELAYED_EVENTS: (keyof AppEvents)[] = [
  "track.started",
  "track.ended",
  "queue.changed",
  "player.stateChanged",
  "player.positionChanged",
  "player.repeatChanged",
  "download.progress",
  "voice.connected",
  "voice.disconnected",
  "playlists.changed",
];

/**
 * One WS connection per open UI tab. Each connection subscribes to specific
 * guildIds via a `{"type":"subscribe","guildId":"..."}` message, so a user
 * only receives events for guilds they're actually looking at (doc §7).
 */
export function createWsHandlers(localToken: string) {
  const unsubscribers: (() => void)[] = [];

  for (const event of RELAYED_EVENTS) {
    const unsub = bus.on(event, (payload: any) => {
      const guildId: string | undefined = payload.guildId;
      broadcast(event, payload, guildId);
    });
    unsubscribers.push(unsub);
  }

  const sockets = new Set<ServerWebSocket<WsData>>();

  function broadcast(type: string, payload: unknown, guildId?: string) {
    const message = JSON.stringify({ type, payload });
    for (const ws of sockets) {
      if (!ws.data.authenticated) continue;
      if (guildId && !ws.data.guildIds.has(guildId)) continue;
      ws.send(message);
    }
  }

  return {
    open(ws: ServerWebSocket<WsData>) {
      ws.data = { authenticated: false, guildIds: new Set() };
      sockets.add(ws);
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", payload: { message: "Invalid JSON" } }));
        return;
      }

      if (msg.type === "auth") {
        ws.data.authenticated = tokensMatch(msg.token, localToken);
        if (!ws.data.authenticated) {
          ws.send(JSON.stringify({ type: "error", payload: { message: "Invalid token" } }));
          ws.close(4001, "unauthorized");
        }
        return;
      }

      if (!ws.data.authenticated) return; // silently drop everything pre-auth except "auth" itself

      if (msg.type === "subscribe" && typeof msg.guildId === "string") {
        ws.data.guildIds.add(msg.guildId);
      } else if (msg.type === "unsubscribe" && typeof msg.guildId === "string") {
        ws.data.guildIds.delete(msg.guildId);
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      sockets.delete(ws);
    },

    /** Call on server shutdown to detach from the bus. */
    dispose() {
      unsubscribers.forEach((u) => u());
    },
  };
}
