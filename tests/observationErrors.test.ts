import { expect, test } from "bun:test";

import { addReceiver, addTarget, createTestContext } from "./helpers/database";

test("失敗した観測の一覧は部分索引をたどり、失敗の 4 つの形をすべて新しい順に返す", () => {
  const context = createTestContext();
  try {
    const receiverId = addReceiver(context);
    const example = addTarget(context, { handle: "example" });
    const other = addTarget(context, { handle: "other" });
    const observe = (
      targetId: number,
      failure: { responseStatus?: number | null; error?: string; parseError?: string } = {},
    ) =>
      context.observations.recordObservation(
        {
          receiverId,
          targetId,
          fetchedAt: "2026-09-03T00:00:00.000Z",
          completedAt: "2026-09-03T00:00:00.100Z",
          queryId: "q",
          endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
          variablesJson: "{}",
          featuresJson: "{}",
          transactionId: null,
          responseStatus: failure.responseStatus === undefined ? 200 : failure.responseStatus,
          responseText: null,
          rateLimitLimit: null,
          rateLimitRemaining: null,
          rateLimitResetAt: null,
          error: failure.error ?? null,
          parseError: failure.parseError ?? null,
        },
        [],
      ).observationId;
    observe(example);
    const notFound = observe(example, { responseStatus: 404 });
    const unreachable = observe(example, {
      responseStatus: null,
      error: "The operation timed out.",
    });
    observe(other, { responseStatus: 404 });
    const graphqlError = observe(example, { parseError: "X内部GraphQL APIエラー: OverCapacity" });
    const thrown = observe(example, { error: "保存に失敗" });
    observe(example);

    // 実際に発行された SQL に実行計画をかけるので、条件の書き方を変えた変更もそのまま確かめられる
    const issued: string[] = [];
    const query = context.db.query.bind(context.db);
    context.db.query = (sql: string) => {
      issued.push(sql);
      return query(sql);
    };
    const listed = context.observations.listRecent(10, {
      errorsOnly: true,
      targetHandle: "example",
    });
    context.db.query = query;

    expect(listed.map((row) => row.id)).toEqual([thrown, graphqlError, unreachable, notFound]);
    expect(context.observations.listRecent(10, { errorsOnly: true })).toHaveLength(5);
    expect(context.observations.listRecent(10)).toHaveLength(7);
    const details = (
      context.db.query(`EXPLAIN QUERY PLAN ${issued.at(-1)!}`).all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .filter((detail) => /\bobservations\b/.test(detail));
    // 計画の全文は固定しない。SQLite の実行計画の表示は版によって変わりうる。
    expect(details).toEqual([expect.stringContaining("internal_graphql_observations_error_idx")]);
  } finally {
    context.db.close();
  }
});
