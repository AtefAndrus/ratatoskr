import { describe, expect, test } from "bun:test";

import { canonicalizeQuery } from "../src/http/adminAuth";
import { createAdminRouter } from "../src/http/adminEndpoints";
import {
  executeAdminRead,
  type AdminReadRepositories,
  type AdminReadRequest,
} from "../src/http/adminReads";
import { hmacSha256Hex } from "../src/http/hmac";
import { xSnowflakeTimestampMs } from "../src/services/deliveryService";
import { clearRecentLogs, logger } from "../src/utils/logger";
import { addReceiver, addTarget, createTestContext, recentPostId } from "./helpers/database";

const SECRET = "test-admin-secret";

function inProcessReader(repositories: AdminReadRepositories) {
  return async (request: AdminReadRequest) => ({
    ...executeAdminRead(repositories, request),
    headers: { "Content-Type": "application/json" },
  });
}

async function signedRequest(url: string, method = "GET", secret = SECRET): Promise<Request> {
  const parsed = new URL(url);
  const timestamp = Date.now();
  const message = `${method}\n${parsed.pathname}\n${canonicalizeQuery(parsed.searchParams)}\n${timestamp}`;
  const signature = await hmacSha256Hex(secret, message);
  return new Request(url, {
    method,
    headers: { "X-Admin-Timestamp": String(timestamp), "X-Admin-Signature": `sha256=${signature}` },
  });
}

