import { setTimeout as delay } from "node:timers/promises";

import { AutopushUaidChangedError, listenAutopush, registerAutopush } from "../autopush/client";
import type { ExchangeRepository } from "../db/repositories/exchanges";
import type { InternalGraphqlRepository } from "../db/repositories/internalGraphql";
import type { NotificationRepository } from "../db/repositories/notifications";
import type { ReceiverRecord, ReceiverRepository } from "../db/repositories/receivers";
import type { TargetRepository } from "../db/repositories/targets";
import { InternalPollCollector, type InternalPollStatus } from "../pipeline/internalPollCollector";
import { WebPushPipeline } from "../pipeline/webpushPipeline";
import { kindsFromInternalTypes, type PostKind } from "../postKinds";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";
import { generateWebPushKeys } from "../webpush/keys";
import type { InternalGraphqlConfigurationProvider } from "../x/internalGraphql";
import { XInternalGraphqlClient } from "../x/internalGraphql";
import { registerXPushSubscription, XPushRegistrationError } from "../x/pushRegistration";
import { configureTargetNotifications } from "../x/targetNotifications";
import type { DeliveryService } from "./deliveryService";

const RECEIVER_SYNC_INTERVAL_MS = 60_000;
const TARGET_RECONCILE_INTERVAL_MS = 10 * 60_000;
const MIN_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const PROVISION_RETRY_DELAY_MS = 5 * 60_000;

export interface ReceiverStatus {
  label: string;
  autopushConnected: boolean;
  pushRegisteredAt: string | null;
  lastNotificationAt: string | null;
  lastError: string | null;
  internalPoll: InternalPollStatus | null;
}

export interface ReceiverSupervisorDependencies {
  receivers: ReceiverRepository;
  targets: TargetRepository;
  exchanges: ExchangeRepository;
  notifications: NotificationRepository;
  observations: InternalGraphqlRepository;
  delivery: DeliveryService | null;
  internalGraphqlConfiguration: InternalGraphqlConfigurationProvider;
  internalPollEnabled: boolean;
  deliveryNotBefore: string;
}

interface RunningReceiver {
  controller: AbortController;
  status: ReceiverStatus;
  collector: InternalPollCollector | null;
  done: Promise<void>;
}

/**
 * DB に登録された受信アカウントごとに Web Push 受信ループと内部 GraphQL 収集を動かす。
 * 受信アカウントの追加・削除は DB を定期的に読み直して反映するため、CLI で登録した直後から再起動なしで動き出す。
 */
export class ReceiverSupervisor {
  private readonly running = new Map<number, RunningReceiver>();
  private reconcileRequested: (() => void) | null = null;

  constructor(private readonly deps: ReceiverSupervisorDependencies) {}

  statuses(): ReceiverStatus[] {
    return [...this.running.values()].map((entry) => ({
      ...entry.status,
      internalPoll: entry.collector?.snapshot() ?? null,
    }));
  }

  /** /watch add の直後に、他の受信アカウントにも監視対象のフォローを行き渡らせる。 */
  requestReconcile(): void {
    this.reconcileRequested?.();
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        this.syncReceivers(signal);
        await delay(RECEIVER_SYNC_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      for (const entry of this.running.values()) entry.controller.abort();
      await Promise.allSettled([...this.running.values()].map((entry) => entry.done));
      this.running.clear();
    }
  }

  /**
   * 指定した受信アカウントで監視対象をフォローし、投稿通知とリポスト通知を有効化する。
   * X との応答は外部交換記録として保存する。
   */
  async configureTarget(
    receiver: ReceiverRecord,
    handle: string,
  ): Promise<{ userId: string; handle: string; displayName: string }> {
    const result = await configureTargetNotifications(receiver.credentials, handle);
    for (const exchange of result.exchanges) {
      this.deps.exchanges.record({
        source: "x_target_notifications",
        receiverId: receiver.id,
        occurredAt: exchange.occurredAt,
        method: exchange.method,
        url: exchange.url,
        requestSummaryJson: JSON.stringify({ receiver: receiver.label, handle }),
        responseStatus: exchange.status,
        responseText: exchange.responseText,
        error: null,
      });
    }
    return result.after;
  }

