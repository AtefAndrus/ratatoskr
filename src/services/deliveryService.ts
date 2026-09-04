import type { DeliveryRepository, DeliverySource } from "../db/repositories/deliveries";
import type { GuildSettingsRepository, LinkDomain } from "../db/repositories/guildSettings";
import type { RouteRecord, RouteRepository } from "../db/repositories/routes";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";

export interface DiscordPostSender {
  sendPostUrl(channelId: string, postUrl: string): Promise<{ messageId: string }>;
}

export interface DeliveryResult {
  sent: number;
  failed: number;
  skipped: number;
}

export interface DeliverablePost {
  source: DeliverySource;
  sourceRecordId: number;
  targetId: number;
  /** 通知主体側の投稿 ID。リポストでは元投稿ではなくリポスト自体の ID で、重複排除キーに使う。 */
  postId: string;
  postUrl: string;
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

export function isPostOnOrAfter(postId: string, boundary: string): boolean {
  const postTimestampMs = xSnowflakeTimestampMs(postId);
  const boundaryMs = new Date(boundary).getTime();
  if (!Number.isFinite(boundaryMs)) throw new Error(`Discord 配信開始時刻が不正です: ${boundary}`);
  return postTimestampMs !== null && postTimestampMs >= boundaryMs;
}

/**
 * 投稿 URL を該当する全経路へ一度ずつ送る。
 * 経路と投稿 ID の組を claim として先に確保するため、Web Push と内部 GraphQL の両方が
 * 同じ投稿を検出しても、またプロセスを再起動しても同じチャンネルへは一度しか送らない。
 */
export class DeliveryService {
  constructor(
    private readonly routes: RouteRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly sender: DiscordPostSender,
    private readonly guildSettings: GuildSettingsRepository | null = null,
  ) {}

  async deliver(
    post: DeliverablePost,
    attemptedAt = new Date().toISOString(),
  ): Promise<DeliveryResult> {
    const routes = dedupeByChannel(this.routes.listEnabledByTarget(post.targetId));
    const result: DeliveryResult = { sent: 0, failed: 0, skipped: 0 };
    for (const route of routes) {
      const dedupeKey = `post:${post.postId}`;
      const claimed = this.deliveries.claim({
        source: post.source,
        sourceRecordId: post.sourceRecordId,
        routeId: route.id,
        dedupeKey,
        claimedAt: attemptedAt,
      });
      if (!claimed) {
        this.deliveries.record({
          source: post.source,
          sourceRecordId: post.sourceRecordId,
          routeId: route.id,
          attemptedAt,
          status: "skipped_duplicate",
        });
        metrics.increment("delivery.skipped_duplicate");
        result.skipped += 1;
        continue;
      }
      try {
        const linkDomain = this.guildSettings?.get(route.guildId).linkDomain ?? "x.com";
        const sent = await this.sender.sendPostUrl(
          route.channelId,
          rewritePostUrl(post.postUrl, linkDomain),
        );
        this.deliveries.record({
          source: post.source,
          sourceRecordId: post.sourceRecordId,
          routeId: route.id,
          attemptedAt,
          status: "sent",
          discordMessageId: sent.messageId,
        });
        this.deliveries.markSent(route.id, dedupeKey);
        metrics.increment("delivery.sent");
        result.sent += 1;
        logger.info("Delivered post", {
          source: post.source,
          channelId: route.channelId,
          postUrl: post.postUrl,
        });
      } catch (error) {
        this.deliveries.record({
          source: post.source,
          sourceRecordId: post.sourceRecordId,
          routeId: route.id,
          attemptedAt,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.deliveries.release(route.id, dedupeKey);
        metrics.increment("delivery.failed");
        result.failed += 1;
        logger.warn("Delivery failed", {
          channelId: route.channelId,
          postUrl: post.postUrl,
          error,
        });
      }
    }
    return result;
  }
}

function dedupeByChannel(routes: RouteRecord[]): RouteRecord[] {
  const byChannel = new Map<string, RouteRecord>();
  for (const route of routes) {
    if (!byChannel.has(route.channelId)) byChannel.set(route.channelId, route);
  }
  return [...byChannel.values()];
}
