import type { Router } from "../router";
import { getBotClient } from "../../bot/client";
import { ChannelType } from "discord.js";

export function registerGuildRoutes(router: Router) {
  router.get("/api/guilds", () => {
    const client = getBotClient();
    const guilds = client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      iconUrl: g.iconURL() ?? null,
      memberCount: g.memberCount,
    }));
    return Response.json({ guilds });
  });

  router.get("/api/guilds/:guildId/channels", ({ params }) => {
    const client = getBotClient();
    const guild = client.guilds.cache.get(params.guildId);
    if (!guild) {
      return Response.json({ error: { code: "not_found", message: "Bot is not in that guild" } }, { status: 404 });
    }
    const channels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildVoice)
      .map((c) => ({ id: c.id, name: c.name }));
    return Response.json({ channels });
  });
}
