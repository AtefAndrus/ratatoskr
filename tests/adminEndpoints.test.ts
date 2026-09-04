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
      context.routes.add({ targetId: target, guildId: "g", channelId: "c" });
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
