import type { Database } from "bun:sqlite";

/**
 * 受信アカウントと監視対象の組で、その投稿を前に観測したか。
 * 組の観測からたどる計画にしないのは、本番では 1 組に観測が 1 万件以上あり、
 * 初めて見る投稿や新しい投稿ではその全件を、取得 1 回につき投稿の数だけたどるためである。
 * 投稿 ID の索引から引き、自分の直近の観測が先に当たるよう新しい順にたどる。
 * 古い順にしないのは、ほかの受信アカウントが長く見てきた投稿を後から担当した受信アカウントが、毎回その全件をたどるため。
 * いまの SQLite は ORDER BY だけでも投稿 ID の索引を先に引くが、統計が入って計画が変わっても順を保つよう CROSS JOIN でも固定する。
 */
export const HAS_SEEN_POST_SQL = `SELECT 1
  FROM internal_graphql_observation_posts AS posts
  CROSS JOIN internal_graphql_observations AS observations
    ON observations.id = posts.observation_id
  WHERE observations.receiver_id = $receiverId
    AND observations.target_id = $targetId
    AND posts.post_id = $postId
  ORDER BY posts.observation_id DESC
  LIMIT 1`;

export interface NewObservation {
  receiverId: number;
  targetId: number;
  fetchedAt: string;
  completedAt: string;
  queryId: string;
  endpoint: string;
  variablesJson: string;
  featuresJson: string;
  transactionId: string | null;
  responseStatus: number | null;
  responseText: string | null;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  error: string | null;
  parseError: string | null;
}

export interface NewObservationPost {
  postId: string;
  createdAt: string | null;
  authorUserId: string | null;
  authorHandle: string | null;
  typesJson: string;
  referencedPostIdsJson: string;
  referencedAuthorHandle: string | null;
  /** 添付メディアの種別を並べた JSON。判定できなかった投稿は null。 */
  mediaTypesJson: string | null;
  rawResultJson: string;
  isTargetAuthor: number;
}

export interface NewTargetPost {
  id: number;
  postId: string;
  createdAt: string | null;
  authorHandle: string | null;
  typesJson: string;
  referencedPostIdsJson: string;
  referencedAuthorHandle: string | null;
  mediaTypesJson: string | null;
  /** 同じ受信アカウントがこの対象の取得で初めて見た投稿か。 */
  isNew: boolean;
}

export interface ObservationView {
  id: number;
  receiverId: number;
  receiverLabel: string;
  targetId: number;
  targetHandle: string;
  fetchedAt: string;
  completedAt: string;
  queryId: string;
  responseStatus: number | null;
  hasResponseText: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  error: string | null;
  parseError: string | null;
  postCount: number;
  targetPostCount: number;
  newPostCount: number;
}

export interface PostSightingView {
  id: number;
  observationId: number;
  postId: string;
  receiverLabel: string;
  targetHandle: string;
  fetchedAt: string;
  createdAt: string | null;
  authorHandle: string | null;
  typesJson: string;
  referencedPostIdsJson: string;
  mediaTypesJson: string | null;
  isNew: number;
  isTargetAuthor: number;
}

export class InternalGraphqlRepository {
  constructor(private readonly db: Database) {}

