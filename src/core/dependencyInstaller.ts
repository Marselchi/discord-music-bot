import { existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config";
import { FFMPEG_PATH, YTDLP_PATH } from "./binaries";
import { promptUser } from "./prompt";
import { createLogger } from "./logger";

const log = createLogger("core/dependencyInstaller");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

export async function checkDependenciesInstalled(): Promise<{
  ytdlp: boolean;
  ffmpeg: boolean;
}> {
  let ytdlpOk = false;
  let ffmpegOk = false;

  try {
    const proc = Bun.spawn([YTDLP_PATH, "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    ytdlpOk = code === 0;
  } catch {
    ytdlpOk = false;
  }

  try {
    const proc = Bun.spawn([FFMPEG_PATH, "-version"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    ffmpegOk = code === 0;
  } catch {
    ffmpegOk = false;
  }

  return { ytdlp: ytdlpOk, ffmpeg: ffmpegOk };
}

export async function installYtDlp(onProgress?: (msg: string) => void): Promise<string> {
  onProgress?.("Downloading yt-dlp...");
  log.info("installing yt-dlp");

  let downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
  if (process.platform === "win32") {
    downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  } else if (process.platform === "darwin") {
    downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  }

  const targetPath = join(APP_DIR, `yt-dlp${EXE_SUFFIX}`);
  const res = await fetch(downloadUrl, { headers: { "User-Agent": "discord-music-bot" } });
  if (!res.ok) {
    throw new Error(`Failed to download yt-dlp from ${downloadUrl}: ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await Bun.write(targetPath, arrayBuffer);

  if (process.platform !== "win32") {
    chmodSync(targetPath, 0o755);
  }

  onProgress?.("yt-dlp installed successfully.");
  log.info("yt-dlp installed", { targetPath });
  return targetPath;
}

export async function installFFmpeg(onProgress?: (msg: string) => void): Promise<void> {
  onProgress?.("Downloading ffmpeg...");
  log.info("installing ffmpeg");

  if (process.platform === "win32") {
    // On Windows, Gyan.dev essentials zip contains ffmpeg.exe and ffprobe.exe
    const zipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    const tempZip = join(APP_DIR, "ffmpeg-temp.zip");

    const res = await fetch(zipUrl, { headers: { "User-Agent": "discord-music-bot" } });
    if (!res.ok) throw new Error(`Failed to download ffmpeg: ${res.statusText}`);
    await Bun.write(tempZip, await res.arrayBuffer());

    onProgress?.("Extracting ffmpeg...");
    // Use powershell to extract
    const proc = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${tempZip}' -DestinationPath '${APP_DIR}/ffmpeg-temp' -Force; ` +
          `Get-ChildItem -Path '${APP_DIR}/ffmpeg-temp' -Recurse -Filter 'ffmpeg.exe' | Copy-Item -Destination '${APP_DIR}/ffmpeg.exe'; ` +
          `Get-ChildItem -Path '${APP_DIR}/ffmpeg-temp' -Recurse -Filter 'ffprobe.exe' | Copy-Item -Destination '${APP_DIR}/ffprobe.exe'; ` +
          `Remove-Item -Recurse -Force '${APP_DIR}/ffmpeg-temp'; ` +
          `Remove-Item -Force '${tempZip}'`,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to extract ffmpeg on Windows (code ${exitCode})`);
    }
  } else {
    // On Linux / macOS, advise user or download static binary
    throw new Error(
      `Automatic ffmpeg install on ${process.platform} is not automated. Please install ffmpeg via your system package manager (e.g. brew install ffmpeg / sudo apt install ffmpeg).`
    );
  }

  onProgress?.("ffmpeg installed successfully.");
  log.info("ffmpeg installed");
}

export async function promptInstallDependenciesOnStartup(): Promise<void> {
  const status = await checkDependenciesInstalled();
  const missing: string[] = [];
  if (!status.ytdlp) missing.push("yt-dlp");
  if (!status.ffmpeg) missing.push("ffmpeg");

  if (missing.length === 0) return;

  console.log("\n==============================================================");
  console.log(`  [Media] Missing required tool(s): ${missing.join(", ")}`);
  console.log("  Music playback & download requires yt-dlp and ffmpeg.");
  console.log("==============================================================");

  const answer = await promptUser(
    `Would you like to install ${missing.join(" and ")} automatically now? (Y/n) [default: Y in 10s]: `,
    "y",
    10_000
  );

  if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
    console.log("[installer] Starting automatic download...");
    try {
      if (!status.ytdlp) {
        await installYtDlp((msg) => console.log(`[installer] ${msg}`));
      }
      if (!status.ffmpeg && process.platform === "win32") {
        await installFFmpeg((msg) => console.log(`[installer] ${msg}`));
      }
      console.log("[installer] All missing components installed successfully!\n");
    } catch (err) {
      console.error(`[installer] Error installing components: ${(err as Error).message}\n`);
    }
  } else {
    console.log("[installer] Skipping dependency installation. Warning: Audio playback may fail.\n");
  }
}
