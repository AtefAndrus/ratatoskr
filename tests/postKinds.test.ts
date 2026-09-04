import { describe, expect, test } from "bun:test";

import { describeKinds, kindsFromTypesJson } from "../src/postKinds";
import { DeliveryService } from "../src/services/deliveryService";
import { WatchService } from "../src/services/watchService";
import { extractTweetResult } from "../src/x/internalGraphql";
import {
  addReceiver,
  addTarget,
  createRecordingSender,
  createTestContext,
} from "./helpers/database";

async function failingResolver(): Promise<readonly ["posts"]> {
  throw new Error("lookup failed");
}

describe("投稿種別のフィルタ", () => {
  test("経路は種別ごとの許可を持ち、再登録で指定した項目だけ更新する", () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      const first = context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "c",
        kinds: { replies: false },
      });
      expect(first.created).toBe(true);
      expect(first.route.kinds).toEqual({
        posts: true,
        quotes: true,
        reposts: true,
        replies: false,
      });
      const second = context.routes.add({ targetId: target, guildId: "g", channelId: "c" });
      expect(second.created).toBe(false);
      expect(second.route.kinds.replies).toBe(false);
      const third = context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "c",
        kinds: { reposts: false },
      });
      expect(third.route.kinds).toEqual({
        posts: true,
        quotes: true,
        reposts: false,
        replies: false,
      });
      expect(describeKinds(third.route.kinds)).toBe("除外: リポスト, 返信");
      expect(describeKinds(first.route.kinds)).toBe("除外: 返信");
      expect(describeKinds({ posts: true, quotes: true, reposts: true, replies: true })).toBe(
        "すべて",
      );
    } finally {
      context.db.close();
    }
  });

  test("内部 GraphQL の分類を種別に対応づける", () => {
    expect(kindsFromTypesJson('["original"]')).toEqual(["posts"]);
    expect(kindsFromTypesJson('["repost","quote"]')).toEqual(["reposts", "quotes"]);
    expect(kindsFromTypesJson('["reply","quote"]')).toEqual(["replies", "quotes"]);
    expect(kindsFromTypesJson("null")).toEqual([]);
  });

  test("種別が確定している投稿は OR 条件で経路ごとに送り分ける", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "all" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "no-replies",
        kinds: { replies: false },
      });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "reposts-only",
        kinds: { posts: false, quotes: false, replies: false },
      });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      const base = { source: "internal_graphql" as const, targetId: target };

      expect(
        await service.deliver({
          ...base,
          sourceRecordId: 1,
          postId: "1",
          postUrl: "reply",
          kinds: ["replies"],
        }),
      ).toEqual({ sent: 1, failed: 0, skipped: 0, filtered: 2 });
      expect(
        await service.deliver({
          ...base,
          sourceRecordId: 2,
          postId: "2",
          postUrl: "repost-quote",
          kinds: ["reposts", "quotes"],
        }),
      ).toEqual({ sent: 3, failed: 0, skipped: 0, filtered: 0 });
      expect(sender.sent).toEqual([
        "all:reply",
        "all:repost-quote",
        "no-replies:repost-quote",
        "reposts-only:repost-quote",
      ]);
    } finally {
      context.db.close();
    }
  });

  test("通常投稿と引用の扱いが同じ経路では解決関数を呼ばず、違う経路でだけ一度呼ぶ", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "all" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "no-quotes",
        kinds: { quotes: false },
      });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "no-posts",
        kinds: { posts: false },
      });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      let resolutions = 0;
      const resolve = async (): Promise<readonly ["quotes"]> => {
        resolutions += 1;
        return ["quotes"];
      };

      expect(
        await service.deliver({
          source: "webpush",
          sourceRecordId: 1,
          targetId: target,
          postId: "1",
          postUrl: "q",
          kinds: resolve,
        }),
      ).toEqual({ sent: 2, failed: 0, skipped: 0, filtered: 1 });
      expect(resolutions).toBe(1);
      expect(sender.sent).toEqual(["all:q", "no-posts:q"]);

      expect(
        await service.deliver({
          source: "webpush",
          sourceRecordId: 2,
          targetId: target,
          postId: "2",
          postUrl: "unknown",
          kinds: failingResolver,
        }),
      ).toEqual({ sent: 3, failed: 0, skipped: 0, filtered: 0 });
    } finally {
      context.db.close();
    }
  });

  test("TweetResultByRestId の応答から種別を確定する", () => {
    const quote = extractTweetResult({
      data: {
        tweetResult: {
          result: {
            rest_id: "10",
            core: { user_results: { result: { core: { screen_name: "Example" } } } },
            legacy: {
              created_at: "Thu Sep 03 00:00:00 +0000 2026",
              user_id_str: "1",
              is_quote_status: true,
            },
          },
        },
      },
    });
    expect(quote).toMatchObject({ postId: "10", authorHandle: "example", types: ["quote"] });
    expect(extractTweetResult({ data: {} })).toBeNull();
    expect(extractTweetResult({ data: { tweetResult: {} } })).toBeNull();
  });

  test("/watch add の再実行は種別だけを更新する", async () => {
    const context = createTestContext();
    try {
      addReceiver(context, "a");
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        {
          configureTarget: async (_receiver, handle) => ({
            userId: `id-${handle}`,
            handle,
            displayName: handle,
          }),
          requestReconcile: () => undefined,
        },
        context.guildSettings,
      );
      const first = await service.add({
        handle: "example",
        guildId: "g",
        channelId: "c",
        kinds: { replies: false },
      });
      expect(first.created).toBe(true);
      expect(first.route.kinds.replies).toBe(false);
      const second = await service.add({
        handle: "example",
        guildId: "g",
        channelId: "c",
        kinds: { reposts: false },
      });
      expect(second.created).toBe(false);
      expect(second.route.kinds).toEqual({
        posts: true,
        quotes: true,
        reposts: false,
        replies: false,
      });
      expect(service.list("g")[0]?.kinds.replies).toBe(false);
    } finally {
      context.db.close();
    }
  });
});
