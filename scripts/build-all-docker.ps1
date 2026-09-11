# Builds standalone executables for every platform via Docker (see
# Dockerfile.build), then packages each into a drop-in-and-run folder:
#   bot-server(.exe)
#   DISCORD_TOKEN.env
#   ffmpeg(.exe) / ffprobe(.exe) / yt-dlp(.exe)   <- if present in vendor\<platform>\
# zipped up as dist\discord-music-bot-<platform>.zip.
#
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

    # Copies in ffmpeg/ffprobe/yt-dlp IF you've placed them in
    # vendor\<platform>\ first — see README's "Bundling ffmpeg/ffprobe/yt-dlp"
    # section for exactly where to download each one per platform.
    $vendorDir = "vendor/$platform"
    if (Test-Path $vendorDir) {
        Copy-Item "$vendorDir/*" $outDir -Force
    } else {
        Write-Host "  (no vendor/$platform/ found - shipping without ffmpeg/ffprobe/yt-dlp; see README)"
    }

    $tokenFile = "$outDir/DISCORD_TOKEN.env"
    if (-not (Test-Path $tokenFile)) {
        "DISCORD_TOKEN=ENTER_YOUR_TOKEN" | Out-File -Encoding ascii -FilePath $tokenFile
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
