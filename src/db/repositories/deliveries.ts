import type { Database } from "bun:sqlite";

export type DeliverySource = "webpush" | "internal_graphql";
export type DeliveryStatus = "sent" | "failed" | "skipped_duplicate";

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

  claim(input: {
    source: DeliverySource;
    sourceRecordId: number;
    routeId: number;
    dedupeKey: string;
    claimedAt: string;
  }): boolean {
    const result = this.db
      .query(
        `INSERT INTO delivery_claims (source, source_record_id, route_id, dedupe_key, claimed_at)
         VALUES ($source, $sourceRecordId, $routeId, $dedupeKey, $claimedAt)
         ON CONFLICT (route_id, dedupe_key) DO NOTHING`,
      )
      .run(input);
    return result.changes === 1;
  }

  markSent(routeId: number, dedupeKey: string): void {
    this.db
      .query(
        "UPDATE delivery_claims SET state = 'sent' WHERE route_id = $routeId AND dedupe_key = $dedupeKey",
      )
      .run({ routeId, dedupeKey });
  }

  release(routeId: number, dedupeKey: string): void {
    this.db
      .query(
        "DELETE FROM delivery_claims WHERE route_id = $routeId AND dedupe_key = $dedupeKey AND state = 'pending'",
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
