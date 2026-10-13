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
  "delivery_queue",
  "backlog_progress",
  "discord_deliveries",
  "internal_graphql_observations",
  "internal_graphql_observation_posts",
  "external_exchanges",
] as const;

/** 本文だけを先に落とす表。`pending` は本文が残っている行の条件。 */
export interface RawTextTable {
  table: string;
  timeColumn: string;
  clear: string;
  pending: string;
}

export const RAW_TEXT_TABLES: readonly RawTextTable[] = [
  {
    table: "internal_graphql_observations",
    timeColumn: "fetched_at",
    clear: "response_text = NULL",
    pending: "response_text IS NOT NULL",
  },
  {
    table: "autopush_frames",
    timeColumn: "received_at",
    clear: "raw_text = NULL, encrypted_data_base64url = NULL",
    pending: "(raw_text IS NOT NULL OR encrypted_data_base64url IS NOT NULL)",
  },
  {
    table: "external_exchanges",
    timeColumn: "occurred_at",
    clear: "response_text = NULL",
    pending: "response_text IS NOT NULL",
  },
];

/**
 * 行ごと消す表。delivery_claims、delivery_queue、backlog_progress は重複排除と再開の根拠なので含めない。
 * 観測は 1 件に投稿が十数行付いて連鎖削除されるので、1 回に消す件数を小さくする。
 */
export const EXPIRING_TABLES: readonly { table: string; timeColumn: string; batchSize: number }[] =
  [
    { table: "internal_graphql_observations", timeColumn: "fetched_at", batchSize: 200 },
    { table: "autopush_frames", timeColumn: "received_at", batchSize: 1_000 },
    { table: "discord_deliveries", timeColumn: "attempted_at", batchSize: 1_000 },
    { table: "external_exchanges", timeColumn: "occurred_at", batchSize: 1_000 },
  ];

/**
 * 保持期間に基づく整理。
 * 生応答本文は先に落として容量を抑え、行そのものは長めに残して観測メタデータと投稿一覧を調査に使えるようにする。
 * 1 回の呼び出しは小さなトランザクションに留める。bun:sqlite は同期で動くため、
 * 全行を 1 トランザクションで処理すると、その間 HTTP や AutoPush を含むプロセス全体が止まる。
 */
export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

  /**
   * id がこの値以下の行はすべて `before` より古い。
   * 時刻の順と id の順は取得の並行で前後しうるので、新しい側の最小 id から求める。
   */
  rawTextUpperId(spec: RawTextTable, before: string): number {
    // min(id) のままだと SQLite は主キーを先頭から読む最適化を選び、古い行を全件たどる。
    // 単項の + でそれを外し、時刻の索引の新しい側だけを読ませる。
    const row = this.db
      .query(
        `SELECT coalesce(
           (SELECT min(+id) FROM ${spec.table} WHERE ${spec.timeColumn} >= $before) - 1,
           (SELECT max(id) FROM ${spec.table}),
           0
         ) AS upperId`,
      )
      .get({ before }) as { upperId: number };
    return row.upperId;
  }

  /** id が (afterId, untilId] の行の本文を落とす。観測なら、その観測に属する投稿の生 JSON も落とす。 */
  clearRawTextRange(spec: RawTextTable, afterId: number, untilId: number): number {
    return this.db.transaction(() => {
      let cleared = this.db
        .query(
          `UPDATE ${spec.table} SET ${spec.clear}
           WHERE id > $afterId AND id <= $untilId AND ${spec.pending}`,
        )
        .run({ afterId, untilId }).changes;
      if (spec.table === "internal_graphql_observations") {
        cleared += this.db
          .query(
            `UPDATE internal_graphql_observation_posts SET raw_result_json = NULL
             WHERE observation_id > $afterId AND observation_id <= $untilId
               AND raw_result_json IS NOT NULL`,
          )
          .run({ afterId, untilId }).changes;
      }
      return cleared;
    })();
  }

  /** `before` より古い行を古い順に最大 `limit` 行消し、消した行数 (連鎖削除分を除く) を返す。 */
  deleteExpiredBatch(
    spec: { table: string; timeColumn: string },
    before: string,
    limit: number,
  ): number {
    return this.db
      .query(
        `DELETE FROM ${spec.table}
         WHERE id IN (
           SELECT id FROM ${spec.table} WHERE ${spec.timeColumn} < $before
           ORDER BY ${spec.timeColumn} LIMIT $limit
         )
         RETURNING id`,
      )
      .all({ before, limit }).length;
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
