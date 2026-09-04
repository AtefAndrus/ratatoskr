import type { Database } from "bun:sqlite";

export interface RetentionResult {
  rawTextCleared: number;
  rowsDeleted: number;
}

export interface TableCounts {
  [table: string]: number;
}

const COUNTED_TABLES = [
  "receivers",
  "watch_targets",
  "routes",
  "autopush_frames",
  "parsed_notifications",
  "delivery_claims",
  "discord_deliveries",
  "internal_graphql_observations",
  "internal_graphql_observation_posts",
  "external_exchanges",
] as const;

/**
 * 保持期間に基づく整理。
 * 生応答本文は先に落として容量を抑え、行そのものは長めに残して観測メタデータと投稿一覧を調査に使えるようにする。
 * delivery_claims は重複排除の根拠なので消さない。
 */
export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

  applyRetention(input: { rawBefore: string; rowsBefore: string }): RetentionResult {
    return this.db.transaction(() => {
      let rawTextCleared = 0;
      rawTextCleared += this.db
        .query(
          `UPDATE internal_graphql_observations SET response_text = NULL
           WHERE fetched_at < $rawBefore AND response_text IS NOT NULL`,
        )
        .run({ rawBefore: input.rawBefore }).changes;
      rawTextCleared += this.db
        .query(
          `UPDATE internal_graphql_observation_posts SET raw_result_json = NULL
           WHERE raw_result_json IS NOT NULL
             AND observation_id IN (
               SELECT id FROM internal_graphql_observations WHERE fetched_at < $rawBefore
             )`,
        )
        .run({ rawBefore: input.rawBefore }).changes;
      rawTextCleared += this.db
        .query(
          `UPDATE autopush_frames SET raw_text = NULL, encrypted_data_base64url = NULL
           WHERE received_at < $rawBefore AND (raw_text IS NOT NULL OR encrypted_data_base64url IS NOT NULL)`,
        )
        .run({ rawBefore: input.rawBefore }).changes;
      rawTextCleared += this.db
        .query(
          `UPDATE external_exchanges SET response_text = NULL
           WHERE occurred_at < $rawBefore AND response_text IS NOT NULL`,
        )
        .run({ rawBefore: input.rawBefore }).changes;

      let rowsDeleted = 0;
      rowsDeleted += this.db
        .query("DELETE FROM internal_graphql_observations WHERE fetched_at < $rowsBefore")
        .run({ rowsBefore: input.rowsBefore }).changes;
      rowsDeleted += this.db
        .query("DELETE FROM autopush_frames WHERE received_at < $rowsBefore")
        .run({ rowsBefore: input.rowsBefore }).changes;
      rowsDeleted += this.db
        .query("DELETE FROM discord_deliveries WHERE attempted_at < $rowsBefore")
        .run({ rowsBefore: input.rowsBefore }).changes;
      rowsDeleted += this.db
        .query("DELETE FROM external_exchanges WHERE occurred_at < $rowsBefore")
        .run({ rowsBefore: input.rowsBefore }).changes;
      return { rawTextCleared, rowsDeleted };
    })();
  }

  tableCounts(): TableCounts {
    const counts: TableCounts = {};
    for (const table of COUNTED_TABLES) {
      const row = this.db.query(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      counts[table] = row.count;
    }
    return counts;
  }
}
