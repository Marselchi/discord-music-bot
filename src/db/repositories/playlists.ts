import { getDb } from "../index";
import type { Track } from "./tracks";

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
}

export function listPlaylists(): Playlist[] {
  const rows = getDb().query("SELECT id, name, created_at FROM playlists ORDER BY created_at DESC").all() as any[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

export function createPlaylist(id: string, name: string): Playlist {
  const createdAt = Date.now();
  getDb().query("INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)").run(id, name, createdAt);
  return { id, name, createdAt };
}

export function deletePlaylist(id: string): void {
  getDb().query("DELETE FROM playlists WHERE id = ?").run(id);
}

export function getPlaylist(id: string): Playlist | null {
  const row = getDb().query("SELECT id, name, created_at FROM playlists WHERE id = ?").get(id) as any;
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

export function getPlaylistTracks(id: string): (Track & { position: number })[] {
  const rows = getDb()
    .query(
      `SELECT pt.position, t.* FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = ? ORDER BY pt.position ASC`
    )
    .all(id) as any[];
  return rows.map((r) => ({
    position: r.position,
    id: r.id,
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    localPath: r.local_path,
    title: r.title,
    durationSeconds: r.duration_seconds,
    thumbnailUrl: r.thumbnail_url,
    addedAt: r.added_at,
  }));
}

export function addTrackToPlaylist(playlistId: string, trackId: string): void {
  const db = getDb();
  const next = db
    .query("SELECT COALESCE(MAX(position), -1) + 1 as next FROM playlist_tracks WHERE playlist_id = ?")
    .get(playlistId) as { next: number };
  db.query("INSERT OR REPLACE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)").run(
    playlistId,
    trackId,
    next.next
  );
}

export function removeTrackFromPlaylist(playlistId: string, trackId: string): void {
  getDb()
    .query("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?")
    .run(playlistId, trackId);
}
