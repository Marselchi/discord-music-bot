import { Client, GatewayIntentBits } from "discord.js";
import { createLogger } from "../core/logger";
import { registerCommands } from "./commands";

const log = createLogger("bot");

let client: Client | null = null;

export function getBotClient(): Client {
  if (!client) throw new Error("Bot client not initialized — call startBot() first, from index.ts");
  return client;
}

export async function startBot(token: string): Promise<Client> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", (c) => {
    log.info("bot logged in", { tag: c.user.tag, guildCount: c.guilds.cache.size });
  });

  client.on("error", (err) => {
    log.error("discord client error", { error: String(err) });
  });

  registerCommands(client);

  await client.login(token);
  return client;
}
