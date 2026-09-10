import { describe, expect, test } from "bun:test";

import type { NewObservation, NewObservationPost } from "../src/db/repositories/internalGraphql";
import { isMediaAllowed, mediaTypesFromJson } from "../src/mediaFilter";
import {
  deliverNewInternalPosts,
  InternalPollCollector,
} from "../src/pipeline/internalPollCollector";
import { postLookupFromPost, WebPushPipeline } from "../src/pipeline/webpushPipeline";
import { DeliveryService } from "../src/services/deliveryService";
import { PostLookupCache } from "../src/services/postLookupCache";
import { decodeBase64url } from "../src/utils/base64url";
import type { WebPushKeys } from "../src/webpush/keys";
import type {
  InternalPostType,
  InternalTimelineFetchResult,
  InternalTweetLookupResult,
  XInternalGraphqlClient,
} from "../src/x/internalGraphql";
import { classifyTweetResult } from "../src/x/internalGraphql";
import {
  addReceiver,
  addTarget,
  createRecordingSender,
  createTestContext,
} from "./helpers/database";
import { encryptAes128Gcm } from "./helpers/webpush";

const RFC_PUBLIC_KEY =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const publicBytes = decodeBase64url(RFC_PUBLIC_KEY);
const keys: WebPushKeys = {
  publicKey: RFC_PUBLIC_KEY,
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  privateKeyJwk: {
    kty: "EC",
    crv: "P-256",
    x: Buffer.from(publicBytes.slice(1, 33)).toString("base64url"),
    y: Buffer.from(publicBytes.slice(33, 65)).toString("base64url"),
    d: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    ext: true,
  },
};

function photoMedia(count = 1): Record<string, unknown> {
  return { media: Array.from({ length: count }, () => ({ type: "photo" })) };
}

function tweet(input: {
  restId: string;
  legacy?: Record<string, unknown>;
}): Record<string, unknown> {
  return { rest_id: input.restId, legacy: { ...input.legacy } };
}

/**
 * 投稿 ID から投稿時刻を復元して経路の作成時刻と比べるため、実在しうる snowflake を作る。
 * 固定値では経路の作成より前の投稿になり、メディアとは関係なく落ちる。
 */
function recentPostId(offsetMs = 0): string {
  return String((BigInt(Date.now() + offsetMs - 1_288_834_974_657) << 22n) + 1n);
}

describe("isMediaAllowed", () => {
  test("すべてを選んだ経路は判定できなかった投稿も通す", () => {
    expect(isMediaAllowed("all", null)).toBe(true);
    expect(isMediaAllowed("all", [])).toBe(true);
  });

  test("画像付きのみを選んだ経路は、判定できなかった投稿を通さない", () => {
    expect(isMediaAllowed("photo", ["photo"])).toBe(true);
    expect(isMediaAllowed("photo", ["photo", "photo"])).toBe(true);
    expect(isMediaAllowed("photo", [])).toBe(false);
    expect(isMediaAllowed("photo", ["video"])).toBe(false);
    expect(isMediaAllowed("photo", ["animated_gif"])).toBe(false);
    expect(isMediaAllowed("photo", null)).toBe(false);
  });

  test("保存された JSON を読み戻す。列が空なら判定できなかった扱いにする", () => {
    expect(mediaTypesFromJson('["photo"]')).toEqual(["photo"]);
    expect(mediaTypesFromJson("[]")).toEqual([]);
    expect(mediaTypesFromJson(null)).toBeNull();
    expect(mediaTypesFromJson("壊れた JSON")).toBeNull();
  });
});

describe("追加取得の結果の組み立て", () => {
  test("メディアが読めなくても失敗にせず、確定した種別をそのまま返す", () => {
    // 失敗にすると受信アカウント間で共有するキャッシュから消え、同じ応答を何度も引き直すことになる。
    expect(postLookupFromPost({ types: ["quote"], mediaTypes: null })).toEqual({
      kinds: ["quotes"],
      mediaTypes: null,
    });
    expect(postLookupFromPost({ types: ["original"], mediaTypes: ["photo"] })).toEqual({
      kinds: ["posts"],
      mediaTypes: ["photo"],
    });
  });
});

