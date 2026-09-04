import { describe, expect, test } from "bun:test";

import { generateClientTransactionId, parseTransactionPairs } from "../src/x/clientTransactionId";
import {
  extractTimelinePosts,
  InternalGraphqlConfigurationProvider,
  XInternalGraphqlClient,
} from "../src/x/internalGraphql";

describe("X 内部 GraphQL", () => {
  test("timeline 直下の通常投稿・返信・引用・リポストを抽出する", () => {
    const payload = {
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      entry("tweet-1", tweet("1", {})),
                      entry("tweet-2", tweet("2", { in_reply_to_status_id_str: "10" })),
                      entry(
                        "tweet-3",
                        tweet(
                          "3",
                          { is_quote_status: true },
                          {
                            quoted_status_result: { result: tweet("30", {}).tweet_results.result },
                          },
                        ),
                      ),
                      entry(
                        "tweet-4",
                        tweet(
                          "4",
                          {
                            retweeted_status_result: { result: { rest_id: "40" } },
                            is_quote_status: true,
                          },
                          {
                            quoted_status_result: { result: tweet("41", {}).tweet_results.result },
                          },
                        ),
                      ),
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };

    const posts = extractTimelinePosts(payload);

    expect(
      posts.map((post) => ({
        id: post.postId,
        types: post.types,
        references: post.referencedPostIds,
      })),
    ).toEqual([
      { id: "1", types: ["original"], references: [] },
      { id: "2", types: ["reply"], references: ["10"] },
      { id: "3", types: ["quote"], references: ["30"] },
      { id: "4", types: ["repost"], references: ["40"] },
    ]);
    expect(posts.every((post) => post.authorHandle === "example")).toBe(true);
    expect(posts.every((post) => post.createdAt === "2026-09-03T00:00:00.000Z")).toBe(true);
  });

  test("transaction ID を決定的な入力から生成できる", async () => {
    const pair = parseTransactionPairs([
      { verification: Buffer.from([1, 2, 3, 4]).toString("base64"), animationKey: "abc" },
    ])[0]!;

    const value = await generateClientTransactionId(
      "GET",
      "/i/api/graphql/id/UserTweetsAndReplies",
      pair,
      new Date("2026-09-03T00:00:00.000Z"),
      7,
    );

    expect(value).toBe("BwYFBAMXUk4B/9fLjDJNZcuDA0/XlbfnLwQ");
  });

  test("設定は TTL 内で再取得せず、失敗時は前回値を使う", async () => {
    let calls = 0;
    let fail = false;
    const fetchImplementation = (async (input: string | URL | Request) => {
      calls += 1;
      if (fail) return new Response("boom", { status: 500 });
      const url = String(input);
      if (url.endsWith("API.json")) {
        return Response.json({
          graphql: { UserTweetsAndReplies: { queryId: "query-1", features: { flag: true } } },
        });
      }
      return Response.json([{ verification: "AQID", animationKey: "key" }]);
    }) as typeof fetch;
    let nowMs = 0;
    const exchanges: string[] = [];
    const provider = new InternalGraphqlConfigurationProvider(
      (exchange) => {
        exchanges.push(exchange.source);
      },
      1_000,
      fetchImplementation,
      () => nowMs,
    );

    expect((await provider.get()).queryId).toBe("query-1");
    expect((await provider.get()).queryId).toBe("query-1");
    expect(calls).toBe(2);
    nowMs = 2_000;
    fail = true;
    expect((await provider.get()).queryId).toBe("query-1");
    expect(calls).toBe(3);
    expect(exchanges).toEqual([
      "x_internal_api_document",
      "x_transaction_pairs",
      "x_internal_api_document",
    ]);
  });

  test("クライアントは設定供給関数から query ID と feature を使う", async () => {
    let requested: URL | null = null;
    const fetchImplementation = (async (input: string | URL | Request) => {
      requested = new URL(String(input));
      return new Response("{}", {
        status: 200,
        headers: {
          "x-rate-limit-limit": "50",
          "x-rate-limit-remaining": "49",
          "x-rate-limit-reset": "1700000000",
        },
      });
    }) as typeof fetch;
    const client = new XInternalGraphqlClient(
      { authToken: "a", csrfToken: "c", bearerToken: "b" },
      async () => ({
        queryId: "query-2",
        features: { flag: false },
        pairs: [{ verification: "AQID", animationKey: "k" }],
      }),
      fetchImplementation,
    );

    const result = await client.fetchUserTweetsAndReplies({ userId: "42", handle: "example" });

    expect(result.queryId).toBe("query-2");
    expect(result.rateLimitRemaining).toBe(49);
    expect(result.rateLimitResetAt).toBe("2023-11-14T22:13:20.000Z");
    expect(result.posts).toEqual([]);
    expect(requested!.pathname).toBe("/i/api/graphql/query-2/UserTweetsAndReplies");
    expect(JSON.parse(requested!.searchParams.get("variables")!)).toMatchObject({ userId: "42" });
  });
});

function entry(entryId: string, itemContent: object): object {
  return { entryId, content: { itemContent } };
}

function tweet(
  id: string,
  legacy: object,
  extra: object = {},
): { tweet_results: { result: object } } {
  return {
    tweet_results: {
      result: {
        __typename: "Tweet",
        rest_id: id,
        core: { user_results: { result: { rest_id: "99", core: { screen_name: "Example" } } } },
        legacy: { created_at: "Thu Sep 03 00:00:00 +0000 2026", user_id_str: "99", ...legacy },
        ...extra,
      },
    },
  };
}
