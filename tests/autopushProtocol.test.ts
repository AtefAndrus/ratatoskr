import { describe, expect, test } from "bun:test";

import {
  ackMessage,
  helloMessage,
  parseServerMessage,
  registerMessage,
  X_VAPID_PUBLIC_KEY,
} from "../src/autopush/protocol";

describe("Mozilla AutoPushプロトコル", () => {
  test("Firefox互換のhelloを組み立てる", () => {
    expect(JSON.parse(helloMessage("uaid-1"))).toEqual({
      messageType: "hello",
      uaid: "uaid-1",
      use_webpush: true,
      broadcasts: {},
    });
  });

  test("XのVAPID鍵を付けてregisterを組み立てる", () => {
    expect(JSON.parse(registerMessage("channel-1"))).toEqual({
      messageType: "register",
      channelID: "channel-1",
      key: X_VAPID_PUBLIC_KEY,
    });
  });

  test("notificationの数値versionも文字列として保持する", () => {
    expect(
      parseServerMessage(
        '{"messageType":"notification","channelID":"channel-1","version":42,"data":"abc","headers":{"encoding":"aes128gcm"}}',
      ),
    ).toEqual({
      messageType: "notification",
      channelId: "channel-1",
      version: "42",
      data: "abc",
      headers: { encoding: "aes128gcm" },
    });
  });

  test("ACKコードを明示して組み立てる", () => {
    expect(JSON.parse(ackMessage("channel-1", "42", 101))).toEqual({
      messageType: "ack",
      updates: [{ channelID: "channel-1", version: "42", code: 101 }],
    });
  });
});
