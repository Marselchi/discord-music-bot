# Discord Music Bot — Backend

Local-first backend for a Discord music bot: a single Bun process runs the
Discord client, the HTTP/WS API for a companion web UI, the SQLite-backed
queue/library, and the yt-dlp → ffmpeg streaming pipeline.

## Requirements

- [Bun](https://bun.sh) >= 1.1
- `ffmpeg`, `ffprobe`, and `yt-dlp` — see **"Bundling ffmpeg/ffprobe/yt-dlp"**
  below for exactly how these are resolved and where to get each one
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
  with the **Server Members** and **Message Content** privileged intents
  enabled, invited to your server with `bot` + `applications.commands` scopes

No C++ build tools required, and no Opus codec package either (this
project previously tried `opusscript`, a pure-JS/WASM Opus encoder, as a
workaround for `@discordjs/opus`'s native build failing on machines
without build tools. `opusscript` avoided the install problem but was too
slow to encode audio in real time, causing audible stuttering and slow
pause/resume response). The actual fix: **ffmpeg encodes to Opus itself**
(`-c:a libopus`, fast C implementation) and hands `@discordjs/voice`
already-encoded Ogg/Opus — see `media/ffmpeg.ts` and
`player/guildPlayer.ts`. No Opus codec library is needed in JS at all,
native or otherwise. `package.json` sets `"trustedDependencies": []` so
Bun never runs `@discordjs/voice`'s optional `@discordjs/opus`
dependency's native-build install script (which this project doesn't use
anyway) — if you see a `node-pre-gyp`/`node-gyp` error mentioning
`@discordjs/opus` during `bun install`, delete `node_modules` and
`bun.lock`/`bun.lockb` and reinstall; it means a stale lockfile is pinning
it from before this was added.

### Bundling ffmpeg/ffprobe/yt-dlp

`core/binaries.ts` resolves each of these by looking **next to the app**
first — the project root when running `bun run dev`/`bun run start`, or
whatever folder the compiled executable is sitting in in production —
before falling back to PATH. Filenames are platform-aware (`ffmpeg.exe` on
Windows, `ffmpeg` elsewhere, etc.).

This matters because a compiled standalone executable
(`bun build --compile`) only bundles JS/TS. A binary resolved from
`node_modules` at runtime — which is how the `ffmpeg-static`/`ffprobe-static`
npm packages this project used to depend on actually work — is NOT
embedded into that executable, and silently breaks the moment you ship
just the `.exe` on its own without its `node_modules` folder alongside it.
The fix is shipping plain binary files next to the executable instead of
relying on npm packages to provide them at runtime. The end result is
meant to be a folder like this, fully self-contained and drop-in-runnable:

```
bot-server.exe
DISCORD_TOKEN.env
ffmpeg.exe
ffprobe.exe
yt-dlp.exe
```

(non-Windows: `bot-server`, `ffmpeg`, `ffprobe`, `yt-dlp` — no `.exe`.)

