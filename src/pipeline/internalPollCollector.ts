import { setTimeout as delay } from "node:timers/promises";

import type { InternalGraphqlRepository, NewTargetPost } from "../db/repositories/internalGraphql";
import type { TargetRecord, TargetRepository } from "../db/repositories/targets";
import type { DeliveryResult, DeliveryService } from "../services/deliveryService";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";
import { AdaptivePollScheduler, type PollCompletion } from "../x/adaptivePollScheduler";
import type { XInternalGraphqlClient } from "../x/internalGraphql";

const IDLE_WAIT_MS = 30_000;

export interface InternalPollSummary {
  target: string;
  observationId: number;
  responseStatus: number | null;
  postCount: number;
  targetPostCount: number;
  newPostCount: number;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  error: string | null;
  parseError: string | null;
  deliverySent: number;
  deliveryFailed: number;
  deliverySkipped: number;
  deliverySuppressed: number;
}

export interface InternalPollStatus {
  targets: string[];
  lastPolledAt: string | null;
  lastError: string | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export interface InternalDeliveryResult extends DeliveryResult {
  suppressed: number;
}

export interface InternalPollCollectorDependencies {
  receiverId: number;
  receiverLabel: string;
  client: XInternalGraphqlClient;
  targets: TargetRepository;
  observations: InternalGraphqlRepository;
  delivery: DeliveryService | null;
  deliveryNotBefore: string;
}

/**
 * 監視対象本人のタイムラインを適応間隔で取得し、Web Push が拾わない返信などを補完する。
 * 監視対象は毎周回 DB から読み直すため、/watch add で増えた対象は再起動なしで取り込む。
 */
export class InternalPollCollector {
  private readonly scheduler = new AdaptivePollScheduler([]);
  private readonly status: InternalPollStatus = {
    targets: [],
    lastPolledAt: null,
    lastError: null,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };

  constructor(private readonly deps: InternalPollCollectorDependencies) {}

  snapshot(): InternalPollStatus {
    return { ...this.status, targets: [...this.status.targets] };
  }

  async run(signal: AbortSignal): Promise<void> {
    logger.info("Internal poll collector started", { receiver: this.deps.receiverLabel });
    try {
      while (!signal.aborted) {
        const byHandle = this.syncTargets();
        const scheduled = this.scheduler.next();
        if (scheduled === null) {
          await delay(IDLE_WAIT_MS, undefined, { signal }).catch(() => undefined);
          continue;
        }
        if (scheduled.waitMs > 0) {
          await delay(scheduled.waitMs, undefined, { signal }).catch(() => undefined);
          if (signal.aborted) break;
        }
        const target = byHandle.get(scheduled.target);
        if (target === undefined) continue;
        try {
          const summary = await this.pollTarget(target);
          this.scheduler.complete(target.handle, completionFromSummary(summary));
          this.status.lastPolledAt = new Date().toISOString();
          this.status.lastError = summary.error ?? summary.parseError;
          this.status.rateLimitRemaining = summary.rateLimitRemaining;
          this.status.rateLimitResetAt = summary.rateLimitResetAt;
          metrics.increment("internal.polls");
          if (summary.error !== null || summary.parseError !== null) {
            metrics.increment("internal.poll_errors");
            logger.warn("Internal poll returned an error", {
              receiver: this.deps.receiverLabel,
              ...summary,
            });
          } else if (summary.newPostCount > 0) {
            logger.info("Internal poll found new posts", {
              receiver: this.deps.receiverLabel,
              ...summary,
            });
          }
        } catch (error) {
          // 保存や配信で例外が出ても収集ループは止めない。
          metrics.increment("internal.poll_errors");
          this.status.lastError = error instanceof Error ? error.message : String(error);
          logger.error("Internal poll failed", {
            receiver: this.deps.receiverLabel,
            target: target.handle,
            error,
          });
          if (this.scheduler.snapshot().some((state) => state.target === target.handle)) {
            this.scheduler.complete(target.handle, { outcome: "error" });
          }
        }
      }
    } finally {
      logger.info("Internal poll collector stopped", { receiver: this.deps.receiverLabel });
    }
  }

  private syncTargets(): Map<string, TargetRecord> {
    const enabled = this.deps.targets.listEnabled();
    const byHandle = new Map(enabled.map((target) => [target.handle, target]));
    for (const state of this.scheduler.snapshot()) {
      if (!byHandle.has(state.target)) this.scheduler.removeTarget(state.target);
    }
    for (const handle of byHandle.keys()) this.scheduler.addTarget(handle);
    this.status.targets = [...byHandle.keys()];
    return byHandle;
  }

