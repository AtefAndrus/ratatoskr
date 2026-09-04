import {
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import { WatchServiceError, type WatchService } from "../../services/watchService";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";

export function createInteractionCreateHandler(
  watchService: WatchService,
): (interaction: Interaction) => Promise<void> {
  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "watch") return;
    metrics.increment(`command.watch.${interaction.options.getSubcommand()}`);
    try {
      await handleWatch(interaction, watchService);
    } catch (error) {
      metrics.increment("command.errors");
      const message =
        error instanceof WatchServiceError
          ? error.message
          : `コマンドの実行中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`;
      logger.error("Command execution failed", { error });
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: message });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        logger.error("Failed to send error message", { replyError });
      }
    }
  };
}

async function handleWatch(
  interaction: ChatInputCommandInteraction,
  watchService: WatchService,
): Promise<void> {
  if (interaction.guildId === null) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ使用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") {
    const routes = watchService.list(interaction.guildId);
    const content =
      routes.length === 0
        ? "監視対象はありません。"
        : routes
            .map((route) => `@${route.handle} (${route.displayName}) → <#${route.channelId}>`)
            .join("\n");
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const account = interaction.options.getString("account", true);
  const channel = interaction.options.getChannel("channel") ?? interaction.channel;
  if (channel === null || !("guildId" in channel) || channel.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "投稿先チャンネルを特定できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "add") {
    // X 側の設定に数秒かかるため先に defer する。
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const me = interaction.guild?.members.me ?? null;
    const permissions =
      me === null || !("permissionsFor" in channel) ? null : channel.permissionsFor(me);
    if (
      permissions !== null &&
      !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    ) {
      await interaction.editReply({
        content: `<#${channel.id}> に Bot の閲覧権限と送信権限がありません。`,
      });
      return;
    }
    const result = await watchService.add({
      handle: account,
      guildId: interaction.guildId,
      channelId: channel.id,
      requestedBy: interaction.user.id,
    });
    const verb = result.created ? "追加しました" : "は登録済みです";
    await interaction.editReply({
      content: `@${result.target.handle} (${result.target.displayName}) → <#${channel.id}> ${verb}。`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "remove") {
    const result = watchService.remove({ handle: account, channelId: channel.id });
    const content = result.removed
      ? `@${account.replace(/^@/, "")} → <#${channel.id}> を削除しました。${
          result.targetDisabled ? " 投稿先が無くなったため監視を停止しました。" : ""
        }`
      : "該当する監視対象と投稿先の組はありません。";
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}