function lookupResult(
  post: { types: InternalPostType[]; mediaTypes: string[] | null } | null,
): InternalTweetLookupResult {
  return {
    fetchedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:00:00.500Z",
    queryId: "q",
    endpoint: "https://x.com/i/api/graphql/q/TweetResultByRestId",
    variables: {},
    features: {},
    transactionId: null,
    responseStatus: post === null ? 404 : 200,
    responseText: "{}",
    rateLimitLimit: null,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    error: post === null ? "投稿がありません" : null,
    parseError: null,
    post:
      post === null
        ? null
        : {
            postId: "100",
            createdAt: "2026-09-05T00:00:00.000Z",
            authorUserId: "42",
            authorHandle: "example",
            types: post.types,
            referencedPostIds: [],
            referencedAuthorHandle: null,
            mediaTypes: post.mediaTypes,
            rawResult: {},
          },
  };
}

describe("追加取得の共有キャッシュ", () => {
  test("メディアが読めなかった結果も受信アカウントをまたいで再利用する", async () => {
    const context = createTestContext();
    try {
      const receiverA = addReceiver(context, "receiver-a");
      const receiverB = addReceiver(context, "receiver-b");
      let fetches = 0;
      const client = {
        async fetchTweetResult(): Promise<InternalTweetLookupResult> {
          fetches += 1;
          return lookupResult({ types: ["quote"], mediaTypes: null });
        },
      } as unknown as XInternalGraphqlClient;
      const cache = new PostLookupCache(context.exchanges);

      // 受信アカウントが違っても、同じ投稿なら取得は 1 回。
      expect(await cache.get(receiverA, client, "100")).toEqual({
        kinds: ["quotes"],
        mediaTypes: null,
      });
      expect(await cache.get(receiverB, client, "100")).toEqual({
        kinds: ["quotes"],
        mediaTypes: null,
      });
      expect(fetches).toBe(1);
    } finally {
      context.db.close();
    }
  });

  test("取得そのものが失敗した投稿は残さず、次の通知で引き直す", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      let fetches = 0;
      const client = {
        async fetchTweetResult(): Promise<InternalTweetLookupResult> {
          fetches += 1;
          return fetches === 1
            ? lookupResult(null)
            : lookupResult({ types: ["original"], mediaTypes: ["photo"] });
        },
      } as unknown as XInternalGraphqlClient;
      const cache = new PostLookupCache(context.exchanges);

      await expect(cache.get(receiverId, client, "100")).rejects.toThrow("投稿がありません");
      expect(await cache.get(receiverId, client, "100")).toEqual({
        kinds: ["posts"],
        mediaTypes: ["photo"],
      });
      expect(fetches).toBe(2);
    } finally {
      context.db.close();
    }
  });
});

