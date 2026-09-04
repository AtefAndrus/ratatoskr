import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import { isLinkDomain } from "../../db/repositories/guildSettings";
import { WatchServiceError, type WatchService } from "../../services/watchService";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";

export function createInteractionCreateHandler(
  watchService: WatchService,
): (interaction: Interaction) => Promise<void> {
  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "watch") await handleAutocomplete(interaction, watchService);
      return;
    }
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
        if (interaction.deferred && !interaction.replied) {
          // 追加は公開メッセージとして defer しているため、失敗時は空の公開応答を消して本人にだけ知らせる
          await interaction.deleteReply();
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
        } else if (interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        logger.error("Failed to send error message", { replyError });
      }
    }
  };
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  watchService: WatchService,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "account" || interaction.guildId === null) {
    await interaction.respond([]);
    return;
  }
  try {
    const suggestions = watchService.suggestHandles(interaction.guildId, focused.value);
    await interaction.respond(
      suggestions.map((suggestion) => ({
        name: `@${suggestion.handle} (${suggestion.displayName})`.slice(0, 100),
        value: suggestion.handle,
      })),
    );
  } catch (error) {
    logger.warn("Autocomplete failed", { error });
    await interaction.respond([]).catch(() => undefined);
  }
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
    const lines = [`投稿 URL のドメイン: ${watchService.getLinkDomain(interaction.guildId)}`];
    if (routes.length === 0) {
      lines.push("監視対象はありません。");
    } else {
      lines.push(
        ...routes.map((route) => `@${route.handle} (${route.displayName}) → <#${route.channelId}>`),
      );
    }
    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "domain") {
    const requested = interaction.options.getString("domain");
    if (requested === null) {
      await interaction.reply({
        content: `投稿 URL のドメインは ${watchService.getLinkDomain(interaction.guildId)} です。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isLinkDomain(requested)) {
      await interaction.reply({
        content: "対応していないドメインです。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    watchService.setLinkDomain(interaction.guildId, requested);
    await interaction.reply({ content: `投稿 URL のドメインを ${requested} にしました。` });
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
    // X 側の設定に数秒かかるため先に defer する。追加はサーバーの他のメンバーにも見える公開応答にする。
    await interaction.deferReply();
    const me = interaction.guild?.members.me ?? null;
    const permissions =
      me === null || !("permissionsFor" in channel) ? null : channel.permissionsFor(me);
    if (
      permissions !== null &&
      !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    ) {
      await interaction.deleteReply();
      await interaction.followUp({
        content: `<#${channel.id}> に Bot の閲覧権限と送信権限がありません。`,
        flags: MessageFlags.Ephemeral,
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
          result.targetDisabled
            ? " このアカウントの投稿先が無くなったので、投稿の取得も止めました。"
            : ""
        }`
      : "該当する監視対象と投稿先の組はありません。";
    await interaction.reply({
      content,
      ...(result.removed ? {} : { flags: MessageFlags.Ephemeral }),
      allowedMentions: { parse: [] },
    });
  }
}
