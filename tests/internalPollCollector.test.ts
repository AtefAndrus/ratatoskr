import { describe, expect, test } from "bun:test";

import type { NewTargetPost } from "../src/db/repositories/internalGraphql";
import {
  deliverNewInternalPosts,
  InternalPollCollector,
} from "../src/pipeline/internalPollCollector";
import { DeliveryService } from "../src/services/deliveryService";
import type { InternalTimelineFetchResult, XInternalGraphqlClient } from "../src/x/internalGraphql";
import {
  addReceiver,
  addTarget,
  createRecordingSender,
  createTestContext,
} from "./helpers/database";

describe("内部 GraphQL からの Discord 通知", () => {
  test("起動前の初出投稿は保存対象に留め、起動後の投稿だけを送る", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "discord-channel" });
      const sender = createRecordingSender();
      const result = await deliverNewInternalPosts({
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        target: { id: target, handle: "example" },
        posts: [
          createPost(1, "100", "2026-09-04T00:00:00.000Z"),
          createPost(2, "101", "2026-09-04T00:01:00.000Z"),
        ],
        deliveryNotBefore: "2026-09-04T00:00:30.000Z",
        attemptedAt: "2026-09-04T00:01:10.000Z",
      });

      expect(result).toEqual({ sent: 1, failed: 0, skipped: 0, filtered: 0, suppressed: 1 });
      expect(sender.sent).toEqual(["discord-channel:https://x.com/example/status/101"]);
    } finally {
      context.db.close();
    }
  });

  test("リポストは参照元の投稿 URL を送る", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "discord-channel" });
      const sender = createRecordingSender();
      await deliverNewInternalPosts({
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        target: { id: target, handle: "example" },
        posts: [
          createPost(1, "200", "2026-09-04T00:01:00.000Z", ["repost"], ["199"], "origin_user"),
          createPost(2, "201", "2026-09-04T00:02:00.000Z", ["repost"], ["198"]),
        ],
        deliveryNotBefore: "2026-09-04T00:00:30.000Z",
        attemptedAt: "2026-09-04T00:01:10.000Z",
      });
      expect(sender.sent).toEqual([
        "discord-channel:https://x.com/origin_user/status/199",
        "discord-channel:https://x.com/i/web/status/198",
      ]);
    } finally {
      context.db.close();
    }
  });

  test("収集ループは DB の監視対象を読み直し、観測を保存して新規投稿を配信する", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { userId: "42", handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "c1" });
      const sender = createRecordingSender();
      const controller = new AbortController();
      const fetched: string[] = [];
      const client = {
        async fetchUserTweetsAndReplies(input: {
          userId: string;
          handle: string;
        }): Promise<InternalTimelineFetchResult> {
          fetched.push(input.handle);
          controller.abort();
          return {
            fetchedAt: "2026-09-05T00:00:00.000Z",
            completedAt: "2026-09-05T00:00:00.500Z",
            queryId: "q",
            endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
            variables: { userId: input.userId },
            features: {},
            transactionId: null,
            responseStatus: 200,
            responseText: "{}",
            rateLimitLimit: 50,
            rateLimitRemaining: 49,
            rateLimitResetAt: null,
            error: null,
            parseError: null,
            posts: [
              {
                postId: "500",
                createdAt: "2026-09-05T00:00:00.000Z",
                authorUserId: "42",
                authorHandle: "example",
                types: ["reply"],
                referencedPostIds: ["1"],
                referencedAuthorHandle: null,
                rawResult: {},
              },
            ],
          };
        },
      } as unknown as XInternalGraphqlClient;
      const collector = new InternalPollCollector({
        receiverId,
        receiverLabel: "receiver-a",
        client,
        targets: context.targets,
        observations: context.observations,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        deliveryNotBefore: "2026-09-04T00:00:00.000Z",
        selectTargets: (targets) => targets,
      });

      await collector.run(controller.signal);

      expect(fetched).toEqual(["example"]);
      expect(sender.sent).toEqual(["c1:https://x.com/example/status/500"]);
      expect(collector.snapshot()).toMatchObject({
        targets: ["example"],
        rateLimitRemaining: 49,
        lastError: null,
      });
      expect(context.observations.listRecent(10)).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });

  test("担当外の監視対象は取得せず、取得ごとに HTTP ステータスを報告する", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const mine = addTarget(context, { userId: "42", handle: "mine" });
      const theirs = addTarget(context, { userId: "43", handle: "theirs" });
      context.routes.add({ targetId: mine, guildId: "g", channelId: "c1" });
      context.routes.add({ targetId: theirs, guildId: "g", channelId: "c1" });
      const controller = new AbortController();
      const fetched: string[] = [];
      const statuses: Array<number | null> = [];
      const client = {
        async fetchUserTweetsAndReplies(input: {
          userId: string;
          handle: string;
        }): Promise<InternalTimelineFetchResult> {
          fetched.push(input.handle);
          return {
            fetchedAt: "2026-09-05T00:00:00.000Z",
            completedAt: "2026-09-05T00:00:00.500Z",
            queryId: "q",
            endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
            variables: { userId: input.userId },
            features: {},
            transactionId: null,
            responseStatus: 401,
            responseText: null,
            rateLimitLimit: null,
            rateLimitRemaining: null,
            rateLimitResetAt: null,
            error: null,
            parseError: null,
            posts: [],
          };
        },
      } as unknown as XInternalGraphqlClient;
      const collector = new InternalPollCollector({
        receiverId,
        receiverLabel: "receiver-a",
        client,
        targets: context.targets,
        observations: context.observations,
        delivery: null,
        deliveryNotBefore: "2026-09-04T00:00:00.000Z",
        selectTargets: (targets) => targets.filter((target) => target.id === mine),
        onPollResponse: (responseStatus) => {
          statuses.push(responseStatus);
          controller.abort();
        },
      });

      await collector.run(controller.signal);

      expect(fetched).toEqual(["mine"]);
      expect(collector.snapshot().targets).toEqual(["mine"]);
      expect(statuses).toEqual([401]);
    } finally {
      context.db.close();
    }
  });

  test("停止後に返ってきた応答は報告しない", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      addTarget(context, { userId: "42", handle: "example" });
      const controller = new AbortController();
      const statuses: Array<number | null> = [];
      const client = {
        async fetchUserTweetsAndReplies(input: {
          userId: string;
          handle: string;
        }): Promise<InternalTimelineFetchResult> {
          // 取得中に停止が指示された状況。古い認証情報の結果を次のループへ持ち越さない。
          controller.abort();
          return {
            fetchedAt: "2026-09-05T00:00:00.000Z",
            completedAt: "2026-09-05T00:00:00.500Z",
            queryId: "q",
            endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
            variables: { userId: input.userId },
            features: {},
            transactionId: null,
            responseStatus: 401,
            responseText: null,
            rateLimitLimit: null,
            rateLimitRemaining: null,
            rateLimitResetAt: null,
            error: null,
            parseError: null,
            posts: [],
          };
        },
      } as unknown as XInternalGraphqlClient;
      const collector = new InternalPollCollector({
        receiverId,
        receiverLabel: "receiver-a",
        client,
        targets: context.targets,
        observations: context.observations,
        delivery: null,
        deliveryNotBefore: "2026-09-04T00:00:00.000Z",
        selectTargets: (targets) => targets,
        onPollResponse: (responseStatus) => statuses.push(responseStatus),
      });

      await collector.run(controller.signal);

      expect(statuses).toEqual([]);
    } finally {
      context.db.close();
    }
  });
});

function createPost(
  id: number,
  postId: string,
  createdAt: string,
  types: string[] = ["original"],
  referencedPostIds: string[] = [],
  referencedAuthorHandle: string | null = null,
): NewTargetPost {
  return {
    id,
    postId,
    createdAt,
    authorHandle: "example",
    typesJson: JSON.stringify(types),
    referencedPostIdsJson: JSON.stringify(referencedPostIds),
    referencedAuthorHandle,
  };
}
