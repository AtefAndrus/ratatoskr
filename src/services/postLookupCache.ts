import type { ExchangeRepository } from "../db/repositories/exchanges";
import { type PostLookup, postLookupFromPost } from "../pipeline/webpushPipeline";
import { metrics } from "../utils/metrics";
import { SharedPromiseCache } from "../utils/sharedPromiseCache";
import type { XInternalGraphqlClient } from "../x/internalGraphql";

/** 種別とメディアを覚えておく投稿の件数。通知が届いてから配信するまでの間だけ効けばよいので小さくてよい。 */
const DEFAULT_LIMIT = 500;

/**
 * 投稿 1 件の種別とメディアを、受信アカウントをまたいで一度だけ解決する。
 * 受信アカウントは全員が同じ投稿の通知を受け取るため、経路単位の重複排除より前に走るこの取得だけが
 * 受信台数分だけ重複する。解決中の Promise ごと共有して 1 回に畳む。
 * 投稿の種別は後から変わらないので、期限切れは設けず件数だけで打ち切る。
 */
export class PostLookupCache {
  private readonly cache: SharedPromiseCache<PostLookup>;

  constructor(
    private readonly exchanges: Pick<ExchangeRepository, "record">,
    limit = DEFAULT_LIMIT,
  ) {
    this.cache = new SharedPromiseCache<PostLookup>(limit);
  }

  get(receiverId: number, client: XInternalGraphqlClient, postId: string): Promise<PostLookup> {
    return this.cache.get(postId, () => this.fetch(receiverId, client, postId));
  }

  /**
   * 投稿 1 件を内部 GraphQL で引く。応答は調査用に外部交換記録へ残す。
   * 投稿そのものを取得できなければ例外にする。共有キャッシュは失敗を捨てるので、次の通知で引き直せる。
   * メディアが読めなかっただけなら成功として返す。取得は成立しており、種別は確定しているため。
   */
  private async fetch(
    receiverId: number,
    client: XInternalGraphqlClient,
    postId: string,
  ): Promise<PostLookup> {
    const result = await client.fetchTweetResult(postId);
    this.exchanges.record({
      source: "x_tweet_lookup",
      receiverId,
      occurredAt: result.fetchedAt,
      method: "GET",
      url: result.endpoint,
      requestSummaryJson: JSON.stringify({ postId }),
      responseStatus: result.responseStatus,
      responseText: result.responseText,
      error: result.error ?? result.parseError,
    });
    metrics.increment("internal.tweet_lookups");
    if (result.post === null) {
      throw new Error(result.error ?? result.parseError ?? "投稿を取得できませんでした");
    }
    return postLookupFromPost(result.post);
  }
}
