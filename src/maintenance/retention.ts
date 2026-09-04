import { setTimeout as delay } from "node:timers/promises";

import type { MaintenanceRepository } from "../db/repositories/maintenance";
import { logger } from "../utils/logger";

const RETENTION_INTERVAL_MS = 60 * 60_000;

export async function runRetentionLoop(input: {
  maintenance: MaintenanceRepository;
  rawRetentionDays: number;
  retentionDays: number;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      const now = Date.now();
      const result = input.maintenance.applyRetention({
        rawBefore: new Date(now - input.rawRetentionDays * 86_400_000).toISOString(),
        rowsBefore: new Date(now - input.retentionDays * 86_400_000).toISOString(),
      });
      if (result.rawTextCleared > 0 || result.rowsDeleted > 0) {
        logger.info("Retention applied", result);
      }
    } catch (error) {
      logger.error("Retention failed", { error });
    }
    await delay(RETENTION_INTERVAL_MS, undefined, { signal: input.signal }).catch(() => undefined);
  }
}
