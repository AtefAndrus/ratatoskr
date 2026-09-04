import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import { LINK_DOMAINS } from "../../db/repositories/guildSettings";
import { POST_KIND_LABELS } from "../../postKinds";

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
      )
      .addBooleanOption((option) =>
        option.setName("posts").setDescription(`${POST_KIND_LABELS.posts}を送るか (既定: はい)`),
      )
      .addBooleanOption((option) =>
        option.setName("quotes").setDescription(`${POST_KIND_LABELS.quotes}を送るか (既定: はい)`),
      )
      .addBooleanOption((option) =>
        option
          .setName("reposts")
          .setDescription(`${POST_KIND_LABELS.reposts}を送るか (既定: はい)`),
      )
      .addBooleanOption((option) =>
        option
          .setName("replies")
          .setDescription(`${POST_KIND_LABELS.replies}を送るか (既定: はい)`),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("監視対象アカウントと投稿先チャンネルの紐づけを削除します")
      .addStringOption((option) =>
        option
          .setName("account")
          .setDescription("X のアカウント名 (このサーバーに登録済みのものから選べます)")
          .setRequired(true)
          .setAutocomplete(true),
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
  )
  .addSubcommand((sub) =>
    sub
      .setName("domain")
      .setDescription("投稿 URL のドメインを設定します (省略時は現在の設定を表示)")
      .addStringOption((option) =>
        option
          .setName("domain")
          .setDescription(
            "x.com のままにするか、埋め込みを整形するサービスのドメインに置き換えるか",
          )
          .addChoices(...LINK_DOMAINS.map((domain) => ({ name: domain, value: domain }))),
      ),
  );
