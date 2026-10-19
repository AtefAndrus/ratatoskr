import { setTimeout as delay } from "node:timers/promises";

import {
  COUNTED_TABLES,
  type MaintenanceRepository,
  type TableCounts,
} from "../db/repositories/maintenance";
import { noteActivity } from "../utils/stallWatch";

/** 1 回に数える行数。ページがキャッシュに無い起動直後でも、1 回の停止を短く保つ。 */
const COUNT_BATCH_SIZE = 50_000;

/**
 * 表の行数を rowid の範囲ごとに小分けに数え、合間にイベントループへ処理を返す。
 * 表ごとに 1 回の count(*) で数えると、本番 (観測投稿 400 万行超) の起動直後にはページの読み込みで
 * プロセス全体が数秒止まり、Coolify のヘルスチェックに応答できない。
 * そのため数えている間の追加や削除は、数え終えた範囲なら反映されず、まだ数えていない範囲なら反映される。
 */
export async function countTablesInChunks(
  maintenance: MaintenanceRepository,
  yieldToEventLoop: () => Promise<void> = () => delay(0),
): Promise<TableCounts> {
  const counts: TableCounts = {};
  for (const table of COUNTED_TABLES) {
    let total = 0;
    let after = 0;
    for (;;) {
      noteActivity(`admin.countRows ${table}`);
      const batch = maintenance.countRowsAfter(table, after, COUNT_BATCH_SIZE);
      total += batch.count;
      if (batch.last === null || batch.count < COUNT_BATCH_SIZE) break;
      after = batch.last;
      await yieldToEventLoop();
    }
    counts[table] = total;
  }
  return counts;
}
