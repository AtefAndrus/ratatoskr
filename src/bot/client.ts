import { ActivityType, Client, GatewayIntentBits } from "discord.js";

import packageJson from "../../package.json";

export function createBotClient(): Client {
  // 投稿 URL の送信と Slash Command だけなので Guilds intent のみを使う。
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    // ClientUser#setActivity では IDENTIFY 時の presence が更新されないため、
    // 再セッション後に表示が消える。ClientOptions 側に持たせて毎回の IDENTIFY に載せる。
    presence: {
      activities: [{ name: `v${packageJson.version}`, type: ActivityType.Watching }],
    },
  });
}
