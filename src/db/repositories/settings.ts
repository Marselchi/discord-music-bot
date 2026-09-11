import { getDb } from "../index";

export function getSetting(key: string): string | null {
  const row = getDb().query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .query(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().query("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export interface GuildSettings {
  guildId: string;
  defaultVolume: number;
  autoplay: boolean;
}

export function getGuildSettings(guildId: string): GuildSettings {
  const row = getDb()
    .query("SELECT guild_id, default_volume, autoplay FROM guild_settings WHERE guild_id = ?")
    .get(guildId) as { guild_id: string; default_volume: number; autoplay: number } | undefined;

  if (!row) {
    return { guildId, defaultVolume: 1.0, autoplay: false };
  }
  return { guildId: row.guild_id, defaultVolume: row.default_volume, autoplay: !!row.autoplay };
}

export function upsertGuildSettings(settings: GuildSettings): void {
  getDb()
    .query(
      `INSERT INTO guild_settings (guild_id, default_volume, autoplay) VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET default_volume = excluded.default_volume, autoplay = excluded.autoplay`
    )
    .run(settings.guildId, settings.defaultVolume, settings.autoplay ? 1 : 0);
}
