import type { Client } from "discord.js";

import type { DiscordPostSender } from "../services/deliveryService";

export class DiscordChannelPostSender implements DiscordPostSender {
  constructor(private readonly client: Client) {}

  async sendPostUrl(channelId: string, postUrl: string): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error(`Discord チャンネルへ送信できません: ${channelId}`);
    }
    const message = await channel.send({ content: postUrl, allowedMentions: { parse: [] } });
    return { messageId: message.id };
  }
}
