import * as readline from "node:readline";

/**
 * Prompts the user in the terminal with an optional timeout.
 * If stdin is not a TTY or the timeout expires, returns defaultValue.
 */
export async function promptUser(
  questionText: string,
  defaultValue = "",
  timeoutMs = 10_000
): Promise<string> {
  if (!process.stdin.isTTY) {
    return defaultValue;
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let timer: any = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        rl.close();
        console.log(`\n[prompt] Timeout reached (${timeoutMs / 1000}s), using default.`);
        resolve(defaultValue);
      }, timeoutMs);
    }

    rl.question(questionText, (answer) => {
      if (timer) clearTimeout(timer);
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue);
    });
  });
}

/**
 * Prompts for a secret/token (does not timeout).
 */
export async function promptForToken(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Cannot prompt for token: stdin is not a TTY.");
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
