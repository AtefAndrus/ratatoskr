import { describe, expect, test } from "bun:test";

import { applyMigrations, SCHEMA_VERSION } from "../src/db/schema";
import { addReceiver, addTarget, createTestContext } from "./helpers/database";

describe("receivers", () => {
  test("認証情報と Web Push 購読を保存し、一覧には秘密情報を含めない", () => {
    const context = createTestContext();
    try {
      const receiver = context.receivers.add("Receiver-A", {
        authToken: " auth ",
        csrfToken: "csrf",
      });
      expect(receiver.label).toBe("receiver-a");
      expect(receiver.credentials).toEqual({
        authToken: "auth",
        csrfToken: "csrf",
        bearerToken: "default-bearer",
      });
      expect(receiver.push).toBeNull();

      context.receivers.savePushSubscription(
        receiver.id,
        { uaid: "uaid", channelId: "channel", endpoint: "https://push.example/1" },
        {
          privateKeyJwk: { kty: "EC", crv: "P-256", d: "d" },
          publicKey: "pub",
          authSecret: "auth-secret",
        },
      );
      expect(context.receivers.getById(receiver.id)?.push).toEqual({
        session: { uaid: "uaid", channelId: "channel", endpoint: "https://push.example/1" },
        keys: {
          privateKeyJwk: { kty: "EC", crv: "P-256", d: "d" },
          publicKey: "pub",
          authSecret: "auth-secret",
        },
        registeredAt: null,
      });
      context.receivers.markPushRegistered(receiver.id, "2026-09-05T00:00:00.000Z");
      expect(context.receivers.listSummaries()).toEqual([
        {
          id: receiver.id,
          label: "receiver-a",
          enabled: true,
          pushEndpoint: "https://push.example/1",
          pushRegisteredAt: "2026-09-05T00:00:00.000Z",
          createdAt: expect.any(String),
        },
      ]);
      expect(JSON.stringify(context.receivers.listSummaries())).not.toContain("auth");

      expect(context.receivers.setEnabled("receiver-a", false)).toBe(true);
      expect(context.receivers.listEnabled()).toEqual([]);
      expect(context.receivers.remove("receiver-a")).toBe(true);
      expect(context.receivers.remove("receiver-a")).toBe(false);
      expect(() =>
        context.receivers.add("bad label", { authToken: "a", csrfToken: "c" }),
      ).toThrow();
    } finally {
      context.db.close();
    }
  });
});

describe("targets", () => {
  test("表示名で通知主体を確定し、重複時は投稿者ハンドルで解決する", () => {
    const context = createTestContext();
    try {
      addTarget(context, { userId: "1", handle: "News", displayName: "ニュース" });
      addTarget(context, { userId: "2", handle: "other", displayName: "ニュース" });
      addTarget(context, { userId: "3", handle: "unique", displayName: "Unique" });

      expect(
        context.targets.resolveNotificationTarget({
          authorHandle: "someone",
          notificationTitle: "Unique",
        })?.handle,
      ).toBe("unique");
      expect(
        context.targets.resolveNotificationTarget({
          authorHandle: "news",
          notificationTitle: "ニュース",
        })?.handle,
      ).toBe("news");
      expect(
        context.targets.resolveNotificationTarget({
          authorHandle: "nobody",
          notificationTitle: "ニュース",
        }),
      ).toBeNull();
    } finally {
      context.db.close();
    }
  });

  test("ハンドル変更を user_id で追従し、受信アカウントごとの設定状況を持つ", () => {
    const context = createTestContext();
    try {
      const receiverA = addReceiver(context, "a");
      const receiverB = addReceiver(context, "b");
      const first = context.targets.upsert({
        userId: "42",
        handle: "old_name",
        displayName: "Old",
      });
      const renamed = context.targets.upsert({
        userId: "42",
        handle: "new_name",
        displayName: "New",
      });
      expect(renamed.id).toBe(first.id);
      expect(context.targets.findByHandle("old_name")).toBeNull();
      expect(context.targets.findByHandle("@New_Name")?.displayName).toBe("New");

      context.targets.markReceiverConfigured(receiverA, first.id);
      expect(context.targets.listUnconfiguredForReceiver(receiverA)).toEqual([]);
      expect(
        context.targets.listUnconfiguredForReceiver(receiverB).map((target) => target.handle),
      ).toEqual(["new_name"]);
      context.targets.setEnabled(first.id, false);
      expect(context.targets.listUnconfiguredForReceiver(receiverB)).toEqual([]);
      expect(context.targets.listEnabled()).toEqual([]);
    } finally {
      context.db.close();
    }
  });
});