describe("admin endpoints", () => {
  test.each([500, 503, 504])(
    "DB 読み取りのエラー %s を全エンドポイントでそのまま返す",
    async (status) => {
      const body = ' { "error": "reader failed" }\n';
      const router = createAdminRouter({
        adminApiSecret: SECRET,
        read: async () => ({
          status,
          body: new TextEncoder().encode(body),
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        }),
        receiverStatuses: () => {
          throw new Error("Failed DB reads must not request runtime status");
        },
      });
      for (const path of [
        "metrics",
        "backlog",
        "receivers",
        "targets",
        "notifications",
        "deliveries",
        "observations",
        "observations/1",
        "posts/1",
        "exchanges",
      ]) {
        const response = await router(await signedRequest(`http://localhost:3000/admin/${path}`));
        expect(response.status).toBe(status);
        expect(response.headers.get("Retry-After")).toBe("5");
        expect(await response.text()).toBe(body);
      }
    },
  );

  test("DB の JSON 本文を再整形せずに返す", async () => {
    const body = ' { "targets": ["日本語"], "routes": [] }\n';
    const router = createAdminRouter({
      adminApiSecret: SECRET,
      read: async () => ({ status: 200, body: new TextEncoder().encode(body), headers: {} }),
      receiverStatuses: () => [],
    });
    const response = await router(await signedRequest("http://localhost:3000/admin/targets"));
    expect(await response.text()).toBe(body);
  });

  test.each(["/admin/metrics", "/admin/receivers"])(
    "%s は子プロセスの本文が JSON として読めなければ JSON の 500 を返す",
    async (path) => {
      const router = createAdminRouter({
        adminApiSecret: SECRET,
        read: async () => ({
          status: 200,
          body: new TextEncoder().encode("not json"),
          headers: {},
        }),
        receiverStatuses: () => [],
      });
      const response = await router(await signedRequest(`http://localhost:3000${path}`));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Invalid admin database reader response" });
    },
  );

  test("認証と読み取り専用の制約を守る", async () => {
    const context = createTestContext();
    try {
      addReceiver(context);
      const target = addTarget(context, { handle: "example" });
      const route = context.routes.add({ targetId: target, guildId: "g", channelId: "c" }).route;
      context.backlog.ensure(target);
      context.backlog.startFromLatest(target, "cursor-1", "2026-09-03T00:00:00.000Z");
      context.deliveries.enqueue({
        targetId: target,
        routeId: route.id,
        postId: "1",
        postUrl: "https://x.com/example/status/1",
        kindsJson: '["posts"]',
        postCreatedAt: "2026-09-03T00:00:00.000Z",
        source: "internal_graphql",
        sourceRecordId: 1,
        queuedAt: "2026-09-03T00:00:00.000Z",
      });
      for (const postId of ["2", "3"]) {
        context.deliveries.enqueue({
          targetId: target,
          routeId: route.id,
          postId,
          postUrl: `https://x.com/example/status/${postId}`,
          kindsJson: '["posts"]',
          postCreatedAt: "2026-09-03T00:00:00.000Z",
          source: "internal_graphql",
          sourceRecordId: Number(postId),
          queuedAt: "2026-09-03T00:00:00.000Z",
        });
      }
      context.db.query("UPDATE delivery_queue SET state = 'sending' WHERE post_id = '2'").run();
      context.db.query("UPDATE delivery_queue SET state = 'failed' WHERE post_id = '3'").run();
      const router = createAdminRouter({
        adminApiSecret: SECRET,
        read: inProcessReader(context),
        receiverStatuses: () => [],
      });
      const base = "http://localhost:3000";

      expect((await router(await signedRequest(`${base}/admin/metrics`, "POST"))).status).toBe(405);
      expect((await router(new Request(`${base}/admin/metrics`))).status).toBe(401);
      expect(
        (await router(await signedRequest(`${base}/admin/metrics`, "GET", "wrong"))).status,
      ).toBe(401);
      expect((await router(await signedRequest(`${base}/admin/unknown`))).status).toBe(404);

      const metrics = await router(await signedRequest(`${base}/admin/metrics`));
      expect(metrics.status).toBe(200);
      expect(await metrics.json()).toMatchObject({
        tables: { receivers: 1, routes: 1 },
        receivers: [],
      });

      const targets = await router(await signedRequest(`${base}/admin/targets`));
      expect(await targets.json()).toMatchObject({
        routes: [{ handle: "example", channelId: "c" }],
      });

      const backlog = await router(await signedRequest(`${base}/admin/backlog`));
      expect(await backlog.json()).toMatchObject({
        queue: { pending: 1, sending: 1, failed: 1 },
        progress: [
          { targetHandle: "example", nextCursor: "cursor-1", lastStopReason: "page_saved" },
        ],
      });

      const receivers = await router(await signedRequest(`${base}/admin/receivers`));
      expect(JSON.stringify(await receivers.json())).not.toContain("csrf");

      expect((await router(await signedRequest(`${base}/admin/observations?limit=0`))).status).toBe(
        400,
      );
      expect((await router(await signedRequest(`${base}/admin/observations/999`))).status).toBe(
        404,
      );
      expect((await router(await signedRequest(`${base}/admin/observations/abc`))).status).toBe(
        400,
      );
      expect(
        (await router(await signedRequest(`${base}/admin/deliveries?status=bogus`))).status,
      ).toBe(400);

      clearRecentLogs();
      logger.warn("first warning", { value: 1 });
      logger.info("plain info");
      const logs = await router(await signedRequest(`${base}/admin/logs?level=warn&lines=10`));
      const body = await logs.text();
      expect(body).toContain("first warning");
      expect(body).not.toContain("plain info");
    } finally {
      context.db.close();
    }
  });

  test("投稿 ID から通知、観測、投稿先ごとのキュー状態をまとめて返す", async () => {
    const context = createTestContext();
    try {
      const receiver = addReceiver(context);
      const target = addTarget(context, { handle: "example" });
      const other = addTarget(context, { handle: "other" });
      const route = context.routes.add({ targetId: target, guildId: "g", channelId: "c1" }).route;
      const filtered = context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "c2",
        kinds: { reposts: false },
      }).route;
      context.routes.add({ targetId: other, guildId: "g", channelId: "c3" });
      const originalId = recentPostId(-60_000);
      const repostId = recentPostId();
      const frameId = context.notifications.insertFrame({
        receiverId: receiver,
        receivedAt: "2026-10-17T00:00:00.000Z",
        rawText: "{}",
        messageType: null,
        channelId: null,
        version: null,
        encryptedData: null,
        headersJson: null,
      });
      const notificationId = context.notifications.insertParsed({
        frameId,
        parsedAt: "2026-10-17T00:00:00.000Z",
        parserVersion: "test",
        decryptedText: null,
        payloadJson: null,
        notificationKind: "post",
        postId: originalId,
        postUrl: `https://x.com/author/status/${originalId}`,
        authorHandle: "author",
        notificationPostId: repostId,
        notificationTitle: null,
        targetId: target,
        parseError: null,
      });
      const observation = {
        receiverId: receiver,
        targetId: target,
        completedAt: "2026-10-17T00:00:01.000Z",
        queryId: "q",
        endpoint: "UserTweets",
        variablesJson: "{}",
        featuresJson: "{}",
        transactionId: null,
        responseStatus: 200,
        responseText: null,
        rateLimitLimit: null,
        rateLimitRemaining: null,
        rateLimitResetAt: null,
        error: null,
        parseError: null,
      };
      const post = {
        postId: repostId,
        createdAt: null,
        authorUserId: null,
        authorHandle: "example",
        typesJson: '["repost"]',
        referencedPostIdsJson: JSON.stringify([originalId]),
        referencedAuthorHandle: "author",
        mediaTypesJson: null,
        rawResultJson: "{}",
        isTargetAuthor: 1,
      };
      for (const fetchedAt of ["2026-10-17T00:00:01.000Z", "2026-10-17T00:01:01.000Z"]) {
        context.observations.recordObservation({ ...observation, fetchedAt }, [post]);
      }
      context.deliveries.enqueue({
        targetId: target,
        routeId: route.id,
        postId: repostId,
        postUrl: `https://x.com/author/status/${originalId}`,
        kindsJson: '["reposts"]',
        postCreatedAt: "2026-10-17T00:00:00.000Z",
        source: "webpush",
        sourceRecordId: notificationId,
        queuedAt: "2026-10-17T00:00:00.000Z",
      });
      const router = createAdminRouter({
        adminApiSecret: SECRET,
        read: inProcessReader(context),
        receiverStatuses: () => [],
      });
      const base = "http://localhost:3000";

      expect((await router(await signedRequest(`${base}/admin/posts/abc`))).status).toBe(400);
      const response = await router(
        await signedRequest(`${base}/admin/posts/${originalId}?limit=1`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        postIds: Array<{ postId: string; postedAt: string }>;
        notifications: unknown[];
        observations: { count: number; lastFetchedAt: string; sightings: unknown[] };
        routes: Array<{ channelId: string; queue: unknown[] }>;
      };
      expect(body.postIds.map((entry) => entry.postId)).toEqual([originalId, repostId]);
      expect(body.postIds[1]?.postedAt).toBe(
        new Date(xSnowflakeTimestampMs(repostId) ?? 0).toISOString(),
      );
      expect(body.notifications).toHaveLength(1);
      expect(body.observations).toMatchObject({
        count: 2,
        lastFetchedAt: "2026-10-17T00:01:01.000Z",
        sightings: [{ postId: repostId, receiverLabel: "receiver-a", isNew: 1 }],
      });
      expect(body.routes.map((r) => r.channelId)).toEqual(["c1", "c2", "c3"]);
      expect(body.routes[0]?.queue).toMatchObject([{ state: "pending", source: "webpush" }]);
      expect(body.routes[1]).toMatchObject({
        id: filtered.id,
        kinds: { reposts: false },
        queue: [],
      });

      const unknown = await router(await signedRequest(`${base}/admin/posts/1`));
      expect(await unknown.json()).toMatchObject({
        postIds: [{ postId: "1" }],
        notifications: [],
        observations: { count: 0, lastFetchedAt: null, sightings: [] },
        routes: [{ queue: [] }, { queue: [] }, { queue: [] }],
      });

      const outOfRange = await router(
        await signedRequest(`${base}/admin/posts/37000000000000000000000`),
      );
      expect(outOfRange.status).toBe(200);
      expect(await outOfRange.json()).toMatchObject({ postIds: [{ postedAt: null }] });
    } finally {
      context.db.close();
    }
  });

  test("通知の無いリポストと他の対象のタイムラインに出た投稿も投稿先と送信履歴までたどる", async () => {
    const context = createTestContext();
    try {
      const receiver = addReceiver(context);
      const target = addTarget(context, { handle: "example" });
      const author = addTarget(context, { handle: "Author" });
      const route = context.routes.add({ targetId: target, guildId: "g", channelId: "c1" }).route;
      context.routes.add({ targetId: author, guildId: "g", channelId: "c2" });
      const originalId = recentPostId(-60_000);
      const repostId = recentPostId();
      const recorded = context.observations.recordObservation(
        {
          receiverId: receiver,
          targetId: target,
          fetchedAt: "2026-10-17T00:00:01.000Z",
          completedAt: "2026-10-17T00:00:01.000Z",
          queryId: "q",
          endpoint: "UserTweets",
          variablesJson: "{}",
          featuresJson: "{}",
          transactionId: null,
          responseStatus: 200,
          responseText: null,
          rateLimitLimit: null,
          rateLimitRemaining: null,
          rateLimitResetAt: null,
          error: null,
          parseError: null,
        },
        [
          {
            postId: repostId,
            createdAt: null,
            authorUserId: null,
            authorHandle: "example",
            typesJson: '["repost"]',
            referencedPostIdsJson: JSON.stringify([originalId]),
            referencedAuthorHandle: "author",
            mediaTypesJson: null,
            rawResultJson: "{}",
            isTargetAuthor: 1,
          },
          {
            postId: originalId,
            createdAt: null,
            authorUserId: null,
            authorHandle: "author",
            typesJson: '["original"]',
            referencedPostIdsJson: "[]",
            referencedAuthorHandle: null,
            mediaTypesJson: null,
            rawResultJson: "{}",
            isTargetAuthor: 0,
          },
        ],
      );
      const sourceRecordId = recorded.targetPosts[0]?.id ?? 0;
      context.deliveries.enqueue({
        targetId: target,
        routeId: route.id,
        postId: repostId,
        postUrl: `https://x.com/author/status/${originalId}`,
        kindsJson: '["reposts"]',
        postCreatedAt: "2026-10-17T00:00:00.000Z",
        source: "internal_graphql",
        sourceRecordId,
        queuedAt: "2026-10-17T00:00:01.000Z",
      });
      for (const [attemptedAt, status] of [
        ["2026-10-17T00:00:02.000Z", "failed"],
        ["2026-10-17T00:00:40.000Z", "sent"],
        ["2026-10-17T00:05:00.000Z", "skipped_duplicate"],
      ] as const) {
        context.deliveries.record({
          source: "internal_graphql",
          sourceRecordId,
          routeId: route.id,
          attemptedAt,
          status,
          error: status === "failed" ? "Missing Access" : null,
        });
      }
      context.db
        .query("UPDATE delivery_queue SET state = 'sent', updated_at = '2026-10-17T00:00:41.000Z'")
        .run();
      const router = createAdminRouter({
        adminApiSecret: SECRET,
        read: inProcessReader(context),
        receiverStatuses: () => [],
      });

      const response = await router(
        await signedRequest(`http://localhost:3000/admin/posts/${originalId}`),
      );
      const body = (await response.json()) as {
        postIds: Array<{ postId: string }>;
        observations: { count: number };
        routes: Array<{
          channelId: string;
          queue: Array<{
            state: string;
            attempts: Array<{ status: string; error: string | null }>;
          }>;
        }>;
      };
      expect(body.postIds.map((entry) => entry.postId)).toEqual([originalId, repostId]);
      expect(body.observations.count).toBe(2);
      expect(body.routes.map((r) => r.channelId)).toEqual(["c1", "c2"]);
      expect(body.routes[0]?.queue).toMatchObject([
        {
          state: "sent",
          attempts: [
            { status: "failed", error: "Missing Access" },
            { status: "sent", error: null },
          ],
        },
      ]);
      expect(body.routes[1]?.queue).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  test("送信履歴はキュー行ごとの配信元と、投入直後と最終更新直前の範囲だけから拾う", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      const route = context.routes.add({ targetId: target, guildId: "g", channelId: "c1" }).route;
      const migrated = context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "c2",
      }).route;
      const originalId = recentPostId(-120_000);
      const firstRepost = recentPostId(-60_000);
      const secondRepost = recentPostId();
      const queued = "2026-10-15T00:00:00.000Z";
      const enqueue = (routeId: number, postId: string, postUrl: string, sourceRecordId: number) =>
        context.deliveries.enqueue({
          targetId: target,
          routeId,
          postId,
          postUrl,
          kindsJson: '["reposts"]',
          postCreatedAt: queued,
          source: "internal_graphql",
          sourceRecordId,
          queuedAt: queued,
        });
      const origin = addTarget(context, { handle: "Author" });
      context.routes.add({ targetId: origin, guildId: "g", channelId: "c3" });
      // 監視対象 Author の元投稿そのものは観測せず、example のリポストだけを観測する。
      const sighting = context.observations.recordObservation(
        {
          receiverId: addReceiver(context),
          targetId: target,
          fetchedAt: "2026-10-15T00:14:00.000Z",
          completedAt: "2026-10-15T00:14:00.000Z",
          queryId: "q",
          endpoint: "UserTweets",
          variablesJson: "{}",
          featuresJson: "{}",
          transactionId: null,
          responseStatus: 200,
          responseText: null,
          rateLimitLimit: null,
          rateLimitRemaining: null,
          rateLimitResetAt: null,
          error: null,
          parseError: null,
        },
        [
          {
            postId: firstRepost,
            createdAt: null,
            authorUserId: null,
            authorHandle: "example",
            typesJson: '["repost"]',
            referencedPostIdsJson: JSON.stringify([originalId]),
            referencedAuthorHandle: "author",
            mediaTypesJson: null,
            rawResultJson: "{}",
            isTargetAuthor: 1,
          },
        ],
      );
      const sightingId = sighting.targetPosts[0]?.id ?? 0;
      const notificationFor = (repostId: string) =>
        context.notifications.insertParsed({
          frameId: context.notifications.insertFrame({
            receiverId: 1,
            receivedAt: queued,
            rawText: "{}",
            messageType: null,
            channelId: null,
            version: null,
            encryptedData: null,
            headersJson: null,
          }),
          parsedAt: queued,
          parserVersion: "test",
          decryptedText: null,
          payloadJson: null,
          notificationKind: "post",
          postId: originalId,
          postUrl: `https://x.com/author/status/${originalId}`,
          authorHandle: null,
          notificationPostId: repostId,
          notificationTitle: null,
          targetId: target,
          parseError: null,
        });
      const firstNotification = notificationFor(firstRepost);
      const secondNotification = notificationFor(secondRepost);
      // キュー行自身の配信元 (501、502) の観測投稿は作らない。保持期間で元の観測が消えた状態にあたる。
      enqueue(route.id, firstRepost, `https://x.com/author/status/${originalId}`, 501);
      enqueue(route.id, secondRepost, `https://x.com/author/status/${originalId}`, 502);
      enqueue(migrated.id, firstRepost, `https://x.com/example/status/${firstRepost}`, 501);
      context.db
        .query(
          "UPDATE delivery_queue SET updated_at = '2026-10-17T00:00:00.000Z' WHERE source_record_id = 501",
        )
        .run();
      context.db
        .query(
          "UPDATE delivery_queue SET updated_at = '2026-10-15T00:30:00.000Z' WHERE source_record_id = 502",
        )
        .run();
      for (const [source, sourceRecordId, attemptedAt, status] of [
        ["internal_graphql", 501, "2026-10-15T00:10:00.000Z", "failed"],
        ["webpush", firstNotification, "2026-10-15T00:12:00.000Z", "failed"],
        ["internal_graphql", sightingId, "2026-10-15T00:15:00.000Z", "failed"],
        ["internal_graphql", 502, "2026-10-15T00:20:00.000Z", "sent"],
        ["webpush", secondNotification, "2026-10-15T00:25:00.000Z", "skipped_duplicate"],
        ["internal_graphql", 501, "2026-10-16T00:00:00.000Z", "failed"],
        ["internal_graphql", 501, "2026-10-16T23:50:00.000Z", "failed"],
      ] as const) {
        context.deliveries.record({
          source,
          sourceRecordId,
          routeId: route.id,
          attemptedAt,
          status,
        });
      }
      const router = createAdminRouter({
        adminApiSecret: SECRET,
        read: inProcessReader(context),
        receiverStatuses: () => [],
      });

      const response = await router(
        await signedRequest(`http://localhost:3000/admin/posts/${originalId}`),
      );
      const body = (await response.json()) as {
        routes: Array<{
          channelId: string;
          queue: Array<{ postId: string; attempts: Array<{ attemptedAt: string }> }>;
        }>;
      };
      const attemptsByPost = Object.fromEntries(
        (body.routes[0]?.queue ?? []).map((entry) => [
          entry.postId,
          entry.attempts.map((attempt) => attempt.attemptedAt),
        ]),
      );
      expect(attemptsByPost).toEqual({
        [firstRepost]: [
          "2026-10-15T00:10:00.000Z",
          "2026-10-15T00:12:00.000Z",
          "2026-10-15T00:15:00.000Z",
          "2026-10-16T23:50:00.000Z",
        ],
        [secondRepost]: ["2026-10-15T00:20:00.000Z", "2026-10-15T00:25:00.000Z"],
      });
      expect(body.routes.map((r) => r.channelId)).toEqual(["c1", "c2", "c3"]);
      expect(body.routes[1]?.queue.map((entry) => entry.postId)).toEqual([firstRepost]);
      expect(body.routes[2]?.queue).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  test("シークレット未設定なら 503 を返す", async () => {
    const context = createTestContext();
    try {
      const router = createAdminRouter({
        adminApiSecret: undefined,
        read: inProcessReader(context),
        receiverStatuses: () => [],
      });
      expect(
        (await router(await signedRequest("http://localhost:3000/admin/metrics"))).status,
      ).toBe(503);
    } finally {
      context.db.close();
    }
  });
});
