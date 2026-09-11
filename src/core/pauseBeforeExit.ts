/**
 * Waits for a keypress before returning, so a fatal error is actually
 * readable instead of the window vanishing instantly — which is exactly
 * what happens on Windows when a console is auto-created for a
 * double-clicked .exe and the process then exits with nothing holding it
 * open. Skipped when stdin isn't an interactive terminal (piped output, a
 * process manager, CI, systemd, etc.) so this never hangs a non-interactive
 * run waiting for input that will never come.
 */
export async function pauseBeforeExit(): Promise<void> {
  if (!process.stdin.isTTY) return;
  console.log("\nPress Enter to close this window...");
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}
