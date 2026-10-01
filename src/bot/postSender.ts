import {
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type SendableChannels,
} from "discord.js";

const UNAVAILABLE_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
]);

import type { DiscordPostSender, SentPost } from "../services/deliveryService";

export type MessageCheck =
  | { status: "found"; hasEmbeds: boolean; suppressed: boolean }
  | { status: "unavailable" }
  | { status: "error"; error: unknown };

export interface EmbedRepairClient {
  checkMessage(channelId: string, messageId: string): Promise<MessageCheck>;
  setEmbedsSuppressed(channelId: string, messageId: string, suppressed: boolean): Promise<void>;
}

export class DiscordChannelPostSender implements DiscordPostSender, EmbedRepairClient {
  constructor(private readonly client: Client) {}

  async sendPostUrl(channelId: string, postUrl: string): Promise<SentPost> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error(`Discord チャンネルへ送信できません: ${channelId}`);
    }
    const message = await channel.send({ content: postUrl, allowedMentions: { parse: [] } });
    return { messageId: message.id, embedLinks: this.embedLinks(channel) };
  }

  // 判定の失敗で配信を失敗扱いにしない。修復の可否を決めるだけなので、判定できなければ null に倒す。
  private embedLinks(channel: SendableChannels): boolean | null {
    const user = this.client.user;
    if (user === null || !("permissionsFor" in channel)) return null;
    if (typeof channel.permissionsFor !== "function") return null;
    try {
      return channel.permissionsFor(user)?.has(PermissionFlagsBits.EmbedLinks) ?? null;
    } catch {
      return null;
    }
  }

  async checkMessage(channelId: string, messageId: string): Promise<MessageCheck> {
    try {
      const channel = await this.messageChannel(channelId);
      const message = await channel.messages.fetch({ message: messageId, force: true });
      return {
        status: "found",
        hasEmbeds: message.embeds.length > 0,
        suppressed: message.flags.has(MessageFlags.SuppressEmbeds),
      };
    } catch (error: unknown) {
      if (error instanceof DiscordAPIError && UNAVAILABLE_CODES.has(Number(error.code))) {
        return { status: "unavailable" };
      }
      return { status: "error", error };
    }
  }

  async setEmbedsSuppressed(
    channelId: string,
    messageId: string,
    suppressed: boolean,
  ): Promise<void> {
    const channel = await this.messageChannel(channelId);
    await channel.messages.edit(messageId, {
      flags: suppressed ? MessageFlags.SuppressEmbeds : [],
    });
  }

  private async messageChannel(channelId: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !("messages" in channel)) {
      throw new Error(`Discord メッセージを取得できません: ${channelId}`);
    }
    return channel;
  }
}
