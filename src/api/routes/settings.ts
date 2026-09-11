import type { Router } from "../router";
import { jsonBody } from "../router";
import * as settingsRepo from "../../db/repositories/settings";

export function registerSettingsRoutes(router: Router) {
  router.get("/api/settings", () => {
    return Response.json({ settings: settingsRepo.getAllSettings() });
  });

  router.patch("/api/settings", async ({ req }) => {
    const updates = await jsonBody<Record<string, string>>(req);
    for (const [key, value] of Object.entries(updates)) {
      settingsRepo.setSetting(key, String(value));
    }
    return Response.json({ settings: settingsRepo.getAllSettings() });
  });
}