  recordObservation(
    observation: NewObservation,
    posts: readonly NewObservationPost[],
  ): {
    observationId: number;
    newPostCount: number;
    postCount: number;
    targetPostCount: number;
    newTargetPosts: NewTargetPost[];
    targetPosts: NewTargetPost[];
  } {
    const insertObservation = this.db.query(
      `INSERT INTO internal_graphql_observations (
         receiver_id, target_id, fetched_at, completed_at, query_id, endpoint,
         variables_json, features_json, transaction_id, response_status,
         response_text, rate_limit_limit, rate_limit_remaining,
         rate_limit_reset_at, error, parse_error
       ) VALUES (
         $receiverId, $targetId, $fetchedAt, $completedAt, $queryId, $endpoint,
         $variablesJson, $featuresJson, $transactionId, $responseStatus,
         $responseText, $rateLimitLimit, $rateLimitRemaining,
         $rateLimitResetAt, $error, $parseError
       )
       RETURNING id`,
    );
    // 初出判定は受信アカウントと監視対象の組ごとに行う。
    // 受信アカウントを追加した直後に過去投稿を「新規」と誤判定しても、
    // 配信側の起動時刻境界と経路単位の重複排除で Discord には送られない。
    const hasSeenPost = this.db.query(HAS_SEEN_POST_SQL);
    const insertPost = this.db.query(
      `INSERT INTO internal_graphql_observation_posts (
         observation_id, post_id, created_at, author_user_id, author_handle,
         types_json, referenced_post_ids_json, referenced_author_handle, media_types_json,
         raw_result_json, is_new, is_target_author
       ) VALUES (
         $observationId, $postId, $createdAt, $authorUserId, $authorHandle,
         $typesJson, $referencedPostIdsJson, $referencedAuthorHandle, $mediaTypesJson,
         $rawResultJson, $isNew, $isTargetAuthor
       )
       RETURNING id`,
    );
    return this.db.transaction(() => {
      const inserted = insertObservation.get({ ...observation }) as { id: number };
      let newPostCount = 0;
      let targetPostCount = 0;
      const newTargetPosts: NewTargetPost[] = [];
      const targetPosts: NewTargetPost[] = [];
      for (const post of posts) {
        const isNew =
          hasSeenPost.get({
            receiverId: observation.receiverId,
            targetId: observation.targetId,
            postId: post.postId,
          }) === null
            ? 1
            : 0;
        targetPostCount += post.isTargetAuthor;
        newPostCount += isNew * post.isTargetAuthor;
        // 初出でない投稿の生 JSON は保存しない。同じ投稿を毎周回入れ直すことになり、
        // しかも同じ内容は観測の response_text にも初出時の行にも既にある。
        // 保持期間切れで raw_result_json が NULL になった行と同じ形なので、読み手はそのまま扱える。
        const storedPost = insertPost.get({
          observationId: inserted.id,
          ...post,
          rawResultJson: isNew === 1 ? post.rawResultJson : null,
          isNew,
        }) as { id: number };
        if (post.isTargetAuthor === 1) {
          const targetPost = {
            id: storedPost.id,
            postId: post.postId,
            createdAt: post.createdAt,
            authorHandle: post.authorHandle,
            typesJson: post.typesJson,
            referencedPostIdsJson: post.referencedPostIdsJson,
            referencedAuthorHandle: post.referencedAuthorHandle,
            mediaTypesJson: post.mediaTypesJson,
            isNew: isNew === 1,
          };
          targetPosts.push(targetPost);
          if (isNew === 1) newTargetPosts.push(targetPost);
        }
      }
      this.db
        .query(
          `UPDATE internal_graphql_observations
           SET post_count = $postCount, target_post_count = $targetPostCount, new_post_count = $newPostCount
           WHERE id = $observationId`,
        )
        .run({
          observationId: inserted.id,
          postCount: posts.length,
          targetPostCount,
          newPostCount,
        });
      return {
        observationId: inserted.id,
        newPostCount,
        postCount: posts.length,
        targetPostCount,
        newTargetPosts,
        targetPosts,
      };
    })();
  }

  listRecent(
    limit: number,
    filter: { targetHandle?: string; errorsOnly?: boolean } = {},
  ): ObservationView[] {
    return this.db
      .query(
        `SELECT observations.id, observations.receiver_id AS receiverId, receivers.label AS receiverLabel,
                observations.target_id AS targetId, targets.handle AS targetHandle,
                observations.fetched_at AS fetchedAt, observations.completed_at AS completedAt,
                observations.query_id AS queryId, observations.response_status AS responseStatus,
                (observations.response_text IS NOT NULL) AS hasResponseText,
                observations.rate_limit_limit AS rateLimitLimit,
                observations.rate_limit_remaining AS rateLimitRemaining,
                observations.rate_limit_reset_at AS rateLimitResetAt,
                observations.error, observations.parse_error AS parseError,
                observations.post_count AS postCount, observations.target_post_count AS targetPostCount,
                observations.new_post_count AS newPostCount
         FROM internal_graphql_observations AS observations
         JOIN receivers ON receivers.id = observations.receiver_id
         JOIN watch_targets AS targets ON targets.id = observations.target_id
         WHERE ($targetHandle IS NULL OR targets.handle = $targetHandle)
           AND ($errorsOnly = 0 OR observations.error IS NOT NULL OR observations.parse_error IS NOT NULL
                OR observations.response_status IS NULL OR observations.response_status != 200)
         ORDER BY observations.id DESC
         LIMIT $limit`,
      )
      .all({
        limit,
        targetHandle: filter.targetHandle ?? null,
        errorsOnly: filter.errorsOnly ? 1 : 0,
      }) as ObservationView[];
  }

