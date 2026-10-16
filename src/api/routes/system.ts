import type { Router } from "../router";
import { checkSystemUpdates, runYtDlpAutoUpdate } from "../../core/versionChecker";

export function registerSystemRoutes(router: Router) {
  router.get("/api/system/updates", async ({ query }) => {
    const force = query.get("force") === "true";
    const status = await checkSystemUpdates(force);
    return Response.json(status);
  });

  router.post("/api/system/update/ytdlp", async () => {
    const result = await runYtDlpAutoUpdate();
    if (!result.success) {
      return Response.json(
        { error: { code: "internal_error", message: result.output || "Failed to update yt-dlp" } },
        { status: 500 }
      );
    }
    const freshStatus = await checkSystemUpdates(true);
    return Response.json({ ok: true, output: result.output, status: freshStatus });
  });
}
