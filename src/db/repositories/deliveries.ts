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

export class DeliveryRepository {
  constructor(private readonly db: Database) {}

  enqueue(input: {
    targetId: number;
    routeId: number;
    postId: string;
    postUrl: string;
    kindsJson: string;
    postCreatedAt: string;
    source: DeliverySource;
    sourceRecordId: number;
    queuedAt: string;
  }): boolean {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT state FROM delivery_queue WHERE route_id = $routeId AND post_id = $postId")
        .get(input) as { state: DeliveryQueueState } | null;
      if (existing?.state === "failed") {
        this.db
          .query(
            `UPDATE delivery_queue
             SET state = 'pending', source = $source, source_record_id = $sourceRecordId,
                 updated_at = $queuedAt
             WHERE route_id = $routeId AND post_id = $postId AND state = 'failed'`,
          )
          .run(input);
        return true;
      }
      if (existing !== null) return false;
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
      this.db
        .query(
          `INSERT INTO delivery_queue (
             target_id, route_id, post_id, post_url, kinds_json, post_created_at,
             source, source_record_id, state, created_at, updated_at
           ) VALUES (
             $targetId, $routeId, $postId, $postUrl, $kindsJson, $postCreatedAt,
             $source, $sourceRecordId, $state, $queuedAt, $queuedAt
           )`,
        )
        .run({ ...input, state });
      return state !== "sent";
    })();
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
