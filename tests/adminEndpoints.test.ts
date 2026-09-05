import { describe, expect, test } from "bun:test";

import { canonicalizeQuery } from "../src/http/adminAuth";
import { createAdminRouter } from "../src/http/adminEndpoints";
import { hmacSha256Hex } from "../src/http/hmac";
import { clearRecentLogs, logger } from "../src/utils/logger";
import { addReceiver, addTarget, createTestContext } from "./helpers/database";

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
