import { expect, test } from "bun:test";

import { createTestContext } from "./helpers/database";

/**
 * 本番で行数の多い表。表本体をたどって数えると、細い索引よりはるかに多くのページを読む
 * (観測の表のように応答本文を持つ表では、表本体の 1 ページに入る行がとくに少ない)。
 * 行数の少ない表 (受信アカウント、投稿先など) は対象にしない。
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
      const sqls = issued.filter(
        (candidate) =>
          /count\(\*\)/i.test(candidate) && new RegExp(`\\b${table}\\b`).test(candidate),
      );
      expect({ table, counted: sqls.length > 0 }).toEqual({ table, counted: true });
      for (const sql of sqls) {
        // 計画の全文は固定しない。SQLite の実行計画の表示は版によって変わりうる。
        // 副問い合わせだけが索引を使い、外側で表本体をたどる形も防ぐため、その表に触れる行をすべて見る
        const touching = (
          context.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
        )
          .map((row) => row.detail)
          .filter((detail) => new RegExp(`\\b${table}\\b`).test(detail));
        expect({ table, touched: touching.length > 0 }).toEqual({ table, touched: true });
        for (const detail of touching) {
          expect({ table, detail }).toEqual({
            table,
            detail: expect.stringContaining("USING COVERING INDEX"),
          });
        }
      }
    }
  } finally {
    context.db.close();
  }
});
