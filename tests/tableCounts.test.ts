import { expect, test } from "bun:test";

import { COUNTED_TABLES } from "../src/db/repositories/maintenance";
import { countTablesInChunks } from "../src/maintenance/tableCounts";
import { createTestContext, type TestContext } from "./helpers/database";

/** 先頭の 10 行を消した後に、1 回に数える 50,000 行を 2 回またぐ件数を入れる。 */
function seedReceivers(context: TestContext): number {
  const rows = 100_011;
  context.db
    .query(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $rows)
       INSERT INTO receivers (label, auth_token, csrf_token) SELECT 'r' || i, 'a', 'c' FROM n`,
    )
    .run({ rows });
  // rowid が 1 から連続しない表でも数が合うことを見る
  context.db.query("DELETE FROM receivers WHERE id <= 10").run();
  return rows - 10;
}

test("表の行数を小分けに正確に数え、1 回ごとに処理を返す", async () => {
  const context = createTestContext();
  try {
    const expected = seedReceivers(context);
    let yields = 0;
    const counts = await countTablesInChunks(context.maintenance, async () => {
      yields += 1;
    });
    expect(counts.receivers).toBe(expected);
    expect(counts.routes).toBe(0);
    // receivers は 3 回、ほかの表は 1 回ずつ数え、表の最後の回の後にも返す
    expect(yields).toBe(3 + COUNTED_TABLES.length - 1);
  } finally {
    context.db.close();
  }
});

test("既定では、数える合間に待っているタイマーを先に動かす", async () => {
  const context = createTestContext();
  try {
    seedReceivers(context);
    const events: string[] = [];
    const countRowsAfter = context.maintenance.countRowsAfter.bind(context.maintenance);
    context.maintenance.countRowsAfter = (...args) => {
      events.push("count");
      return countRowsAfter(...args);
    };
    setTimeout(() => events.push("timer"), 0);
    await countTablesInChunks(context.maintenance);
    expect(events.indexOf("timer")).toBe(1);
  } finally {
    context.db.close();
  }
});