describe("生 JSON からのメディア種別の読み取り", () => {
  test("添付の枚数と種別をそのまま並べる", () => {
    expect(
      classifyTweetResult(tweet({ restId: "1", legacy: { extended_entities: photoMedia() } }))
        ?.mediaTypes,
    ).toEqual(["photo"]);
    expect(
      classifyTweetResult(tweet({ restId: "1", legacy: { extended_entities: photoMedia(4) } }))
        ?.mediaTypes,
    ).toEqual(["photo", "photo", "photo", "photo"]);
    expect(
      classifyTweetResult(
        tweet({
          restId: "1",
          legacy: { extended_entities: { media: [{ type: "video" }] } },
        }),
      )?.mediaTypes,
    ).toEqual(["video"]);
    expect(
      classifyTweetResult(
        tweet({
          restId: "1",
          legacy: { extended_entities: { media: [{ type: "animated_gif" }] } },
        }),
      )?.mediaTypes,
    ).toEqual(["animated_gif"]);
  });

  test("添付が無い投稿は空配列になり、判定不能とは区別される", () => {
    expect(classifyTweetResult(tweet({ restId: "1" }))?.mediaTypes).toEqual([]);
    expect(
      classifyTweetResult(tweet({ restId: "1", legacy: { extended_entities: {} } }))?.mediaTypes,
    ).toEqual([]);
  });

  test("構造があるのに読めないときは、添付なしと決めつけずに判定不能にする", () => {
    expect(
      classifyTweetResult(tweet({ restId: "1", legacy: { extended_entities: "壊れた値" } }))
        ?.mediaTypes,
    ).toBeNull();
    expect(
      classifyTweetResult(
        tweet({ restId: "1", legacy: { extended_entities: { media: "配列ではない" } } }),
      )?.mediaTypes,
    ).toBeNull();
    expect(
      classifyTweetResult(tweet({ restId: "1", legacy: { extended_entities: { media: [{}] } } }))
        ?.mediaTypes,
    ).toBeNull();
  });

  test("1 枚目しか入らない entities.media ではなく extended_entities.media を読む", () => {
    expect(
      classifyTweetResult(
        tweet({
          restId: "1",
          legacy: {
            entities: photoMedia(1),
            extended_entities: photoMedia(3),
          },
        }),
      )?.mediaTypes,
    ).toEqual(["photo", "photo", "photo"]);
  });

  test("リポストは元投稿の添付を見る", () => {
    const post = classifyTweetResult(
      tweet({
        restId: "10",
        legacy: {
          retweeted_status_result: {
            result: tweet({ restId: "1", legacy: { extended_entities: photoMedia(2) } }),
          },
        },
      }),
    );
    expect(post?.types).toEqual(["repost"]);
    expect(post?.mediaTypes).toEqual(["photo", "photo"]);
  });

  test("リポストの参照先が tweet で包まれていても展開する", () => {
    expect(
      classifyTweetResult(
        tweet({
          restId: "10",
          legacy: {
            retweeted_status_result: {
              result: {
                tweet: tweet({ restId: "1", legacy: { extended_entities: photoMedia() } }),
              },
            },
          },
        }),
      )?.mediaTypes,
    ).toEqual(["photo"]);
  });

  test("リポストの参照先が読めないときは判定不能にする", () => {
    // 元投稿に legacy が無くてもリポストとしては成立するので、添付が無いと決めつけない。
    const post = classifyTweetResult(
      tweet({
        restId: "10",
        legacy: { retweeted_status_result: { result: { rest_id: "1", core: {} } } },
      }),
    );
    expect(post?.types).toEqual(["repost"]);
    expect(post?.mediaTypes).toBeNull();
  });

  test("引用は引用元の添付を拾わない", () => {
    const post = classifyTweetResult({
      rest_id: "10",
      legacy: { is_quote_status: true },
      quoted_status_result: {
        result: tweet({ restId: "1", legacy: { extended_entities: photoMedia(2) } }),
      },
    });
    expect(post?.types).toEqual(["quote"]);
    expect(post?.mediaTypes).toEqual([]);
  });

  test("引用者自身の添付は拾う", () => {
    const post = classifyTweetResult({
      rest_id: "10",
      legacy: { is_quote_status: true, extended_entities: photoMedia() },
      quoted_status_result: { result: tweet({ restId: "1" }) },
    });
    expect(post?.types).toEqual(["quote"]);
    expect(post?.mediaTypes).toEqual(["photo"]);
  });
});

describe("経路のメディア設定", () => {
  test("既定はすべてで、省略した再登録は既存の設定を変えない", () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      const first = context.routes.add({ targetId: target, guildId: "g", channelId: "c" });
      expect(first.route.mediaFilter).toBe("all");

      const second = context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "c",
        mediaFilter: "photo",
      });
      expect(second.route.mediaFilter).toBe("photo");

      const third = context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "c",
        kinds: { replies: false },
      });
      expect(third.route.mediaFilter).toBe("photo");
      expect(third.route.kinds.replies).toBe(false);
    } finally {
      context.db.close();
    }
  });
});

