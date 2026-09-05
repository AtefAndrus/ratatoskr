import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations } from "../src/db/schema";
import { InternalPollCollector } from "../src/pipeline/internalPollCollector";
import { DeliveryService } from "../src/services/deliveryService";
import { AdaptivePollScheduler } from "../src/x/adaptivePollScheduler";
import type { InternalTimelineFetchResult, XInternalGraphqlClient } from "../src/x/internalGraphql";
import {
  addReceiver,
  addTarget,
  createRecordingSender,
  createTestContext,
} from "./helpers/database";

describe("停止中投稿の補完", () => {
  test("通常取得と複数の補完ページを交互に取得し、ページ間重複を一度だけ送る", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const targetId = addTarget(context, { userId: "42", handle: "example" });
      context.routes.add({ targetId, guildId: "g", channelId: "c" });
      setRouteCreatedAt(context.db, targetId, "2026-09-01T00:00:00.000Z");
      const controller = new AbortController();
      const requests: Array<string | null> = [];
      const pages = new Map<string, InternalTimelineFetchResult>([
        ["latest", page([post("3"), post("2")], "cursor-1", ["3", "2"], 499)],
        ["cursor-1", page([post("2"), post("1")], "cursor-2", ["2", "1"], 498)],
        ["cursor-2", page([post("1"), post("0")], null, ["1", "0"], 497)],
      ]);
      const client = {
        async fetchUserTweetsAndReplies(
          _target: { userId: string; handle: string },
          cursor?: string,
        ): Promise<InternalTimelineFetchResult> {
          requests.push(cursor ?? null);
          return pages.get(cursor ?? "latest")!;
        },
      } as XInternalGraphqlClient;
      const sender = createRecordingSender();
      const delivery = new DeliveryService(context.routes, context.deliveries, {
        async sendPostUrl(channelId, postUrl) {
          const sent = await sender.sendPostUrl(channelId, postUrl);
          if (postUrl.endsWith("/0")) controller.abort();
          return sent;
        },
      });
      const statuses: Array<number | null> = [];
      const collector = new InternalPollCollector({
        receiverId,
        receiverLabel: "receiver-a",
        client,
        targets: context.targets,
        observations: context.observations,
        backlog: context.backlog,
        delivery,
        selectTargets: (targets) => targets,
        onPollResponse: (status) => statuses.push(status),
        scheduler: fastScheduler(),
      });

      await collector.run(controller.signal);

      expect(requests).toEqual([null, "cursor-1", null, "cursor-2"]);
      expect(sender.sent.map((value) => value.split("/").at(-1))).toEqual(["3", "2", "1", "0"]);
      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(context.backlog.get(targetId)).toMatchObject({
        state: "complete",
        pagesFetched: 2,
        lastStopReason: "bottom_cursor_missing",
      });
      expect(context.deliveries.queueCounts()).toEqual({ pending: 0, sending: 0, failed: 0 });
    } finally {
      context.db.close();
    }
  });

  test("保存したカーソルから再開し、固定投稿を除く通常エントリの重なりで完了する", () => {
    const context = createTestContext();
    try {
      const receiverA = addReceiver(context, "a");
      const receiverB = addReceiver(context, "b");
      const targetId = addTarget(context, { handle: "example" });
      context.routes.add({ targetId, guildId: "g", channelId: "c" });
      setRouteCreatedAt(context.db, targetId, "2026-09-01T00:00:00.000Z");
      seedSuccessfulObservation(context.db, receiverA, targetId, ["known-1", "known-2", "known-3"]);
      expect(context.backlog.ensure(targetId)).toMatchObject({
        notBefore: "2026-09-02T00:00:00.000Z",
        knownPostIds: ["known-1", "known-2", "known-3"],
      });
      context.backlog.startFromLatest(targetId, "cursor-1", "2026-09-03T00:00:00.000Z");
      const acquired = context.backlog.acquire(
        targetId,
        receiverA,
        "2026-09-03T00:00:01.000Z",
        "2026-09-03T00:01:01.000Z",
      );
      expect(acquired?.nextCursor).toBe("cursor-1");
      expect(
        context.backlog.acquire(
          targetId,
          receiverB,
          "2026-09-03T00:00:02.000Z",
          "2026-09-03T00:01:02.000Z",
        ),
      ).toBeNull();
      context.backlog.stop(targetId, receiverA, "HTTP 429", "2026-09-03T00:00:03.000Z");

      const resumed = context.backlog.acquire(
        targetId,
        receiverB,
        "2026-09-03T00:00:04.000Z",
        "2026-09-03T00:01:04.000Z",
      );
      expect(resumed?.nextCursor).toBe("cursor-1");
      context.backlog.savePage({
        targetId,
        receiverId: receiverB,
        requestedCursor: "cursor-1",
        bottomCursor: "cursor-2",
        regularPostIds: ["known-1", "known-2", "known-3"],
        now: "2026-09-03T00:00:05.000Z",
      });
      expect(context.backlog.get(targetId)).toMatchObject({
        state: "complete",
        lastStopReason: "known_posts_overlap",
      });
    } finally {
      context.db.close();
    }
  });

  test("カーソル循環を完了として止め、別受信の同時取得をリースで防ぐ", () => {
    const context = createTestContext();
    try {
      const receiverA = addReceiver(context, "a");
      const receiverB = addReceiver(context, "b");
      const targetId = addTarget(context, { handle: "example" });
      context.routes.add({ targetId, guildId: "g", channelId: "c" });
      context.backlog.ensure(targetId);
      context.backlog.startFromLatest(targetId, "cursor-1", "2026-09-03T00:00:00.000Z");
      expect(
        context.backlog.acquire(
          targetId,
          receiverA,
          "2026-09-03T00:00:01.000Z",
          "2026-09-03T00:01:01.000Z",
        ),
      ).not.toBeNull();
      expect(
        context.backlog.acquire(
          targetId,
          receiverB,
          "2026-09-03T00:00:02.000Z",
          "2026-09-03T00:01:02.000Z",
        ),
      ).toBeNull();
      context.backlog.savePage({
        targetId,
        receiverId: receiverA,
        requestedCursor: "cursor-1",
        bottomCursor: "cursor-1",
        regularPostIds: [],
        now: "2026-09-03T00:00:03.000Z",
      });
      expect(context.backlog.get(targetId)).toMatchObject({
        state: "complete",
        lastStopReason: "cursor_cycle",
      });
    } finally {
      context.db.close();
    }
  });
});

