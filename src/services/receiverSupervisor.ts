import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { AutopushUaidChangedError, listenAutopush, registerAutopush } from "../autopush/client";
import type { AdminAlertSender } from "../bot/alertSender";
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
import { SharedPromiseCache } from "../utils/sharedPromiseCache";
import { waitFor } from "../utils/waitFor";
import { generateWebPushKeys } from "../webpush/keys";
import type { InternalGraphqlConfigurationProvider } from "../x/internalGraphql";
import { XInternalGraphqlClient } from "../x/internalGraphql";
import { registerXPushSubscription, XPushRegistrationError } from "../x/pushRegistration";
import { configureTargetNotifications } from "../x/targetNotifications";
import {
  type AuthAlert,
  type AuthOutcome,
  AuthFailureTracker,
  authOutcomeOfProvisioningError,
  authOutcomeOfResponse,
} from "./authFailureTracker";
import type { DeliveryService } from "./deliveryService";
import { assignTargets } from "./pollAssignment";

const RECEIVER_SYNC_INTERVAL_MS = 60_000;
const TARGET_RECONCILE_INTERVAL_MS = 10 * 60_000;
const MIN_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const PROVISION_RETRY_DELAY_MS = 5 * 60_000;
/** 種別を覚えておく投稿の件数。通知が届いてから配信するまでの間だけ効けばよいので小さくてよい。 */
const POST_KIND_CACHE_LIMIT = 500;
/** 認証切れとみなすまでの連続失敗回数。1 回で鳴らすと瞬断でも通知が飛ぶ。 */
const AUTH_FAILURE_ALERT_THRESHOLD = 3;
/** 通知の送信が落ちたあと、次に送るまで空ける時間。 */
const ALERT_RETRY_DELAY_MS = 5 * 60_000;
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
  /** 未設定なら通知しない。 */
  alerts?: AdminAlertSender;
}

interface RunningReceiver {
  controller: AbortController;
  status: ReceiverStatus;
  collector: InternalPollCollector | null;
  done: Promise<void>;
  /** 認証情報の差し替えを検知するための指紋。値そのものは持たない。 */
  credentialsFingerprint: string;
  auth: AuthFailureTracker;
  retiring: boolean;
}

/**
 * DB に登録された受信アカウントごとに Web Push 受信ループと内部 GraphQL 収集を動かす。
 * 受信アカウントの追加・削除は DB を定期的に読み直して反映するため、CLI で登録した直後から再起動なしで動き出す。
 */
export class ReceiverSupervisor {
  private readonly running = new Map<number, RunningReceiver>();
  private readonly postKinds = new SharedPromiseCache<readonly PostKind[]>(POST_KIND_CACHE_LIMIT);
  /**
   * 監視対象の振り分けに使う受信アカウント。DB 上で有効なだけの受信は入れない。
   * provisioning に失敗し続けている受信を数に入れると、正常な受信がその分の対象を手放して無人になる。
   */
  private pollingReceiverIds: readonly number[] = [];
  /** 待機中のループを起こす関数。待機が終わるたびに外さないと呼び出しが積み上がる。 */
  private readonly syncWaiters = new Set<() => void>();
  private readonly reconcileWaiters = new Set<() => void>();
  private readonly authTrackers = new Map<string, AuthFailureTracker>();

  constructor(private readonly deps: ReceiverSupervisorDependencies) {}

  statuses(): ReceiverStatus[] {
    return [...this.running.values()]
      .filter((entry) => !entry.retiring)
      .map((entry) => ({
        ...entry.status,
        internalPoll: entry.collector?.snapshot() ?? null,
      }));
  }

