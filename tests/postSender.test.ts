import { describe, expect, test } from "bun:test";

import { DiscordAPIError, MessageFlags, PermissionFlagsBits, type Client } from "discord.js";

import { DiscordChannelPostSender } from "../src/bot/postSender";

function sender(channel: unknown): DiscordChannelPostSender {
  const client = {
    user: { id: "bot" },
    channels: {
      async fetch() {
        return channel;
      },
    },
  } as unknown as Client;
  return new DiscordChannelPostSender(client);
}

describe("DiscordChannelPostSender", () => {
  test("取得時にキャッシュを迂回して埋め込みと抑止を判定する", async () => {
    const fetches: unknown[] = [];
    const postSender = sender({
      messages: {
        async fetch(options: unknown) {
          fetches.push(options);
          return {
            embeds: [{}],
            flags: { has: (flag: MessageFlags) => flag === MessageFlags.SuppressEmbeds },
          };
        },
      },
    });
    expect(await postSender.checkMessage("c", "m")).toEqual({
      status: "found",
      hasEmbeds: true,
      suppressed: true,
    });
    expect(fetches).toEqual([{ message: "m", force: true }]);
  });

  test("見つからないメッセージを unavailable として返す", async () => {
    const missing = new DiscordAPIError(
      { message: "Unknown Message", code: 10008 },
      10008,
      404,
      "GET",
      "/channels/c/messages/m",
      { body: undefined, files: undefined },
    );
    const postSender = sender({
      messages: {
        async fetch() {
          throw missing;
        },
      },
    });
    expect(await postSender.checkMessage("c", "m")).toEqual({ status: "unavailable" });
  });

  test("権限不足を unavailable として返す", async () => {
    const forbidden = new DiscordAPIError(
      { message: "Missing Permissions", code: 50013 },
      50013,
      403,
      "GET",
      "/channels/c/messages/m",
      { body: undefined, files: undefined },
    );
    const postSender = sender({
      messages: {
        async fetch() {
          throw forbidden;
        },
      },
    });
    expect(await postSender.checkMessage("c", "m")).toEqual({ status: "unavailable" });
  });

  test("通信エラーは error として返す", async () => {
    const error = new Error("network");
    const postSender = sender({
      messages: {
        async fetch() {
          throw error;
        },
      },
    });
    expect(await postSender.checkMessage("c", "m")).toEqual({ status: "error", error });
  });

  test("本文を取得せず flags の PATCH で抑止を付け外しする", async () => {
    const edits: unknown[] = [];
    const postSender = sender({
      messages: {
        async edit(messageId: string, options: unknown) {
          edits.push({ messageId, options });
        },
      },
    });
    await postSender.setEmbedsSuppressed("c", "m", true);
    await postSender.setEmbedsSuppressed("c", "m", false);
    expect(edits).toEqual([
      { messageId: "m", options: { flags: MessageFlags.SuppressEmbeds } },
      { messageId: "m", options: { flags: [] } },
    ]);
  });

  test("送信先の Embed Links 権限を返す", async () => {
    const sent: unknown[] = [];
    const channel = {
      isSendable: () => true,
      permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.EmbedLinks }),
      async send(options: unknown) {
        sent.push(options);
        return { id: "m" };
      },
    };
    expect(await sender(channel).sendPostUrl("c", "https://fixupx.com/a/status/1")).toEqual({
      messageId: "m",
      embedLinks: true,
    });
    expect(sent).toEqual([
      { content: "https://fixupx.com/a/status/1", allowedMentions: { parse: [] } },
    ]);
    expect(
      await sender({ ...channel, permissionsFor: () => null }).sendPostUrl("c", "url"),
    ).toEqual({
      messageId: "m",
      embedLinks: null,
    });
    const throwing = {
      ...channel,
      permissionsFor: () => {
        throw new Error("cache miss");
      },
    };
    expect(await sender(throwing).sendPostUrl("c", "url")).toEqual({
      messageId: "m",
      embedLinks: null,
    });
    expect(await sender({ ...channel, permissionsFor: undefined }).sendPostUrl("c", "url")).toEqual(
      {
        messageId: "m",
        embedLinks: null,
      },
    );
  });
});