describe("メディアによる配信の絞り込み", () => {
  test("画像付きのみの経路には画像なしの投稿を送らない", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "all" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      const base = {
        source: "internal_graphql" as const,
        targetId: target,
        kinds: ["posts"] as const,
      };

      expect(
        await service.deliver({
          ...base,
          sourceRecordId: 1,
          postId: "1",
          postUrl: "text-only",
          mediaTypes: [],
        }),
      ).toMatchObject({ sent: 1, filtered: 1 });
      expect(
        await service.deliver({
          ...base,
          sourceRecordId: 2,
          postId: "2",
          postUrl: "with-photo",
          mediaTypes: ["photo"],
        }),
      ).toMatchObject({ sent: 2, filtered: 0 });
      expect(
        await service.deliver({
          ...base,
          sourceRecordId: 3,
          postId: "3",
          postUrl: "unknown",
          mediaTypes: null,
        }),
      ).toMatchObject({ sent: 1, filtered: 1 });

      expect(sender.sent).toEqual([
        "all:text-only",
        "all:with-photo",
        "photo:with-photo",
        "all:unknown",
      ]);
    } finally {
      context.db.close();
    }
  });

  test("メディアの解決は、経路の設定が必要とするときだけ走る", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      let resolutions = 0;
      const resolve = async (): Promise<readonly string[]> => {
        resolutions += 1;
        return ["photo"];
      };
      const base = {
        source: "internal_graphql" as const,
        targetId: target,
        kinds: ["posts"] as const,
        mediaTypes: resolve,
      };

      context.routes.add({ targetId: target, guildId: "g", channelId: "all" });
      expect(
        await service.deliver({ ...base, sourceRecordId: 1, postId: "1", postUrl: "a" }),
      ).toMatchObject({ sent: 1 });
      expect(resolutions).toBe(0);

      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      expect(
        await service.deliver({ ...base, sourceRecordId: 2, postId: "2", postUrl: "b" }),
      ).toMatchObject({ sent: 2 });
      // 経路が 2 つあっても、解決は投稿ごとに 1 回で済む。
      expect(resolutions).toBe(1);
    } finally {
      context.db.close();
    }
  });

  test("種別で落ちる経路のためにメディアを引かない", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);
      let resolutions = 0;
      const resolve = async (): Promise<readonly string[]> => {
        resolutions += 1;
        return ["photo"];
      };

      // 画像付きのみだがリポストを拒否する経路と、すべて送るがリポストを許す経路。
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo-no-reposts",
        kinds: { reposts: false },
        mediaFilter: "photo",
      });
      context.routes.add({ targetId: target, guildId: "g", channelId: "all-reposts" });

      expect(
        await service.deliver({
          source: "webpush",
          sourceRecordId: 1,
          targetId: target,
          postId: "1",
          postUrl: "repost",
          kinds: ["reposts"],
          mediaTypes: resolve,
        }),
      ).toMatchObject({ sent: 1, filtered: 1 });
      expect(resolutions).toBe(0);
      expect(sender.sent).toEqual(["all-reposts:repost"]);
    } finally {
      context.db.close();
    }
  });

  test("解決に失敗した投稿は画像付きのみの経路へ送らず、すべての経路へは送る", async () => {
    const context = createTestContext();
    try {
      const target = addTarget(context, { handle: "example" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "all" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      const sender = createRecordingSender();
      const service = new DeliveryService(context.routes, context.deliveries, sender);

      expect(
        await service.deliver({
          source: "webpush",
          sourceRecordId: 1,
          targetId: target,
          postId: "1",
          postUrl: "unresolved",
          kinds: ["posts"],
          mediaTypes: async () => {
            throw new Error("lookup failed");
          },
        }),
      ).toMatchObject({ sent: 1, filtered: 1 });
      expect(sender.sent).toEqual(["all:unresolved"]);
    } finally {
      context.db.close();
    }
  });
});

