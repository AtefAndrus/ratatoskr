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
        "[livedoornews](https://x.com/livedoornews)  ライブドアニュース",
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
    expect(message).toBe(
      [
        "### 監視対象の一覧",
        "-# 投稿 URL のドメイン: fixupx.com",
        "",
        "[a](https://x.com/a)  A",
        "- <#1>  送る種別: すべて",
        "- <#2>  送る種別: 通常投稿, 引用, リポスト",
        "",
        "[b](https://x.com/b)  B",
        "- <#1>  送る種別: すべて",
      ].join("\n"),
    );
    expect(watchListMessage({ linkDomain: "x.com", routes: [] })).toContain("監視対象はありません");
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
        "[livedoornews](https://x.com/livedoornews)  ライブドアニュース",
        "- 投稿先: <#1>",
      ].join("\n"),
    );
  });
});
