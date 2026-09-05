import { describe, expect, test } from "bun:test";

import {
  formatKinds,
  watchAddedMessage,
  watchListMessage,
  watchRemovedMessage,
} from "../src/bot/messages";
import { ALL_KINDS } from "../src/postKinds";

describe("コマンド応答の Markdown", () => {
  test("送る種別は許可した種別を並べ、すべて許可なら「すべて」にする", () => {
    expect(formatKinds(ALL_KINDS)).toBe("すべて");
    expect(formatKinds({ ...ALL_KINDS, reposts: false, replies: false })).toBe("通常投稿, 引用");
    expect(formatKinds({ posts: false, quotes: false, reposts: false, replies: false })).toBe(
      "なし",
    );
  });

  test("追加の応答は見出し、アカウント、投稿先、種別を段組みで返す", () => {
    expect(
      watchAddedMessage({
        handle: "livedoornews",
        displayName: "ライブドアニュース",
        channelId: "1",
        kinds: { ...ALL_KINDS, replies: false },
        created: false,
      }),
    ).toBe(
      [
        "### 監視対象の設定を更新しました",
        "**ライブドアニュース ([@livedoornews](https://x.com/livedoornews))**",
        "- 投稿先: <#1>",
        "- 送る種別: 通常投稿, 引用, リポスト",
        "-# 除外: 返信",
      ].join("\n"),
    );
  });

  test("一覧はアカウントごとに投稿先をまとめる", () => {
    const base = {
      id: 0,
      targetId: 1,
      guildId: "g",
      enabled: true,
      createdBy: null,
      createdAt: "",
    };
    const message = watchListMessage({
      linkDomain: "fixupx.com",
      routes: [
        { ...base, handle: "a", displayName: "A", channelId: "1", kinds: ALL_KINDS },
        {
          ...base,
          handle: "a",
          displayName: "A",
          channelId: "2",
          kinds: { ...ALL_KINDS, replies: false },
        },
        { ...base, handle: "b", displayName: "B", channelId: "1", kinds: ALL_KINDS },
      ],
    });
    expect(message).toEqual([
      [
        "### 監視対象の一覧",
        "-# 投稿 URL のドメイン: fixupx.com",
        "",
        "**A ([@a](https://x.com/a))**",
        "- <#1>  送る種別: すべて",
        "- <#2>  送る種別: 通常投稿, 引用, リポスト",
        "",
        "**B ([@b](https://x.com/b))**",
        "- <#1>  送る種別: すべて",
      ].join("\n"),
    ]);
    expect(watchListMessage({ linkDomain: "x.com", routes: [] })[0]).toContain(
      "監視対象はありません",
    );
  });

  test("一覧が 1 メッセージに収まらないときは上限内で分割してページ番号を付ける", () => {
    const base = {
      id: 0,
      targetId: 1,
      guildId: "g",
      enabled: true,
      createdBy: null,
      createdAt: "",
      kinds: ALL_KINDS,
      channelId: "987654321098765432",
    };
    const routes = Array.from({ length: 60 }, (_, index) => ({
      ...base,
      handle: `example_user${index}`,
      displayName: `サンプル表示名${index}`,
    }));
    const messages = watchListMessage({ linkDomain: "x.com", routes });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(2000);
    expect(messages[0]).toStartWith("### 監視対象の一覧");
    expect(messages[0]).toEndWith(`-# (1/${messages.length})`);
    // 分割してもアカウントのブロックは途中で切らず、全件がどこかのメッセージに現れる。
    const joined = messages.join("\n");
    for (const route of routes) {
      expect(joined).toContain(`**${route.displayName} ([@${route.handle}]`);
    }
  });

  test("1 アカウントに経路が集中して単独で上限を超えるときは行で割る", () => {
    const routes = Array.from({ length: 80 }, (_, index) => ({
      id: index,
      targetId: 1,
      guildId: "g",
      enabled: true,
      createdBy: null,
      createdAt: "",
      kinds: ALL_KINDS,
      handle: "example_user",
      displayName: "サンプル表示名",
      channelId: `98765432109876543${index % 10}`,
    }));
    const messages = watchListMessage({ linkDomain: "x.com", routes });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(2000);
    expect(messages.join("\n").split("送る種別: すべて").length - 1).toBe(80);
  });

  test("削除の応答はアカウントと投稿先を追加の応答と同じ段組みで返す", () => {
    expect(
      watchRemovedMessage({
        handle: "livedoornews",
        displayName: "ライブドアニュース",
        channelId: "1",
      }),
    ).toBe(
      [
        "### 監視対象から外しました",
        "**ライブドアニュース ([@livedoornews](https://x.com/livedoornews))**",
        "- 投稿先: <#1>",
      ].join("\n"),
    );
  });
});