describe("routes", () => {
  test("対象とチャンネルの組を一意に持ち、サーバー単位で一覧する", () => {
    const context = createTestContext();
    try {
      const news = addTarget(context, { handle: "news" });
      const tech = addTarget(context, { handle: "tech" });
      expect(context.routes.add({ targetId: news, guildId: "g1", channelId: "c1" }).created).toBe(
        true,
      );
      expect(context.routes.add({ targetId: news, guildId: "g1", channelId: "c1" }).created).toBe(
        false,
      );
      context.routes.add({ targetId: news, guildId: "g2", channelId: "c2" });
      context.routes.add({ targetId: tech, guildId: "g1", channelId: "c1" });

      expect(
        context.routes.listByGuild("g1").map((route) => `${route.handle}->${route.channelId}`),
      ).toEqual(["news->c1", "tech->c1"]);
      expect(context.routes.listEnabledByTarget(news).map((route) => route.channelId)).toEqual([
        "c1",
        "c2",
      ]);
      expect(context.routes.remove(news, "c1")).toBe(true);
      expect(context.routes.remove(news, "c1")).toBe(false);
      expect(context.routes.countByTarget(news)).toBe(1);
    } finally {
      context.db.close();
    }
  });
});

describe("observations と保持期間", () => {
  test("投稿の初出を受信アカウントと対象の組で判定し、生応答は保持期間で落とす", () => {
    const context = createTestContext();
    try {
      const receiverA = addReceiver(context, "a");
      const receiverB = addReceiver(context, "b");
      const target = addTarget(context, { userId: "42", handle: "example" });
      const observation = {
        receiverId: receiverA,
        targetId: target,
        fetchedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:00.100Z",
        queryId: "query-id",
        endpoint: "https://x.com/i/api/graphql/query-id/UserTweetsAndReplies",
        variablesJson: '{"userId":"42"}',
        featuresJson: "{}",
        transactionId: "transaction-id",
        responseStatus: 200,
        responseText: '{"data":{}}',
        rateLimitLimit: 500,
        rateLimitRemaining: 499,
        rateLimitResetAt: "2026-09-03T00:15:00.000Z",
        error: null,
        parseError: null,
      };
      const posts = [
        {
          postId: "100",
          createdAt: "2026-09-03T00:00:00.000Z",
          authorUserId: "42",
          authorHandle: "example",
          typesJson: '["original"]',
          referencedPostIdsJson: "[]",
          referencedAuthorHandle: null,
          rawResultJson: '{"rest_id":"100"}',
          isTargetAuthor: 1,
        },
      ];

      expect(context.observations.recordObservation(observation, posts)).toMatchObject({
        postCount: 1,
        targetPostCount: 1,
        newPostCount: 1,
        newTargetPosts: [{ postId: "100" }],
      });
      expect(
        context.observations.recordObservation(
          { ...observation, fetchedAt: "2026-09-03T00:01:00.000Z" },
          posts,
        ),
      ).toMatchObject({ newPostCount: 0, newTargetPosts: [] });
      expect(
        context.observations.recordObservation({ ...observation, receiverId: receiverB }, posts),
      ).toMatchObject({
        newPostCount: 1,
      });
      expect(context.observations.listRecent(10)).toHaveLength(3);
      expect(context.observations.listRecent(10, { errorsOnly: true })).toHaveLength(0);
      expect(context.observations.getResponseText(1)?.responseText).toBe('{"data":{}}');

      const result = context.maintenance.applyRetention({
        rawBefore: "2026-09-03T00:00:30.000Z",
        rowsBefore: "2026-09-01T00:00:00.000Z",
      });
      expect(result).toEqual({ rawTextCleared: 4, rowsDeleted: 0 });
      expect(context.observations.getResponseText(1)?.responseText).toBeNull();
      expect(context.observations.getResponseText(2)?.responseText).toBe('{"data":{}}');

      const deleted = context.maintenance.applyRetention({
        rawBefore: "2026-09-04T00:00:00.000Z",
        rowsBefore: "2026-09-03T00:00:30.000Z",
      });
      // bun:sqlite の changes は外部キーの連鎖削除分も含むため下限だけを見る
      expect(deleted.rowsDeleted).toBeGreaterThanOrEqual(2);
      expect(context.maintenance.tableCounts()).toMatchObject({
        internal_graphql_observations: 1,
        internal_graphql_observation_posts: 1,
      });
    } finally {
      context.db.close();
    }
  });

  test("スキーマバージョンを記録し、新しすぎる DB は拒否する", () => {
    const context = createTestContext();
    try {
      context.db
        .query("UPDATE schema_meta SET version = $version")
        .run({ version: SCHEMA_VERSION + 1 });
      expect(() => applyMigrations(context.db)).toThrow("新しすぎます");
    } finally {
      context.db.close();
    }
  });
});
