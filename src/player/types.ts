export type PlaybackState = "idle" | "playing" | "paused";

export interface PlayerState {
  guildId: string;
  state: PlaybackState;
  currentTrackId: string | null;
  positionSeconds: number;
  durationSeconds: number | null;
  volume: number; // 0.0 - 2.0, 1.0 = default
  repeat: boolean;
  updatedAt: number; // epoch ms this snapshot was computed
}
