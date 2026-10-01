import { setTimeout as delay } from "node:timers/promises";

import type { EmbedRepairClient, MessageCheck } from "../bot/postSender";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";
import type { EmbedRepairScheduler } from "./deliveryService";

const CHECK_OFFSETS_MS = [30_000, 90_000, 240_000, 600_000] as const;

interface RepairTarget {
  channelId: string;
  messageId: string;
  sentAtMs: number;
  nextIndex: number;
  attempted: boolean;
}

interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const defaultClock: Clock = {
  now: Date.now,
  async sleep(ms, signal) {
    await delay(ms, undefined, { signal });
  },
};

export class EmbedRepairService implements EmbedRepairScheduler {
  private readonly pending: RepairTarget[] = [];
  private wake = new AbortController();
  private signal: AbortSignal | null = null;

  constructor(
    private readonly client: EmbedRepairClient,
    private readonly clock: Clock = defaultClock,
  ) {}

  schedule(target: { channelId: string; messageId: string; sentAtMs: number }): void {
    if (this.signal?.aborted) {
      metrics.increment("embed_repair.dropped_on_shutdown");
      return;
    }
    this.pending.push({ ...target, nextIndex: 0, attempted: false });
    metrics.increment("embed_repair.scheduled");
    this.wake.abort();
    this.wake = new AbortController();
  }

  async run(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    try {
      while (!signal.aborted) {
        const now = this.clock.now();
        const ready = this.pending
          .filter((target) => target.sentAtMs + CHECK_OFFSETS_MS[target.nextIndex]! <= now)
          .toSorted((a, b) => a.sentAtMs - b.sentAtMs)[0];
        if (ready !== undefined) {
          const latestIndex = CHECK_OFFSETS_MS.findLastIndex(
            (offset) => ready.sentAtMs + offset <= now,
          );
          ready.nextIndex = latestIndex + 1;
          const done = await this.process(ready, latestIndex, signal);
          if (done) this.pending.splice(this.pending.indexOf(ready), 1);
          continue;
        }
        const nextAt = Math.min(
          ...this.pending.map((target) => target.sentAtMs + CHECK_OFFSETS_MS[target.nextIndex]!),
        );
        const waitMs = Number.isFinite(nextAt) ? Math.max(0, nextAt - now) : 2_147_483_647;
        const wake = this.wake;
        const combined = AbortSignal.any([signal, wake.signal]);
        try {
          await this.clock.sleep(waitMs, combined);
        } catch (error: unknown) {
          if (!combined.aborted) throw error;
        }
      }
    } finally {
      if (this.pending.length > 0) {
        metrics.increment("embed_repair.dropped_on_shutdown", this.pending.length);
        this.pending.length = 0;
      }
    }
  }

  private async process(
    target: RepairTarget,
    index: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    let check: MessageCheck;
    try {
      check = await this.client.checkMessage(target.channelId, target.messageId);
    } catch (error: unknown) {
      check = { status: "error", error };
    }
    if (signal.aborted) return false;
    const final = index === CHECK_OFFSETS_MS.length - 1;
    if (check.status === "unavailable" || check.status === "error") {
      if (check.status === "error") {
        logger.warn("Embed repair message check failed", {
          messageId: target.messageId,
          error: check.error,
        });
      }
      if (final) metrics.increment("embed_repair.final_fetch_failed");
      else if (check.status === "unavailable") metrics.increment("embed_repair.skipped");
      return final || check.status === "unavailable";
    }
    if (check.hasEmbeds) {
      metrics.increment(
        target.attempted ? "embed_repair.ok_after_repair" : "embed_repair.ok_before_repair",
      );
      return true;
    }
    if (check.suppressed) {
      metrics.increment("embed_repair.skipped");
      return true;
    }
    if (final) {
      metrics.increment("embed_repair.empty_final");
      return true;
    }
    target.attempted = true;
    metrics.increment("embed_repair.toggle_attempts");
    try {
      await this.client.setEmbedsSuppressed(target.channelId, target.messageId, true);
    } catch (error: unknown) {
      logger.warn("Embed suppression failed", { messageId: target.messageId, error });
    }
    // 停止の signal を渡さない。抑止を付けたまま終わらせないため、停止中でも解除まで進める。
    await this.clock.sleep(1_000);
    try {
      await this.client.setEmbedsSuppressed(target.channelId, target.messageId, false);
    } catch (error: unknown) {
      metrics.increment("embed_repair.unsuppress_failed");
      logger.warn("Embed unsuppression failed", { messageId: target.messageId, error });
      return true;
    }
    return false;
  }
}
