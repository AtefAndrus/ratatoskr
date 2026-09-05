import { setTimeout as delay } from "node:timers/promises";

import type { BacklogRepository } from "../db/repositories/backlog";
import type { InternalGraphqlRepository, NewTargetPost } from "../db/repositories/internalGraphql";
import type { TargetRecord, TargetRepository } from "../db/repositories/targets";
import { kindsFromTypesJson } from "../postKinds";
import type { DeliveryResult, DeliveryService } from "../services/deliveryService";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";
import { AdaptivePollScheduler, type PollCompletion } from "../x/adaptivePollScheduler";
import type { XInternalGraphqlClient } from "../x/internalGraphql";

const IDLE_WAIT_MS = 30_000;
/** 待機を刻む上限。担当替えを取り込むまでの最大の遅れになる。 */
const TARGET_REFRESH_INTERVAL_MS = 30_000;
const BACKLOG_LEASE_MS = 60_000;

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
  backlog: BacklogRepository;
  delivery: DeliveryService | null;
  selectTargets: (targets: readonly TargetRecord[]) => readonly TargetRecord[];
  onPollResponse?: (responseStatus: number | null) => void;
  scheduler?: AdaptivePollScheduler;
}

/**
 * 監視対象本人のタイムラインを適応間隔で取得し、Web Push が拾わない返信などを補完する。
 * 監視対象は毎周回 DB から読み直すため、/watch add で増えた対象は再起動なしで取り込む。
 * 全対象ではなく自分に割り当てられた分だけを追う。受信アカウント全員が全対象を引くと、
 * 配信は claim で 1 回に落ちるのに X への要求だけが台数倍になるため。
 */
export class InternalPollCollector {
  private readonly scheduler: AdaptivePollScheduler;
  private readonly backfillNext = new Set<number>();
  private readonly initializedBacklogTargets = new Set<number>();
  private readonly status: InternalPollStatus = {
    targets: [],
    lastPolledAt: null,
    lastError: null,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };

