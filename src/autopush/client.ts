import {
  AUTOPUSH_URL,
  ackMessage,
  helloMessage,
  parseServerMessage,
  registerMessage,
  type AutopushNotification,
  type AutopushServerMessage,
  type AutopushSession,
} from "./protocol";

const RESPONSE_TIMEOUT_MS = 10_000;
const APPLICATION_PING_INTERVAL_MS = 4 * 60_000;
const WEBSOCKET_PING_INTERVAL_MS = 150_000;

export type NotificationAckCode = 100 | 101 | 102;

export interface AutopushTransport {
  send(text: string): void;
  ping(): void;
  receive(timeoutMs: number, signal?: AbortSignal): Promise<string | null>;
}

export interface AutopushHeartbeatOptions {
  applicationPingIntervalMs?: number;
  webSocketPingIntervalMs?: number;
  responseTimeoutMs?: number;
  now?: () => number;
}

export class AutopushUaidChangedError extends Error {
  constructor(readonly newUaid: string) {
    super(`Mozilla AutoPushが新しいUAIDを返しました: ${newUaid}`);
  }
}

export async function registerAutopush(): Promise<AutopushSession> {
  const socket = await AutopushSocket.connect();
  try {
    const uaid = await performHello(socket, "");
    const channelId = crypto.randomUUID();
    socket.send(registerMessage(channelId));
    const response = await receiveExpected(socket, "register");
    if (response.status !== 200) {
      throw new Error(`Mozilla AutoPushのregisterが失敗しました: ${response.status}`);
    }
    if (response.channelID !== channelId) {
      throw new Error("Mozilla AutoPushのchannelIDが一致しません");
    }
    return { uaid, channelId, endpoint: response.pushEndpoint };
  } finally {
    socket.close();
  }
}

export async function listenAutopush(
  session: AutopushSession,
  onNotification: (notification: AutopushNotification) => Promise<NotificationAckCode>,
  signal?: AbortSignal,
  onConnected?: () => void,
): Promise<void> {
  const socket = await AutopushSocket.connect();
  try {
    const uaid = await performHello(socket, session.uaid);
    if (uaid !== session.uaid) {
      throw new AutopushUaidChangedError(uaid);
    }
    onConnected?.();

    await consumeAutopushMessages(socket, onNotification, signal);
  } finally {
    socket.close();
  }
}

export async function consumeAutopushMessages(
  socket: AutopushTransport,
  onNotification: (notification: AutopushNotification) => Promise<NotificationAckCode>,
  signal?: AbortSignal,
  options: AutopushHeartbeatOptions = {},
): Promise<void> {
  const applicationPingIntervalMs =
    options.applicationPingIntervalMs ?? APPLICATION_PING_INTERVAL_MS;
  const webSocketPingIntervalMs = options.webSocketPingIntervalMs ?? WEBSOCKET_PING_INTERVAL_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  assertPositiveInterval("applicationPingIntervalMs", applicationPingIntervalMs);
  assertPositiveInterval("webSocketPingIntervalMs", webSocketPingIntervalMs);
  assertPositiveInterval("responseTimeoutMs", responseTimeoutMs);

  let nextApplicationPingAt = now() + applicationPingIntervalMs;
  let nextWebSocketPingAt = now() + webSocketPingIntervalMs;

  while (!signal?.aborted) {
    const timeoutMs = Math.max(0, Math.min(nextApplicationPingAt, nextWebSocketPingAt) - now());
    const rawText = await socket.receive(timeoutMs, signal);
    if (signal?.aborted) break;

    if (rawText !== null) {
      const receivedAt = now();
      nextApplicationPingAt = receivedAt + applicationPingIntervalMs;
      nextWebSocketPingAt = receivedAt + webSocketPingIntervalMs;
      await handleAutopushText(socket, rawText, onNotification);
      continue;
    }

    const timerAt = now();
    if (timerAt >= nextApplicationPingAt) {
      socket.send("{}");
      const responseText = await socket.receive(responseTimeoutMs, signal);
      if (signal?.aborted) break;
      if (responseText === null) {
        throw new Error("Mozilla AutoPushのハートビート応答がタイムアウトしました");
      }
      const receivedAt = now();
      nextApplicationPingAt = receivedAt + applicationPingIntervalMs;
      nextWebSocketPingAt = receivedAt + webSocketPingIntervalMs;
      await handleAutopushText(socket, responseText, onNotification);
      continue;
    }

    if (timerAt >= nextWebSocketPingAt) {
      socket.ping();
      nextWebSocketPingAt = timerAt + webSocketPingIntervalMs;
    }
  }
}

