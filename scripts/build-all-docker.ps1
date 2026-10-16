# Builds standalone executables for every platform via Docker (see
# Dockerfile.build), then packages each into a lightweight release archive:
#   bot-server(.exe)
#   run.bat (Windows only)
#
# Media dependencies (ffmpeg, yt-dlp) and DISCORD_TOKEN are NOT packaged.
# Run from the project root in PowerShell: .\scripts\build-all-docker.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "Building all platform executables via Docker (bun cross-compiles; nothing runs natively on Windows)..."
docker build --target export --output type=local,dest=./dist -f Dockerfile.build .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

$platforms = "windows-x64", "linux-x64", "linux-arm64", "macos-x64", "macos-arm64"

foreach ($platform in $platforms) {
    $outDir = "dist/$platform"
    if (-not (Test-Path $outDir)) {
        Write-Host "Skipping $platform - no build output found"
        continue
    }

    if ($platform -eq "windows-x64") {
        Copy-Item "windows/run.bat" $outDir -Force
    }

    $zipPath = "dist/discord-music-bot-$platform.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath }
    Compress-Archive -Path "$outDir/*" -DestinationPath $zipPath

    Write-Host "Built $zipPath"
}

Write-Host "Done. See dist/ for per-platform zips."
