import type { AutopushNotification } from "../autopush/protocol";
import type { NotificationRepository } from "../db/repositories/notifications";
import type { TargetRepository } from "../db/repositories/targets";
import type { MediaTypes } from "../mediaFilter";
import { PARSER_VERSION, parseXNotification } from "../notification/parser";
import { kindsFromInternalTypes, type PostKind } from "../postKinds";
import type {
  DeliveryService,
  MediaTypesSource,
  PostKindsSource,
} from "../services/deliveryService";
import { xSnowflakeTimestampMs } from "../services/deliveryService";
import { decodeBase64url } from "../utils/base64url";
import { metrics } from "../utils/metrics";
import { decryptAes128Gcm, decryptAesGcm } from "../webpush/decrypt";
import type { WebPushKeys } from "../webpush/keys";
import type { InternalPostType } from "../x/internalGraphql";

export type AckCode = 100 | 101 | 102;

export interface WebPushPipelineDependencies {
  notifications: NotificationRepository;
  targets: TargetRepository;
  delivery: DeliveryService | null;
  /**
   * 種別かメディアの確定が必要なときだけ呼ばれ、投稿 1 件を引いて両方を返す。
   * 未指定なら種別は通常投稿か引用のどちらか、メディアは判定不能として扱う。
   */
  classifyPost?: (postId: string) => Promise<PostLookup>;
}

export interface PostLookup {
  kinds: readonly PostKind[];
  mediaTypes: MediaTypes;
}

/**
 * 取得できた投稿から種別とメディアを取り出す。
 * メディアが読めなくても失敗として扱わない。取得は成立していて種別は確定しており、
 * 失敗にすると受信アカウント間で共有するキャッシュから消えて、同じ応答を何度も引き直すことになる。
 */
export function postLookupFromPost(post: {
  types: readonly InternalPostType[];
  mediaTypes: MediaTypes;
}): PostLookup {
  return { kinds: kindsFromInternalTypes(post.types), mediaTypes: post.mediaTypes };
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
    // URI の投稿者が監視対象と違えばリポスト。同じなら通常投稿か引用で、ペイロードからは区別できない。
    const isRepost = parsed.authorHandle !== null && parsed.authorHandle !== target.handle;
    // 追加取得の対象は URI が指す投稿。リポストではこれが元投稿で、添付はそちらに付く。
    const lookupPostId = parsed.postId;
    const classifyPost = this.deps.classifyPost;
    // 種別とメディアは同じ取得から出るが、独立した軸として渡す。
    // リポストは種別が確定していて、メディアだけ引く必要がある。
    const lookup =
      classifyPost === undefined ? null : new SharedLookup(() => classifyPost(lookupPostId));
    const kinds: PostKindsSource = isRepost
      ? ["reposts"]
      : lookup === null
        ? ["posts", "quotes"]
        : async () => (await lookup.get()).kinds;
    const mediaTypes: MediaTypesSource =
      lookup === null ? null : async () => (await lookup.get()).mediaTypes;
    const result = await this.deps.delivery.deliver({
      source: "webpush",
      sourceRecordId: notificationId,
      targetId: target.id,
      postId,
      postUrl: parsed.postUrl,
      createdAt: createdAtFromPostId(postId),
      kinds,
      mediaTypes,
    });
    return result.failed > 0 ? 102 : 100;
  }
}

/**
 * 通知 1 件のなかで種別とメディアの両軸が同じ取得を共有する。
 * 失敗も保持する。受信アカウント間で共有するキャッシュは失敗を捨てるので、
 * ここで保持しないと種別の取得が失敗した直後にメディア側が同じ投稿を引き直す。
 */
class SharedLookup {
  private pending: Promise<PostLookup> | null = null;

  constructor(private readonly load: () => Promise<PostLookup>) {}

  get(): Promise<PostLookup> {
    this.pending ??= this.load();
    return this.pending;
  }
}

function createdAtFromPostId(postId: string): string | null {
  const milliseconds = xSnowflakeTimestampMs(postId);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
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
