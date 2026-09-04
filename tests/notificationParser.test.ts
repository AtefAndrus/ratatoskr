import { describe, expect, test } from "bun:test";

import { parsePostUri, parseXNotification } from "../src/notification/parser";

describe("X通知の解析", () => {
  test("x.comの投稿URLを抽出する", () => {
    expect(
      parseXNotification('{"data":{"uri":"https://x.com/Cloudflare/status/12345?s=20"}}'),
    ).toMatchObject({
      kind: "post",
      postId: "12345",
      postUrl: "https://x.com/Cloudflare/status/12345",
      authorHandle: "cloudflare",
      notificationPostId: "12345",
      notificationTitle: null,
      targetHandle: null,
    });
  });

  test("リポスト通知から通知主体の投稿IDと表示名を抽出する", () => {
    const parsed = parseXNotification(
      JSON.stringify({
        title: "ライブドアニュース",
        data: {
          title: "ライブドアニュース",
          tag: "tweet-2095104502278005216",
          uri: "/doorfumi2018/status/2095103190001647724",
          type: "tweet",
        },
      }),
    );

    expect(parsed).toMatchObject({
      kind: "post",
      postId: "2095103190001647724",
      authorHandle: "doorfumi2018",
      notificationPostId: "2095104502278005216",
      notificationTitle: "ライブドアニュース",
      targetHandle: null,
    });
  });

  test("X Web Pushの相対投稿URIを抽出する", () => {
    const parsed = parseXNotification(
      JSON.stringify({
        data: { uri: "/livedoornews/status/2095065830912582033", type: "tweet" },
      }),
    );

    expect(parsed).toMatchObject({
      kind: "post",
      postId: "2095065830912582033",
      postUrl: "https://x.com/livedoornews/status/2095065830912582033",
      authorHandle: "livedoornews",
    });
  });

  test("twitterスキームからIDを抽出する", () => {
    expect(parsePostUri("twitter://status?id=98765")).toEqual({
      postId: "98765",
      postUrl: "https://x.com/i/status/98765",
      authorHandle: null,
    });
  });

  test("投稿以外の通知を保存対象として識別する", () => {
    expect(parseXNotification('{"data":{"uri":"twitter://notifications"}}').kind).toBe("other");
  });

  test("壊れたJSONを捨てない", () => {
    expect(parseXNotification("not-json")).toMatchObject({
      kind: "malformed",
      payload: "not-json",
    });
  });
});
