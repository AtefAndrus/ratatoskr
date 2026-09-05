import { setTimeout as delay } from "node:timers/promises";

import type {
  DeliveryRepository,
  DeliverySource,
  NewQueuedDelivery,
} from "../db/repositories/deliveries";
import type { GuildSettingsRepository, LinkDomain } from "../db/repositories/guildSettings";
import type { RouteRecord, RouteRepository } from "../db/repositories/routes";
import { isKindAllowed, type PostKind, type RouteKinds } from "../postKinds";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";

const DELIVERY_RETRY_INTERVAL_MS = 30_000;

export interface DiscordPostSender {
  sendPostUrl(channelId: string, postUrl: string): Promise<{ messageId: string }>;
}

export interface DeliveryResult {
  sent: number;
  failed: number;
  skipped: number;
  /** 経路の種別設定で送らなかった件数。 */
  filtered: number;
}

/**
 * 投稿の種別。確定していれば配列、Web Push のように通常投稿と引用を区別できない場合は
 * 必要になったときだけ呼ばれる解決関数を渡す。
 */
export type PostKindsSource = readonly PostKind[] | (() => Promise<readonly PostKind[]>);

export interface DeliverablePost {
  source: DeliverySource;
  sourceRecordId: number;
  targetId: number;
  /** 通知主体側の投稿 ID。リポストでは元投稿ではなくリポスト自体の ID で、重複排除キーに使う。 */
  postId: string;
  postUrl: string;
  createdAt?: string | null;
  kinds: PostKindsSource;
}

interface EnqueuedPost {
  postId: string;
  queuedRoutes: Array<{ id: number; routeId: number }>;
  result: DeliveryResult;
}

interface PreparedPost {
  postId: string;
  queueInputs: NewQueuedDelivery[];
  result: DeliveryResult;
}

