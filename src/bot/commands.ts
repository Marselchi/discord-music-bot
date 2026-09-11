import { Client, SlashCommandBuilder, ChatInputCommandInteraction, REST, Routes } from "discord.js";
import { getOrCreatePlayer } from "../player/manager";
import { resolveInput } from "../media/resolver";
import * as queueRepo from "../db/repositories/queue";
import { bus } from "../core/bus";
import { createLogger } from "../core/logger";

const log = createLogger("bot/commands");

/**
 * Every command handler here does exactly what the equivalent REST route
 * does — resolve/enqueue/control through the same player/manager and
 * media/resolver — so Discord slash commands and the web UI are two
 * front-ends over one backend, never two implementations (see doc §6).
 */
const definitions = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or add it to the queue")
    .addStringOption((opt) => opt.setName("query").setDescription("URL or search text").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the current queue"),
  new SlashCommandBuilder().setName("leave").setDescription("Disconnect from voice"),
];

export async function registerGlobalSlashCommands(appId: string, token: string): Promise<void> {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationCommands(appId), { body: definitions.map((d) => d.toJSON()) });
  log.info("registered global slash commands", { count: definitions.length });
}

export function registerCommands(client: Client): void {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await dispatch(interaction);
    } catch (err) {
      log.error("command handler threw", { command: interaction.commandName, error: String(err) });
      const content = "Something went wrong running that command.";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  });
}

async function dispatch(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
    return;
  }

  switch (interaction.commandName) {
    case "play": {
      await interaction.deferReply();
      const query = interaction.options.getString("query", true);

      // Join the invoking user's current voice channel if not already connected.
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      const voiceChannel = member.voice.channel;
      const player = getOrCreatePlayer(guildId);
      if (voiceChannel) {
        await player.join(voiceChannel.id, guildId, interaction.guild!.voiceAdapterCreator);
      }

      const track = await resolveInput(query);
      queueRepo.enqueue(guildId, track.id, interaction.user.id);
      bus.emit("queue.changed", { guildId });

      const state = player.getState();
      if (state.state === "idle") await player.playCurrent();

      await interaction.editReply(`Queued **${track.title}**`);
      break;
    }
    case "skip": {
      getOrCreatePlayer(guildId).skip();
      await interaction.reply("Skipped.");
      break;
    }
    case "pause": {
      getOrCreatePlayer(guildId).pause();
      await interaction.reply("Paused.");
      break;
    }
    case "resume": {
      getOrCreatePlayer(guildId).resume();
      await interaction.reply("Resumed.");
      break;
    }
    case "queue": {
      const items = queueRepo.getQueue(guildId);
      if (items.length === 0) {
        await interaction.reply("Queue is empty.");
        break;
      }
      const lines = items.slice(0, 10).map((i, idx) => `${idx + 1}. ${i.track.title}`);
      await interaction.reply(lines.join("\n"));
      break;
    }
    case "leave": {
      getOrCreatePlayer(guildId).leave();
      await interaction.reply("Left the voice channel.");
      break;
    }
  }
}
