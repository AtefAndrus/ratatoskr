import type { Database } from "bun:sqlite";

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
    const hasSeenPost = this.db.query(
      `SELECT 1
       FROM internal_graphql_observation_posts AS posts
       JOIN internal_graphql_observations AS observations ON observations.id = posts.observation_id
       WHERE observations.receiver_id = $receiverId
         AND observations.target_id = $targetId
         AND posts.post_id = $postId
       LIMIT 1`,
    );
    const insertPost = this.db.query(
      `INSERT INTO internal_graphql_observation_posts (
         observation_id, post_id, created_at, author_user_id, author_handle,
         types_json, referenced_post_ids_json, referenced_author_handle, raw_result_json,
         is_new, is_target_author
       ) VALUES (
         $observationId, $postId, $createdAt, $authorUserId, $authorHandle,
         $typesJson, $referencedPostIdsJson, $referencedAuthorHandle, $rawResultJson,
         $isNew, $isTargetAuthor
       )
       RETURNING id`,
    );
    return this.db.transaction(() => {
      const inserted = insertObservation.get({ ...observation }) as { id: number };
      let newPostCount = 0;
      let targetPostCount = 0;
      const newTargetPosts: NewTargetPost[] = [];
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
        const storedPost = insertPost.get({ observationId: inserted.id, ...post, isNew }) as {
          id: number;
        };
        if (isNew === 1 && post.isTargetAuthor === 1) {
          newTargetPosts.push({
            id: storedPost.id,
            postId: post.postId,
            createdAt: post.createdAt,
            authorHandle: post.authorHandle,
            typesJson: post.typesJson,
            referencedPostIdsJson: post.referencedPostIdsJson,
            referencedAuthorHandle: post.referencedAuthorHandle,
          });
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
                referenced_author_handle AS referencedAuthorHandle, raw_result_json AS rawResultJson,
                is_new AS isNew, is_target_author AS isTargetAuthor
         FROM internal_graphql_observation_posts
         WHERE observation_id = $observationId
         ORDER BY id`,
      )
      .all({ observationId }) as Array<Record<string, unknown>>;
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
