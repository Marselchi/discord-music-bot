#!/usr/bin/env bash
# Builds standalone executables for every platform via Docker (see
# Dockerfile.build), then packages each into a lightweight release archive:
#   bot-server(.exe)
#   run.bat (Windows only)
#
# Media dependencies (ffmpeg, yt-dlp) and DISCORD_TOKEN are NOT packaged.
# The bot prompts for token and offers 1-click dependency install on first launch.
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

  if [ "$platform" = "windows-x64" ]; then
    cp windows/run.bat "$outdir/"
  fi

  (cd dist && tar -czf "discord-music-bot-$platform.tar.gz" "$platform")
  echo "Built dist/discord-music-bot-$platform.tar.gz"
done

echo "Done. See dist/ for per-platform archives."
