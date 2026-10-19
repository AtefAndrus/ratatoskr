import { describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db";
import {
  HAS_SEEN_BY_PAIR_SQL,
  RECENT_SIGHTING_LIMIT,
  RECENT_SIGHTINGS_SQL,
} from "../src/db/repositories/internalGraphql";
import { addReceiver, addTarget, createTestContext, type TestContext } from "./helpers/database";

const params = { receiverId: 1, targetId: 1, postId: "1", limit: RECENT_SIGHTING_LIMIT };

function plan(sql: string): string[] {
  const db = openDatabase(":memory:");
  try {
    return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>).map(
      (row) => row.detail,
    );
  } finally {
    db.close();
  }
}

function opcodes(sql: string): string[] {
  const db = openDatabase(":memory:");
  try {
    return (db.query(`EXPLAIN ${sql}`).all(params) as Array<{ opcode: string }>).map(
      (row) => row.opcode,
    );
  } finally {
    db.close();
  }
}

let clock = 0;

function observe(
  context: TestContext,
  receiverId: number,
  targetId: number,
  postId: string,
): boolean {
  clock += 1;
  const fetchedAt = new Date(Date.UTC(2026, 9, 1) + clock * 1000).toISOString();
  const result = context.observations.recordObservation(
    {
      receiverId,
      targetId,
      fetchedAt,
      completedAt: fetchedAt,
      queryId: "q",
      endpoint: "UserTweets",
      variablesJson: "{}",
      featuresJson: "{}",
      transactionId: null,
      responseStatus: 200,
      responseText: "{}",
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      error: null,
      parseError: null,
    },
    [
      {
        postId,
        createdAt: null,
        authorUserId: null,
        authorHandle: null,
        typesJson: '["original"]',
        referencedPostIdsJson: "[]",
        referencedAuthorHandle: null,
        mediaTypesJson: null,
        rawResultJson: "{}",
        isTargetAuthor: 1,
      },
    ],
  );
  return result.newPostCount === 1;
}

describe("観測済みの判定", () => {
  test("まず投稿 ID の索引から新しい順に直近の観測を見る", () => {
    expect(plan(RECENT_SIGHTINGS_SQL)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "SEARCH internal_graphql_observation_posts USING COVERING INDEX internal_graphql_posts_post_idx",
        ),
      ]),
    );
    // 計画の文字列は走査の向きを表さないので、バイトコードで新しい順 (Prev) にたどることを見る
    expect(opcodes(RECENT_SIGHTINGS_SQL)).toContain("Prev");
    expect(opcodes(RECENT_SIGHTINGS_SQL)).not.toContain("Next");
  });

  test("直近で決まらないときは、組の観測からたどる", () => {
    expect(plan(HAS_SEEN_BY_PAIR_SQL)[0]).toContain(
      "SEARCH observations USING COVERING INDEX internal_graphql_observations_target_idx",
    );
  });

  test("直近の観測が上限に届いて組を含まなくても、それより前に組が見ていれば既知とする", () => {
    const context = createTestContext();
    try {
      const mine = addReceiver(context, "mine");
      const other = addReceiver(context, "other");
      const target = addTarget(context, { handle: "example" });
      expect(observe(context, mine, target, "shared")).toBe(true);
      for (let index = 0; index < RECENT_SIGHTING_LIMIT; index += 1) {
        observe(context, other, target, "shared");
      }
      expect(observe(context, mine, target, "shared")).toBe(false);
    } finally {
      context.db.close();
    }
  });

  test("ほかの組だけが見てきた投稿は、件数が上限の前後どちらでも初出とする", () => {
    const context = createTestContext();
    try {
      const mine = addReceiver(context, "mine");
      const other = addReceiver(context, "other");
      const target = addTarget(context, { handle: "example" });
      for (const [postId, count] of [
        ["few", RECENT_SIGHTING_LIMIT - 1],
        ["many", RECENT_SIGHTING_LIMIT],
      ] as const) {
        for (let index = 0; index < count; index += 1) observe(context, other, target, postId);
        expect(observe(context, mine, target, postId)).toBe(true);
        expect(observe(context, mine, target, postId)).toBe(false);
      }
    } finally {
      context.db.close();
    }
  });

  test("直近の観測は上限の件数で読むのをやめる", () => {
    const context = createTestContext();
    try {
      const mine = addReceiver(context, "mine");
      const other = addReceiver(context, "other");
      const target = addTarget(context, { handle: "example" });
      observe(context, mine, target, "edge");
      for (let index = 0; index < RECENT_SIGHTING_LIMIT - 1; index += 1) {
        observe(context, other, target, "edge");
      }
      const recent = context.db.query(RECENT_SIGHTINGS_SQL);
      const key = {
        receiverId: mine,
        targetId: target,
        postId: "edge",
        limit: RECENT_SIGHTING_LIMIT,
      };
      // 自分の観測がちょうど上限の件数目にあれば、直近の範囲で見つかる
      expect(recent.get(key)).toEqual({ sightings: RECENT_SIGHTING_LIMIT, seen: 1 });
      observe(context, other, target, "edge");
      // 1 件押し出されると範囲から外れ、読むのは上限の件数で止まる
      expect(recent.get(key)).toEqual({ sightings: RECENT_SIGHTING_LIMIT, seen: 0 });
    } finally {
      context.db.close();
    }
  });

  test("組の観測からたどるのは、直近の観測が上限に届いて組を含まないときだけ", () => {
    const context = createTestContext();
    try {
      const mine = addReceiver(context, "mine");
      const other = addReceiver(context, "other");
      const target = addTarget(context, { handle: "example" });
      for (let index = 0; index < RECENT_SIGHTING_LIMIT; index += 1) {
        observe(context, other, target, "many");
      }
      for (let index = 0; index < RECENT_SIGHTING_LIMIT - 1; index += 1) {
        observe(context, other, target, "few");
      }
      const fallbacks = countPairLookups(context);
      observe(context, mine, target, "unseen");
      observe(context, mine, target, "few");
      observe(context, mine, target, "few");
      expect(fallbacks.count).toBe(0);
      observe(context, mine, target, "many");
      expect(fallbacks.count).toBe(1);
      // 一度見た後は自分の観測が直近に入るので、もう切り替えない
      observe(context, mine, target, "many");
      expect(fallbacks.count).toBe(1);
    } finally {
      context.db.close();
    }
  });
});

/** 組の観測からたどるクエリの実行回数を数える。bun:sqlite は同じ SQL の文を使い回すので、その文の get を包む。 */
function countPairLookups(context: TestContext): { count: number } {
  const counter = { count: 0 };
  const statement = context.db.query(HAS_SEEN_BY_PAIR_SQL);
  const get = statement.get.bind(statement);
  statement.get = (...args: Parameters<typeof get>) => {
    counter.count += 1;
    return get(...args);
  };
  return counter;
}
