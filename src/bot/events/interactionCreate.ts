import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import { isLinkDomain } from "../../db/repositories/guildSettings";
import { POST_KINDS, type RouteKinds } from "../../postKinds";
import { WatchServiceError, type WatchService } from "../../services/watchService";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";
import {
  errorMessage,
  linkDomainMessage,
  watchAddedMessage,
  watchListMessage,
  watchRemovedMessage,
} from "../messages";

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
      const message = errorMessage(
        error instanceof WatchServiceError
          ? error.message
          : `コマンドの実行中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    await interaction.respond(watchAutocompleteChoices(suggestions));
  } catch (error) {
    logger.warn("Autocomplete failed", { error });
    await interaction.respond([]).catch(() => undefined);
  }
}

export function watchAutocompleteChoices(
  suggestions: Array<{ handle: string; displayName: string }>,
): Array<{ name: string; value: string }> {
  return suggestions.map((suggestion) => ({
    name: `@${suggestion.handle} (${suggestion.displayName})`.slice(0, 100),
    value: suggestion.handle,
  }));
}

async function handleWatch(
  interaction: ChatInputCommandInteraction,
  watchService: WatchService,
): Promise<void> {
  if (interaction.guildId === null) {
    await interaction.reply({
      content: errorMessage("このコマンドはサーバー内でのみ使用できます。"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") {
    const messages = watchListMessage({
      routes: watchService.list(interaction.guildId),
      linkDomain: watchService.getLinkDomain(interaction.guildId),
    });
    await interaction.reply({
      content: messages[0]!,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    // 並び順のまま読ませるため、続きは並行送信せず 1 通ずつ追送する。
    for (const content of messages.slice(1)) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    return;
  }

  if (subcommand === "domain") {
    const requested = interaction.options.getString("domain");
    if (requested === null) {
      await interaction.reply({
        content: linkDomainMessage(watchService.getLinkDomain(interaction.guildId), false),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isLinkDomain(requested)) {
      await interaction.reply({
        content: errorMessage("対応していないドメインです。"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    watchService.setLinkDomain(interaction.guildId, requested);
    await interaction.reply({ content: linkDomainMessage(requested, true) });
    return;
  }

  const account = interaction.options.getString("account", true);
  const channel = interaction.options.getChannel("channel") ?? interaction.channel;
  if (channel === null || !("guildId" in channel) || channel.guildId !== interaction.guildId) {
    await interaction.reply({
      content: errorMessage("投稿先チャンネルを特定できません。"),
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
        content: errorMessage(`<#${channel.id}> に Bot の閲覧権限と送信権限がありません。`),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const kinds: Partial<RouteKinds> = {};
    for (const kind of POST_KINDS) {
      const value = interaction.options.getBoolean(kind);
      if (value !== null) kinds[kind] = value;
    }
    const result = await watchService.add({
      handle: account,
      guildId: interaction.guildId,
      channelId: channel.id,
      requestedBy: interaction.user.id,
      kinds,
    });
    await interaction.editReply({
      content: watchAddedMessage({
        handle: result.target.handle,
        displayName: result.target.displayName,
        channelId: channel.id,
        kinds: result.route.kinds,
        created: result.created,
      }),
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "remove") {
    const result = watchService.remove({ handle: account, channelId: channel.id });
    const content = result.removed
      ? watchRemovedMessage({
          handle: result.handle,
          displayName: result.displayName,
          channelId: channel.id,
        })
      : errorMessage("該当する監視対象と投稿先の組はありません。");
    await interaction.reply({
      content,
      ...(result.removed ? {} : { flags: MessageFlags.Ephemeral }),
      allowedMentions: { parse: [] },
    });
  }
}