describe("永続送信キュー", () => {
  test("保存直後の停止と送信中の停止を再起動後に送る", async () => {
    const context = createTestContext();
    try {
      const targetId = addTarget(context, { handle: "example" });
      const route = context.routes.add({ targetId, guildId: "g", channelId: "c" }).route;
      setRouteCreatedAt(context.db, targetId, "2026-09-01T00:00:00.000Z");
      enqueue(context, targetId, route.id, "1");
      enqueue(context, targetId, route.id, "2");
      context.db.query("UPDATE delivery_queue SET state = 'sending' WHERE post_id = '2'").run();
      const sender = createRecordingSender();

      const restarted = new DeliveryService(context.routes, context.deliveries, sender);
      await restarted.drain();

      expect(sender.sent.map((value) => value.split("/").at(-1))).toEqual(["1", "2"]);
      expect(context.deliveries.queueCounts()).toEqual({ pending: 0, sending: 0, failed: 0 });
    } finally {
      context.db.close();
    }
  });

  test("送信失敗を永続化して次回に再試行する", async () => {
    const context = createTestContext();
    try {
      const targetId = addTarget(context, { handle: "example" });
      context.routes.add({ targetId, guildId: "g", channelId: "c" });
      let fail = true;
      const service = new DeliveryService(context.routes, context.deliveries, {
        async sendPostUrl() {
          if (fail) throw new Error("Discord down");
          return { messageId: "accepted" };
        },
      });
      const deliverable = {
        source: "webpush" as const,
        sourceRecordId: 1,
        targetId,
        postId: "1",
        postUrl: "https://x.com/example/status/1",
        createdAt: new Date().toISOString(),
        kinds: ["posts"] as const,
      };
      expect(await service.deliver(deliverable)).toMatchObject({ failed: 1 });
      expect(context.deliveries.queueCounts().failed).toBe(1);
      fail = false;
      await service.drain();
      expect(context.deliveries.queueCounts()).toEqual({ pending: 0, sending: 0, failed: 0 });
      expect(context.deliveries.listRecent(10).map((entry) => entry.status)).toEqual([
        "sent",
        "failed",
      ]);
    } finally {
      context.db.close();
    }
  });

  test("投稿先の登録時刻より前は保存せず、未送信行は保持期限で消さない", async () => {
    const context = createTestContext();
    try {
      const targetId = addTarget(context, { handle: "example" });
      const route = context.routes.add({ targetId, guildId: "g", channelId: "c" }).route;
      setRouteCreatedAt(context.db, targetId, "2026-09-03T00:00:00.000Z");
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      expect(
        await service.deliver({
          source: "internal_graphql",
          sourceRecordId: 1,
          targetId,
          postId: "old",
          postUrl: "https://x.com/example/status/old",
          createdAt: "2026-09-02T00:00:00.000Z",
          kinds: ["posts"],
        }),
      ).toMatchObject({ filtered: 1, sent: 0 });
      enqueue(context, targetId, route.id, "pending", "2020-01-01T00:00:00.000Z");
      context.maintenance.applyRetention({
        rawBefore: "2026-09-01T00:00:00.000Z",
        rowsBefore: "2026-09-01T00:00:00.000Z",
      });
      expect(context.deliveries.queueCounts().pending).toBe(1);
      expect(sender.sent).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  test("移行時に既存のsent claimをキューへ引き継ぐ", () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_meta (version INTEGER NOT NULL) STRICT;
        INSERT INTO schema_meta VALUES (4);
        CREATE TABLE receivers (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE watch_targets (id INTEGER PRIMARY KEY, handle TEXT NOT NULL) STRICT;
        CREATE TABLE routes (
          id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE delivery_claims (
          id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_record_id INTEGER NOT NULL,
          route_id INTEGER NOT NULL, dedupe_key TEXT NOT NULL, claimed_at TEXT NOT NULL,
          state TEXT NOT NULL
        ) STRICT;
        CREATE TABLE internal_graphql_observations (
          id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL, fetched_at TEXT NOT NULL,
          response_status INTEGER, error TEXT, parse_error TEXT
        ) STRICT;
        CREATE TABLE internal_graphql_observation_posts (
          id INTEGER PRIMARY KEY, observation_id INTEGER NOT NULL, post_id TEXT NOT NULL,
          is_target_author INTEGER NOT NULL
        ) STRICT;
        INSERT INTO watch_targets VALUES (1, 'example');
        INSERT INTO routes VALUES (1, 1, '2026-09-01T00:00:00.000Z');
        INSERT INTO delivery_claims VALUES (
          1, 'webpush', 9, 1, 'post:123', '2026-09-03T00:00:00.000Z', 'sent'
        );
        INSERT INTO internal_graphql_observations VALUES (
          1, 1, '2026-09-02T00:00:00.000Z', 200, NULL, NULL
        );
        INSERT INTO internal_graphql_observation_posts VALUES (1, 1, 'known-1', 1);
      `);

      applyMigrations(db);

      expect(
        db.query("SELECT post_id AS postId, state, post_url AS postUrl FROM delivery_queue").get(),
      ).toEqual({
        postId: "123",
        state: "sent",
        postUrl: "https://x.com/example/status/123",
      });
      expect(
        db
          .query(
            "SELECT not_before AS notBefore, known_post_ids_json AS knownPostIdsJson FROM backlog_progress",
          )
          .get(),
      ).toEqual({
        notBefore: "2026-09-02T00:00:00.000Z",
        knownPostIdsJson: '["known-1"]',
      });
    } finally {
      db.close();
    }
  });
});

function fastScheduler(): AdaptivePollScheduler {
  return new AdaptivePollScheduler([], Date.now(), {
    activeIntervalMs: 1,
    quietIntervalsMs: [1],
    errorIntervalsMs: [1],
    minimumRequestSpacingMs: 1,
    intervalJitterRatio: 0,
    resetJitterMs: 0,
  });
}

function post(postId: string) {
  return {
    postId,
    createdAt: `2026-09-03T00:00:0${postId}.000Z`,
    authorUserId: "42",
    authorHandle: "example",
    types: ["original" as const],
    referencedPostIds: [],
    referencedAuthorHandle: null,
    rawResult: {},
  };
}

function page(
  posts: ReturnType<typeof post>[],
  bottomCursor: string | null,
  regularPostIds: string[],
  remaining: number,
): InternalTimelineFetchResult {
  return {
    fetchedAt: "2026-09-03T00:00:10.000Z",
    completedAt: "2026-09-03T00:00:10.100Z",
    queryId: "q",
    endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
    variables: {},
    features: {},
    transactionId: null,
    responseStatus: 200,
    responseText: "{}",
    rateLimitLimit: 500,
    rateLimitRemaining: remaining,
    rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
    error: null,
    parseError: null,
    posts,
    regularPostIds,
    bottomCursor,
  };
}

function setRouteCreatedAt(db: Database, targetId: number, createdAt: string): void {
  db.query("UPDATE routes SET created_at = $createdAt WHERE target_id = $targetId").run({
    targetId,
    createdAt,
  });
}

function seedSuccessfulObservation(
  db: Database,
  receiverId: number,
  targetId: number,
  postIds: string[],
): void {
  db.query(
    `INSERT INTO internal_graphql_observations (
       receiver_id, target_id, fetched_at, completed_at, query_id, endpoint,
       variables_json, features_json, response_status
     ) VALUES (
       $receiverId, $targetId, '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:01.000Z',
       'q', 'https://x.com/graphql', '{}', '{}', 200
     )`,
  ).run({ receiverId, targetId });
  for (const postId of postIds) {
    db.query(
      `INSERT INTO internal_graphql_observation_posts (
         observation_id, post_id, types_json, referenced_post_ids_json, is_new, is_target_author
       ) VALUES (1, $postId, '["original"]', '[]', 1, 1)`,
    ).run({ postId });
  }
}

function enqueue(
  context: ReturnType<typeof createTestContext>,
  targetId: number,
  routeId: number,
  postId: string,
  queuedAt = "2026-09-03T00:00:00.000Z",
): void {
  context.deliveries.enqueue({
    targetId,
    routeId,
    postId,
    postUrl: `https://x.com/example/status/${postId}`,
    kindsJson: '["posts"]',
    postCreatedAt: queuedAt,
    source: "internal_graphql",
    sourceRecordId: 1,
    queuedAt,
  });
}
