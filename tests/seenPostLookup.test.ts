import { expect, test } from "bun:test";

import { openDatabase } from "../src/db";
import { HAS_SEEN_POST_SQL } from "../src/db/repositories/internalGraphql";

test("観測済みの判定は投稿 ID の索引から新しい順に引き、受信アカウントと対象の観測を全件たどらない", () => {
  const db = openDatabase(":memory:");
  try {
    const plan = (
      db
        .query(`EXPLAIN QUERY PLAN ${HAS_SEEN_POST_SQL}`)
        .all({ receiverId: 1, targetId: 1, postId: "1" }) as Array<{ detail: string }>
    ).map((row) => row.detail);
    expect(plan).toEqual([
      expect.stringContaining("SEARCH posts USING COVERING INDEX internal_graphql_posts_post_idx"),
      expect.stringContaining("SEARCH observations USING INTEGER PRIMARY KEY"),
    ]);
    // 計画の文字列は走査の向きを表さないので、バイトコードで新しい順 (Prev) にたどることを見る
    const opcodes = (
      db
        .query(`EXPLAIN ${HAS_SEEN_POST_SQL}`)
        .all({ receiverId: 1, targetId: 1, postId: "1" }) as Array<{ opcode: string }>
    ).map((row) => row.opcode);
    expect(opcodes).toContain("Prev");
    expect(opcodes).not.toContain("Next");
  } finally {
    db.close();
  }
});
