import { join } from "node:path";
import { FFMPEG_PATH, YTDLP_PATH } from "./binaries";
import { APP_DIR } from "./config";
import { promptUser } from "./prompt";
import { createLogger } from "./logger";

const log = createLogger("core/versionChecker");

export interface BinaryVersionInfo {
  name: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  canAutoUpdate: boolean;
}

export interface SystemUpdatesStatus {
  bot?: BinaryVersionInfo;
  ytdlp: BinaryVersionInfo;
  ffmpeg: BinaryVersionInfo;
  checkedAt: number;
}

let cachedStatus: SystemUpdatesStatus | null = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function getCurrentYtDlpVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn([YTDLP_PATH, "--version"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim() || null;
  } catch (err) {
    log.error("failed to get yt-dlp version", { error: String(err) });
    return null;
  }
}

export async function getCurrentFFmpegVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn([FFMPEG_PATH, "-version"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const firstLine = stdout.split("\n")[0] || "";
    // e.g. "ffmpeg version n9.0.1-27-g9b0578816c-20260910 Copyright..." -> "9.0.1"
    const match = firstLine.match(/version\s+(?:n)?([0-9]+(?:\.[0-9]+)*)/i);
    if (match?.[1]) return match[1];
    const rawMatch = firstLine.match(/version\s+([^\s]+)/i);
    return rawMatch?.[1] || firstLine.slice(0, 30).trim() || null;
  } catch (err) {
    log.error("failed to get ffmpeg version", { error: String(err) });
    return null;
  }
}

export async function getLatestYtDlpVersion(): Promise<{ version: string | null; url: string }> {
  const fallbackUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest";
  try {
    const res = await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", {
      headers: { "User-Agent": "discord-music-bot" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { version: null, url: fallbackUrl };
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const version = data.tag_name ? data.tag_name.replace(/^v/, "") : null;
    return { version, url: data.html_url || fallbackUrl };
  } catch (err) {
    log.warn("failed to fetch latest yt-dlp release", { error: String(err) });
    return { version: null, url: fallbackUrl };
  }
}

export async function getLatestFFmpegVersion(): Promise<{ version: string | null; url: string }> {
  const fallbackUrl = "https://www.gyan.dev/ffmpeg/builds/";
  try {
    const res = await fetch("https://www.gyan.dev/ffmpeg/builds/release-version", {
      headers: { "User-Agent": "discord-music-bot" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { version: null, url: fallbackUrl };
    const text = (await res.text()).trim();
    return { version: text || null, url: fallbackUrl };
  } catch (err) {
    log.warn("failed to fetch latest ffmpeg release", { error: String(err) });
    return { version: null, url: fallbackUrl };
  }
}

function compareVersions(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const cleanCurr = current.replace(/^n/, "").trim();
  const cleanLate = latest.replace(/^n/, "").trim();
  if (cleanCurr === cleanLate) return false;

  // Compare semantic/date parts if numeric
  const p1 = cleanCurr.split(/[.-]/).map((p) => parseInt(p, 10));
  const p2 = cleanLate.split(/[.-]/).map((p) => parseInt(p, 10));
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] ?? 0;
    const num2 = p2[i] ?? 0;
    if (isNaN(num1) || isNaN(num2)) continue;
    if (num2 > num1) return true;
    if (num1 > num2) return false;
  }
  return false;
}

export const BOT_VERSION = "0.2.0";
export const GITHUB_REPO = "Marselchi/discord-music-bot";

export async function getLatestBotVersion(): Promise<{ version: string | null; url: string }> {
  const fallbackUrl = `https://github.com/${GITHUB_REPO}/releases/latest`;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { "User-Agent": "discord-music-bot" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return { version: null, url: fallbackUrl };
    const release = (await res.json()) as any;
    const latestTag = release.tag_name ? release.tag_name.replace(/^v/, "") : null;
    return { version: latestTag, url: release.html_url || fallbackUrl };
  } catch (err) {
    log.warn("failed to fetch latest bot release", { error: String(err) });
    return { version: null, url: fallbackUrl };
  }
}

export async function checkSystemUpdates(force = false): Promise<SystemUpdatesStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - lastCheckTime < CACHE_TTL_MS) {
    return cachedStatus;
  }

  const [currentYtDlp, currentFFmpeg, latestYtDlp, latestFFmpeg, latestBot] = await Promise.all([
    getCurrentYtDlpVersion(),
    getCurrentFFmpegVersion(),
    getLatestYtDlpVersion(),
    getLatestFFmpegVersion(),
    getLatestBotVersion(),
  ]);

  const ytdlpUpdate = compareVersions(currentYtDlp, latestYtDlp.version);
  const ffmpegUpdate = compareVersions(currentFFmpeg, latestFFmpeg.version);
  const botUpdate = compareVersions(BOT_VERSION, latestBot.version);

  cachedStatus = {
    bot: {
      name: "discord-music-bot",
      current: BOT_VERSION,
      latest: latestBot.version,
      updateAvailable: botUpdate,
      releaseUrl: latestBot.url,
      canAutoUpdate: false,
    },
    ytdlp: {
      name: "yt-dlp",
      current: currentYtDlp,
      latest: latestYtDlp.version,
      updateAvailable: ytdlpUpdate,
      releaseUrl: latestYtDlp.url,
      canAutoUpdate: true,
    },
    ffmpeg: {
      name: "ffmpeg",
      current: currentFFmpeg,
      latest: latestFFmpeg.version,
      updateAvailable: ffmpegUpdate,
      releaseUrl: latestFFmpeg.url,
      canAutoUpdate: false,
    },
    checkedAt: now,
  };
  lastCheckTime = now;
  return cachedStatus;
}

