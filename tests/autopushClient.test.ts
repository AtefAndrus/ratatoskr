import { describe, expect, test } from "bun:test";

import { consumeAutopushMessages, type AutopushTransport } from "../src/autopush/client";

class FakeTransport implements AutopushTransport {
  readonly sent: string[] = [];
  pingCount = 0;
  now = 0;

  constructor(
    private readonly received: Array<string | null>,
    private readonly abortAfterReceive: AbortController | null = null,
  ) {}

  send(text: string): void {
    this.sent.push(text);
  }

  ping(): void {
    this.pingCount += 1;
  }

  async receive(timeoutMs: number): Promise<string | null> {
    if (this.received.length === 0) {
      this.abortAfterReceive?.abort();
      return null;
    }
    const value = this.received.shift()!;
    if (value === null) this.now += timeoutMs;
    return value;
  }
}

const heartbeatOptions = {
  applicationPingIntervalMs: 40,
  webSocketPingIntervalMs: 20,
  responseTimeoutMs: 5,
};

describe("AutoPush接続監視", () => {
  test("WebSocket Pingとは別にアプリケーションPingの応答を確認する", async () => {
    const abortController = new AbortController();
    const socket = new FakeTransport([null, null, "{}"], abortController);

    await consumeAutopushMessages(socket, async () => 100, abortController.signal, {
      ...heartbeatOptions,
      now: () => socket.now,
    });

    expect(socket.pingCount).toBe(1);
    expect(socket.sent).toEqual(["{}"]);
  });

  test("アプリケーションPingへ応答がなければ再接続用のエラーにする", async () => {
    const socket = new FakeTransport([null, null, null]);

    await expect(
      consumeAutopushMessages(socket, async () => 100, undefined, {
        ...heartbeatOptions,
        now: () => socket.now,
      }),
    ).rejects.toThrow("ハートビート応答がタイムアウトしました");
  });

  test("通知を処理して結果コードをACKする", async () => {
    const abortController = new AbortController();
    const rawText = JSON.stringify({
      messageType: "notification",
      channelID: "channel-1",
      version: "42",
      data: "ciphertext",
      headers: { encoding: "aes128gcm" },
    });
    const socket = new FakeTransport([rawText], abortController);

    await consumeAutopushMessages(
      socket,
      async (notification) => {
        expect(notification.rawText).toBe(rawText);
        return 101;
      },
      abortController.signal,
      {
        ...heartbeatOptions,
        now: () => socket.now,
      },
    );

    expect(socket.sent.map((text) => JSON.parse(text))).toEqual([
      {
        messageType: "ack",
        updates: [{ channelID: "channel-1", version: "42", code: 101 }],
      },
    ]);
  });
});
