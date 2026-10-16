# API Contract

Everything here is served by the single backend process (default
`http://localhost:21000`, configurable via `config.json`'s `port`). There is
no separate auth service, no OAuth — one shared local pairing token secures
every request. Read this alongside `README.md` for setup/run instructions.

## Base URL & CORS

- Base URL: `http://localhost:<port>` (or wherever the user's machine is
  reachable — e.g. via a tunnel, if the frontend is deployed remotely).
- CORS allows exactly one origin: `config.json`'s `frontendOrigin`. It must
  match your deployed frontend's origin **exactly** (scheme + host + port,
  no wildcard, no trailing slash) or the browser will block every request.

## Authentication

The backend prints a **local pairing token** to its console on every
startup. The frontend needs the user to paste this in once; store it
(e.g. `localStorage`) and attach it to every request after that.

- **REST**: send it as `X-Local-Token: <token>` on every request except
  `GET /health`.
- **WebSocket**: the connection starts unauthenticated; the first message
  you send must be `{"type":"auth","token":"<token>"}`. Until that
  succeeds, the server ignores all other messages from you. A wrong token
  gets a `{"type":"error",...}` message followed by the socket closing
  with code `4001`.

There's no token refresh/expiry — it's a single long-lived local secret,
regenerated only if `.token` is deleted.

### Error shape

Every error response (REST) has this shape, with an appropriate HTTP status
(400/401/404/409/500/502):

```json
{ "error": { "code": "bad_request", "message": "human-readable detail" } }
```

Known `code` values you may want to branch on: `unauthorized`,
`bad_request`, `not_found`, `join_failed`, `playback_failed`, `internal_error`. Treat unknown
codes the same as `internal_error` — don't assume the list is exhaustive.

---

## REST Endpoints

### Health

**`GET /health`** — no auth required. Use this as your connection probe
before asking the user for a token.

```json
{ "status": "ok", "version": "0.1.0", "uptimeSeconds": 123.4 }
```

---

### Guilds & Channels

**`GET /api/guilds`** — servers the bot is currently in.

```json
{ "guilds": [{ "id": "123", "name": "My Server", "iconUrl": "https://...", "memberCount": 42 }] }
```

**`GET /api/guilds/:guildId/channels`** — voice channels in that guild
(for the channel picker before joining).

```json
{ "channels": [{ "id": "456", "name": "General" }] }
```

---

### Player (voice connection + playback control)

**`POST /api/player/:guildId/join`** — the bot joins a voice channel. This
is what makes the bot fully controllable from the UI without anyone typing
a slash command.

Request body:
```json
{ "channelId": "456" }
```
Response: `{ "ok": true, "guildId": "123", "channelId": "456" }`
Errors: `404 not_found` if the bot isn't in that guild; `400 bad_request` if
`channelId` isn't a real voice channel in that guild; `502 join_failed` if
Discord's voice handshake times out (~15s).

**`POST /api/player/:guildId/leave`** — disconnects from voice. No body.
Note this only *initiates* the disconnect — see the WebSocket section
below for why you should wait for `voice.disconnected` rather than assume
success from this response alone.

**`GET /api/player/:guildId`** — current playback state. Poll this or (better)
listen for `player.stateChanged` / `player.positionChanged` over the
WebSocket instead of polling.

```json
{
  "guildId": "123",
  "state": "playing",
  "currentTrackId": "dQw4w9WgXcQ",
  "positionSeconds": 42,
  "durationSeconds": 212,
  "volume": 1,
  "repeat": false,
  "updatedAt": 1699999999999
}
```
`state` is one of `"idle" | "playing" | "paused"`. `currentTrackId` can be
an ad-hoc track (see `play-adhoc` below) rather than the queue's current
item — this field always reflects what's actually playing, whichever way
it was started. `positionSeconds` is now
live (backed by `@discordjs/voice`'s per-resource playback clock, which
itself pauses counting while the player is paused — no drift on
pause/resume). `durationSeconds` comes from the track's metadata and can
be `null` if the source never reported one. `repeat` reflects the last
value set via `POST /api/player/:guildId/repeat` (see below) and does not
apply to ad-hoc tracks. `updatedAt`
is just the epoch ms this snapshot was computed, in case you need to
reason about staleness after a dropped WS message.

**`POST /api/player/:guildId/play`** — (re)starts playback. Body is
optional:

```json
{}
```
starts/resumes at wherever the queue cursor currently is (the original
behavior — useful right after `join` to kick off the first track), or:
```json
{ "position": 2 }
```
jumps straight to that queue position (0-indexed) and plays it, stopping
whatever was already playing. Errors: `400 bad_request` if `position` is
out of range for the guild's current queue length.

