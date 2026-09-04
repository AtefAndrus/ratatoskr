import { Client, GatewayIntentBits } from "discord.js";

export function createBotClient(): Client {
  // 投稿 URL の送信と Slash Command だけなので Guilds intent のみを使う。
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}
