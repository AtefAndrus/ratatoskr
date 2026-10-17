import type { Database } from "bun:sqlite";

export type DeliverySource = "webpush" | "internal_graphql";
export type DeliveryStatus = "sent" | "failed" | "skipped_duplicate";
export type DeliveryQueueState = "pending" | "sending" | "failed" | "sent";

export interface QueuedDelivery {
  id: number;
  targetId: number;
  routeId: number;
  guildId: string;
  channelId: string;
  postId: string;
  postUrl: string;
  kindsJson: string;
  postCreatedAt: string;
  source: DeliverySource;
  sourceRecordId: number;
  state: DeliveryQueueState;
  attemptCount: number;
}

export interface NewQueuedDelivery {
  targetId: number;
  routeId: number;
  postId: string;
  postUrl: string;
  kindsJson: string;
  postCreatedAt: string;
  source: DeliverySource;
  sourceRecordId: number;
  queuedAt: string;
}

export interface DeliveryQueueCounts {
  pending: number;
  sending: number;
  failed: number;
}

export interface DeliveryView {
  id: number;
  source: DeliverySource;
  sourceRecordId: number;
  routeId: number;
  channelId: string;
  targetHandle: string | null;
  attemptedAt: string;
  status: DeliveryStatus;
  discordMessageId: string | null;
  error: string | null;
}

export interface QueueEntryView {
  id: number;
  targetId: number;
  routeId: number;
  postId: string;
  postUrl: string;
  kindsJson: string;
  postCreatedAt: string;
  source: DeliverySource;
  sourceRecordId: number;
  state: DeliveryQueueState;
  attemptCount: number;
  lastAttemptedAt: string | null;
  discordMessageId: string | null;
  lastError: string | null;
  queuedAt: string;
  updatedAt: string;
}

export interface DeliveryAttemptView {
  id: number;
  source: DeliverySource;
  sourceRecordId: number;
  attemptedAt: string;
  status: DeliveryStatus;
  discordMessageId: string | null;
  error: string | null;
}

export class DeliveryRepository {
  constructor(private readonly db: Database) {}

  enqueue(input: NewQueuedDelivery): boolean {
    return this.db.transaction(() => this.enqueueWithinTransaction(input) !== null)();
  }

  enqueueBatch(
    inputs: readonly NewQueuedDelivery[],
    afterEnqueue: (queueIds: ReadonlyArray<number | null>) => void,
  ): Array<number | null> {
    return this.db.transaction(() => {
      const queueIds = inputs.map((input) => this.enqueueWithinTransaction(input));
      afterEnqueue(queueIds);
      return queueIds;
    })();
  }

  private enqueueWithinTransaction(input: NewQueuedDelivery): number | null {
    const existing = this.db
      .query("SELECT id, state FROM delivery_queue WHERE route_id = $routeId AND post_id = $postId")
      .get({ ...input }) as { id: number; state: DeliveryQueueState } | null;
    if (existing?.state === "failed") {
      this.db
        .query(
          `UPDATE delivery_queue
           SET state = 'pending', source = $source, source_record_id = $sourceRecordId,
               updated_at = $queuedAt
           WHERE route_id = $routeId AND post_id = $postId AND state = 'failed'`,
        )
        .run({ ...input });
      return existing.id;
    }
    if (existing !== null) return null;
    const dedupeKey = `post:${input.postId}`;
    const claim = this.db
      .query(
        "SELECT state FROM delivery_claims WHERE route_id = $routeId AND dedupe_key = $dedupeKey",
      )
      .get({ routeId: input.routeId, dedupeKey }) as { state: "pending" | "sent" } | null;
    const state: DeliveryQueueState = claim?.state === "sent" ? "sent" : "pending";
    if (claim === null) {
      this.db
        .query(
          `INSERT INTO delivery_claims (
             source, source_record_id, route_id, dedupe_key, claimed_at, state
           ) VALUES ($source, $sourceRecordId, $routeId, $dedupeKey, $queuedAt, 'pending')`,
        )
        .run({ ...input, dedupeKey });
    }
    const inserted = this.db
      .query(
        `INSERT INTO delivery_queue (
           target_id, route_id, post_id, post_url, kinds_json, post_created_at,
           source, source_record_id, state, created_at, updated_at
         ) VALUES (
           $targetId, $routeId, $postId, $postUrl, $kindsJson, $postCreatedAt,
           $source, $sourceRecordId, $state, $queuedAt, $queuedAt
         )
         RETURNING id`,
      )
      .get({ ...input, state }) as { id: number };
    return state === "sent" ? null : inserted.id;
  }

