import { loadConfig } from "./core/config";
import { getOrCreateLocalToken } from "./core/auth";
import { createLogger } from "./core/logger";
import { pauseBeforeExit } from "./core/pauseBeforeExit";
import { killAllTrackedProcesses } from "./core/processRegistry";
import { initDb } from "./db/index";
import { startBot } from "./bot/client";
import { startServer } from "./api/server";
import { checkBotUpdateOnStartup } from "./core/versionChecker";
import { promptInstallDependenciesOnStartup } from "./core/dependencyInstaller";

const log = createLogger("index");

async function main() {
  // Check for new releases on startup and prompt in console
  await checkBotUpdateOnStartup();

  // Check for missing ffmpeg / yt-dlp and prompt to install if needed
  await promptInstallDependenciesOnStartup();

  const config = await loadConfig();
  initDb();
  const localToken = getOrCreateLocalToken();

  log.info("starting up", { port: config.port, hasMusicFolder: !!config.musicFolder });

  await startBot(config.discordToken!);
  const server = startServer(config, localToken);

  console.log("\n──────────────────────────────────────────────");
  console.log(`  Local pairing token: ${localToken}`);
  console.log(`  Paste this into the web UI to connect.`);
  console.log(`  Server: http://localhost:${server.port}`);
  console.log("──────────────────────────────────────────────\n");

  process.on("SIGINT", () => shutdown(server));
  process.on("SIGTERM", () => shutdown(server));
}

function shutdown(server: { stop: () => void }) {
  log.info("shutting down");
  killAllTrackedProcesses();
  server.stop();
  process.exit(0);
}

main().catch(async (err) => {
  log.error("fatal startup error", { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  console.error("\nThe bot failed to start — see the error above.");
  await pauseBeforeExit();
  process.exit(1);
});