async function handleAutopushText(
  socket: AutopushTransport,
  rawText: string,
  onNotification: (notification: AutopushNotification) => Promise<NotificationAckCode>,
): Promise<void> {
  const message = parseServerMessage(rawText);
  if (message?.messageType !== "notification") return;
  const code = await onNotification({ ...message, rawText });
  socket.send(ackMessage(message.channelId, message.version, code));
}

function assertPositiveInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}は正の有限値である必要があります`);
  }
}

async function performHello(socket: AutopushSocket, uaid: string): Promise<string> {
  socket.send(helloMessage(uaid));
  const response = await receiveExpected(socket, "hello");
  if (response.status !== 200) {
    throw new Error(`Mozilla AutoPushのhelloが失敗しました: ${response.status}`);
  }
  return response.uaid;
}

async function receiveExpected<T extends "hello" | "register">(
  socket: AutopushSocket,
  expected: T,
): Promise<Extract<AutopushServerMessage, { messageType: T }>> {
  const rawText = await socket.receive(RESPONSE_TIMEOUT_MS);
  if (rawText === null) {
    throw new Error(`Mozilla AutoPushの${expected}応答がタイムアウトしました`);
  }
  const message = parseServerMessage(rawText);
  if (message?.messageType !== expected) {
    throw new Error(`Mozilla AutoPushから予期しない応答を受信しました: ${rawText}`);
  }
  return message as Extract<AutopushServerMessage, { messageType: T }>;
}

class AutopushSocket {
  private readonly queue: string[] = [];
  private readonly waiters: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed: { code: number; reason: string } | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : null;
      if (text === null) {
        this.failure = new Error("Mozilla AutoPushからテキスト以外のフレームを受信しました");
        this.rejectWaiters();
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(text);
      } else {
        this.queue.push(text);
      }
    });
    socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.rejectWaiters();
    });
    socket.addEventListener("error", () => {
      this.failure = new Error("Mozilla AutoPushのWebSocketで通信エラーが発生しました");
      this.rejectWaiters();
    });
  }

  static async connect(): Promise<AutopushSocket> {
    const BunWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const socket = new BunWebSocket(AUTOPUSH_URL, {
      headers: {
        Origin: "https://x.com",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Mozilla AutoPushへの接続がタイムアウトしました"));
        }, RESPONSE_TIMEOUT_MS);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error("Mozilla AutoPushへ接続できませんでした"));
          },
          { once: true },
        );
      });
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      throw error;
    }
    return new AutopushSocket(socket);
  }

  send(text: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Mozilla AutoPushのWebSocketが開いていません");
    }
    this.socket.send(text);
  }

  ping(): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Mozilla AutoPushのWebSocketが開いていません");
    }
    (this.socket as WebSocket & { ping(): void }).ping();
  }

  async receive(timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    this.throwIfStopped();

    return await new Promise<string | null>((resolve, reject) => {
      let settled = false;
      let waiter: { resolve: (value: string) => void; reject: (error: Error) => void };
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(value);
      };
      const onAbort = (): void => settle(null);
      const timeout = setTimeout(() => settle(null), timeoutMs);
      waiter = {
        resolve: (value: string): void => settle(value),
        reject(error: Error): void {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, "client shutdown");
    }
  }

  private rejectWaiters(): void {
    let error = new Error("Mozilla AutoPushの受信処理が停止しました");
    try {
      this.throwIfStopped();
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private throwIfStopped(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      const backoff =
        this.closed.code === 4774 ? " サーバーは30分以上の待機を要求しています。" : "";
      throw new Error(
        `Mozilla AutoPushが接続を閉じました: ${this.closed.code} ${this.closed.reason}.${backoff}`,
      );
    }
  }
}