  recoverSending(recoveredAt: string): number {
    return this.db
      .query(
        `UPDATE delivery_queue
         SET state = 'pending', sending_started_at = NULL,
             last_error = '前回の送信中にプロセスが停止したため再試行します', updated_at = $recoveredAt
         WHERE state = 'sending'`,
      )
      .run({ recoveredAt }).changes;
  }

  listReadyIds(includeFailed = true): number[] {
    return (
      this.db
        .query(
          `SELECT queue.id
           FROM delivery_queue AS queue
           JOIN routes ON routes.id = queue.route_id
           WHERE (queue.state = 'pending' OR ($includeFailed = 1 AND queue.state = 'failed'))
             AND routes.enabled = 1
           ORDER BY queue.post_created_at, queue.id`,
        )
        .all({ includeFailed: includeFailed ? 1 : 0 }) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  claimQueued(id: number, attemptedAt: string): QueuedDelivery | null {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT queue.id, queue.target_id AS targetId, queue.route_id AS routeId,
                  routes.guild_id AS guildId, routes.channel_id AS channelId,
                  queue.post_id AS postId, queue.post_url AS postUrl,
                  queue.kinds_json AS kindsJson, queue.post_created_at AS postCreatedAt,
                  queue.source, queue.source_record_id AS sourceRecordId,
                  queue.state, queue.attempt_count AS attemptCount
           FROM delivery_queue AS queue
           JOIN routes ON routes.id = queue.route_id
           WHERE queue.id = $id AND queue.state IN ('pending', 'failed') AND routes.enabled = 1`,
        )
        .get({ id }) as QueuedDelivery | null;
      if (row === null) return null;
      const changed = this.db
        .query(
          `UPDATE delivery_queue
           SET state = 'sending', attempt_count = attempt_count + 1,
               sending_started_at = $attemptedAt, last_attempted_at = $attemptedAt,
               last_error = NULL, updated_at = $attemptedAt
           WHERE id = $id AND state IN ('pending', 'failed')`,
        )
        .run({ id: row.id, attemptedAt }).changes;
      return changed === 1
        ? { ...row, state: "sending" as const, attemptCount: row.attemptCount + 1 }
        : null;
    })();
  }

  queueState(routeId: number, postId: string): DeliveryQueueState | null {
    const row = this.db
      .query("SELECT state FROM delivery_queue WHERE route_id = $routeId AND post_id = $postId")
      .get({ routeId, postId }) as { state: DeliveryQueueState } | null;
    return row?.state ?? null;
  }

  markQueueSent(
    id: number,
    routeId: number,
    postId: string,
    messageId: string,
    sentAt: string,
  ): void {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE delivery_queue
           SET state = 'sent', sending_started_at = NULL, discord_message_id = $messageId,
               last_error = NULL, updated_at = $sentAt
           WHERE id = $id`,
        )
        .run({ id, messageId, sentAt });
      this.markSent(routeId, `post:${postId}`);
    })();
  }

  markQueueFailed(id: number, error: string, failedAt: string): void {
    this.db
      .query(
        `UPDATE delivery_queue
         SET state = 'failed', sending_started_at = NULL, last_error = $error, updated_at = $failedAt
         WHERE id = $id`,
      )
      .run({ id, error, failedAt });
  }

  /** リポストの行は post_id がリポスト自体の ID で、post_url が元投稿を指すので、URL の末尾でも引く。 */
  listQueueByPostIds(postIds: readonly string[]): QueueEntryView[] {
    return this.db
      .query(
        `SELECT queue.id, queue.target_id AS targetId, queue.route_id AS routeId,
                queue.post_id AS postId, queue.post_url AS postUrl, queue.kinds_json AS kindsJson,
                queue.post_created_at AS postCreatedAt, queue.source,
                queue.source_record_id AS sourceRecordId, queue.state,
                queue.attempt_count AS attemptCount, queue.last_attempted_at AS lastAttemptedAt,
                queue.discord_message_id AS discordMessageId, queue.last_error AS lastError,
                queue.created_at AS queuedAt, queue.updated_at AS updatedAt
         FROM delivery_queue AS queue
         WHERE queue.post_id IN (SELECT value FROM json_each($postIds))
            OR EXISTS (
              SELECT 1 FROM json_each($postIds) AS ids
              WHERE substr(queue.post_url, -length('/status/' || ids.value)) = '/status/' || ids.value
            )
         ORDER BY queue.id`,
      )
      .all({ postIds: JSON.stringify(postIds) }) as QueueEntryView[];
  }

  /**
   * キュー行は再試行のたびに last_error を消し、移行前の送信済み行は discord_message_id を持たないので、送信履歴も添える。
   * 履歴は (source, source_record_id) の索引が無いため、キュー行の投入から最終更新までの時刻範囲で attempted_at の索引から絞る。
   */
  listAttemptsForQueueEntry(
    entry: Pick<QueueEntryView, "routeId" | "queuedAt" | "updatedAt">,
    records: { notificationIds: readonly number[]; postIds: readonly string[] },
  ): DeliveryAttemptView[] {
    return this.db
      .query(
        `SELECT deliveries.id, deliveries.source, deliveries.source_record_id AS sourceRecordId,
                deliveries.attempted_at AS attemptedAt, deliveries.status,
                deliveries.discord_message_id AS discordMessageId, deliveries.error
         FROM discord_deliveries AS deliveries
         WHERE deliveries.attempted_at BETWEEN $from AND $to
           AND deliveries.route_id = $routeId
           AND (
             (deliveries.source = 'webpush'
               AND deliveries.source_record_id IN (SELECT value FROM json_each($notificationIds)))
             OR (deliveries.source = 'internal_graphql'
               AND deliveries.source_record_id IN (
                 SELECT posts.id FROM internal_graphql_observation_posts AS posts
                 WHERE posts.post_id IN (SELECT value FROM json_each($postIds))
               ))
           )
         ORDER BY deliveries.id`,
      )
      .all({
        from: entry.queuedAt,
        to: entry.updatedAt,
        routeId: entry.routeId,
        notificationIds: JSON.stringify(records.notificationIds),
        postIds: JSON.stringify(records.postIds),
      }) as DeliveryAttemptView[];
  }

  queueCounts(): DeliveryQueueCounts {
    const rows = this.db
      .query(
        `SELECT state, count(*) AS count
         FROM delivery_queue
         WHERE state IN ('pending', 'sending', 'failed')
         GROUP BY state`,
      )
      .all() as Array<{ state: Exclude<DeliveryQueueState, "sent">; count: number }>;
    const counts: DeliveryQueueCounts = { pending: 0, sending: 0, failed: 0 };
    for (const row of rows) counts[row.state] = row.count;
    return counts;
  }

  markSent(routeId: number, dedupeKey: string): void {
    this.db
      .query(
        "UPDATE delivery_claims SET state = 'sent' WHERE route_id = $routeId AND dedupe_key = $dedupeKey",
      )
      .run({ routeId, dedupeKey });
  }

  record(input: {
    source: DeliverySource;
    sourceRecordId: number;
    routeId: number;
    attemptedAt: string;
    status: DeliveryStatus;
    discordMessageId?: string | null;
    error?: string | null;
  }): number {
    const row = this.db
      .query(
        `INSERT INTO discord_deliveries (
           source, source_record_id, route_id, attempted_at, status, discord_message_id, error
         ) VALUES (
           $source, $sourceRecordId, $routeId, $attemptedAt, $status, $discordMessageId, $error
         )
         RETURNING id`,
      )
      .get({ discordMessageId: null, error: null, ...input }) as { id: number };
    return row.id;
  }

  listRecent(limit: number, status?: DeliveryStatus): DeliveryView[] {
    return this.db
      .query(
        `SELECT deliveries.id, deliveries.source, deliveries.source_record_id AS sourceRecordId,
                deliveries.route_id AS routeId, routes.channel_id AS channelId,
                targets.handle AS targetHandle, deliveries.attempted_at AS attemptedAt,
                deliveries.status, deliveries.discord_message_id AS discordMessageId, deliveries.error
         FROM discord_deliveries AS deliveries
         JOIN routes ON routes.id = deliveries.route_id
         LEFT JOIN watch_targets AS targets ON targets.id = routes.target_id
         WHERE ($status IS NULL OR deliveries.status = $status)
         ORDER BY deliveries.id DESC
         LIMIT $limit`,
      )
      .all({ limit, status: status ?? null }) as DeliveryView[];
  }
}