  /** /watch add の直後に、他の受信アカウントにも監視対象のフォローを行き渡らせる。 */
  requestReconcile(): void {
    wakeAll(this.reconcileWaiters);
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        this.syncReceivers(signal);
        await waitFor(RECEIVER_SYNC_INTERVAL_MS, signal, (wake) => {
          this.syncWaiters.add(wake);
          return () => this.syncWaiters.delete(wake);
        });
      }
    } finally {
      const entries = [...this.running.values()];
      for (const entry of entries) entry.controller.abort();
      await Promise.allSettled(entries.map((entry) => entry.done));
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
    signal?: AbortSignal,
  ): Promise<{ userId: string; handle: string; displayName: string }> {
    const result = await configureTargetNotifications(
      receiver.credentials,
      handle,
      undefined,
      signal,
    );
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

  /**
   * 投稿 1 件の種別を、受信アカウントをまたいで一度だけ解決する。
   * 受信アカウントは全員が同じ投稿の通知を受け取るため、経路単位の重複排除より前に走るこの取得だけが
   * 受信台数分だけ重複する。解決中の Promise ごと共有して 1 回に畳む。
   * 投稿の種別は後から変わらないので、期限切れは設けず件数だけで打ち切る。
   */
  private classifyPost(
    receiverId: number,
    client: XInternalGraphqlClient,
    postId: string,
  ): Promise<readonly PostKind[]> {
    return this.postKinds.get(postId, () => this.fetchPostKinds(receiverId, client, postId));
  }

  /** 投稿 1 件を内部 GraphQL で引いて種別を確定する。応答は調査用に外部交換記録へ残す。 */
  private async fetchPostKinds(
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

  /**
   * 認証状態を更新し、運用者へ伝わっている状態との差分だけを送る。
   * 送信の成否は tracker 側に返して、次の判定でその時点の差分から導き直す。
   */
  private recordAuthOutcome(entry: RunningReceiver, outcome: AuthOutcome): void {
    if (outcome === "failed") metrics.increment("receiver.auth_failures");
    entry.auth.record(outcome);
    this.sendPendingAlert(entry);
  }

  private sendPendingAlert(entry: RunningReceiver): void {
    const alert = entry.auth.beginSend();
    if (alert === null) return;
    const label = entry.status.label;
    const message =
      alert === "recovered"
        ? `受信アカウント **${label}** の認証が回復した。`
        : [
            "### 受信アカウントの認証が切れている",
            `**${label}** の X への要求が ${entry.auth.failureStreak} 回続けて拒否された。`,
            `X の Cookie を取り直して \`bun run cli receiver:update ${label}\` で更新する。再起動は要らない。`,
          ].join("\n");
    if (this.deps.alerts === undefined) {
      // 通知先が無い運用では伝わったことにする。しないと判定が毎回立ち続ける。
      entry.auth.endSend(alert, true);
      return;
    }
    void this.deliverAlert(this.deps.alerts, entry, alert, message);
  }

  private async deliverAlert(
    alerts: AdminAlertSender,
    entry: RunningReceiver,
    alert: AuthAlert,
    message: string,
  ): Promise<void> {
    try {
      await alerts.sendAlert(message);
      entry.auth.endSend(alert, true);
      // 送信中に状態が変わっていれば、次の取得を待たずにその差分を送る。
      this.sendPendingAlert(entry);
    } catch (error) {
      // 通知の失敗で受信ループを止めない。落ちたことはログに残す。
      logger.error("Failed to send admin alert", { receiver: entry.status.label, error });
      entry.auth.endSend(alert, false);
    }
  }

  /**
   * 認証状態は受信アカウントごとに持ち、ループの張り直しをまたいで残す。
   * receivers の行 ID は AUTOINCREMENT でないため削除後に再利用される。作成時刻まで鍵に含めて、
   * 同じ ID の別アカウントが前のアカウントの連続失敗や通知済み状態を引き継がないようにする。
   */
  private authTracker(receiver: ReceiverRecord): AuthFailureTracker {
    const key = trackerKey(receiver);
    const existing = this.authTrackers.get(key);
    if (existing !== undefined) return existing;
    const created = new AuthFailureTracker({
      threshold: AUTH_FAILURE_ALERT_THRESHOLD,
      retryDelayMs: ALERT_RETRY_DELAY_MS,
    });
    this.authTrackers.set(key, created);
    return created;
  }

  /**
   * 停止を指示し、ループが本当に終わってから running から外す。
   * 外してすぐ立て直すと、signal を受け取らない X への要求が古い認証情報のまま新しいループと重なり、
   * 終了時の待ち合わせからも漏れる。
   */
  private requestSync(): void {
    wakeAll(this.syncWaiters);
  }

  private retire(entry: RunningReceiver): void {
    entry.retiring = true;
    entry.controller.abort();
    this.refreshPollingReceivers();
    // 次の周期を待つと、認証情報の載せ替えが検知から反映まで 2 周期ぶんかかる。
    void entry.done.finally(() => this.requestSync());
  }

  private syncReceivers(signal: AbortSignal): void {
    const enabled = this.deps.receivers.listEnabled();
    const enabledIds = new Set(enabled.map((receiver) => receiver.id));
    const fingerprints = new Map(
      enabled.map((receiver) => [receiver.id, credentialsFingerprint(receiver)]),
    );
    const liveKeys = new Set(enabled.map((receiver) => trackerKey(receiver)));
    for (const [key, tracker] of this.authTrackers) {
      // 停止中のループが残っている間や送信中に捨てると、同じ受信について 2 本の通知が並ぶ。
      if (liveKeys.has(key) || tracker.busy) continue;
      if ([...this.running.values()].some((entry) => entry.auth === tracker)) continue;
      this.authTrackers.delete(key);
    }
    for (const [id, entry] of this.running) {
      if (entry.retiring) continue;
      if (!enabledIds.has(id)) {
        logger.info("Stopping receiver", { receiver: entry.status.label });
        this.retire(entry);
        continue;
      }
      if (fingerprints.get(id) !== entry.credentialsFingerprint) {
        // 認証情報だけは実行中のループが起動時の値を握り続けるため、載せ替えにはループの張り直しが要る。
        logger.info("Retiring receiver for updated credentials", {
          receiver: entry.status.label,
        });
        this.retire(entry);
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
        credentialsFingerprint: fingerprints.get(receiver.id) ?? "",
        auth: this.authTracker(receiver),
        retiring: false,
      };
      entry.done = this.runReceiver(receiver.id, entry)
        .catch((error: unknown) => {
          logger.error("Receiver loop terminated", { receiver: receiver.label, error });
        })
        .finally(() => {
          signal.removeEventListener("abort", onParentAbort);
          // 例外で終わった entry を running に残すと、動いていない受信が担当枠を抱え続ける。
          if (this.running.get(receiver.id) === entry) this.running.delete(receiver.id);
          this.refreshPollingReceivers();
        });
      this.running.set(receiver.id, entry);
      logger.info("Starting receiver", { receiver: receiver.label });
    }
    this.refreshPollingReceivers();
  }

  /**
   * 割り当ての母集団を取り直す。
   * 同期の周期だけで更新すると、起動直後は collector がまだ無いので母集団が空になり、
   * 全受信が全対象を取得する状態が次の周期まで続く。減った側も同じだけ担当枠を抱え続ける。
   */
  private refreshPollingReceivers(): void {
    this.pollingReceiverIds = [...this.running]
      .filter(([, entry]) => !entry.retiring && entry.collector !== null)
      .map(([id]) => id)
      .toSorted((left, right) => left - right);
  }

  private async runReceiver(receiverId: number, entry: RunningReceiver): Promise<void> {
    const signal = entry.controller.signal;
    while (!signal.aborted) {
      let receiver = this.deps.receivers.getById(receiverId);
      if (receiver === null || !receiver.enabled) return;
      try {
        const provisioned = await this.ensurePushSubscription(receiver, false, signal);
        receiver = provisioned.receiver;
        entry.status.pushRegisteredAt = receiver.push?.registeredAt ?? null;
        entry.status.lastError = null;
        if (provisioned.authVerified) {
          this.recordAuthOutcome(entry, "ok");
        }
      } catch (error) {
        entry.status.lastError = error instanceof Error ? error.message : String(error);
        logger.error("Receiver provisioning failed; retrying later", {
          receiver: receiver.label,
          error,
        });
        // 鍵生成、Mozilla AutoPush 登録、DB 更新も同じ try に入る。X が資格情報を拒んだ場合だけを
        // 認証失敗に数える。そうしないと AutoPush 側の障害で「Cookie が切れている」と誤通知する。
        this.recordAuthOutcome(entry, authOutcomeOfProvisioningError(error));
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
          selectTargets: (targets) => assignTargets(targets, receiverId, this.pollingReceiverIds),
          onPollResponse: (responseStatus) => {
            this.recordAuthOutcome(entry, authOutcomeOfResponse(responseStatus));
          },
        });
        entry.collector = collector;
        this.refreshPollingReceivers();
        tasks.push(collector.run(signal));
      }
      try {
        await Promise.all(tasks);
      } finally {
        // 1 つが落ちても残りは動き続ける。停止を伝えてから全部の終了を待たないと、
        // 孤児のループが古い認証情報のまま残り、担当枠も抱えたままになる。
        entry.controller.abort();
        await Promise.allSettled(tasks);
      }
      return;
    }
  }

  /**
   * `authVerified` は X へ登録要求を出して通った場合だけ立つ。
   * 既に登録済みで X を呼ばなかった回まで認証の成功に数えると、切れた資格情報が回復扱いになる。
   */
  private async ensurePushSubscription(
    receiver: ReceiverRecord,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<{ receiver: ReceiverRecord; authVerified: boolean }> {
    let current = receiver;
    let authVerified = false;
    if (current.push === null || force) {
      const keys = await generateWebPushKeys();
      const session = await registerAutopush();
      this.deps.receivers.savePushSubscription(current.id, session, keys);
      current = this.deps.receivers.getById(current.id)!;
      logger.info("AutoPush subscription created", { receiver: current.label });
    }
    if (current.push!.registeredAt === null) {
      await this.registerWithX(current, signal);
      authVerified = true;
      current = this.deps.receivers.getById(current.id)!;
      logger.info("Web Push subscription registered with X", { receiver: current.label });
    }
    return { receiver: current, authVerified };
  }

  private async registerWithX(receiver: ReceiverRecord, signal?: AbortSignal): Promise<void> {
    const push = receiver.push!;
    const summary = JSON.stringify({ receiver: receiver.label, secrets: "redacted" });
    try {
      const result = await registerXPushSubscription(
        receiver.credentials,
        push.session,
        push.keys,
        undefined,
        signal,
      );
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
            const reprovisioned = await this.ensurePushSubscription(receiver, true, signal);
            entry.status.pushRegisteredAt = new Date().toISOString();
            if (reprovisioned.authVerified) {
              this.recordAuthOutcome(entry, "ok");
            }
          } catch (registrationError) {
            entry.status.lastError =
              registrationError instanceof Error
                ? registrationError.message
                : String(registrationError);
            logger.error("Re-registration failed", {
              receiver: receiver.label,
              error: registrationError,
            });
            this.recordAuthOutcome(entry, authOutcomeOfProvisioningError(registrationError));
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
          const configured = await this.configureTarget(receiver, target.handle, signal);
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
    await waitFor(TARGET_RECONCILE_INTERVAL_MS, signal, (wake) => {
      this.reconcileWaiters.add(wake);
      return () => this.reconcileWaiters.delete(wake);
    });
  }
}

/** 認証情報が差し替わったかだけを見たいので、値は持たずハッシュで比べる。 */
function credentialsFingerprint(receiver: ReceiverRecord): string {
  return createHash("sha256")
    .update(
      [
        receiver.createdAt,
        receiver.credentials.authToken,
        receiver.credentials.csrfToken,
        receiver.credentials.bearerToken,
      ].join("\u0000"),
    )
    .digest("hex");
}

/** wake は自分の登録を外すため、走査しながらの削除を避けて取り出してから呼ぶ。 */
function wakeAll(waiters: Set<() => void>): void {
  const pending = Array.from(waiters);
  waiters.clear();
  for (const wake of pending) wake();
}

/**
 * 行 ID は AUTOINCREMENT でないため削除後に再利用される。ラベルと作成時刻まで含めて識別する。
 * 作成時刻はミリ秒までなので、同じラベルを 1 ミリ秒以内に消して作り直すと前の状態を引き継ぐ。
 * 同じラベルの登録し直しは同じアカウントの再登録であり、引き継いだ連続失敗も次の成功で消えるため許容する。
 */
function trackerKey(receiver: ReceiverRecord): string {
  return `${receiver.id}:${receiver.label}:${receiver.createdAt}`;
}