describe("Web Push 経路のメディア判定", () => {
  async function notify(input: {
    pipeline: WebPushPipeline;
    receiverId: number;
    uri: string;
    title: string;
    tag?: string;
  }): Promise<number> {
    const payload = JSON.stringify({
      data: {
        uri: input.uri,
        title: input.title,
        ...(input.tag === undefined ? {} : { tag: input.tag }),
      },
    });
    return await input.pipeline.process({
      receiverId: input.receiverId,
      keys,
      notification: {
        rawText: "{}",
        channelId: "channel",
        version: "1",
        headers: { encoding: "aes128gcm" },
        data: await encryptAes128Gcm(payload, keys),
      },
    });
  }

  test("画像付きのみの経路があるとき、リポストも元投稿を引いて判定する", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", displayName: "サンプル" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      // 元投稿の種別でリポストを上書きすると、この経路へ届いてしまう。
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo-no-reposts",
        kinds: { reposts: false },
        mediaFilter: "photo",
      });
      const sender = createRecordingSender();
      const lookups: string[] = [];
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        classifyPost: async (postId) => {
          lookups.push(postId);
          // 引くのは元投稿なので、返る種別は元投稿のもの。リポストの種別を上書きしてはならない。
          return { kinds: ["posts"], mediaTypes: ["photo"] };
        },
      });

      // リポストの通知は元投稿の URI を運び、tag にリポスト自身の ID が入る。
      const originalId = recentPostId();
      const repostId = recentPostId(1_000);
      expect(
        await notify({
          pipeline,
          receiverId,
          uri: `https://x.com/original_author/status/${originalId}`,
          title: "サンプル",
          tag: `tweet-${repostId}`,
        }),
      ).toBe(100);

      // 引くのは元投稿。重複排除に使う ID はリポスト自身。
      expect(lookups).toEqual([originalId]);
      // リポストを拒否する経路へは届かない。種別はリポストのまま扱われている。
      expect(sender.sent).toEqual([`photo:https://x.com/original_author/status/${originalId}`]);
      expect(context.deliveries.queueState(1, repostId)).toBe("sent");
      expect(
        (
          context.db
            .query("SELECT kinds_json AS kindsJson FROM delivery_queue WHERE post_id = $postId")
            .get({ postId: repostId }) as { kindsJson: string }
        ).kindsJson,
      ).toBe('["reposts"]');
    } finally {
      context.db.close();
    }
  });

  test("画像が無いリポストは画像付きのみの経路へ送らない", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", displayName: "サンプル" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      const sender = createRecordingSender();
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        classifyPost: async () => ({ kinds: ["reposts"], mediaTypes: [] }),
      });

      const originalId = recentPostId();
      const repostId = recentPostId(1_000);
      await notify({
        pipeline,
        receiverId,
        uri: `https://x.com/original_author/status/${originalId}`,
        title: "サンプル",
        tag: `tweet-${repostId}`,
      });
      expect(sender.sent).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  test("すべてを送る経路しかなければ、リポストで投稿を引かない", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", displayName: "サンプル" });
      context.routes.add({ targetId: target, guildId: "g", channelId: "all" });
      const sender = createRecordingSender();
      const lookups: string[] = [];
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        classifyPost: async (postId) => {
          lookups.push(postId);
          return { kinds: ["reposts"], mediaTypes: ["photo"] };
        },
      });

      const originalId = recentPostId();
      const repostId = recentPostId(1_000);
      await notify({
        pipeline,
        receiverId,
        uri: `https://x.com/original_author/status/${originalId}`,
        title: "サンプル",
        tag: `tweet-${repostId}`,
      });
      expect(lookups).toEqual([]);
      expect(sender.sent).toEqual([`all:https://x.com/original_author/status/${originalId}`]);
    } finally {
      context.db.close();
    }
  });

  test("種別とメディアの両方が要るときも、投稿を引くのは 1 回で済む", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", displayName: "サンプル" });
      // 通常投稿と引用の扱いが違うので種別の解決が要り、画像付きのみなのでメディアの解決も要る。
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo-no-quotes",
        kinds: { quotes: false },
        mediaFilter: "photo",
      });
      const sender = createRecordingSender();
      let lookups = 0;
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        classifyPost: async () => {
          lookups += 1;
          return { kinds: ["posts"], mediaTypes: ["photo"] };
        },
      });

      const originalId = recentPostId();
      await notify({
        pipeline,
        receiverId,
        uri: `https://x.com/example/status/${originalId}`,
        title: "サンプル",
      });
      expect(lookups).toBe(1);
      expect(sender.sent).toEqual([`photo-no-quotes:https://x.com/example/status/${originalId}`]);
    } finally {
      context.db.close();
    }
  });

  test("取得が失敗しても 1 回しか引かず、種別は送る側へ倒してメディアは送らない側へ倒す", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", displayName: "サンプル" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo-no-quotes",
        kinds: { quotes: false },
        mediaFilter: "photo",
      });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "all-no-quotes",
        kinds: { quotes: false },
      });
      const sender = createRecordingSender();
      let lookups = 0;
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        classifyPost: async () => {
          lookups += 1;
          throw new Error("lookup failed");
        },
      });

      const originalId = recentPostId();
      await notify({
        pipeline,
        receiverId,
        uri: `https://x.com/example/status/${originalId}`,
        title: "サンプル",
      });
      // 両軸が同じ取得を共有するので、失敗しても 2 回目は走らない。
      expect(lookups).toBe(1);
      // 種別は通常投稿か引用のどちらかとみなして送り、メディアは判定不能なので送らない。
      expect(sender.sent).toEqual([`all-no-quotes:https://x.com/example/status/${originalId}`]);
    } finally {
      context.db.close();
    }
  });

  test("投稿は取れたがメディアが読めないとき、確定した種別は候補へ戻さない", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", displayName: "サンプル" });
      // 引用だけを許す経路。種別を候補 (通常投稿か引用) へ戻す誤実装でもここへは届くので、
      // 通常投稿だけを許す経路を並べて、そちらへ漏れないことで種別の確定を見る。
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "quotes-only",
        kinds: { posts: false, reposts: false, replies: false },
      });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "posts-only",
        kinds: { quotes: false, reposts: false, replies: false },
      });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo-quotes-only",
        kinds: { posts: false, reposts: false, replies: false },
        mediaFilter: "photo",
      });
      const sender = createRecordingSender();
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        // 取得は成立している。読めなかったのはメディアだけ。
        classifyPost: async () => ({ kinds: ["quotes"], mediaTypes: null }),
      });

      const originalId = recentPostId();
      await notify({
        pipeline,
        receiverId,
        uri: `https://x.com/example/status/${originalId}`,
        title: "サンプル",
      });

      // 引用として扱われるので通常投稿だけの経路へは行かず、メディアが不明なので画像付きのみの経路にも行かない。
      expect(sender.sent).toEqual([`quotes-only:https://x.com/example/status/${originalId}`]);
    } finally {
      context.db.close();
    }
  });
});

