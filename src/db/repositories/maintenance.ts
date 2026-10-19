import type { Database } from "bun:sqlite";

export interface RetentionResult {
  rawTextCleared: number;
  rowsDeleted: number;
}

export interface TableCounts {
  [table: string]: number;
}

export const COUNTED_TABLES = [
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

/** 本文の整理でたどり終えた位置。時刻が同じ行は id の順に並べる。 */
export interface RawTextCursor {
  time: string;
  id: number;
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
   * 時刻と id の組で `after` より後ろの行を、時刻の古い順に最大 `limit` 行たどり、`before` より古いものの本文を落とす。
   * 観測なら、その観測に属する投稿の生 JSON も落とす。たどった最後の行を次の呼び出しの `after` に使う。
   * 位置を主キーの値だけで持たないのは、最大の id の行が消えると SQLite が同じ id を使い回し、
   * 期限後の行を飛ばすためである。
   * たどり終えた位置より前の時刻で後から入った行は、行ごと消えるまで本文が残る。
   * 時刻は取得や受信の時点の時計で付けるので、時計を 1 日近く巻き戻さない限り起きない。
   */
  clearRawTextBatch(
    spec: RawTextTable,
    before: string,
    after: RawTextCursor | null,
    limit: number,
  ): { cleared: number; scanned: number; last: RawTextCursor | null } {
    return this.db.transaction(() => {
      // 同じ時刻の続きと、それより後の時刻を分けて引く。1 つの条件にまとめると、SQLite は時刻でしか索引を引けず、
      // 同じ時刻の処理済みの行を毎回たどり直す。
      const rows = this.db
        .query(
          `SELECT id, time FROM (
             SELECT id, ${spec.timeColumn} AS time FROM ${spec.table}
             WHERE ${spec.timeColumn} = $afterTime AND id > $afterId AND $afterTime < $before
             ORDER BY id LIMIT $limit
           )
           UNION ALL
           SELECT id, time FROM (
             SELECT id, ${spec.timeColumn} AS time FROM ${spec.table}
             WHERE ${spec.timeColumn} > $afterTime AND ${spec.timeColumn} < $before
             ORDER BY ${spec.timeColumn}, id LIMIT $limit
           )
           ORDER BY time, id LIMIT $limit`,
        )
        .all({
          before,
          afterTime: after?.time ?? "",
          afterId: after?.id ?? 0,
          limit,
        }) as RawTextCursor[];
      if (rows.length === 0) return { cleared: 0, scanned: 0, last: null };
      const ids = JSON.stringify(rows.map((row) => row.id));
      let cleared = this.db
        .query(
          `UPDATE ${spec.table} SET ${spec.clear}
           WHERE id IN (SELECT value FROM json_each($ids)) AND ${spec.pending}`,
        )
        .run({ ids }).changes;
      if (spec.table === "internal_graphql_observations") {
        cleared += this.db
          .query(
            `UPDATE internal_graphql_observation_posts SET raw_result_json = NULL
             WHERE observation_id IN (SELECT value FROM json_each($ids))
               AND raw_result_json IS NOT NULL`,
          )
          .run({ ids }).changes;
      }
      return { cleared, scanned: rows.length, last: rows.at(-1) ?? null };
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

  /** rowid が `after` より大きい行を、rowid の順に最大 `limit` 行だけ数える。 */
  countRowsAfter(
    table: (typeof COUNTED_TABLES)[number],
    after: number,
    limit: number,
  ): { count: number; last: number | null } {
    return this.db
      .query(
        `SELECT count(*) AS count, max(rowid) AS last
         FROM (SELECT rowid FROM ${table} WHERE rowid > $after ORDER BY rowid LIMIT $limit)`,
      )
      .get({ after, limit }) as { count: number; last: number | null };
  }
}
