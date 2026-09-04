import { normalizeHandle } from "../db/handle";
import type { GuildSettingsRepository, LinkDomain } from "../db/repositories/guildSettings";
import type { ReceiverRepository } from "../db/repositories/receivers";
import type { RouteRecord, RouteRepository, RouteWithTarget } from "../db/repositories/routes";
import type { TargetRecord, TargetRepository } from "../db/repositories/targets";
import type { RouteKinds } from "../postKinds";
import { logger } from "../utils/logger";
import type { ReceiverSupervisor } from "./receiverSupervisor";

export interface WatchAddResult {
  target: TargetRecord;
  route: RouteRecord;
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
    private readonly guildSettings: GuildSettingsRepository,
  ) {}

  async add(input: {
    handle: string;
    guildId: string;
    channelId: string;
    requestedBy?: string;
    kinds?: Partial<RouteKinds>;
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
        const { route, created } = this.routes.add({
          targetId: target.id,
          guildId: input.guildId,
          channelId: input.channelId,
          createdBy: input.requestedBy,
          kinds: input.kinds,
        });
        this.supervisor.requestReconcile();
        logger.info("Watch route added", {
          target: target.handle,
          channelId: input.channelId,
          created,
          kinds: route.kinds,
          receiver: receiver.label,
        });
        return { target, route, created, configuredBy: receiver.label };
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

  /** /watch remove の autocomplete 用に、このサーバーに経路がある監視対象を入力で絞って返す。 */
  suggestHandles(
    guildId: string,
    query: string,
    limit = 25,
  ): Array<{ handle: string; displayName: string }> {
    const needle = query.trim().replace(/^@/, "").toLowerCase();
    const seen = new Map<string, { handle: string; displayName: string }>();
    for (const route of this.routes.listByGuild(guildId)) {
      if (seen.has(route.handle)) continue;
      if (
        needle !== "" &&
        !route.handle.includes(needle) &&
        !route.displayName.toLowerCase().includes(needle)
      ) {
        continue;
      }
      seen.set(route.handle, { handle: route.handle, displayName: route.displayName });
    }
    return [...seen.values()].slice(0, limit);
  }

  getLinkDomain(guildId: string): LinkDomain {
    return this.guildSettings.get(guildId).linkDomain;
  }

  setLinkDomain(guildId: string, linkDomain: LinkDomain): void {
    this.guildSettings.setLinkDomain(guildId, linkDomain);
    logger.info("Link domain updated", { guildId, linkDomain });
  }
}