function observation(fetchedAt: string): NewObservation {
  return {
    receiverId: 1,
    targetId: 1,
    fetchedAt,
    completedAt: fetchedAt,
    queryId: "q",
    endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
    variablesJson: "{}",
    featuresJson: "{}",
    transactionId: null,
    responseStatus: 200,
    responseText: "{}",
    rateLimitLimit: 50,
    rateLimitRemaining: 49,
    rateLimitResetAt: null,
    error: null,
    parseError: null,
  };
}

function observedPost(mediaTypesJson: string | null): NewObservationPost {
  return {
    postId: "500",
    createdAt: "2026-09-05T00:00:00.000Z",
    authorUserId: "42",
    authorHandle: "example",
    typesJson: '["original"]',
    referencedPostIdsJson: "[]",
    referencedAuthorHandle: null,
    mediaTypesJson,
    rawResultJson: "{}",
    isTargetAuthor: 1,
  };
}

describe("内部 GraphQL 経路のメディア判定", () => {
  test("判定できなかった投稿は、後の観測で判定できれば送られ、その次は重複排除される", async () => {
    const context = createTestContext();
    try {
      addReceiver(context);
      const target = addTarget(context, { handle: "example" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      context.db
        .query("UPDATE routes SET created_at = $createdAt WHERE target_id = $targetId")
        .run({ targetId: target, createdAt: "2026-09-04T00:00:00.000Z" });
      const sender = createRecordingSender();
      const delivery = new DeliveryService(context.routes, context.deliveries, sender);

      const deliverObserved = async (
        mediaTypesJson: string | null,
        fetchedAt: string,
      ): Promise<{ sent: number; filtered: number; skipped: number }> => {
        const stored = context.observations.recordObservation(observation(fetchedAt), [
          observedPost(mediaTypesJson),
        ]);
        return await deliverNewInternalPosts({
          delivery,
          target: { id: target, handle: "example" },
          posts: stored.targetPosts,
          attemptedAt: fetchedAt,
        });
      };

      // 判定できなければキューに入れない。初出でない再観測でも判定材料は毎回渡るので、
      // 次の観測で読めれば送られる。
      expect(await deliverObserved(null, "2026-09-05T00:00:00.000Z")).toMatchObject({
        sent: 0,
        filtered: 1,
      });
      expect(sender.sent).toEqual([]);

      expect(await deliverObserved('["photo"]', "2026-09-05T00:01:00.000Z")).toMatchObject({
        sent: 1,
        filtered: 0,
      });
      expect(sender.sent).toEqual(["photo:https://x.com/example/status/500"]);

      expect(await deliverObserved('["photo"]', "2026-09-05T00:02:00.000Z")).toMatchObject({
        sent: 0,
        skipped: 1,
      });
      expect(sender.sent).toEqual(["photo:https://x.com/example/status/500"]);
    } finally {
      context.db.close();
    }
  });

  test("取得した投稿のメディア種別が観測行を経由して配信判定へ渡る", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const target = addTarget(context, { handle: "example", userId: "42" });
      context.routes.add({
        targetId: target,
        guildId: "g",
        channelId: "photo",
        mediaFilter: "photo",
      });
      context.db
        .query("UPDATE routes SET created_at = $createdAt WHERE target_id = $targetId")
        .run({ targetId: target, createdAt: "2026-09-04T00:00:00.000Z" });
      const sender = createRecordingSender();
      const controller = new AbortController();
      const client = {
        async fetchUserTweetsAndReplies(input: {
          userId: string;
          handle: string;
        }): Promise<InternalTimelineFetchResult> {
          controller.abort();
          return {
            fetchedAt: "2026-09-05T00:00:00.000Z",
            completedAt: "2026-09-05T00:00:00.500Z",
            queryId: "q",
            endpoint: "https://x.com/i/api/graphql/q/UserTweetsAndReplies",
            variables: { userId: input.userId },
            features: {},
            transactionId: null,
            responseStatus: 200,
            responseText: "{}",
            rateLimitLimit: 50,
            rateLimitRemaining: 49,
            rateLimitResetAt: null,
            error: null,
            parseError: null,
            regularPostIds: ["500", "501"],
            bottomCursor: null,
            posts: [
              {
                postId: "500",
                createdAt: "2026-09-05T00:00:00.000Z",
                authorUserId: "42",
                authorHandle: "example",
                types: ["original"],
                referencedPostIds: [],
                referencedAuthorHandle: null,
                mediaTypes: ["photo"],
                rawResult: {},
              },
              {
                postId: "501",
                createdAt: "2026-09-05T00:00:00.000Z",
                authorUserId: "42",
                authorHandle: "example",
                types: ["original"],
                referencedPostIds: [],
                referencedAuthorHandle: null,
                mediaTypes: [],
                rawResult: {},
              },
            ],
          };
        },
      } as unknown as XInternalGraphqlClient;

      await new InternalPollCollector({
        receiverId,
        receiverLabel: "receiver-a",
        client,
        targets: context.targets,
        observations: context.observations,
        backlog: context.backlog,
        delivery: new DeliveryService(context.routes, context.deliveries, sender),
        selectTargets: (targets) => targets,
      }).run(controller.signal);

      expect(sender.sent).toEqual(["photo:https://x.com/example/status/500"]);
      expect(
        context.observations
          .listPostsForObservation(1)
          .map((post) => (post as { mediaTypesJson?: string | null }).mediaTypesJson ?? null),
      ).toEqual(['["photo"]', "[]"]);
    } finally {
      context.db.close();
    }
  });
});
