import { GuildPlayer } from "./guildPlayer";

const players = new Map<string, GuildPlayer>();

/** Every route/command goes through this — never construct a GuildPlayer directly. */
export function getOrCreatePlayer(guildId: string): GuildPlayer {
  let player = players.get(guildId);
  if (!player) {
    player = new GuildPlayer(guildId);
    players.set(guildId, player);
  }
  return player;
}

export function getPlayer(guildId: string): GuildPlayer | null {
  return players.get(guildId) ?? null;
}

export function removePlayer(guildId: string): void {
  players.get(guildId)?.leave();
  players.delete(guildId);
}