**`POST /api/player/:guildId/play-track`** — same idea as `play` with a
`position`, but by track id instead of position — looks the track up in
the guild's *current* queue and plays from wherever it happens to be:

```json
{ "trackId": "dQw4w9WgXcQ" }
```
Errors: `404 not_found` if that trackId isn't actually in this guild's
queue right now (this endpoint doesn't enqueue anything itself — add it
via `POST /api/queue/:guildId` first if it isn't there, **or**, if you
specifically don't want it added to the queue, use `play-adhoc` below).

**`POST /api/player/:guildId/play-adhoc`** — plays a track that is **not**
in the queue, without adding it, reordering anything, or otherwise
touching the queue at all:

```json
{ "trackId": "dQw4w9WgXcQ" }
```
Response: `{ "ok": true, "trackId": "dQw4w9WgXcQ" }`. When this track ends
— naturally, via a later `skip`, or on an error — playback resumes exactly
where the queue already was, in its existing order, as if the ad-hoc track
had been playing in a separate lane the whole time. `repeat` does **not**
apply to an ad-hoc track (it always plays once); calling `play`/`play-track`
while one is playing stops it and jumps to that position instead, same as
it would during normal queue playback. Use this for previews / one-off
plays — e.g. a search result the user wants to hear before deciding
whether to queue it. Errors: `404 not_found` if the trackId isn't in the
library at all (resolve it first via `POST /api/library/download` or by
adding it to a queue once); `502 playback_failed` if opening the track's
stream throws (e.g. its cached file is missing/corrupt).

**`POST /api/player/:guildId/pause`** / **`POST /api/player/:guildId/resume`** — no body.

**`POST /api/player/:guildId/skip`** — stops the current track; the queue
advances and the next track starts automatically. No body.

**`POST /api/player/:guildId/seek`** — **not implemented yet** (accepted,
but currently a no-op logged as a warning server-side). Body shape for
when it lands: `{ "seconds": 30 }`.

**`POST /api/player/:guildId/volume`** — body: `{ "level": 1.0 }` (0.0–2.0,
1.0 = default). Applies to the *next* track that starts — not one already
playing (the audio pipeline encodes to Opus before `@discordjs/voice` ever
sees it, so there's no live gain stage to adjust mid-track; see the
backend README's Opus/ffmpeg note).

**`POST /api/player/:guildId/repeat`** — toggles repeat-current-track.
Body: `{ "enabled": true }`. Response: `{ "ok": true, "enabled": true }`.
Only affects a track that ends *naturally* — if it's on, the same track
just plays again instead of the queue advancing. A manual `skip` or a
`play`/`play-track` jump always moves on regardless of this setting. Works
even before anything's playing (unlike most other player routes, this one
doesn't 404 if the bot hasn't joined a voice channel yet) — it's just
remembered for whenever playback starts.

**Every route above except `join` returns `404 not_found`** (not a silent
`200`) if the bot has never joined a voice channel in this guild in the
current process — i.e. `getPlayer()` finds nothing. If you're seeing
`{"ok":true}` responses but nothing audibly happens, check the response
status wasn't actually a 404 you're not surfacing, and check the backend's
logs (`api/player` and `player` loggers) — every one of these routes and
every step of starting playback (download resolved, ffmpeg piped, resource
created, `AudioPlayer.play()` called) logs at `info` level specifically so
"is this a backend problem or a frontend request problem" is answerable
from logs alone.

---

### Queue

**`GET /api/queue/:guildId`**

```json
{
  "queue": [
    {
      "guildId": "123", "position": 0, "trackId": "dQw4w9WgXcQ", "requestedBy": "9991112223",
      "track": {
        "id": "dQw4w9WgXcQ", "sourceType": "youtube", "sourceUrl": "https://...",
        "localPath": null, "title": "...", "durationSeconds": 212,
        "thumbnailUrl": "https://...", "addedAt": 1699999999999
      }
    }
  ]
}
```

**`POST /api/queue/:guildId`** — add a track. Provide **one** of:

```json
{ "url": "https://youtube.com/watch?v=..." }
{ "query": "some search text" }
{ "trackId": "already-known-id", "requestedBy": "optional-user-id" }
```

`url`/`query` trigger metadata resolution (yt-dlp) if the track isn't
already known; `trackId` skips straight to enqueueing something already in
the library (e.g. from a playlist or search result).

Response: `{ "position": 0, "trackId": "dQw4w9WgXcQ" }`, status `201`.

**Downloading behavior you should know about**: adding a YouTube/SoundCloud
track kicks off a **background download** to disk immediately (so it only
ever gets fetched from the source once — see README). If the track is
already cached, this is a no-op. There's no "download complete" REST
signal yet; if you want to show download progress, listen for
`download.progress` on the WebSocket (job id is currently the track id for
this path). **If you want a track downloaded/saved to the library WITHOUT
adding it to anyone's playback queue**, use `POST /api/library/download`
instead (see the Library section) — this endpoint always does both
resolve-and-enqueue together, by design.

**`DELETE /api/queue/:guildId/:position`** — remove the item at that queue
position (0-indexed). Response: `{ "ok": true }`.

**`POST /api/queue/:guildId/reorder`** — body: `{ "from": 2, "to": 0 }`
(positions, 0-indexed). Response: `{ "ok": true }`.

**`POST /api/queue/:guildId/clear`** — empties the guild's queue. No body.

---

### Settings

**`GET /api/settings`** — global key/value settings (not per-guild).

```json
{ "settings": { "some_key": "some_value" } }
```

**`PATCH /api/settings`** — merge-patch; body is any subset of key/value
pairs to set. Returns the full updated settings object.

---

### Playlists

**`GET /api/playlists`**
```json
{ "playlists": [{ "id": "uuid", "name": "Road Trip", "createdAt": 1699999999999 }] }
```

**`POST /api/playlists`** — body: `{ "name": "Road Trip" }`. Response:
`{ "playlist": {...} }`, status `201`.

**`DELETE /api/playlists/:playlistId`**

**`GET /api/playlists/:playlistId/tracks`** — tracks in position order,
same `Track` shape as in the queue, plus `position`.

**`POST /api/playlists/:playlistId/tracks`** — body: `{ "trackId": "..." }`.
Appends to the end. Status `201`.

**`DELETE /api/playlists/:playlistId/tracks/:trackId`**

---

### Library (search + local file scanning)

**`GET /api/library/search?q=text`** — searches previously-resolved/cached
tracks by title substring (this is *your* library — cached downloads +
scanned local files — not a live YouTube search). Empty `q` returns
recent tracks.

```json
{ "tracks": [ /* Track[] */ ] }
```

**`POST /api/library/download`** — resolves a URL/search query and
downloads it to the library, **without** adding it to any guild's queue
(compare to `POST /api/queue/:guildId`, which always does both together).
Provide one of:

```json
{ "url": "https://youtube.com/watch?v=..." }
{ "query": "some search text" }
```

Response: `{ "track": { /* Track */ } }`, status `202` — the download
continues in the background after this returns; the `track` object is
available immediately (metadata resolves fast), but playback-readiness
follows the same "listen for `download.progress` with `jobId` = the
track's id" pattern as the queue route.

**`POST /api/library/:trackId`** — makes sure a track already known to the
library (by id) is actually downloaded/cached on disk, without touching
any guild's queue. Useful to retry a track whose cached file got evicted,
or to pre-warm something before a user is ready to play it. No body.

Response: `{ "trackId": "...", "alreadyCached": false }`, status `202`
(or `200` with `alreadyCached: true` implied if it's a local file, which
is never "downloaded"). Errors: `404 not_found` if that trackId isn't in
the library at all — resolve it first via `POST /api/library/download`,
a queue add, or a local scan.

**`POST /api/library/scan`** — kicks off a scan of the configured
`musicFolder` (see `config.json`) in the background. Response:
`{ "jobId": "uuid" }`, status `202`. Progress comes over the WebSocket as
`download.progress` events keyed by this `jobId` (same event type is reused
for both track downloads and folder scans — check whether the `jobId` you
get back matches a track id or this scan's job id to tell them apart).
Errors: `400 bad_request` if no `musicFolder` is configured.

**`POST /api/library/inspect`** — inspects a video URL, returning title, duration, thumbnail, and detected chapters without downloading audio.
Body: `{ "url": "https://..." }`.
Response: `{ "metadata": { "id": "...", "title": "...", "duration": 1200, "thumbnail": "...", "chapters": [{ "title": "...", "startTime": 0, "endTime": 120 }] } }`.

**`POST /api/library/download-playlist`** — downloads an entire remote playlist, saving tracks to the library and optionally creating a local Playlist.
Body: `{ "url": "https://...", "createPlaylist": true }`.
Response: `{ "ok": true, "jobId": "...", "playlistId": "...", "title": "...", "trackCount": 25, "tracks": [...] }`, status `202`.

**`POST /api/library/slice`** — slices an audio file into independent tracks registered in SQLite and cache.
Body:
```json
{
  "trackId": "existing-id",
  "url": "https://...",
  "slices": [{ "title": "Track 1", "startTime": 0, "endTime": 180 }],
  "enqueueGuildId": "optional-guild-id",
  "createPlaylistName": "optional-playlist-name"
}
```
Response: `{ "ok": true, "tracks": [...], "playlistId": "..." }`, status `201`.

**`GET /api/tracks/:trackId/chapters`** — fetches chapter markers for an already-registered track if available from source metadata.

**`PATCH /api/tracks/:trackId`** — renames a track in the library and throughout all queues and playlists.
Body: `{ "title": "New Track Title" }`.
Response: `{ "ok": true, "track": { /* Track */ } }`.

---

### System & Updates

**`GET /api/system/updates`** — checks current vs latest versions of `yt-dlp` and `ffmpeg`.
Response:
```json
{
  "ytdlp": { "current": "2024.08.19", "latest": "2025.01.15", "updateAvailable": true, "releaseUrl": "...", "canAutoUpdate": true },
  "ffmpeg": { "current": "7.0.1", "latest": "7.1", "updateAvailable": false, "releaseUrl": "...", "canAutoUpdate": false },
  "checkedAt": 1700000000000
}
```

**`POST /api/system/update/ytdlp`** — triggers automated update of yt-dlp (`yt-dlp -U`).
Response: `{ "ok": true, "output": "...", "status": { ... } }`.

---

## WebSocket

**Connect**: `ws://localhost:<port>/ws`

**Auth** (first message, required):
```json
{ "type": "auth", "token": "<local pairing token>" }
```

**Subscribe to a guild's events** (send after auth):
```json
{ "type": "subscribe", "guildId": "123" }
```
```json
{ "type": "unsubscribe", "guildId": "123" }
```
You only receive events for guilds you've subscribed to. Subscribe to every
guild the current UI view cares about — typically just the one the user
has selected.

### Server → client messages

All messages look like `{ "type": "<event>", "payload": {...} }`.

| type                 | payload                                                              |
|----------------------|-----------------------------------------------------------------------|
| `track.started`      | `{ guildId, trackId }`                                                |
| `track.ended`        | `{ guildId, trackId, reason: "finished" \| "skipped" \| "error" }`    |
| `queue.changed`       | `{ guildId }` — re-fetch `GET /api/queue/:guildId` on this            |
| `player.stateChanged` | `{ guildId, state: "idle" \| "playing" \| "paused" }`                 |
| `player.positionChanged` | `{ guildId, positionSeconds, durationSeconds }` — emitted roughly once/second while `state === "playing"`; stops while paused/idle |
| `player.repeatChanged` | `{ guildId, enabled }` — mirrors whatever was last set via `POST /api/player/:guildId/repeat` |
| `download.progress`  | `{ jobId, done, total }`                                              |
| `voice.connected`    | `{ guildId, channelId }`                                              |
| `voice.disconnected` | `{ guildId }`                                                         |

`queue.changed` is intentionally a bare notification, not the queue
itself — re-fetch rather than trying to keep a client-side diff in sync.
Everything else is the full payload you need, no follow-up fetch required.

**`voice.connected`/`voice.disconnected` reflect the actual Discord voice
state, not just the API call that requested it.** `voice.connected` fires
only after the voice handshake actually reaches "Ready" — not when
`POST /api/player/:guildId/join` is *called*, but when it *succeeds*
(if it fails, you get the 502 response instead and no event).
`voice.disconnected` fires whenever the bot actually leaves voice for
*any* reason: an explicit `POST /api/player/:guildId/leave` call, yes,
but equally a mod kicking the bot from the channel, a Discord voice
server hiccup, or anything else — the backend detects this from the voice
connection itself (its `Destroyed` state), not from who asked for it. If
your UI shows "connected to #general" from the `join` response alone and
never updates on this event, it will go stale the moment the bot is
disconnected by anything other than your own UI.

`error` messages (`{"type":"error","payload":{"message":"..."}}`) can also
arrive — e.g. malformed JSON you sent, or a failed auth attempt.

### Client → server messages

Only three: `auth` (required first), `subscribe`, `unsubscribe` (both
shown above). Anything else is silently ignored.

---

## Suggested frontend flow

1. `GET /health` on load, no token — confirms the backend is reachable at all.
2. Prompt for the pairing token (or read a previously-saved one), then
   `GET /api/guilds` with `X-Local-Token` to confirm it's valid.
3. Open the WebSocket, send `auth`, then `subscribe` to the selected guild.
4. `GET /api/guilds/:guildId/channels`, let the user pick one, `POST /api/player/:guildId/join`.
5. Search/queue tracks via `POST /api/queue/:guildId`; render the queue from
   `GET /api/queue/:guildId`, refreshing on `queue.changed`.
6. Drive the transport controls (play/pause/skip/volume) via the
   `/api/player/:guildId/*` routes; reflect state from `player.stateChanged`
   rather than polling `GET /api/player/:guildId`.
