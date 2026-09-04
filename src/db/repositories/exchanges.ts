import type { Database } from "bun:sqlite";

export interface NewExchange {
  source: string;
  receiverId: number | null;
  occurredAt: string;
  method: string;
  url: string;
  requestSummaryJson: string | null;
  responseStatus: number | null;
  responseText: string | null;
  error: string | null;
}

export interface ExchangeView extends NewExchange {
  id: number;
}

/** X や参照データ取得元との HTTP やり取りを、レスポンス本文ごと保存する。API 仕様変更の調査用。 */
export class ExchangeRepository {
  constructor(private readonly db: Database) {}

  record(input: NewExchange): number {
    const row = this.db
      .query(
        `INSERT INTO external_exchanges (
           source, receiver_id, occurred_at, method, url, request_summary_json,
           response_status, response_text, error
         ) VALUES (
           $source, $receiverId, $occurredAt, $method, $url, $requestSummaryJson,
           $responseStatus, $responseText, $error
         )
         RETURNING id`,
      )
      .get({ ...input }) as { id: number };
    return row.id;
  }

  listRecent(limit: number, source?: string): ExchangeView[] {
    return this.db
      .query(
        `SELECT id, source, receiver_id AS receiverId, occurred_at AS occurredAt, method, url,
                request_summary_json AS requestSummaryJson, response_status AS responseStatus,
                response_text AS responseText, error
         FROM external_exchanges
         WHERE ($source IS NULL OR source = $source)
         ORDER BY id DESC
         LIMIT $limit`,
      )
      .all({ limit, source: source ?? null }) as ExchangeView[];
  }
}
