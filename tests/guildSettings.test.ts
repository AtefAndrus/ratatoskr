import { describe, expect, test } from "bun:test";

import { DeliveryService, rewritePostUrl } from "../src/services/deliveryService";
import { WatchService } from "../src/services/watchService";
import { addTarget, createRecordingSender, createTestContext } from "./helpers/database";

describe("投稿 URL のドメイン設定", () => {
  test("既定は x.com で、サーバーごとに置き換えられる", () => {
    const context = createTestContext();
    try {
      expect(context.guildSettings.get("g1")).toEqual({ guildId: "g1", linkDomain: "x.com" });
      context.guildSettings.setLinkDomain("g1", "fixupx.com");
      context.guildSettings.setLinkDomain("g1", "fixvx.com");
      expect(context.guildSettings.get("g1").linkDomain).toBe("fixvx.com");
      expect(context.guildSettings.get("g2").linkDomain).toBe("x.com");
    } finally {
      context.db.close();
    }
  });

  test("x.com のホストだけを差し替える", () => {
    expect(rewritePostUrl("https://x.com/example/status/1", "fixupx.com")).toBe(
      "https://fixupx.com/example/status/1",
    );
    expect(rewritePostUrl("https://x.com/i/web/status/1", "fixvx.com")).toBe(
      "https://fixvx.com/i/web/status/1",
    );
    expect(rewritePostUrl("https://x.com/example/status/1", "x.com")).toBe(
      "https://x.com/example/status/1",
    );
    expect(rewritePostUrl("https://example.com/x", "fixupx.com")).toBe("https://example.com/x");
    expect(rewritePostUrl("not a url", "fixupx.com")).toBe("not a url");
  });

  test("配信時にサーバーの設定を適用し、重複排除キーは元の投稿 ID のまま", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g1", channelId: "c1" });
      context.routes.add({ targetId: target, guildId: "g2", channelId: "c2" });
      context.guildSettings.setLinkDomain("g1", "fixupx.com");
      const sender = createRecordingSender();
      const service = new DeliveryService(
        context.routes,
        context.deliveries,
        sender,
        context.guildSettings,
      );

      const post = {
        source: "webpush" as const,
        sourceRecordId: 1,
        targetId: target,
        postId: "1",
        postUrl: "https://x.com/example/status/1",
        kinds: ["posts"] as const,
      };
      await service.deliver(post);
      expect(
        await service.deliver({ ...post, source: "internal_graphql", sourceRecordId: 2 }),
      ).toEqual({
        sent: 0,
        failed: 0,
        skipped: 2,
        filtered: 0,
      });
      expect(sender.sent).toEqual([
        "c1:https://fixupx.com/example/status/1",
        "c2:https://x.com/example/status/1",
      ]);
    } finally {
      context.db.close();
    }
  });

  test("autocomplete 用の候補はサーバー内の経路から入力で絞る", () => {
    const context = createTestContext();
    try {
      const news = addTarget(context, { handle: "news_jp", displayName: "ニュース" });
      const tech = addTarget(context, { handle: "techblog", displayName: "Tech Blog" });
      context.routes.add({ targetId: news, guildId: "g1", channelId: "c1" });
      context.routes.add({ targetId: news, guildId: "g1", channelId: "c2" });
      context.routes.add({ targetId: tech, guildId: "g1", channelId: "c1" });
      context.routes.add({ targetId: tech, guildId: "g2", channelId: "c9" });
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        {
          configureTarget: () => Promise.reject(new Error("unused")),
          requestReconcile: () => undefined,
        },
        context.guildSettings,
      );

      expect(service.suggestHandles("g1", "").map((item) => item.handle)).toEqual([
        "news_jp",
        "techblog",
      ]);
      expect(service.suggestHandles("g1", "@Tech").map((item) => item.handle)).toEqual([
        "techblog",
      ]);
      expect(service.suggestHandles("g1", "ニュ").map((item) => item.handle)).toEqual(["news_jp"]);
      expect(service.suggestHandles("g2", "news")).toEqual([]);
      expect(service.getLinkDomain("g1")).toBe("x.com");
      service.setLinkDomain("g1", "fixupx.com");
      expect(service.getLinkDomain("g1")).toBe("fixupx.com");
    } finally {
      context.db.close();
    }
  });
});
