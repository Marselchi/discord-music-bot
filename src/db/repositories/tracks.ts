import { getDb } from "../index";

export type SourceType = "youtube" | "soundcloud" | "local";

export interface Track {
  id: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  localPath: string | null;
  title: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  addedAt: number;
}

function fromRow(row: any): Track {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    localPath: row.local_path,
    title: row.title,
    durationSeconds: row.duration_seconds,
    thumbnailUrl: row.thumbnail_url,
    addedAt: row.added_at,
  };
}

export function upsertTrack(track: Track): void {
  getDb()
    .query(
      `INSERT INTO tracks (id, source_type, source_url, local_path, title, duration_seconds, thumbnail_url, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         duration_seconds = excluded.duration_seconds,
         thumbnail_url = excluded.thumbnail_url`
    )
    .run(
      track.id,
      track.sourceType,
      track.sourceUrl,
      track.localPath,
      track.title,
      track.durationSeconds,
      track.thumbnailUrl,
      track.addedAt
    );
}

export function getTrack(id: string): Track | null {
  const row = getDb().query("SELECT * FROM tracks WHERE id = ?").get(id);
  return row ? fromRow(row) : null;
}

export function searchTracks(query: string, limit = 50, offset = 0): Track[] {
  const rows = getDb()
    .query("SELECT * FROM tracks WHERE title LIKE ? ORDER BY added_at DESC LIMIT ? OFFSET ?")
    .all(`%${query}%`, limit, offset);
  return rows.map(fromRow);
}

export function updateTrackTitle(id: string, title: string): Track | null {
  const db = getDb();
  db.query("UPDATE tracks SET title = ? WHERE id = ?").run(title, id);
  return getTrack(id);
}

