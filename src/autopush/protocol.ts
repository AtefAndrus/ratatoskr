export const AUTOPUSH_URL = "wss://push.services.mozilla.com/";

// XのWebクライアントが2026-09-02時点で利用している値として、実ブラウザで再検証する。
export const X_VAPID_PUBLIC_KEY =
  "BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs";

export interface AutopushSession {
  uaid: string;
  channelId: string;
  endpoint: string;
}

export interface AutopushNotification {
  rawText: string;
  channelId: string;
  version: string;
  data: string | null;
  headers: Record<string, string> | null;
}

export type AutopushServerMessage =
  | { messageType: "hello"; status: number; uaid: string }
  | { messageType: "register"; status: number; channelID: string; pushEndpoint: string }
  | ({ messageType: "notification" } & Omit<AutopushNotification, "rawText">)
  | { messageType: "unknown"; raw: unknown };

export function helloMessage(uaid = ""): string {
  return JSON.stringify({ messageType: "hello", uaid, use_webpush: true, broadcasts: {} });
}

export function registerMessage(channelId: string): string {
  return JSON.stringify({ messageType: "register", channelID: channelId, key: X_VAPID_PUBLIC_KEY });
}

export function ackMessage(channelId: string, version: string, code: 100 | 101 | 102): string {
  return JSON.stringify({
    messageType: "ack",
    updates: [{ channelID: channelId, version, code }],
  });
}

export function parseServerMessage(rawText: string): AutopushServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return { messageType: "unknown", raw: rawText };
  }
  if (!isObject(value) || !("messageType" in value)) {
    return null;
  }

  if (
    value.messageType === "hello" &&
    typeof value.status === "number" &&
    typeof value.uaid === "string"
  ) {
    return { messageType: "hello", status: value.status, uaid: value.uaid };
  }
  if (
    value.messageType === "register" &&
    typeof value.status === "number" &&
    typeof value.channelID === "string" &&
    typeof value.pushEndpoint === "string"
  ) {
    return {
      messageType: "register",
      status: value.status,
      channelID: value.channelID,
      pushEndpoint: value.pushEndpoint,
    };
  }
  if (
    value.messageType === "notification" &&
    typeof value.channelID === "string" &&
    (typeof value.version === "string" || typeof value.version === "number")
  ) {
    return {
      messageType: "notification",
      channelId: value.channelID,
      version: String(value.version),
      data: typeof value.data === "string" ? value.data : null,
      headers: stringRecord(value.headers),
    };
  }
  return { messageType: "unknown", raw: value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isObject(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return null;
  }
  return Object.fromEntries(entries);
}
