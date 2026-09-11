#!/usr/bin/env bash
# Builds standalone executables for every platform via Docker (see
# Dockerfile.build), then packages each into a drop-in-and-run folder:
#   bot-server(.exe)
#   DISCORD_TOKEN.env
#   ffmpeg(.exe) / ffprobe(.exe) / yt-dlp(.exe)   <- if present in vendor/<platform>/
# zipped up as dist/discord-music-bot-<platform>.zip.
#
# Run from the project root: bash scripts/build-all-docker.sh
# (or `bun run build:docker`)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building all platform executables via Docker (bun cross-compiles; nothing runs natively on Windows)..."
docker build --target export --output type=local,dest=./dist -f Dockerfile.build .

PLATFORMS=(windows-x64 linux-x64 linux-arm64 macos-x64 macos-arm64)

for platform in "${PLATFORMS[@]}"; do
  outdir="dist/$platform"
  if [ ! -d "$outdir" ]; then
    echo "Skipping $platform - no build output found"
    continue
  fi

  # Copies in ffmpeg/ffprobe/yt-dlp IF you've placed them in
  # vendor/<platform>/ first — see README's "Bundling ffmpeg/ffprobe/yt-dlp"
  # section for exactly where to download each one per platform. Not
  # fetched automatically here: official download URLs/archive layouts for
  # these change often enough that hardcoding them in this script would go
  # stale silently instead of failing loudly.
  if [ -d "vendor/$platform" ]; then
    cp -n "vendor/$platform"/* "$outdir/" 2>/dev/null || true
  else
    echo "  (no vendor/$platform/ found - shipping without ffmpeg/ffprobe/yt-dlp; see README)"
  fi

  if [ ! -f "$outdir/DISCORD_TOKEN.env" ]; then
    echo "DISCORD_TOKEN=ENTER_YOUR_TOKEN" > "$outdir/DISCORD_TOKEN.env"
  fi

  if [ "$platform" = "windows-x64" ]; then
    cp windows/run.bat "$outdir/"
  fi

  (cd dist && tar -czf "discord-music-bot-$platform.tar.gz" "$platform")
  echo "Built dist/discord-music-bot-$platform.tar.gz"
done

echo "Done. See dist/ for per-platform zips."