  /** 投稿 1 件を内部 GraphQL で引いて種別を確定する。応答は調査用に外部交換記録へ残す。 */
  private async classifyPost(
    receiverId: number,
    client: XInternalGraphqlClient,
    postId: string,
  ): Promise<readonly PostKind[]> {
    const result = await client.fetchTweetResult(postId);
    this.deps.exchanges.record({
      source: "x_tweet_lookup",
      receiverId,
      occurredAt: result.fetchedAt,
      method: "GET",
      url: result.endpoint,
      requestSummaryJson: JSON.stringify({ postId }),
      responseStatus: result.responseStatus,
      responseText: result.responseText,
      error: result.error ?? result.parseError,
    });
    metrics.increment("internal.tweet_lookups");
    if (result.post === null) {
      throw new Error(result.error ?? result.parseError ?? "投稿を取得できませんでした");
    }
    return kindsFromInternalTypes(result.post.types);
  }

  private syncReceivers(signal: AbortSignal): void {
    const enabled = this.deps.receivers.listEnabled();
    const enabledIds = new Set(enabled.map((receiver) => receiver.id));
    for (const [id, entry] of this.running) {
      if (!enabledIds.has(id)) {
        logger.info("Stopping receiver", { receiver: entry.status.label });
        entry.controller.abort();
        this.running.delete(id);
      }
    }
    for (const receiver of enabled) {
      if (this.running.has(receiver.id)) continue;
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort();
      signal.addEventListener("abort", onParentAbort, { once: true });
      const status: ReceiverStatus = {
        label: receiver.label,
        autopushConnected: false,
        pushRegisteredAt: receiver.push?.registeredAt ?? null,
        lastNotificationAt: null,
        lastError: null,
        internalPoll: null,
      };
      const entry: RunningReceiver = {
        controller,
        status,
        collector: null,
        done: Promise.resolve(),
      };
      entry.done = this.runReceiver(receiver.id, entry)
        .catch((error: unknown) => {
          logger.error("Receiver loop terminated", { receiver: receiver.label, error });
        })
        .finally(() => {
          signal.removeEventListener("abort", onParentAbort);
        });
      this.running.set(receiver.id, entry);
      logger.info("Starting receiver", { receiver: receiver.label });
    }
  }

  private async runReceiver(receiverId: number, entry: RunningReceiver): Promise<void> {
    const signal = entry.controller.signal;
    while (!signal.aborted) {
      let receiver = this.deps.receivers.getById(receiverId);
      if (receiver === null || !receiver.enabled) return;
      try {
        receiver = await this.ensurePushSubscription(receiver, false);
        entry.status.pushRegisteredAt = receiver.push?.registeredAt ?? null;
        entry.status.lastError = null;
      } catch (error) {
        entry.status.lastError = error instanceof Error ? error.message : String(error);
        logger.error("Receiver provisioning failed; retrying later", {
          receiver: receiver.label,
          error,
        });
        await delay(PROVISION_RETRY_DELAY_MS, undefined, { signal }).catch(() => undefined);
        continue;
      }
      const tasks: Promise<void>[] = [
        this.runAutopushLoop(receiverId, entry),
        this.runTargetReconcileLoop(receiverId, entry),
      ];
      if (this.deps.internalPollEnabled) {
        const collector = new InternalPollCollector({
          receiverId,
          receiverLabel: receiver.label,
          client: new XInternalGraphqlClient(receiver.credentials, () =>
            this.deps.internalGraphqlConfiguration.get(),
          ),
          targets: this.deps.targets,
          observations: this.deps.observations,
          delivery: this.deps.delivery,
          deliveryNotBefore: this.deps.deliveryNotBefore,
        });
        entry.collector = collector;
        tasks.push(collector.run(signal));
      }
      await Promise.all(tasks);
      return;
    }
  }

  private async ensurePushSubscription(
    receiver: ReceiverRecord,
    force: boolean,
  ): Promise<ReceiverRecord> {
    let current = receiver;
    if (current.push === null || force) {
      const keys = await generateWebPushKeys();
      const session = await registerAutopush();
      this.deps.receivers.savePushSubscription(current.id, session, keys);
      current = this.deps.receivers.getById(current.id)!;
      logger.info("AutoPush subscription created", { receiver: current.label });
    }
    if (current.push!.registeredAt === null) {
      await this.registerWithX(current);
      current = this.deps.receivers.getById(current.id)!;
      logger.info("Web Push subscription registered with X", { receiver: current.label });
    }
    return current;
  }