  constructor(private readonly deps: InternalPollCollectorDependencies) {
    this.scheduler = deps.scheduler ?? new AdaptivePollScheduler([]);
  }

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
          // 待機は刻み、待ったあとは必ず担当を読み直す。取得に入ってからでは、
          // その 1 回ぶん (最大 20 秒の取得と保存と配信) だけ担当替えの反映が遅れる。
          const sliceMs = Math.min(scheduled.waitMs, TARGET_REFRESH_INTERVAL_MS);
          await delay(sliceMs, undefined, { signal }).catch(() => undefined);
          if (signal.aborted) break;
          continue;
        }
        const target = byHandle.get(scheduled.target);
        if (target === undefined) continue;
        try {
          const summary = await this.pollScheduledTarget(target, signal);
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

  private async pollScheduledTarget(
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<InternalPollSummary> {
    if (this.backfillNext.delete(target.id)) {
      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + BACKLOG_LEASE_MS).toISOString();
      const progress = this.deps.backlog.acquire(target.id, this.deps.receiverId, now, leaseUntil);
      if (progress !== null && progress.nextCursor !== null) {
        return await this.pollTarget(target, signal, progress.nextCursor, progress.notBefore);
      }
    }
    const initializesBacklog = !this.initializedBacklogTargets.has(target.id);
    if (initializesBacklog) this.deps.backlog.ensure(target.id);
    const summary = await this.pollTarget(target, signal, undefined, undefined, initializesBacklog);
    if (initializesBacklog && summary.error === null && summary.parseError === null) {
      this.initializedBacklogTargets.add(target.id);
    }
    const progress = this.deps.backlog.get(target.id);
    if (progress?.state === "pending" && progress.nextCursor !== null) {
      this.backfillNext.add(target.id);
    }
    return summary;
  }

  private syncTargets(): Map<string, TargetRecord> {
    const enabled = this.deps.selectTargets(this.deps.targets.listEnabled());
    const byHandle = new Map(enabled.map((target) => [target.handle, target]));
    const enabledIds = new Set(enabled.map((target) => target.id));
    for (const targetId of this.initializedBacklogTargets) {
      if (!enabledIds.has(targetId)) this.initializedBacklogTargets.delete(targetId);
    }
    for (const targetId of this.backfillNext) {
      if (!enabledIds.has(targetId)) this.backfillNext.delete(targetId);
    }
    for (const state of this.scheduler.snapshot()) {
      if (!byHandle.has(state.target)) this.scheduler.removeTarget(state.target);
    }
    for (const handle of byHandle.keys()) this.scheduler.addTarget(handle);
    this.status.targets = [...byHandle.keys()];
    return byHandle;
  }

  private async pollTarget(
    target: TargetRecord,
    signal: AbortSignal,
    cursor?: string,
    backfillNotBefore?: string,
    initializesBacklog = false,
  ): Promise<InternalPollSummary> {
    const result = await this.deps.client.fetchUserTweetsAndReplies(target, cursor);
    // 保存や配信で落ちても認証の判断材料は失わないよう、応答を得た時点で先に渡す。
    // 停止後に返ってきた応答は使わない。古い認証情報の結果が次のループへ持ち越される。
    if (!signal.aborted) this.deps.onPollResponse?.(result.responseStatus);
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
        referencedAuthorHandle: post.referencedAuthorHandle,
        rawResultJson: JSON.stringify(post.rawResult),
        isTargetAuthor: post.authorUserId === target.userId ? 1 : 0,
      })),
    );
    const deliveryResult =
      this.deps.delivery === null
        ? { sent: 0, failed: 0, skipped: 0, filtered: 0, suppressed: 0 }
        : await deliverNewInternalPosts({
            delivery: this.deps.delivery,
            target,
            posts: stored.targetPosts,
            attemptedAt: result.completedAt,
            ...(backfillNotBefore === undefined ? {} : { notBefore: backfillNotBefore }),
          });
    if (cursor === undefined) {
      if (initializesBacklog && result.error === null && result.parseError === null) {
        this.deps.backlog.startFromLatest(target.id, result.bottomCursor, result.completedAt);
      }
    } else if (result.error !== null || result.parseError !== null) {
      this.deps.backlog.stop(
        target.id,
        this.deps.receiverId,
        result.error ?? result.parseError ?? "unknown_error",
        result.completedAt,
      );
    } else {
      this.deps.backlog.savePage({
        targetId: target.id,
        receiverId: this.deps.receiverId,
        requestedCursor: cursor,
        bottomCursor: result.bottomCursor,
        regularPostIds: result.regularPostIds,
        now: result.completedAt,
      });
    }
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
  attemptedAt: string;
  notBefore?: string;
}): Promise<InternalDeliveryResult> {
  const result: InternalDeliveryResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    filtered: 0,
    suppressed: 0,
  };
  for (const post of input.posts) {
    if (input.notBefore !== undefined && !isOnOrAfter(post.createdAt, input.notBefore)) {
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
        createdAt: post.createdAt,
        kinds: kindsFromTypesJson(post.typesJson),
      },
      input.attemptedAt,
    );
    result.sent += attempt.sent;
    result.failed += attempt.failed;
    result.skipped += attempt.skipped;
    result.filtered += attempt.filtered;
  }
  return result;
}

function isOnOrAfter(value: string | null, boundary: string): boolean {
  if (value === null) return false;
  const valueMs = new Date(value).getTime();
  const boundaryMs = new Date(boundary).getTime();
  return Number.isFinite(valueMs) && Number.isFinite(boundaryMs) && valueMs >= boundaryMs;
}

/**
 * リポストは元投稿の URL を送る。通知主体側の投稿 ID は重複排除にだけ使う。
 * 元投稿者のハンドルが取れなかった場合だけ、投稿者に依存しない /i/web/status/ 形式に落とす。
 */
export function internalPostUrl(
  targetHandle: string,
  post: {
    postId: string;
    typesJson: string;
    referencedPostIdsJson: string;
    referencedAuthorHandle: string | null;
  },
): string {
  const types = JSON.parse(post.typesJson) as unknown;
  const referencedPostIds = JSON.parse(post.referencedPostIdsJson) as unknown;
  if (
    Array.isArray(types) &&
    types.includes("repost") &&
    Array.isArray(referencedPostIds) &&
    typeof referencedPostIds[0] === "string"
  ) {
    return post.referencedAuthorHandle === null
      ? `https://x.com/i/web/status/${referencedPostIds[0]}`
      : `https://x.com/${post.referencedAuthorHandle}/status/${referencedPostIds[0]}`;
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
