import { expect, test } from "bun:test";

import { countTablesInChunks } from "../src/maintenance/tableCounts";
import { createTestContext } from "./helpers/database";

test("表の行数を小分けに正確に数え、合間にイベントループへ処理を返す", async () => {
  const context = createTestContext();
  try {
    // 先頭の 10 行を消した後に、1 回に数える 50,000 行を 2 回またぐ件数にする
    const rows = 100_011;
    context.db
      .query(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $rows)
         INSERT INTO receivers (label, auth_token, csrf_token) SELECT 'r' || i, 'a', 'c' FROM n`,
      )
      .run({ rows });
    // 先頭の行を消し、rowid が 1 から連続しない表でも数が合うことを見る
    context.db.query("DELETE FROM receivers WHERE id <= 10").run();
    let yields = 0;
    const counts = await countTablesInChunks(context.maintenance, async () => {
      yields += 1;
    });
    expect(counts.receivers).toBe(rows - 10);
    expect(counts.routes).toBe(0);
    expect(yields).toBe(2);
  } finally {
    context.db.close();
  }
});
