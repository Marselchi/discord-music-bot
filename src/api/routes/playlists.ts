import type { Router } from "../router";
import { jsonBody } from "../router";
import * as playlistsRepo from "../../db/repositories/playlists";
import { bus } from "../../core/bus";

export function registerPlaylistRoutes(router: Router) {
  router.get("/api/playlists", () => {
    return Response.json({ playlists: playlistsRepo.listPlaylists() });
  });

  router.post("/api/playlists", async ({ req }) => {
    const { name } = await jsonBody<{ name: string }>(req);
    const playlist = playlistsRepo.createPlaylist(crypto.randomUUID(), name);
    bus.emit("playlists.changed", {});
    return Response.json({ playlist }, { status: 201 });
  });

  router.delete("/api/playlists/:playlistId", ({ params }) => {
    playlistsRepo.deletePlaylist(params.playlistId);
    bus.emit("playlists.changed", {});
    return Response.json({ ok: true });
  });

  router.get("/api/playlists/:playlistId/tracks", ({ params }) => {
    return Response.json({ tracks: playlistsRepo.getPlaylistTracks(params.playlistId) });
  });

  router.post("/api/playlists/:playlistId/tracks", async ({ req, params }) => {
    const { trackId } = await jsonBody<{ trackId: string }>(req);
    playlistsRepo.addTrackToPlaylist(params.playlistId, trackId);
    bus.emit("playlists.changed", {});
    return Response.json({ ok: true }, { status: 201 });
  });

  router.delete("/api/playlists/:playlistId/tracks/:trackId", ({ params }) => {
    playlistsRepo.removeTrackFromPlaylist(params.playlistId, params.trackId);
    bus.emit("playlists.changed", {});
    return Response.json({ ok: true });
  });
}
