import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

const WATCHABLE_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
] as const;

export const watchCommand = new SlashCommandBuilder()
  .setName("watch")
  .setDescription("X アカウントの投稿を流す先を管理します")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("監視対象アカウントを追加し、投稿先チャンネルを紐づけます")
      .addStringOption((option) =>
        option.setName("account").setDescription("X のアカウント名 (@ は省略可)").setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("投稿先チャンネル (省略時は現在のチャンネル)")
          .addChannelTypes(...WATCHABLE_CHANNEL_TYPES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("監視対象アカウントと投稿先チャンネルの紐づけを削除します")
      .addStringOption((option) =>
        option.setName("account").setDescription("X のアカウント名 (@ は省略可)").setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("投稿先チャンネル (省略時は現在のチャンネル)")
          .addChannelTypes(...WATCHABLE_CHANNEL_TYPES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("このサーバーの監視対象アカウントと投稿先チャンネルの一覧を表示します"),
  );
