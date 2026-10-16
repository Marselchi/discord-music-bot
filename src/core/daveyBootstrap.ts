import { join } from "node:path";
import { existsSync } from "node:fs";
import { APP_DIR } from "./config";

// Setup and verify native binding for Discord voice end-to-end encryption (DAVE)
if (process.platform === "win32") {
  const localBinding = join(APP_DIR, "davey.win32-x64-msvc.node");

  if (!existsSync(localBinding)) {
    try {
      console.log("[voice] Downloading missing Discord voice native binding (davey)...");
      const res = await fetch(
        "https://registry.npmjs.org/@snazzah/davey-win32-x64-msvc/-/davey-win32-x64-msvc-0.1.12.tgz",
        { headers: { "User-Agent": "discord-music-bot" } }
      );
      if (res.ok) {
        const tgzBuf = await res.arrayBuffer();
        const tempTgz = join(APP_DIR, "davey-temp.tgz");
        await Bun.write(tempTgz, tgzBuf);

        // Extract package/davey.win32-x64-msvc.node
        await Bun.spawn([
          "tar",
          "-xzf",
          tempTgz,
          "-C",
          APP_DIR,
          "--strip-components=1",
          "package/davey.win32-x64-msvc.node",
        ]).exited;

        try {
          await Bun.spawn([
            "powershell",
            "-NoProfile",
            "-Command",
            `Remove-Item -Force '${tempTgz}'`,
          ]).exited;
        } catch {
          // ignore cleanup error
        }

        console.log("[voice] Discord voice native binding installed successfully.");
      }
    } catch (err) {
      console.warn("[voice] Warning: Failed to auto-download voice native binding:", err);
    }
  }

  if (existsSync(localBinding)) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = localBinding;
  }
}
