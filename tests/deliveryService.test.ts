import { describe, expect, test } from "bun:test";

import { DeliveryService, xSnowflakeTimestampMs } from "../src/services/deliveryService";
import { metrics } from "../src/utils/metrics";
import { addTarget, createRecordingSender, createTestContext } from "./helpers/database";

describe("DeliveryService", () => {
  test("Web Push と内部 GraphQL で同じ投稿を検出しても一度だけ送る", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "cloudflare" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "discord-channel" });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      const common = {
        targetId: target,
        postId: "123",
        postUrl: "https://x.com/cloudflare/status/123",
        kinds: ["posts"] as const,
        mediaTypes: [],
      };

      const results = await Promise.all([
        service.deliver({ ...common, source: "webpush", sourceRecordId: 1 }),
        service.deliver({ ...common, source: "internal_graphql", sourceRecordId: 2 }),
      ]);

      expect(sender.sent).toEqual(["discord-channel:https://x.com/cloudflare/status/123"]);
      expect(results).toEqual([
        { sent: 1, failed: 0, skipped: 0, filtered: 0 },
        { sent: 0, failed: 0, skipped: 1, filtered: 0 },
      ]);
      expect(
        context.deliveries
          .listRecent(10)
          .map((delivery) => `${delivery.source}:${delivery.status}`)
          .toSorted(),
      ).toEqual(["internal_graphql:skipped_duplicate", "webpush:sent"]);
    } finally {
      context.db.close();
    }
  });

  test("送信失敗時は claim を解放して再送できる", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "c1" });
      let shouldFail = true;
      const sender = {
        async sendPostUrl(): Promise<{ messageId: string; embedLinks: null }> {
          if (shouldFail) throw new Error("Discord down");
          return { messageId: "m", embedLinks: null };
        },
      };
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      const post = {
        source: "webpush" as const,
        sourceRecordId: 1,
        targetId: target,
        postId: "1",
        postUrl: "u",
        kinds: ["posts"] as const,
        mediaTypes: [],
      };

      expect(await service.deliver(post)).toEqual({ sent: 0, failed: 1, skipped: 0, filtered: 0 });
      shouldFail = false;
      expect(await service.deliver(post)).toEqual({ sent: 1, failed: 0, skipped: 0, filtered: 0 });
      expect(context.deliveries.listRecent(10, "failed")).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });

  test("同じ対象を複数チャンネルへ、同じチャンネルへ複数対象を送る", async () => {
    const context = createTestContext();
    try {
      const a = addTarget(context, { handle: "a" });
      const b = addTarget(context, { handle: "b" });
      context.routes.add({ targetId: a, guildId: "g", channelId: "c1" });
      context.routes.add({ targetId: a, guildId: "g", channelId: "c2" });
      context.routes.add({ targetId: b, guildId: "g", channelId: "c1" });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);

      await service.deliver({
        source: "webpush",
        sourceRecordId: 1,
        targetId: a,
        postId: "1",
        postUrl: "a1",
        kinds: ["posts"],
        mediaTypes: [],
      });
      await service.deliver({
        source: "webpush",
        sourceRecordId: 2,
        targetId: b,
        postId: "2",
        postUrl: "b2",
        kinds: ["posts"],
        mediaTypes: [],
      });

      expect(sender.sent).toEqual(["c1:a1", "c2:a1", "c1:b2"]);
    } finally {
      context.db.close();
    }
  });

  test("X の Snowflake から投稿時刻を復元する", () => {
    expect(xSnowflakeTimestampMs("2095684520301461802")).toBe(
      new Date("2026-09-04T01:25:00.232Z").getTime(),
    );
    expect(xSnowflakeTimestampMs("abc")).toBeNull();
  });

  test("FxEmbed 系で Embed Links がある送信だけ修復を予約する", async () => {
    const context = createTestContext();
    metrics.reset();
    try {
      const targetId = addTarget(context);
      context.routes.add({ targetId, guildId: "g", channelId: "c" });
      const scheduled: Array<{ channelId: string; messageId: string; sentAtMs: number }> = [];
      let embedLinks: boolean | null = true;
      const service = new DeliveryService(
        context.routes,
        context.deliveries,
        {
          async sendPostUrl() {
            return { messageId: "m", embedLinks };
          },
        },
        context.guildSettings,
        { schedule: (target) => scheduled.push(target) },
      );
      const post = (postId: string) => ({
        source: "webpush" as const,
        sourceRecordId: Number(postId),
        targetId,
        postId,
        postUrl: `https://x.com/example/status/${postId}`,
        kinds: ["posts"] as const,
        mediaTypes: [],
      });
      await service.deliver(post("1"));
      context.guildSettings.setLinkDomain("g", "fixupx.com");
      const before = Date.now();
      await service.deliver(post("2"));
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ channelId: "c", messageId: "m" });
      expect(scheduled[0]!.sentAtMs).toBeGreaterThanOrEqual(before);
      embedLinks = false;
      await service.deliver(post("3"));
      embedLinks = null;
      context.guildSettings.setLinkDomain("g", "fixvx.com");
      await service.deliver(post("4"));
      expect(scheduled).toHaveLength(1);
      expect(metrics.snapshot().counters["embed_repair.ineligible"]).toBe(2);
    } finally {
      context.db.close();
      metrics.reset();
    }
  });

  test("修復の予約が例外を投げても送信済みのままで再送しない", async () => {
    const context = createTestContext();
    try {
      const targetId = addTarget(context);
      const route = context.routes.add({ targetId, guildId: "g", channelId: "c" });
      context.guildSettings.setLinkDomain("g", "fixupx.com");
      let sends = 0;
      const service = new DeliveryService(
        context.routes,
        context.deliveries,
        {
          async sendPostUrl() {
            sends += 1;
            return { messageId: "m", embedLinks: true };
          },
        },
        context.guildSettings,
        {
          schedule() {
            throw new Error("schedule failed");
          },
        },
      );
      const result = await service.deliver({
        source: "webpush",
        sourceRecordId: 1,
        targetId,
        postId: "1",
        postUrl: "https://x.com/example/status/1",
        kinds: ["posts"],
        mediaTypes: [],
      });
      await service.drain();
      expect(result).toEqual({ sent: 1, failed: 0, skipped: 0, filtered: 0 });
      expect(sends).toBe(1);
      expect(context.deliveries.queueState(route.route.id, "1")).toBe("sent");
    } finally {
      context.db.close();
    }
  });
});
