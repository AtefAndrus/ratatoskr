import { describe, expect, test } from "bun:test";

import { applyRetentionInChunks, type RawTextWatermarks } from "../src/maintenance/retention";
import { addReceiver, addTarget, createTestContext, type TestContext } from "./helpers/database";

describe("保持期間の整理の分割", () => {
  test("本文の整理を上限行数ごとに分けて処理を返し、次回は前回たどり終えた位置から先だけを見る", async () => {
    const context = createTestContext();
    try {
      seedObservations(context, 2_500, "2026-09-01T00:00:00.000Z");
      const watermarks: RawTextWatermarks = new Map();
      let yields = 0;
      const run = async (rawBefore: string) =>
        await applyRetentionInChunks({
          maintenance: context.maintenance,
          rawBefore,
          rowsBefore: "2026-08-01T00:00:00.000Z",
          watermarks,
          yieldToEventLoop: async () => {
            yields += 1;
          },
        });

      expect(await run("2026-09-02T00:00:00.000Z")).toEqual({
        rawTextCleared: 5_000,
        rowsDeleted: 0,
      });
      expect(watermarks.get("internal_graphql_observations")).toEqual({
        time: "2026-09-01T00:00:00.000Z",
        id: 2_500,
      });
      // 本文の整理 25 回と、表ごとに 1 回ずつの削除
      expect(yields).toBe(25 + 4);

      yields = 0;
      seedObservations(context, 10, "2026-09-02T12:00:00.000Z");
      expect(await run("2026-09-03T00:00:00.000Z")).toEqual({
        rawTextCleared: 20,
        rowsDeleted: 0,
      });
      expect(yields).toBe(1 + 4);
    } finally {
      context.db.close();
    }
  });

  test("使い回された id の行も時刻で判定し、期限前は残して期限後は落とす", async () => {
    const context = createTestContext();
    try {
      seedObservations(context, 3, "2026-09-01T00:00:00.000Z");
      const watermarks: RawTextWatermarks = new Map();
      const run = async (rawBefore: string) =>
        await applyRetentionInChunks({
          maintenance: context.maintenance,
          rawBefore,
          rowsBefore: "2026-08-01T00:00:00.000Z",
          watermarks,
          yieldToEventLoop: async () => undefined,
        });
      await run("2026-09-02T00:00:00.000Z");
      // 最大の id の行が消えると、SQLite は次の行に同じ id を使い回す
      context.db.exec("DELETE FROM internal_graphql_observations");
      seedObservations(context, 1, "2026-09-03T00:00:00.000Z");
      expect(context.observations.getResponseText(1)?.responseText).toBe("{}");

      await run("2026-09-02T12:00:00.000Z");
      expect(context.observations.getResponseText(1)?.responseText).toBe("{}");

      await run("2026-09-04T00:00:00.000Z");
      expect(context.observations.getResponseText(1)?.responseText ?? null).toBeNull();
    } finally {
      context.db.close();
    }
  });

  test("飛び飛びの id は、あいだの範囲をたどらずに処理する", async () => {
    const context = createTestContext();
    try {
      seedObservations(context, 1, "2026-09-01T00:00:00.000Z");
      context.db.exec(`
        PRAGMA foreign_keys = OFF;
        UPDATE internal_graphql_observation_posts SET observation_id = 10000000;
        UPDATE internal_graphql_observations SET id = 10000000;
        PRAGMA foreign_keys = ON;
      `);
      let yields = 0;
      await applyRetentionInChunks({
        maintenance: context.maintenance,
        rawBefore: "2026-09-02T00:00:00.000Z",
        rowsBefore: "2026-08-01T00:00:00.000Z",
        watermarks: new Map(),
        yieldToEventLoop: async () => {
          yields += 1;
        },
      });
      expect(yields).toBe(1 + 4);
      expect(context.observations.getResponseText(10_000_000)?.responseText ?? null).toBeNull();
    } finally {
      context.db.close();
    }
  });

  test("既定ではトランザクションの合間にタイマーへ処理を返す", async () => {
    const context = createTestContext();
    try {
      seedObservations(context, 2_500, "2026-09-01T00:00:00.000Z");
      const events: string[] = [];
      setTimeout(() => events.push("timer"), 0);
      await applyRetentionInChunks({
        maintenance: context.maintenance,
        rawBefore: "2026-09-02T00:00:00.000Z",
        rowsBefore: "2026-08-01T00:00:00.000Z",
        watermarks: new Map(),
      });
      events.push("retention done");
      expect(events).toEqual(["timer", "retention done"]);
    } finally {
      context.db.close();
    }
  });

  test("同じ時刻の行が上限行数より多くても、続きから取りこぼさずにたどる", async () => {
    const context = createTestContext();
    try {
      seedObservations(context, 2_500, "2026-09-01T00:00:00.000Z");
      seedObservations(context, 5, "2026-09-01T00:00:01.000Z");
      const result = await applyRetentionInChunks({
        maintenance: context.maintenance,
        rawBefore: "2026-09-02T00:00:00.000Z",
        rowsBefore: "2026-08-01T00:00:00.000Z",
        watermarks: new Map(),
        yieldToEventLoop: async () => undefined,
      });
      expect(result.rawTextCleared).toBe(2 * 2_505);
    } finally {
      context.db.close();
    }
  });

  test("AutoPush の生フレームと暗号文、外部とのやり取りの応答本文も期限で落とす", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const insertFrame = context.db.query(
        `INSERT INTO autopush_frames (receiver_id, received_at, raw_text, encrypted_data_base64url)
         VALUES ($receiverId, $receivedAt, $rawText, $encrypted)`,
      );
      insertFrame.run({
        receiverId,
        receivedAt: "2026-09-01T00:00:00.000Z",
        rawText: "{}",
        encrypted: "e",
      });
      insertFrame.run({
        receiverId,
        receivedAt: "2026-09-01T00:00:01.000Z",
        rawText: null,
        encrypted: "e",
      });
      insertFrame.run({
        receiverId,
        receivedAt: "2026-09-03T00:00:00.000Z",
        rawText: "{}",
        encrypted: "e",
      });
      const insertExchange = context.db.query(
        `INSERT INTO external_exchanges (source, occurred_at, method, url, response_text)
         VALUES ('x_push_registration', $occurredAt, 'POST', 'u', 'body')`,
      );
      insertExchange.run({ occurredAt: "2026-09-01T00:00:00.000Z" });
      insertExchange.run({ occurredAt: "2026-09-03T00:00:00.000Z" });

      const result = await applyRetentionInChunks({
        maintenance: context.maintenance,
        rawBefore: "2026-09-02T00:00:00.000Z",
        rowsBefore: "2026-08-01T00:00:00.000Z",
        watermarks: new Map(),
        yieldToEventLoop: async () => undefined,
      });

      expect(result).toEqual({ rawTextCleared: 3, rowsDeleted: 0 });
      expect(
        context.db
          .query(
            "SELECT raw_text AS rawText, encrypted_data_base64url AS encrypted FROM autopush_frames ORDER BY id",
          )
          .all(),
      ).toEqual([
        { rawText: null, encrypted: null },
        { rawText: null, encrypted: null },
        { rawText: "{}", encrypted: "e" },
      ]);
      expect(
        context.db
          .query("SELECT response_text AS responseText FROM external_exchanges ORDER BY id")
          .all(),
      ).toEqual([{ responseText: null }, { responseText: "body" }]);
    } finally {
      context.db.close();
    }
  });

  test("期限切れの行を表ごとの上限件数ずつ消し、停止の合図で途中から抜ける", async () => {
    const context = createTestContext();
    try {
      seedObservations(context, 450, "2026-08-01T00:00:00.000Z");
      const deletes: number[] = [];
      const counts = () =>
        (
          context.db.query("SELECT count(*) AS count FROM internal_graphql_observations").get() as {
            count: number;
          }
        ).count;

      const result = await applyRetentionInChunks({
        maintenance: context.maintenance,
        rawBefore: "2026-08-01T00:00:00.000Z",
        rowsBefore: "2026-09-01T00:00:00.000Z",
        watermarks: new Map(),
        yieldToEventLoop: async () => {
          deletes.push(counts());
        },
      });
      expect(result.rowsDeleted).toBe(450);
      // 観測は 200 件ずつ消え、残りが上限未満になった回で次の表へ進む
      expect(deletes.slice(0, 3)).toEqual([250, 50, 0]);
      expect(context.maintenance.tableCounts()).toMatchObject({
        internal_graphql_observations: 0,
        internal_graphql_observation_posts: 0,
      });

      seedObservations(context, 450, "2026-08-01T00:00:00.000Z");
      const controller = new AbortController();
      const stopped = await applyRetentionInChunks({
        maintenance: context.maintenance,
        rawBefore: "2026-08-01T00:00:00.000Z",
        rowsBefore: "2026-09-01T00:00:00.000Z",
        watermarks: new Map(),
        signal: controller.signal,
        yieldToEventLoop: async () => {
          controller.abort();
        },
      });
      expect(stopped.rowsDeleted).toBe(200);
      expect(counts()).toBe(250);
    } finally {
      context.db.close();
    }
  });
});

