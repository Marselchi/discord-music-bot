import type { Router } from "../router";
import { jsonBody } from "../router";
import * as tracksRepo from "../../db/repositories/tracks";
import { scanLocalFolder } from "../../media/localFiles";
import { resolveInput, ensureDownloaded } from "../../media/resolver";
import { isCached } from "../../media/cache";
import { createLogger } from "../../core/logger";
import type { AppConfig } from "../../core/config";

const log = createLogger("api/library");

export function registerLibraryRoutes(router: Router, config: AppConfig) {
  router.get("/api/library/search", ({ query }) => {
    const q = query.get("q") ?? "";
    return Response.json({ tracks: tracksRepo.searchTracks(q) });
  });

  // Resolves + downloads a URL/query into the library WITHOUT touching any
  // guild's queue. This is the "download.progress" answer to "how do I get
  // a track into the library on its own": POST /api/queue/:guildId does
  // resolve+enqueue as one step (and also downloads in the background —
  // see api/routes/queue.ts) — this is the resolve+download-only version.
  //
  // Registered before "/api/library/:trackId" below: the router matches
  // routes in registration order and treats ":param" segments as wildcards,
  // so a literal "/api/library/download" route must come first or the
  // ":trackId" route would swallow it (trackId="download").
  router.post("/api/library/download", async ({ req }) => {
    const body = await jsonBody<{ url?: string; query?: string }>(req);
    const input = body.url ?? body.query;
    if (!input) {
      return Response.json(
        { error: { code: "bad_request", message: "One of url or query is required" } },
        { status: 400 }
      );
    }

    log.info("POST /api/library/download", { input });
    const track = await resolveInput(input);

    // Background, same as the queue route — the response doesn't wait on
    // the full download; poll via GET /api/library/search or listen for
    // "download.progress" (jobId = track.id) on the WebSocket.
    ensureDownloaded(track).catch((err) =>
      log.error("background download failed", { trackId: track.id, error: String(err) })
    );

    return Response.json({ track }, { status: 202 });
  });

  router.post("/api/library/scan", async () => {
    if (!config.musicFolder) {
      return Response.json(
        { error: { code: "bad_request", message: "No musicFolder configured in config.json" } },
        { status: 400 }
      );
    }
    const jobId = crypto.randomUUID();
    // Fire-and-forget: progress streams over ws via bus "download.progress".
    scanLocalFolder(config.musicFolder, jobId).catch((err) =>
      log.error("local folder scan failed", { error: String(err) })
    );
    return Response.json({ jobId }, { status: 202 });
  });

  // Given a trackId already known to the library (from a prior /download
  // call, a queue add, or a local scan), makes sure it's actually cached on
  // disk — without adding it to any guild's queue. Mainly useful to retry a
  // track whose cache file was evicted, or to pre-warm a track a user
  // starred/favorited before they're ready to play it.
  //
  // Registered LAST among the POST /api/library/* routes: this ":trackId"
  // wildcard segment matches ANY literal (including "download" and "scan"),
  // and the router returns the first registered match — so both literal
  // routes above must come first, or this one would swallow their requests.
  router.post("/api/library/:trackId", async ({ params }) => {
    const track = tracksRepo.getTrack(params.trackId);
    if (!track) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: `No track with id ${params.trackId} in the library. Resolve it first via POST /api/library/download.`,
          },
        },
        { status: 404 }
      );
    }

    log.info("POST /api/library/:trackId", { trackId: track.id, sourceType: track.sourceType });

    if (track.sourceType === "local") {
      return Response.json({ trackId: track.id, alreadyCached: true });
    }

    const alreadyCached = isCached(track.id);
    if (!alreadyCached) {
      ensureDownloaded(track).catch((err) =>
        log.error("background download failed", { trackId: track.id, error: String(err) })
      );
    }
    return Response.json({ trackId: track.id, alreadyCached }, { status: 202 });
  });
}