export async function runYtDlpAutoUpdate(): Promise<{ success: boolean; output: string }> {
  try {
    const proc = Bun.spawn([YTDLP_PATH, "--update"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const output = (stdout + "\n" + stderr).trim();
    // Invalidate cached status so fresh version is reported
    cachedStatus = null;
    return { success: exitCode === 0, output };
  } catch (err) {
    return { success: false, output: (err as Error).message };
  }
}

export async function checkBotUpdateOnStartup(): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { "User-Agent": "discord-music-bot" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return false;
    const release = (await res.json()) as any;
    const latestTag = release.tag_name ? release.tag_name.replace(/^v/, "") : null;
    if (!latestTag) return false;

    if (compareVersions(BOT_VERSION, latestTag)) {
      console.log("\n==============================================================");
      console.log(`  Update available for Discord Music Bot: v${latestTag} (current: v${BOT_VERSION})`);
      console.log(`  Release page: ${release.html_url || `https://github.com/${GITHUB_REPO}/releases`}`);
      console.log("==============================================================");

      const answer = await promptUser(
        "Do you want to update now? (y/N) [default: N in 10s]: ",
        "n",
        10_000
      );

      if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
        console.log("[update] Fetching latest release asset for your system...");
        const targetPlatform =
          process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
        const asset = release.assets?.find(
          (a: any) => a.name && (a.name.includes(targetPlatform) || a.name.includes(process.platform))
        );

        if (asset && asset.browser_download_url) {
          console.log(`[update] Downloading ${asset.name}...`);
          const dlRes = await fetch(asset.browser_download_url, {
            headers: { "User-Agent": "discord-music-bot" },
          });
          if (dlRes.ok) {
            const buf = await dlRes.arrayBuffer();
            const tempFile = join(APP_DIR, asset.name);
            await Bun.write(tempFile, buf);

            console.log("[update] Extracting update...");
            if (process.platform === "win32") {
              await Bun.spawn([
                "powershell",
                "-NoProfile",
                "-Command",
                `Expand-Archive -Path '${tempFile}' -DestinationPath '${APP_DIR}/update-temp' -Force; ` +
                  `if (Test-Path '${APP_DIR}/update-temp/windows-x64/bot-server.exe') { Copy-Item -Force '${APP_DIR}/update-temp/windows-x64/bot-server.exe' '${APP_DIR}/bot-server-update.exe' } ` +
                  `elseif (Test-Path '${APP_DIR}/update-temp/bot-server.exe') { Copy-Item -Force '${APP_DIR}/update-temp/bot-server.exe' '${APP_DIR}/bot-server-update.exe' }; ` +
                  `Remove-Item -Recurse -Force '${APP_DIR}/update-temp'; Remove-Item -Force '${tempFile}'`,
              ]).exited;
            } else {
              await Bun.spawn([
                "sh",
                "-c",
                `tar -xzf "${tempFile}" -C "${APP_DIR}" bot-server && rm -f "${tempFile}"`,
              ]).exited;
            }

            console.log("\n[update] Update downloaded successfully!");
            console.log("[update] Restarting with new version...\n");
            process.exit(0);
          }
        } else {
          console.log("[update] No matching binary asset found for your platform in this release.");
          console.log(`[update] You can download it manually from: ${release.html_url}\n`);
        }
      }
    }
  } catch (err) {
    log.debug("startup bot update check skipped or failed", { error: String(err) });
  }
  return false;
}