  getResponseText(id: number): { id: number; responseText: string | null } | null {
    return this.db
      .query(
        "SELECT id, response_text AS responseText FROM internal_graphql_observations WHERE id = $id",
      )
      .get({ id }) as { id: number; responseText: string | null } | null;
  }

  listPostsForObservation(observationId: number): Array<Record<string, unknown>> {
    return this.db
      .query(
        `SELECT id, post_id AS postId, created_at AS createdAt, author_user_id AS authorUserId,
                author_handle AS authorHandle, types_json AS typesJson,
                referenced_post_ids_json AS referencedPostIdsJson,
                referenced_author_handle AS referencedAuthorHandle,
                media_types_json AS mediaTypesJson, raw_result_json AS rawResultJson,
                is_new AS isNew, is_target_author AS isTargetAuthor
         FROM internal_graphql_observation_posts
         WHERE observation_id = $observationId
         ORDER BY id`,
      )
      .all({ observationId }) as Array<Record<string, unknown>>;
  }

  /**
   * 投稿は周回ごとに取り直されて観測の数だけ行があるので、件数と最終時刻は全体から、行は古い順に limit 件だけ返す。
   * リポストの元投稿 ID からは引かない。referenced_post_ids_json には索引が無く、全行を走査することになるため。
   */
  listPostSightings(
    postIds: readonly string[],
    limit: number,
  ): { count: number; lastFetchedAt: string | null; sightings: PostSightingView[] } {
    const params = { postIds: JSON.stringify(postIds) };
    const summary = this.db
      .query(
        `SELECT count(*) AS count, max(observations.fetched_at) AS lastFetchedAt
         FROM internal_graphql_observation_posts AS posts
         JOIN internal_graphql_observations AS observations ON observations.id = posts.observation_id
         WHERE posts.post_id IN (SELECT value FROM json_each($postIds))`,
      )
      .get(params) as { count: number; lastFetchedAt: string | null };
    const sightings = this.db
      .query(
        `SELECT posts.id, posts.observation_id AS observationId, posts.post_id AS postId,
                receivers.label AS receiverLabel, targets.handle AS targetHandle,
                observations.fetched_at AS fetchedAt, posts.created_at AS createdAt,
                posts.author_handle AS authorHandle, posts.types_json AS typesJson,
                posts.referenced_post_ids_json AS referencedPostIdsJson,
                posts.media_types_json AS mediaTypesJson, posts.is_new AS isNew,
                posts.is_target_author AS isTargetAuthor
         FROM internal_graphql_observation_posts AS posts
         JOIN internal_graphql_observations AS observations ON observations.id = posts.observation_id
         JOIN receivers ON receivers.id = observations.receiver_id
         JOIN watch_targets AS targets ON targets.id = observations.target_id
         WHERE posts.post_id IN (SELECT value FROM json_each($postIds))
         ORDER BY posts.id
         LIMIT $limit`,
      )
      .all({ ...params, limit }) as PostSightingView[];
    return { ...summary, sightings };
  }

  latestFetchedAt(receiverId: number): string | null {
    const row = this.db
      .query(
        "SELECT max(fetched_at) AS fetchedAt FROM internal_graphql_observations WHERE receiver_id = $receiverId",
      )
      .get({ receiverId }) as { fetchedAt: string | null };
    return row.fetchedAt;
  }
}
