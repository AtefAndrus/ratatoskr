import { expect, test } from "bun:test";

import { createTestContext } from "./helpers/database";

test("表の行数は表本体ではなく索引をたどって数える", () => {
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

    const counts = issued.filter((sql) => /count\(\*\)/i.test(sql));
    const plans = new Map(
      counts.map((sql) => [
        sql,
        (context.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
          (row) => row.detail,
        ),
      ]),
    );
    const observations = [...plans].find(([sql]) => /\binternal_graphql_observations\b/.test(sql));
    expect(observations).toBeDefined();
    // 応答本文を持つ表は 1 ページに入る行が少なく、表本体をたどると索引より何倍も読む
    expect(observations?.[1].join("\n")).toContain("USING COVERING INDEX");
    for (const [sql, details] of plans) {
      expect({ sql, details }).not.toEqual({
        sql,
        details: expect.arrayContaining([expect.stringContaining("INTEGER PRIMARY KEY")]),
      });
    }
  } finally {
    context.db.close();
  }
});
