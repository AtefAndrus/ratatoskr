import { expect, test } from "bun:test";

import { addReceiver, addTarget, createTestContext, type TestContext } from "./helpers/database";

function observe(
  context: TestContext,
  input: {
    receiverId: number;
    targetId: number;
    fetchedAt: string;
    status?: number;
    error?: string | null;
    cursor?: string;
  },
): number {
  return context.observations.recordObservation(
    {
      receiverId: input.receiverId,
      targetId: input.targetId,
      fetchedAt: input.fetchedAt,
      completedAt: input.fetchedAt,
      queryId: "q",
      endpoint: "UserTweets",
      variablesJson: JSON.stringify(input.cursor === undefined ? {} : { cursor: input.cursor }),
      featuresJson: "{}",
      transactionId: null,
      responseStatus: input.status ?? 200,
      responseText: "{}",
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      error: input.error ?? null,
      parseError: null,
    },
    [],
  ).observationId;
}

test("補完の既知境界は、受信アカウントをまたいで最も古い正常取得と、カーソルなしで最も新しい正常取得から選ぶ", () => {
  const context = createTestContext();
  try {
    const first = addReceiver(context, "a");
    const second = addReceiver(context, "b");
    const target = addTarget(context, { handle: "example" });
    context.routes.add({ targetId: target, guildId: "g", channelId: "c" });
    context.db.query("UPDATE routes SET created_at = '2026-10-01T00:00:00.000Z'").run();
    observe(context, {
      receiverId: second,
      targetId: target,
      fetchedAt: "2026-10-02T00:00:00.000Z",
      status: 401,
    });
    observe(context, {
      receiverId: second,
      targetId: target,
      fetchedAt: "2026-10-02T01:00:00.000Z",
    });
    observe(context, {
      receiverId: first,
      targetId: target,
      fetchedAt: "2026-10-02T02:00:00.000Z",
    });
    observe(context, {
      receiverId: first,
      targetId: target,
      fetchedAt: "2026-10-03T00:00:00.000Z",
    });
    observe(context, {
      receiverId: second,
      targetId: target,
      fetchedAt: "2026-10-04T00:00:00.000Z",
    });
    observe(context, {
      receiverId: first,
      targetId: target,
      fetchedAt: "2026-10-05T00:00:00.000Z",
      error: "parse failed",
    });
    observe(context, {
      receiverId: second,
      targetId: target,
      fetchedAt: "2026-10-06T00:00:00.000Z",
      cursor: "bottom",
    });

    expect(context.backlog.ensure(target, "2026-10-07T00:00:00.000Z")?.notBefore).toBe(
      "2026-10-02T01:00:00.000Z",
    );

    context.db.query("UPDATE backlog_progress SET state = 'complete'").run();
    expect(context.backlog.ensure(target, "2026-10-07T00:00:00.000Z")?.notBefore).toBe(
      "2026-10-04T00:00:00.000Z",
    );
  } finally {
    context.db.close();
  }
});
