import { getDb } from "../index";
import type { Track } from "./tracks";

export interface QueueItem {
  guildId: string;
  position: number;
  trackId: string;
  requestedBy: string | null;
}

export function getQueue(guildId: string): (QueueItem & { track: Track })[] {
  const rows = getDb()
    .query(
      `SELECT q.guild_id, q.position, q.track_id, q.requested_by, t.*
       FROM queue q JOIN tracks t ON t.id = q.track_id
       WHERE q.guild_id = ? ORDER BY q.position ASC`
    )
    .all(guildId) as any[];

  return rows.map((row) => ({
    guildId: row.guild_id,
    position: row.position,
    trackId: row.track_id,
    requestedBy: row.requested_by,
    track: {
      id: row.id,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      localPath: row.local_path,
      title: row.title,
      durationSeconds: row.duration_seconds,
      thumbnailUrl: row.thumbnail_url,
      addedAt: row.added_at,
    },
  }));
}

/** Appends to the end of the guild's queue. Returns the assigned position. */
export function enqueue(guildId: string, trackId: string, requestedBy: string | null): number {
  const db = getDb();
  const { maxLength } = { maxLength: 500 }; // mirrors config.maxQueueLength; enforced in the route layer too

  const countRow = db.query("SELECT COUNT(*) as n FROM queue WHERE guild_id = ?").get(guildId) as {
    n: number;
  };
  if (countRow.n >= maxLength) {
    throw new Error(`Queue for guild ${guildId} is full (max ${maxLength})`);
  }

  const nextPos = db
    .query("SELECT COALESCE(MAX(position), -1) + 1 as next FROM queue WHERE guild_id = ?")
    .get(guildId) as { next: number };

  db.query(
    "INSERT INTO queue (guild_id, position, track_id, requested_by) VALUES (?, ?, ?, ?)"
  ).run(guildId, nextPos.next, trackId, requestedBy);

  return nextPos.next;
}

export function removeAt(guildId: string, position: number): void {
  const db = getDb();
  db.transaction(() => {
    db.query("DELETE FROM queue WHERE guild_id = ? AND position = ?").run(guildId, position);
    // Close the gap so positions stay dense (0..n-1) — keeps reorder math simple.
    db.query(
      "UPDATE queue SET position = position - 1 WHERE guild_id = ? AND position > ?"
    ).run(guildId, position);
  })();
}

export function reorder(guildId: string, from: number, to: number): void {
  if (from === to) return;
  const db = getDb();
  db.transaction(() => {
    const row = db
      .query("SELECT track_id, requested_by FROM queue WHERE guild_id = ? AND position = ?")
      .get(guildId, from) as { track_id: string; requested_by: string | null } | undefined;
    if (!row) return;

    db.query("DELETE FROM queue WHERE guild_id = ? AND position = ?").run(guildId, from);

    if (from < to) {
      db.query(
        "UPDATE queue SET position = position - 1 WHERE guild_id = ? AND position > ? AND position <= ?"
      ).run(guildId, from, to);
    } else {
      db.query(
        "UPDATE queue SET position = position + 1 WHERE guild_id = ? AND position >= ? AND position < ?"
      ).run(guildId, to, from);
    }

    db.query(
      "INSERT INTO queue (guild_id, position, track_id, requested_by) VALUES (?, ?, ?, ?)"
    ).run(guildId, to, row.track_id, row.requested_by);
  })();
}

export function clearQueue(guildId: string): void {
  getDb().query("DELETE FROM queue WHERE guild_id = ?").run(guildId);
}

export function recordHistory(guildId: string, trackId: string): void {
  getDb()
    .query("INSERT INTO history (guild_id, track_id, played_at) VALUES (?, ?, ?)")
    .run(guildId, trackId, Date.now());
}
