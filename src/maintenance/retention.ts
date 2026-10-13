import { setTimeout as delay } from "node:timers/promises";

import {
  EXPIRING_TABLES,
  RAW_TEXT_TABLES,
  type MaintenanceRepository,
  type RetentionResult,
} from "../db/repositories/maintenance";
import { logger } from "../utils/logger";

const RETENTION_INTERVAL_MS = 60 * 60_000;
/** 1 トランザクションで本文を落とす id の幅。観測 1 件に投稿が十数行付くので、これで数万行に収まる。 */
const RAW_TEXT_ID_SPAN = 1_000;

/** 本文を落とし終えた id の上限。プロセス内だけに持ち、起動直後の 1 回は先頭から小分けに走査し直す。 */
export type RawTextWatermarks = Map<string, number>;

/**
 * 保持期間の整理を小さなトランザクションに分けて行い、その合間にイベントループへ処理を返す。
 * 2 回目以降の本文の整理は前回の上限から先だけを見る。古い行は本文を落とし済みなので、毎回全行を読み直さない。
 */
export async function applyRetentionInChunks(input: {
  maintenance: MaintenanceRepository;
  rawBefore: string;
  rowsBefore: string;
  watermarks: RawTextWatermarks;
  signal?: AbortSignal;
  yieldToEventLoop?: () => Promise<void>;
}): Promise<RetentionResult> {
  const yieldToEventLoop = input.yieldToEventLoop ?? (() => delay(0));
  const result: RetentionResult = { rawTextCleared: 0, rowsDeleted: 0 };
  for (const spec of RAW_TEXT_TABLES) {
    const upperId = input.maintenance.rawTextUpperId(spec, input.rawBefore);
    let afterId = input.watermarks.get(spec.table) ?? 0;
    while (afterId < upperId) {
      if (input.signal?.aborted === true) return result;
      const untilId = Math.min(afterId + RAW_TEXT_ID_SPAN, upperId);
      result.rawTextCleared += input.maintenance.clearRawTextRange(spec, afterId, untilId);
      afterId = untilId;
      input.watermarks.set(spec.table, afterId);
      await yieldToEventLoop();
    }
  }
  for (const spec of EXPIRING_TABLES) {
    for (;;) {
      if (input.signal?.aborted === true) return result;
      const deleted = input.maintenance.deleteExpiredBatch(spec, input.rowsBefore, spec.batchSize);
      result.rowsDeleted += deleted;
      await yieldToEventLoop();
      if (deleted < spec.batchSize) break;
    }
  }
  return result;
}

export async function runRetentionLoop(input: {
  maintenance: MaintenanceRepository;
  rawRetentionDays: number;
  retentionDays: number;
  signal: AbortSignal;
}): Promise<void> {
  const watermarks: RawTextWatermarks = new Map();
  while (!input.signal.aborted) {
    try {
      const now = Date.now();
      const result = await applyRetentionInChunks({
        maintenance: input.maintenance,
        rawBefore: new Date(now - input.rawRetentionDays * 86_400_000).toISOString(),
        rowsBefore: new Date(now - input.retentionDays * 86_400_000).toISOString(),
        watermarks,
        signal: input.signal,
      });
      if (result.rawTextCleared > 0 || result.rowsDeleted > 0) {
        logger.info("Retention applied", { ...result, durationMs: Date.now() - now });
      }
    } catch (error) {
      logger.error("Retention failed", { error });
    }
    await delay(RETENTION_INTERVAL_MS, undefined, { signal: input.signal }).catch(() => undefined);
  }
}
