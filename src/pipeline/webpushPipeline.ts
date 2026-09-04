import type { AutopushNotification } from "../autopush/protocol";
import type { NotificationRepository } from "../db/repositories/notifications";
import type { TargetRepository } from "../db/repositories/targets";
import { PARSER_VERSION, parseXNotification } from "../notification/parser";
import type { PostKind } from "../postKinds";
import type { DeliveryService } from "../services/deliveryService";
import { isPostOnOrAfter } from "../services/deliveryService";
import { decodeBase64url } from "../utils/base64url";
import { metrics } from "../utils/metrics";
import { decryptAes128Gcm, decryptAesGcm } from "../webpush/decrypt";
import type { WebPushKeys } from "../webpush/keys";

export type AckCode = 100 | 101 | 102;

export interface WebPushPipelineDependencies {
  notifications: NotificationRepository;
  targets: TargetRepository;
  delivery: DeliveryService | null;
  /** この時刻より前に作成された投稿は保存だけして Discord へは送らない (起動時のバックログ抑止)。 */
  deliveryNotBefore: string;
  /**
   * 通常投稿と引用を区別する必要があるときだけ呼ばれ、投稿 ID から種別を確定する。
   * 未指定なら通常投稿か引用のどちらかとして扱い、どちらかを許可する経路へ送る。
   */
  classifyPost?: (postId: string) => Promise<readonly PostKind[]>;
}

/**
 * AutoPush から受け取った 1 フレームを、生フレーム保存 → 復号 → 解析 → 通知主体の確定 → 配信の順に処理する。
 * 戻り値は AutoPush への ACK コード (100: 処理済, 101: 復号不能, 102: 配信失敗)。
 */
export class WebPushPipeline {
  constructor(private readonly deps: WebPushPipelineDependencies) {}

  async process(input: {
    receiverId: number;
    notification: AutopushNotification;
    keys: WebPushKeys;
    receivedAt?: string;
  }): Promise<AckCode> {
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    metrics.increment("webpush.frames");
    const frameId = this.deps.notifications.insertFrame({
      receiverId: input.receiverId,
      receivedAt,
      rawText: input.notification.rawText,
      messageType: "notification",
      channelId: input.notification.channelId,
      version: input.notification.version,
      encryptedData: input.notification.data,
      headersJson:
        input.notification.headers === null ? null : JSON.stringify(input.notification.headers),
    });
    return await this.processFrame({
      frameId,
      data: input.notification.data,
      headers: input.notification.headers,
      keys: input.keys,
    });
  }

  private async processFrame(input: {
    frameId: number;
    data: string | null;
    headers: Record<string, string> | null;
    keys: WebPushKeys;
  }): Promise<AckCode> {
    const base = {
      frameId: input.frameId,
      parsedAt: new Date().toISOString(),
      parserVersion: PARSER_VERSION,
      decryptedText: null,
      payloadJson: null,
      postId: null,
      postUrl: null,
      authorHandle: null,
      notificationPostId: null,
      notificationTitle: null,
      targetId: null,
      parseError: null,
    };
    if (input.data === null) {
      this.deps.notifications.insertParsed({ ...base, notificationKind: "other" });
      return 100;
    }

    let decryptedText: string;
    try {
      const encoding = findHeader(input.headers, "encoding") ?? "aes128gcm";
      const encoded = decodeBase64url(input.data);
      let decrypted: Uint8Array;
      if (encoding === "aes128gcm") {
        decrypted = await decryptAes128Gcm(encoded, input.keys);
      } else if (encoding === "aesgcm") {
        decrypted = await decryptAesGcm(encoded, input.keys, readAesGcmParameters(input.headers));
      } else {
        throw new Error(`未対応の Web Push 暗号形式です: ${encoding}`);
      }
      decryptedText = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    } catch (error) {
      metrics.increment("webpush.decrypt_failures");
      this.deps.notifications.insertParsed({
        ...base,
        notificationKind: "malformed",
        parseError: error instanceof Error ? error.message : String(error),
      });
      return 101;
    }

    const parsed = parseXNotification(decryptedText);
    const target =
      parsed.kind === "post"
        ? this.deps.targets.resolveNotificationTarget({
            authorHandle: parsed.authorHandle,
            notificationTitle: parsed.notificationTitle,
          })
        : null;
    const notificationId = this.deps.notifications.insertParsed({
      ...base,
      decryptedText,
      payloadJson: typeof parsed.payload === "string" ? null : JSON.stringify(parsed.payload),
      notificationKind: parsed.kind,
      postId: parsed.postId,
      postUrl: parsed.postUrl,
      authorHandle: parsed.authorHandle,
      notificationPostId: parsed.notificationPostId,
      notificationTitle: parsed.notificationTitle,
      targetId: target?.id ?? null,
      parseError: parsed.error,
    });
    metrics.increment(`webpush.kind.${parsed.kind}`);

    if (
      this.deps.delivery === null ||
      parsed.kind !== "post" ||
      parsed.postId === null ||
      parsed.postUrl === null ||
      target === null
    ) {
      if (parsed.kind === "post" && target === null) metrics.increment("webpush.unresolved_target");
      return 100;
    }
    const postId = parsed.notificationPostId ?? parsed.postId;
    if (!isPostOnOrAfter(postId, this.deps.deliveryNotBefore)) {
      metrics.increment("webpush.suppressed_backlog");
      return 100;
    }
    // URI の投稿者が監視対象と違えばリポスト。同じなら通常投稿か引用で、ペイロードからは区別できない。
    const isRepost = parsed.authorHandle !== null && parsed.authorHandle !== target.handle;
    const originalPostId = parsed.postId;
    const classifyPost = this.deps.classifyPost;
    const kinds: readonly PostKind[] | (() => Promise<readonly PostKind[]>) = isRepost
      ? ["reposts"]
      : classifyPost === undefined
        ? ["posts", "quotes"]
        : () => classifyPost(originalPostId);
    const result = await this.deps.delivery.deliver({
      source: "webpush",
      sourceRecordId: notificationId,
      targetId: target.id,
      postId,
      postUrl: parsed.postUrl,
      kinds,
    });
    return result.failed > 0 ? 102 : 100;
  }
}

function readAesGcmParameters(headers: Record<string, string> | null): {
  salt: string;
  senderPublicKey: string;
} {
  const encryption = findHeader(headers, "encryption");
  const cryptoKey = findHeader(headers, "crypto_key") ?? findHeader(headers, "crypto-key");
  const salt = findParameter(encryption, "salt");
  const senderPublicKey = findParameter(cryptoKey, "dh");
  if (salt === null) throw new Error("aesgcm の Encryption salt がありません");
  if (senderPublicKey === null) throw new Error("aesgcm の Crypto-Key dh がありません");
  return { salt, senderPublicKey };
}

function findHeader(headers: Record<string, string> | null, name: string): string | null {
  if (headers === null) return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

function findParameter(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(/[;,]/)) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim().toLowerCase() !== name.toLowerCase())
      continue;
    const value = part
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/g, "");
    return value.length > 0 ? value : null;
  }
  return null;
}
