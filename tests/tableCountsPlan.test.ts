import { expect, test } from "bun:test";

import { createTestContext } from "./helpers/database";

/**
 * 応答本文や生のフレームを行に持ち、本番で行数が多い表。表本体の 1 ページに入る行が少ないので、
 * 表本体をたどって数えると索引よりはるかに多くのページを読む。行数の少ない表 (受信アカウント、投稿先など) は対象にしない。
 */
const LARGE_TABLES = [
  "internal_graphql_observations",
  "internal_graphql_observation_posts",
  "discord_deliveries",
  "autopush_frames",
  "parsed_notifications",
  "external_exchanges",
];

test("行数の多い表は、表本体ではなく索引をたどって数える", () => {
  const context = createTestContext();
  try {
    // 実際に発行された SQL に実行計画をかけるので、数え方を変えた変更もそのまま確かめられる
    const issued: string[] = [];
    const query = context.db.query.bind(context.db);
    context.db.query = (sql: string) => {
      issued.push(sql);
      return query(sql);
    };
    context.maintenance.tableCounts();
    context.db.query = query;

    for (const table of LARGE_TABLES) {
      const sql = issued.find(
        (candidate) =>
          /count\(\*\)/i.test(candidate) && new RegExp(`\\b${table}\\b`).test(candidate),
      );
      expect(sql).toBeDefined();
      const details = (
        context.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
      ).map((row) => row.detail);
      // 計画の全文は固定しない。SQLite の実行計画の表示は版によって変わりうる
      expect({ table, plan: details.join("\n") }).toEqual({
        table,
        plan: expect.stringContaining("USING COVERING INDEX"),
      });
    }
  } finally {
    context.db.close();
  }
});