  private async registerWithX(receiver: ReceiverRecord): Promise<void> {
    const push = receiver.push!;
    const summary = JSON.stringify({ receiver: receiver.label, secrets: "redacted" });
    try {
      const result = await registerXPushSubscription(receiver.credentials, push.session, push.keys);
      this.deps.exchanges.record({
        source: "x_push_registration",
        receiverId: receiver.id,
        occurredAt: result.requestedAt,
        method: "POST",
        url: "https://x.com/i/api/1.1/notifications/settings/login.json",
        requestSummaryJson: summary,
        responseStatus: result.status,
        responseText: result.responseText,
        error: null,
      });
      this.deps.receivers.markPushRegistered(receiver.id, result.requestedAt);
    } catch (error) {
      const result = error instanceof XPushRegistrationError ? error.result : null;
      this.deps.exchanges.record({
        source: "x_push_registration",
        receiverId: receiver.id,
        occurredAt: result?.requestedAt ?? new Date().toISOString(),
        method: "POST",
        url: "https://x.com/i/api/1.1/notifications/settings/login.json",
        requestSummaryJson: summary,
        responseStatus: result?.status ?? null,
        responseText: result?.responseText ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async runAutopushLoop(receiverId: number, entry: RunningReceiver): Promise<void> {
    const signal = entry.controller.signal;
    const initial = this.deps.receivers.getById(receiverId);
    if (initial === null) return;
    const client = new XInternalGraphqlClient(initial.credentials, () =>
      this.deps.internalGraphqlConfiguration.get(),
    );
    const pipeline = new WebPushPipeline({
      notifications: this.deps.notifications,
      targets: this.deps.targets,
      delivery: this.deps.delivery,
      deliveryNotBefore: this.deps.deliveryNotBefore,
      classifyPost: (postId) => this.classifyPost(receiverId, client, postId),
    });
    let reconnectDelay = MIN_RECONNECT_DELAY_MS;
    while (!signal.aborted) {
      const receiver = this.deps.receivers.getById(receiverId);
      if (receiver === null || receiver.push === null) return;
      const push = receiver.push;
      try {
        await listenAutopush(
          push.session,
          async (notification) => {
            entry.status.lastNotificationAt = new Date().toISOString();
            return await pipeline.process({ receiverId, notification, keys: push.keys });
          },
          signal,
          () => {
            reconnectDelay = MIN_RECONNECT_DELAY_MS;
            entry.status.autopushConnected = true;
            metrics.increment("autopush.connections");
            logger.info("AutoPush connected", { receiver: receiver.label });
          },
        );
      } catch (error) {
        entry.status.autopushConnected = false;
        if (signal.aborted) break;
        if (error instanceof AutopushUaidChangedError) {
          logger.warn("AutoPush UAID changed; re-registering", { receiver: receiver.label });
          try {
            await this.ensurePushSubscription(receiver, true);
            entry.status.pushRegisteredAt = new Date().toISOString();
          } catch (registrationError) {
            entry.status.lastError =
              registrationError instanceof Error
                ? registrationError.message
                : String(registrationError);
            logger.error("Re-registration failed", {
              receiver: receiver.label,
              error: registrationError,
            });
            await delay(PROVISION_RETRY_DELAY_MS, undefined, { signal }).catch(() => undefined);
          }
          continue;
        }
        metrics.increment("autopush.disconnections");
        entry.status.lastError = error instanceof Error ? error.message : String(error);
        logger.warn("AutoPush disconnected", {
          receiver: receiver.label,
          retryMs: reconnectDelay,
          error,
        });
        await delay(reconnectDelay, undefined, { signal }).catch(() => undefined);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        continue;
      }
      entry.status.autopushConnected = false;
    }
  }

  private async runTargetReconcileLoop(receiverId: number, entry: RunningReceiver): Promise<void> {
    const signal = entry.controller.signal;
    while (!signal.aborted) {
      const receiver = this.deps.receivers.getById(receiverId);
      if (receiver === null) return;
      for (const target of this.deps.targets.listUnconfiguredForReceiver(receiverId)) {
        if (signal.aborted) return;
        try {
          const configured = await this.configureTarget(receiver, target.handle);
          this.deps.targets.upsert(configured);
          this.deps.targets.markReceiverConfigured(receiverId, target.id);
          logger.info("Target configured on receiver", {
            receiver: receiver.label,
            target: target.handle,
          });
        } catch (error) {
          logger.warn("Target configuration failed; will retry", {
            receiver: receiver.label,
            target: target.handle,
            error,
          });
        }
      }
      await this.waitForReconcile(signal);
    }
  }

  private async waitForReconcile(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, TARGET_RECONCILE_INTERVAL_MS);
      const previous = this.reconcileRequested;
      const onAbort = (): void => finish();
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      this.reconcileRequested = (): void => {
        previous?.();
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
