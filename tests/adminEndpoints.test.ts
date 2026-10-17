import { describe, expect, test } from "bun:test";

import { canonicalizeQuery } from "../src/http/adminAuth";
import { createAdminRouter } from "../src/http/adminEndpoints";
import { hmacSha256Hex } from "../src/http/hmac";
import { clearRecentLogs, logger } from "../src/utils/logger";
import { addReceiver, addTarget, createTestContext, recentPostId } from "./helpers/database";

const SECRET = "test-admin-secret";

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
        ...context,
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
        ...context,
        receiverStatuses: () => [],
      });
      const base = "http://localhost:3000";

      expect((await router(await signedRequest(`${base}/admin/posts/abc`))).status).toBe(400);
      const response = await router(
        await signedRequest(`${base}/admin/posts/${originalId}?limit=1`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        postIds: string[];
        notifications: unknown[];
        observations: { count: number; lastFetchedAt: string; sightings: unknown[] };
        routes: Array<{ channelId: string; queue: unknown[] }>;
      };
      expect(body.postIds).toEqual([originalId, repostId]);
      expect(body.notifications).toHaveLength(1);
      expect(body.observations).toMatchObject({
        count: 2,
        lastFetchedAt: "2026-10-17T00:01:01.000Z",
        sightings: [{ postId: repostId, receiverLabel: "receiver-a", isNew: 1 }],
      });
      expect(body.routes.map((r) => r.channelId)).toEqual(["c1", "c2"]);
      expect(body.routes[0]?.queue).toMatchObject([{ state: "pending", source: "webpush" }]);
      expect(body.routes[1]).toMatchObject({
        id: filtered.id,
        kinds: { reposts: false },
        queue: [],
      });

      const unknown = await router(await signedRequest(`${base}/admin/posts/1`));
      expect(await unknown.json()).toMatchObject({
        postIds: ["1"],
        notifications: [],
        observations: { count: 0, lastFetchedAt: null, sightings: [] },
        routes: [],
      });
    } finally {
      context.db.close();
    }
  });

  test("シークレット未設定なら 503 を返す", async () => {
    const context = createTestContext();
    try {
      const router = createAdminRouter({
        adminApiSecret: undefined,
        ...context,
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
