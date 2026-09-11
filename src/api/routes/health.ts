import type { Router } from "../router";

const VERSION = "0.1.0";

export function registerHealthRoutes(router: Router) {
  router.get("/health", () => {
    return Response.json({ status: "ok", version: VERSION, uptimeSeconds: process.uptime() });
  });
}