**Where to get each binary:**
- `ffmpeg`/`ffprobe`: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) (Windows/Linux) or [evermeet.cx](https://evermeet.cx/ffmpeg/) (macOS) — grab a static/shared build, pull `ffmpeg`/`ffprobe` out of its `bin/` folder.
- `yt-dlp`: the platform binary from [yt-dlp's releases page](https://github.com/yt-dlp/yt-dlp/releases/latest) (`yt-dlp.exe`, `yt-dlp_macos`, `yt-dlp_linux`, etc. — rename to `yt-dlp`/`yt-dlp.exe` as appropriate).

During **development**, if you don't want to copy these into the project
root, just have them on PATH instead — `core/binaries.ts` falls back to
the bare command name, so a system install keeps working exactly like
before. The next-to-the-app resolution only becomes necessary once you're
distributing a compiled executable on its own.

The Docker build flow below (`vendor/<platform>/`) automates copying these
into each platform's output folder — see there for the mechanics.



```bash
bun install
```

Create a `DISCORD_TOKEN.env` file next to `src/` (or next to the compiled
binary, once you build one) containing:

```
DISCORD_TOKEN=your.bot.token
```

Then just run it — no env var needed:

```bash
bun run dev
```

**This is the intended way to hand the same built binary to multiple
users/deployments without rebuilding**: the token lives only in
`DISCORD_TOKEN.env`, which is never written into `config.json` and never
baked into the binary. Give someone `bot-server` (or `bot-server.exe`)
plus instructions to drop their own `DISCORD_TOKEN.env` next to it, and
that's the whole setup — swapping bots/tokens is just swapping that one
file. `DISCORD_TOKEN.env` accepts either `DISCORD_TOKEN=...` on its own
line (blank lines/`#` comments OK) or just the bare token as the file's
entire contents, whichever's easier.

If you'd rather not use a file, `DISCORD_TOKEN` as an actual environment
variable still works and takes priority over the file:

```bash
DISCORD_TOKEN=your.bot.token bun run dev
```

On first run this also writes `config.json` (port, frontendOrigin,
musicFolder — everything except the token) next to the project/binary.
Subsequent runs read that back automatically.

The console prints a **local pairing token** on every start — paste that
into the companion web UI to authenticate its API/WS requests
(`X-Local-Token` header / `{"type":"auth","token":"..."}` WS message).

## Config

Edit `config.json`:

```json
{
  "port": 21000,
  "frontendOrigin": "https://your-app.vercel.app",
  "musicFolder": "/path/to/your/mp3s"
}
```

- `frontendOrigin` — the *exact* origin allowed by CORS. Must match the
  deployed web UI's origin exactly (no wildcards).
- `musicFolder` — optional; enables `POST /api/library/scan` for local
  files.

## Register slash commands (one-time, or after changing command definitions)

```ts
import { registerGlobalSlashCommands } from "./src/bot/commands";
await registerGlobalSlashCommands("<application-id>", "<bot-token>");
```

Global command registration can take up to an hour to propagate; there's
no dedicated script wired up yet — run the above via `bun run -e` or a
one-off script when you're ready.

## Building a frontend

See **`doc.md`** for the full REST + WebSocket API contract (auth flow,
every endpoint, request/response shapes, event payloads).

## Project layout

```
src/
  core/     config, logger, event bus, local-token auth — no dependencies on anything else
  db/       SQLite connection, migrations, repositories
  media/    yt-dlp / ffmpeg / local-file resolution and streaming
  player/   per-guild playback state machine (wraps @discordjs/voice)
  bot/      discord.js client + slash commands
  api/      Bun.serve HTTP router + middleware + routes
  ws/       WebSocket bridge from the internal event bus to UI clients
  index.ts  startup order: config -> db -> token -> bot -> server
```

Everything cross-module talks through `core/bus.ts`'s typed event bus —
e.g. `player/` emits `track.started`, `ws/` relays it to subscribed UI
tabs. Adding a feature that reacts to playback events (lyrics, scrobbling,
whatever) means subscribing to the bus, not reaching into `player/`.

## Run

```bash
bun run dev     # watch mode
bun run start   # no watch
```

## Build a standalone executable

**Recommended: via Docker**, which cross-compiles every platform's
executable inside Linux regardless of your host OS — this sidesteps a
`bun build --compile` bug some Windows setups hit natively (`failed to
copy bun executable into temporary file: ENOENT`), since the actual
compile step never runs on Windows at all, only the cross-compiled
*output* targets it.

```bash
bun run build:docker
# or directly: bash scripts/build-all-docker.sh   (Mac/Linux/WSL)
#          or: .\scripts\build-all-docker.ps1      (native Windows + Docker Desktop)
```

Requires Docker with BuildKit (default in current Docker Desktop). This
builds all five targets (`windows-x64`, `linux-x64`, `linux-arm64`,
`macos-x64`, `macos-arm64`) and packages each into
`dist/discord-music-bot-<platform>.zip` — a starter `DISCORD_TOKEN.env` is
generated automatically, and `ffmpeg`/`ffprobe`/`yt-dlp` are copied in
automatically *if* you've placed them in `vendor/<platform>/` first (see
"Bundling ffmpeg/ffprobe/yt-dlp" above for where to download each one).
Without a `vendor/<platform>/` folder, that platform's zip just won't
include them — still useful for testing, not yet a finished handoff.

The underlying pieces, if you want to drive them yourself: `Dockerfile.build`
does the actual cross-compilation; `docker build --target export --output
type=local,dest=./dist -f Dockerfile.build .` alone (no wrapper script)
gets you the raw executables in `dist/<platform>/` without the
zip/vendor/token-file packaging step.

**Alternative: compile natively with Bun directly** (works fine on
Mac/Linux; on Windows, hits the ENOENT issue above for some people):

```bash
bun run build            # current platform
bun run build:win
bun run build:mac-arm
bun run build:linux-x64
# ...etc, see package.json scripts
```

Either way, the compiled binary is self-contained (Bun embeds the
runtime) apart from `ffmpeg`/`ffprobe`/`yt-dlp` sitting next to it (see
above); `config.json`, `DISCORD_TOKEN.env`, `data.db`, `cache/`, and
`logs/` are all created next to wherever the binary is run from.

### Another compiled-executable pitfall (fixed): migrations

Same category of bug as the ffmpeg-static one above: `db/index.ts` used
to find its `.sql` migration files by scanning a directory
(`readdirSync`) relative to `import.meta.url` at runtime. That works in
`bun run dev` but breaks in a compiled executable — there's no real
directory there anymore, just bundled module code — and shows up as
`ENOENT: no such file or directory, scandir '...\migrations'` on startup.
Fixed by statically importing each migration's SQL as text
(`db/migrations/index.ts`, using Bun's `{ type: "text" }` import
attribute) instead of scanning for it. **If you add a new migration**,
add both the `NNN_*.sql` file and a corresponding static import + entry in
`db/migrations/index.ts` — a file dropped into that folder without an
entry there will silently never run once compiled, even though it'd work
fine under `bun run dev`.

### If the window closes instantly on error (Windows)

Two things are in place for this:

- Any fatal startup error now keeps the process alive and prints
  "Press Enter to close this window..." before actually exiting
  (`core/pauseBeforeExit.ts`, wired into `index.ts`'s top-level error
  handler) — this only engages when stdin is an interactive terminal, so
  it won't hang a non-interactive run (a process manager, CI, etc.).
- `windows/run.bat` is a launcher that calls `bot-server.exe` and
  `pause`s if it exits with an error, independent of the above. It's
  included automatically in the Windows zip the Docker build script
  produces (`dist/discord-music-bot-windows-x64.zip`) — double-click
  `run.bat` instead of `bot-server.exe` directly for this to help.

On the **"closing the window should stop the bot, not leave it eating
memory"** half: every `ffmpeg`/`yt-dlp` subprocess this app spawns is now
tracked (`core/processRegistry.ts`) and explicitly killed on graceful
shutdown (Ctrl+C, or a `SIGTERM`). Worth being direct about the limit
here: closing a console window on Windows terminates the process abruptly
without giving Node/Bun a chance to run any shutdown code first — Windows
normally cascades that closure to attached child processes on its own
(so `ffmpeg`/`yt-dlp` dying with the window is the expected default
behavior already), but if you ever do see one lingering in Task Manager
after closing the window, **Ctrl+C first, then close the window**
guarantees the tracked-process cleanup above actually runs, in a way that
clicking the window's X button can't guarantee.

## What's scaffolded vs. what's a stub

Implemented and wired end-to-end:
- Config/logger/event-bus/auth core
- SQLite schema + migrations + repositories (tracks, queue, playlists, settings)
- REST routes for queue, player control (including joining a voice channel
  by id — `POST /api/player/:guildId/join` — so the bot is fully operable
  from a UI with no slash commands needed; jumping to an arbitrary
  queue position via `POST /api/player/:guildId/play` with `{ "position" }`
  or by track id via `POST /api/player/:guildId/play-track`; playing a
  track that ISN'T in the queue at all, without touching the queue's
  order, via `POST /api/player/:guildId/play-adhoc`; and toggling
  repeat-current-track via `POST /api/player/:guildId/repeat`), settings,
  guilds/channels, playlists, library (including
  `POST /api/library/download` and `POST /api/library/:trackId` for
  downloading/caching a track into the library **without** touching any
  guild's queue — see doc.md)
- WebSocket bridge relaying bus events to authenticated, per-guild-subscribed
  clients, including live `player.positionChanged` ticks (~1/sec while
  playing) and `voice.connected`/`voice.disconnected` reflecting the
  *actual* Discord voice state — the latter fires on kicks, Discord-side
  drops, or anything else that ends the voice connection, not just an
  explicit `leave()` call (see `GuildPlayer.wireConnectionEvents`)
- **Download-once caching**: the first time a YouTube/SoundCloud URL is
  queued (or sent to `POST /api/library/download`), `media/resolver.ts`
  downloads and extracts it to Opus (`yt-dlp -x --audio-format opus`)
  under `cache/`, in the background. Every subsequent play — this session,
  next session, anyone else's queue — reads straight from that cached file
  instead of hitting the source again. Concurrent requests for the same
  still-downloading track share one in-flight download rather than
  double-fetching. Cache eviction (`media/cache.ts`) reclaims space from
  the least-recently-played cached tracks once `cacheDirMaxBytes` is
  exceeded; local files (`sourceType: "local"`) are never evicted.
- Local file scanning via ffprobe with bounded concurrency
- Minimal Discord slash commands (`/play`, `/skip`, `/pause`, `/resume`,
  `/queue`, `/leave`) sharing the same player/manager and media/resolver as
  the REST API — intentionally left at this baseline, no further slash
  command work planned; voice-channel joining and everything else is a UI/API
  concern, not a slash-command one.
- Heavy `info`-level logging through the entire playback start path
  (`api/player` and `player` loggers): every route hit, every stage of
  `GuildPlayer.playCurrent()` (download/cache resolved → ffmpeg piped →
  `AudioResource` created → `AudioPlayer.play()` called → `track.started`
  emitted), and every failure point, specifically so "why didn't it play"
  is answerable from the console/log file alone without guessing whether
  it's a frontend request problem or a backend one.

**Bug fixed**: `openPlaybackStream()` was handing `createAudioResource()` a
Web `ReadableStream` (what `Bun.spawn()`'s `stdout` actually is) instead of
a Node.js `Readable`, which `@discordjs/voice` requires. It type-checked
fine and produced no error — it just silently never streamed audio. Now
converted via `Readable.fromWeb()`. If tracks download successfully but
still don't play, check the logs for whether `AudioPlayer.play()` is even
being reached (see above) before assuming it's this bug again.

Left as explicit follow-ups (marked with comments in code):
- `GuildPlayer.seek()` — needs ffmpeg re-spawn with `-ss`, not implemented
- A one-off script/route for slash command (re-)registration
- First play of an uncached track waits for the full download rather than
  streaming live — usually hidden by the background pre-download that
  starts the moment a track is queued, but a track skipped-to immediately
  after queueing can still stall briefly on the download.
- `playCurrent()` retries through consecutive queue items on failure but
  gives up after 3 in a row (`MAX_CONSECUTIVE_FAILURES` in `guildPlayer.ts`)
  rather than looping the whole queue — deliberate, to avoid a fully-broken
  queue spinning forever, but worth knowing about if you see playback stop
  after several failures.
- `setVolume()` applies to the *next* track that starts, not one already
  playing — since ffmpeg now encodes straight to Opus (see the Opus note
  above), there's no PCM stage left downstream for a live gain transform to
  hook into; volume is baked into that track's ffmpeg spawn instead.
