import type { Client } from "discord.js";

export interface AdminAlertSender {
  sendAlert(message: string): Promise<void>;
}

export class DiscordAlertSender implements AdminAlertSender {
  constructor(
    private readonly client: Client,
    private readonly channelId: string,
  ) {}

  async sendAlert(message: string): Promise<void> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error(`Discord チャンネルへ送信できません: ${this.channelId}`);
    }
    await channel.send({ content: message, allowedMentions: { parse: [] } });
  }
}