export function xSnowflakeTimestampMs(postId: string): number | null {
  if (!/^\d+$/.test(postId)) return null;
  const timestamp = (BigInt(postId) >> 22n) + 1_288_834_974_657n;
  const milliseconds = Number(timestamp);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/** x.com の投稿 URL をサーバー設定のドメインに差し替える。x.com 以外のホストはそのまま返す。 */
export function rewritePostUrl(postUrl: string, linkDomain: LinkDomain): string {
  if (linkDomain === "x.com") return postUrl;
  let parsed: URL;
  try {
    parsed = new URL(postUrl);
  } catch {
    return postUrl;
  }
  if (parsed.hostname !== "x.com" && parsed.hostname !== "www.x.com") return postUrl;
  parsed.hostname = linkDomain;
  return parsed.toString();
}

/** Discord 受理後から送信済み状態の保存までに停止した場合は、欠落を避けるため再送する。 */
export class DeliveryService {
  private draining: Promise<void> | null = null;

  constructor(
    private readonly routes: RouteRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly sender: DiscordPostSender,
    private readonly guildSettings: GuildSettingsRepository | null = null,
  ) {
    this.deliveries.recoverSending(new Date().toISOString());
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.drain();
      await delay(DELIVERY_RETRY_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
  }

  async deliver(
    post: DeliverablePost,
    attemptedAt = new Date().toISOString(),
  ): Promise<DeliveryResult> {
    return await this.deliverBatch([post], attemptedAt);
  }

  async deliverBatch(
    posts: readonly DeliverablePost[],
    attemptedAt: string,
    afterEnqueue: () => void = () => undefined,
  ): Promise<DeliveryResult> {
    const prepared: PreparedPost[] = [];
    for (const post of posts) prepared.push(await this.prepare(post, attemptedAt));
    const queueInputs = prepared.flatMap((post) => post.queueInputs);
    const enqueued: EnqueuedPost[] = [];
    let skipped = 0;
    this.deliveries.enqueueBatch(queueInputs, (queueIds) => {
      let queueIndex = 0;
      for (const post of prepared) {
        const queuedRoutes: Array<{ id: number; routeId: number }> = [];
        for (const input of post.queueInputs) {
          const queueId = queueIds[queueIndex];
          if (queueId !== null && queueId !== undefined) {
            queuedRoutes.push({ id: queueId, routeId: input.routeId });
          } else {
            this.deliveries.record({
              source: input.source,
              sourceRecordId: input.sourceRecordId,
              routeId: input.routeId,
              attemptedAt,
              status: "skipped_duplicate",
            });
            post.result.skipped += 1;
            skipped += 1;
          }
          queueIndex += 1;
        }
        enqueued.push({ postId: post.postId, queuedRoutes, result: post.result });
      }
      afterEnqueue();
    });
    for (let index = 0; index < skipped; index += 1) {
      metrics.increment("delivery.skipped_duplicate");
    }
    await this.drainEnqueued(
      enqueued.flatMap((post) => post.queuedRoutes.map((route) => route.id)),
    );
    const result: DeliveryResult = { sent: 0, failed: 0, skipped: 0, filtered: 0 };
    for (const post of enqueued) {
      result.skipped += post.result.skipped;
      result.filtered += post.result.filtered;
      for (const route of post.queuedRoutes) {
        const state = this.deliveries.queueState(route.routeId, post.postId);
        if (state === "sent") result.sent += 1;
        else if (state === "failed") result.failed += 1;
      }
    }
    return result;
  }

  private async prepare(post: DeliverablePost, attemptedAt: string): Promise<PreparedPost> {
    const routes = dedupeByChannel(this.routes.listEnabledByTarget(post.targetId));
    const result: DeliveryResult = { sent: 0, failed: 0, skipped: 0, filtered: 0 };
    const kinds = new KindsResolver(post.kinds);
    const queueInputs: NewQueuedDelivery[] = [];
    for (const route of routes) {
      if (!(await kinds.isAllowed(route.kinds))) {
        metrics.increment("delivery.filtered");
        result.filtered += 1;
        continue;
      }
      const createdAt =
        post.createdAt === undefined
          ? attemptedAt
          : (post.createdAt ?? createdAtFromPostId(post.postId));
      if (
        createdAt === null ||
        new Date(createdAt).getTime() < new Date(route.createdAt).getTime()
      ) {
        result.filtered += 1;
        continue;
      }
      const resolvedKinds = await kinds.forQueue(route.kinds);
      queueInputs.push({
        targetId: post.targetId,
        routeId: route.id,
        postId: post.postId,
        postUrl: post.postUrl,
        kindsJson: JSON.stringify(resolvedKinds),
        postCreatedAt: createdAt,
        source: post.source,
        sourceRecordId: post.sourceRecordId,
        queuedAt: attemptedAt,
      });
    }
    return { postId: post.postId, queueInputs, result };
  }

  async drain(includeFailed = true): Promise<void> {
    if (this.draining !== null) return await this.draining;
    this.draining = this.drainReady(includeFailed).finally(() => {
      this.draining = null;
    });
    return await this.draining;
  }

  private async drainReady(includeFailed: boolean): Promise<void> {
    const readyIds = this.deliveries.listReadyIds(includeFailed);
    await this.sendReadyIds(readyIds);
  }

  private async drainEnqueued(ids: readonly number[]): Promise<void> {
    while (this.draining !== null) await this.draining;
    this.draining = this.sendReadyIds(ids).finally(() => {
      this.draining = null;
    });
    await this.draining;
  }

  private async sendReadyIds(readyIds: readonly number[]): Promise<void> {
    for (const id of readyIds) {
      const attemptedAt = new Date().toISOString();
      const queued = this.deliveries.claimQueued(id, attemptedAt);
      if (queued === null) continue;
      try {
        const linkDomain = this.guildSettings?.get(queued.guildId).linkDomain ?? "x.com";
        const sent = await this.sender.sendPostUrl(
          queued.channelId,
          rewritePostUrl(queued.postUrl, linkDomain),
        );
        this.deliveries.record({
          source: queued.source,
          sourceRecordId: queued.sourceRecordId,
          routeId: queued.routeId,
          attemptedAt,
          status: "sent",
          discordMessageId: sent.messageId,
        });
        this.deliveries.markQueueSent(
          queued.id,
          queued.routeId,
          queued.postId,
          sent.messageId,
          new Date().toISOString(),
        );
        metrics.increment("delivery.sent");
        logger.info("Delivered post", {
          source: queued.source,
          channelId: queued.channelId,
          postUrl: queued.postUrl,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deliveries.record({
          source: queued.source,
          sourceRecordId: queued.sourceRecordId,
          routeId: queued.routeId,
          attemptedAt,
          status: "failed",
          error: message,
        });
        this.deliveries.markQueueFailed(queued.id, message, new Date().toISOString());
        metrics.increment("delivery.failed");
        logger.warn("Delivery failed", {
          channelId: queued.channelId,
          postUrl: queued.postUrl,
          error,
        });
      }
    }
  }
}

/**
 * 種別の解決を経路の設定が本当に必要とするときまで遅らせる。
 * 通常投稿と引用の扱いが同じ経路なら、どちらであっても結果は変わらないので解決関数を呼ばない。
 * 解決に失敗したときは通常投稿と引用の両方の可能性を残し、どちらかを許可していれば送る (取りこぼしより重複の方が軽いため)。
 */
class KindsResolver {
  private resolved: Promise<readonly PostKind[]> | null = null;

  constructor(private readonly source: PostKindsSource) {}

  async isAllowed(routeKinds: RouteKinds): Promise<boolean> {
    if (typeof this.source !== "function") return isKindAllowed(routeKinds, this.source);
    if (routeKinds.posts === routeKinds.quotes) return routeKinds.posts;
    this.resolved ??= this.source().catch((error: unknown) => {
      logger.warn("Post kind resolution failed; treating as post or quote", { error });
      return ["posts", "quotes"] as const;
    });
    return isKindAllowed(routeKinds, await this.resolved);
  }

  async forQueue(routeKinds: RouteKinds): Promise<readonly PostKind[]> {
    if (typeof this.source !== "function") return this.source;
    if (routeKinds.posts === routeKinds.quotes) return ["posts", "quotes"];
    this.resolved ??= this.source().catch((error: unknown) => {
      logger.warn("Post kind resolution failed; treating as post or quote", { error });
      return ["posts", "quotes"] as const;
    });
    return await this.resolved;
  }
}

function dedupeByChannel(routes: RouteRecord[]): RouteRecord[] {
  const byChannel = new Map<string, RouteRecord>();
  for (const route of routes) {
    if (!byChannel.has(route.channelId)) byChannel.set(route.channelId, route);
  }
  return [...byChannel.values()];
}

function createdAtFromPostId(postId: string): string | null {
  const milliseconds = xSnowflakeTimestampMs(postId);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}
