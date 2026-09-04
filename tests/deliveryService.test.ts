import { describe, expect, test } from "bun:test";

import { DeliveryService, xSnowflakeTimestampMs } from "../src/services/deliveryService";
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
        async sendPostUrl(): Promise<{ messageId: string }> {
          if (shouldFail) throw new Error("Discord down");
          return { messageId: "m" };
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
      });
      await service.deliver({
        source: "webpush",
        sourceRecordId: 2,
        targetId: b,
        postId: "2",
        postUrl: "b2",
        kinds: ["posts"],
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
});