/** 本文付きの観測と、生 JSON 付きの投稿 1 行ずつを `fetchedAt` の時刻で入れる。 */
function seedObservations(context: TestContext, count: number, fetchedAt: string): void {
  const receiverId =
    (context.db.query("SELECT id FROM receivers LIMIT 1").get() as { id: number } | null)?.id ??
    addReceiver(context);
  const targetId =
    (context.db.query("SELECT id FROM watch_targets LIMIT 1").get() as { id: number } | null)?.id ??
    addTarget(context, { handle: "example" });
  const insertObservation = context.db.query(
    `INSERT INTO internal_graphql_observations (
       receiver_id, target_id, fetched_at, completed_at, query_id, endpoint,
       variables_json, features_json, response_status, response_text
     ) VALUES ($receiverId, $targetId, $fetchedAt, $fetchedAt, 'q', 'e', '{}', '{}', 200, '{}')
     RETURNING id`,
  );
  const insertPost = context.db.query(
    `INSERT INTO internal_graphql_observation_posts (
       observation_id, post_id, types_json, referenced_post_ids_json, raw_result_json, is_new
     ) VALUES ($observationId, '1', '["original"]', '[]', '{}', 1)`,
  );
  context.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const { id } = insertObservation.get({ receiverId, targetId, fetchedAt }) as { id: number };
      insertPost.run({ observationId: id });
    }
  })();
}