  private async pollTarget(target: TargetRecord): Promise<InternalPollSummary> {
    const result = await this.deps.client.fetchUserTweetsAndReplies(target);
    const stored = this.deps.observations.recordObservation(
      {
        receiverId: this.deps.receiverId,
        targetId: target.id,
        fetchedAt: result.fetchedAt,
        completedAt: result.completedAt,
        queryId: result.queryId,
        endpoint: result.endpoint,
        variablesJson: JSON.stringify(result.variables),
        featuresJson: JSON.stringify(result.features),
        transactionId: result.transactionId,
        responseStatus: result.responseStatus,
        responseText: result.responseText,
        rateLimitLimit: result.rateLimitLimit,
        rateLimitRemaining: result.rateLimitRemaining,
        rateLimitResetAt: result.rateLimitResetAt,
        error: result.error,
        parseError: result.parseError,
      },
      result.posts.map((post) => ({
        postId: post.postId,
        createdAt: post.createdAt,
        authorUserId: post.authorUserId,
        authorHandle: post.authorHandle,
        typesJson: JSON.stringify(post.types),
        referencedPostIdsJson: JSON.stringify(post.referencedPostIds),
        rawResultJson: JSON.stringify(post.rawResult),
        isTargetAuthor: post.authorUserId === target.userId ? 1 : 0,
      })),
    );
    const deliveryResult =
      this.deps.delivery === null
        ? { sent: 0, failed: 0, skipped: 0, suppressed: 0 }
        : await deliverNewInternalPosts({
            delivery: this.deps.delivery,
            target,
            posts: stored.newTargetPosts,
            deliveryNotBefore: this.deps.deliveryNotBefore,
            attemptedAt: result.completedAt,
          });
    return {
      target: target.handle,
      observationId: stored.observationId,
      responseStatus: result.responseStatus,
      postCount: stored.postCount,
      targetPostCount: stored.targetPostCount,
      newPostCount: stored.newPostCount,
      rateLimitRemaining: result.rateLimitRemaining,
      rateLimitResetAt: result.rateLimitResetAt,
      error: result.error,
      parseError: result.parseError,
      deliverySent: deliveryResult.sent,
      deliveryFailed: deliveryResult.failed,
      deliverySkipped: deliveryResult.skipped,
      deliverySuppressed: deliveryResult.suppressed,
    };
  }
}

export async function deliverNewInternalPosts(input: {
  delivery: DeliveryService;
  target: Pick<TargetRecord, "id" | "handle">;
  posts: readonly NewTargetPost[];
  deliveryNotBefore: string;
  attemptedAt: string;
}): Promise<InternalDeliveryResult> {
  const result: InternalDeliveryResult = { sent: 0, failed: 0, skipped: 0, suppressed: 0 };
  for (const post of input.posts) {
    if (!isOnOrAfter(post.createdAt, input.deliveryNotBefore)) {
      result.suppressed += 1;
      continue;
    }
    const attempt = await input.delivery.deliver(
      {
        source: "internal_graphql",
        sourceRecordId: post.id,
        targetId: input.target.id,
        postId: post.postId,
        postUrl: internalPostUrl(input.target.handle, post),
      },
      input.attemptedAt,
    );
    result.sent += attempt.sent;
    result.failed += attempt.failed;
    result.skipped += attempt.skipped;
  }
  return result;
}

function isOnOrAfter(value: string | null, boundary: string): boolean {
  if (value === null) return false;
  const valueMs = new Date(value).getTime();
  const boundaryMs = new Date(boundary).getTime();
  return Number.isFinite(valueMs) && Number.isFinite(boundaryMs) && valueMs >= boundaryMs;
}

/** リポストは元投稿の URL を送る。通知主体側の投稿 ID は重複排除にだけ使う。 */
export function internalPostUrl(
  targetHandle: string,
  post: { postId: string; typesJson: string; referencedPostIdsJson: string },
): string {
  const types = JSON.parse(post.typesJson) as unknown;
  const referencedPostIds = JSON.parse(post.referencedPostIdsJson) as unknown;
  if (
    Array.isArray(types) &&
    types.includes("repost") &&
    Array.isArray(referencedPostIds) &&
    typeof referencedPostIds[0] === "string"
  ) {
    return `https://x.com/i/web/status/${referencedPostIds[0]}`;
  }
  return `https://x.com/${targetHandle}/status/${post.postId}`;
}

function completionFromSummary(summary: InternalPollSummary): PollCompletion {
  const rateLimit = readRateLimit(summary);
  if (summary.responseStatus === 429) {
    return { outcome: "rate_limited", ...(rateLimit === undefined ? {} : { rateLimit }) };
  }
  if (summary.error !== null || summary.parseError !== null) {
    return { outcome: "error", ...(rateLimit === undefined ? {} : { rateLimit }) };
  }
  return {
    outcome: summary.newPostCount > 0 ? "items" : "empty",
    ...(rateLimit === undefined ? {} : { rateLimit }),
  };
}

function readRateLimit(
  summary: InternalPollSummary,
): { remaining: number; resetAtMs: number } | undefined {
  if (summary.rateLimitRemaining === null || summary.rateLimitResetAt === null) return undefined;
  const resetAtMs = new Date(summary.rateLimitResetAt).getTime();
  if (!Number.isFinite(resetAtMs)) return undefined;
  return { remaining: summary.rateLimitRemaining, resetAtMs };
}
