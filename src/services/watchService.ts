import { normalizeHandle } from "../db/handle";
import type { ReceiverRepository } from "../db/repositories/receivers";
import type { RouteRepository, RouteWithTarget } from "../db/repositories/routes";
import type { TargetRecord, TargetRepository } from "../db/repositories/targets";
import { logger } from "../utils/logger";
import type { ReceiverSupervisor } from "./receiverSupervisor";

export interface WatchAddResult {
  target: TargetRecord;
  created: boolean;
  configuredBy: string;
}

export interface WatchRemoveResult {
  removed: boolean;
  targetDisabled: boolean;
}

export class WatchServiceError extends Error {}

/**
 * /watch コマンドの実体。監視対象の X 側設定、監視対象の登録、経路の追加削除をまとめる。
 * 監視対象と投稿先チャンネルは n:m で、同じ対象を複数チャンネルへ、同じチャンネルへ複数対象を流せる。
 */
export class WatchService {
  constructor(
    private readonly receivers: ReceiverRepository,
    private readonly targets: TargetRepository,
    private readonly routes: RouteRepository,
    private readonly supervisor: Pick<ReceiverSupervisor, "configureTarget" | "requestReconcile">,
  ) {}

  async add(input: {
    handle: string;
    guildId: string;
    channelId: string;
    requestedBy?: string;
  }): Promise<WatchAddResult> {
    const handle = normalizeHandle(input.handle);
    const receivers = this.receivers.listEnabled();
    if (receivers.length === 0) {
      throw new WatchServiceError(
        "受信用の X アカウントが登録されていません。CLI の receiver:add で登録してください。",
      );
    }
    // 最初に成功した受信アカウントで X 側の設定と表示名の取得を行う。残りは監督ループが追って揃える。
    let lastError: unknown = null;
    for (const receiver of receivers) {
      try {
        const configured = await this.supervisor.configureTarget(receiver, handle);
        const target = this.targets.upsert(configured);
        this.targets.markReceiverConfigured(receiver.id, target.id);
        const { created } = this.routes.add({
          targetId: target.id,
          guildId: input.guildId,
          channelId: input.channelId,
          createdBy: input.requestedBy,
        });
        this.supervisor.requestReconcile();
        logger.info("Watch route added", {
          target: target.handle,
          channelId: input.channelId,
          created,
          receiver: receiver.label,
        });
        return { target, created, configuredBy: receiver.label };
      } catch (error) {
        lastError = error;
        logger.warn("Target configuration failed on receiver", {
          receiver: receiver.label,
          handle,
          error,
        });
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new WatchServiceError(`X 側の設定に失敗しました: ${message}`);
  }

  remove(input: { handle: string; channelId: string }): WatchRemoveResult {
    const target = this.targets.findByHandle(input.handle);
    if (target === null) return { removed: false, targetDisabled: false };
    const removed = this.routes.remove(target.id, input.channelId);
    let targetDisabled = false;
    if (removed && this.routes.countByTarget(target.id) === 0) {
      // 経路が無くなった対象はポーリングを止める。X 側のフォローは解除しない (Web Push の再有効化を速くするため)。
      this.targets.setEnabled(target.id, false);
      targetDisabled = true;
    }
    if (removed)
      logger.info("Watch route removed", { target: target.handle, channelId: input.channelId });
    return { removed, targetDisabled };
  }

  list(guildId: string): RouteWithTarget[] {
    return this.routes.listByGuild(guildId);
  }
}
