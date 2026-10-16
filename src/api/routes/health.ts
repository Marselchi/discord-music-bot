import type { Router } from "../router";
import { BOT_VERSION } from "../../core/versionChecker";

export function registerHealthRoutes(router: Router) {
  router.get("/health", () => {
    return Response.json({ status: "ok", version: BOT_VERSION, uptimeSeconds: process.uptime() });
  });
}
