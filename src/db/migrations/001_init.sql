-- settings: single-row key/value store
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,             -- content hash or ytdlp id, stable across queue/playlists
  source_type TEXT NOT NULL,       -- 'youtube' | 'soundcloud' | 'local' | ...
  source_url TEXT,                 -- null for local files
  local_path TEXT,                 -- null for remote
  title TEXT NOT NULL,
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE queue (
  guild_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  requested_by TEXT,               -- discord user id, informational only
  PRIMARY KEY (guild_id, position)
);

CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  played_at INTEGER NOT NULL
);

CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  default_volume REAL NOT NULL DEFAULT 1.0,
  autoplay INTEGER NOT NULL DEFAULT 0
);
