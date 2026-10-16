import type { AppConfig } from "../core/config";
import { createLogger } from "../core/logger";
import { Router } from "./router";
import { checkAuth } from "./middleware/auth";
import { withCors, preflightResponse } from "./middleware/cors";
import { createWsHandlers } from "../ws/handler";

import { registerHealthRoutes } from "./routes/health";
import { registerQueueRoutes } from "./routes/queue";
import { registerPlayerRoutes } from "./routes/player";
import { registerSettingsRoutes } from "./routes/settings";
import { registerGuildRoutes } from "./routes/guilds";
import { registerPlaylistRoutes } from "./routes/playlists";
import { registerLibraryRoutes } from "./routes/library";
import { registerSystemRoutes } from "./routes/system";

const log = createLogger("api/server");

export function startServer(config: AppConfig, localToken: string) {
  const router = new Router();
  registerHealthRoutes(router);
  registerSystemRoutes(router);
  registerQueueRoutes(router);
  registerPlayerRoutes(router);
  registerSettingsRoutes(router);
  registerGuildRoutes(router);
  registerPlaylistRoutes(router);
  registerLibraryRoutes(router, config);

  const ws = createWsHandlers(localToken);

  const server = Bun.serve({
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return preflightResponse(config.frontendOrigin);
      }

      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req, {
          data: { authenticated: false, guildIds: new Set<string>() },
        });
        if (upgraded) return undefined as unknown as Response; // bun handles the response
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const authError = checkAuth(req, localToken);
      if (authError) return withCors(authError, config.frontendOrigin);

      const res = await router.handle(req);
      return withCors(res, config.frontendOrigin);
    },
    websocket: ws,
  });

  log.info(`server listening on http://localhost:${server.port}`, { frontendOrigin: config.frontendOrigin });
  return server;
}
