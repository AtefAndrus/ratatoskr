import type { Database } from "bun:sqlite";

export type BacklogState = "pending" | "complete";

/**
 * X が返す履歴を末尾までたどった実測は最大 162 ページだった。
 * 終端の判定が X の応答の変化で効かなくなっても、補完が通常取得の枠を使い続けないよう上限を置く。
 */
export const BACKLOG_PAGE_LIMIT = 400;

export interface BacklogProgress {
  targetId: number;
  targetHandle: string;
  notBefore: string;
  nextCursor: string | null;
  state: BacklogState;
  knownPostIds: string[];
  seenCursors: string[];
  pagesFetched: number;
  lastStopReason: string | null;
  leaseReceiverId: number | null;
  leaseUntil: string | null;
  updatedAt: string;
}

interface RawBacklogProgress {
  targetId: number;
  targetHandle: string;
  notBefore: string;
  nextCursor: string | null;
  state: BacklogState;
  knownPostIdsJson: string;
  seenCursorsJson: string;
  pagesFetched: number;
  lastStopReason: string | null;
  leaseReceiverId: number | null;
  leaseUntil: string | null;
  updatedAt: string;
}

const SELECT_PROGRESS = `
  SELECT progress.target_id AS targetId, targets.handle AS targetHandle,
         progress.not_before AS notBefore, progress.next_cursor AS nextCursor,
         progress.state, progress.known_post_ids_json AS knownPostIdsJson,
         progress.seen_cursors_json AS seenCursorsJson,
         progress.pages_fetched AS pagesFetched, progress.last_stop_reason AS lastStopReason,
         progress.lease_receiver_id AS leaseReceiverId, progress.lease_until AS leaseUntil,
         progress.updated_at AS updatedAt
  FROM backlog_progress AS progress
  JOIN watch_targets AS targets ON targets.id = progress.target_id
`;

export class BacklogRepository {
  private readonly startupInitialization = new Map<number, "awaiting_latest" | "complete">();

  constructor(private readonly db: Database) {}

  /** 同じプロセス内の collector 群で、対象ごとの起動時初期化を共有する。 */
  prepareForStartup(targetId: number): boolean {
    const existing = this.get(targetId);
    if (existing === null) this.startupInitialization.delete(targetId);
    const state = this.startupInitialization.get(targetId);
    if (state !== undefined) return state === "awaiting_latest";
    if (this.ensure(targetId) === null) return false;
    this.startupInitialization.set(targetId, "awaiting_latest");
    return true;
  }

  /** 複数 collector の通常取得が重なっても、最初の成功だけで補完開始位置を確定する。 */
  startFromLatestOnce(targetId: number, bottomCursor: string | null, now: string): void {
    if (this.startupInitialization.get(targetId) !== "awaiting_latest") return;
    this.startFromLatest(targetId, bottomCursor, now);
    this.startupInitialization.set(targetId, "complete");
  }

  /**
   * 補完の既知境界にする正常取得を、初回は最も古いもの、2 回目以降はカーソルなしの最も新しいものから選ぶ。
   * 受信アカウントごとに (receiver_id, target_id, fetched_at) の索引を順にたどり、最初に条件を満たした行で止める。
   * target_id と fetched_at だけで全受信アカウントをまとめて引かないのは、使える索引が fetched_at だけになり、
   * 期間内の全対象の観測行を 1 行ずつ表から読んで並べ替えるためで、本番では対象ごとに約 30 秒イベントループが止まった。
   */
  private findBaseline(
    targetId: number,
    routeCreatedAt: string,
    now: string,
    earliest: boolean,
  ): { id: number; fetchedAt: string } | null {
    const order = earliest ? "ASC" : "DESC";
    const query = this.db.query(
      `SELECT id, fetched_at AS fetchedAt
       FROM internal_graphql_observations
       WHERE receiver_id = $receiverId AND target_id = $targetId
         AND fetched_at >= $routeCreatedAt AND fetched_at < $now
         AND response_status = 200
         AND ($earliest = 1 OR json_type(variables_json, '$.cursor') IS NULL)
         AND error IS NULL AND parse_error IS NULL
       ORDER BY fetched_at ${order}, id ${order}
       LIMIT 1`,
    );
    const receiverIds = (
      this.db.query("SELECT id FROM receivers ORDER BY id").all() as Array<{ id: number }>
    ).map((row) => row.id);
    let best: { id: number; fetchedAt: string } | null = null;
    for (const receiverId of receiverIds) {
      const candidate = query.get({
        receiverId,
        targetId,
        routeCreatedAt,
        now,
        earliest: earliest ? 1 : 0,
      }) as { id: number; fetchedAt: string } | null;
      if (candidate === null) continue;
      const isBetter =
        best === null ||
        (earliest
          ? candidate.fetchedAt < best.fetchedAt ||
            (candidate.fetchedAt === best.fetchedAt && candidate.id < best.id)
          : candidate.fetchedAt > best.fetchedAt ||
            (candidate.fetchedAt === best.fetchedAt && candidate.id > best.id));
      if (isBetter) best = candidate;
    }
    return best;
  }

  ensure(targetId: number, now = new Date().toISOString()): BacklogProgress | null {
    const route = this.db
      .query("SELECT min(created_at) AS createdAt FROM routes WHERE target_id = $targetId")
      .get({ targetId }) as { createdAt: string | null };
    if (route.createdAt === null) return null;
    const existing = this.get(targetId);
    if (existing?.state === "pending") return existing;
    const baseline = this.findBaseline(targetId, route.createdAt, now, existing === null);
    const knownPostIds =
      baseline === null
        ? []
        : (
            this.db
              .query(
                `SELECT post_id AS postId
                 FROM internal_graphql_observation_posts
                 WHERE observation_id = $observationId AND is_target_author = 1
                 ORDER BY id`,
              )
              .all({ observationId: baseline.id }) as Array<{ postId: string }>
          ).map((row) => row.postId);
    this.db
      .query(
        `INSERT INTO backlog_progress (
           target_id, not_before, known_post_ids_json, created_at, updated_at
         ) VALUES ($targetId, $notBefore, $knownPostIdsJson, $now, $now)
         ON CONFLICT (target_id) DO NOTHING`,
      )
      .run({
        targetId,
        notBefore: baseline?.fetchedAt ?? route.createdAt,
        knownPostIdsJson: JSON.stringify(knownPostIds),
        now,
      });
    if (existing !== null) {
      this.db
        .query(
          `UPDATE backlog_progress
           SET not_before = $notBefore, known_post_ids_json = $knownPostIdsJson,
               seen_cursors_json = '[]', pages_fetched = 0, last_stop_reason = NULL,
               lease_receiver_id = NULL, lease_until = NULL, updated_at = $now
           WHERE target_id = $targetId AND state = 'complete'`,
        )
        .run({
          targetId,
          notBefore: baseline?.fetchedAt ?? route.createdAt,
          knownPostIdsJson: JSON.stringify(knownPostIds),
          now,
        });
    }
    return this.get(targetId);
  }

  get(targetId: number): BacklogProgress | null {
    const row = this.db
      .query(`${SELECT_PROGRESS} WHERE progress.target_id = $targetId`)
      .get({ targetId }) as RawBacklogProgress | null;
    return row === null ? null : toProgress(row);
  }

  list(): BacklogProgress[] {
    return (
      this.db.query(`${SELECT_PROGRESS} ORDER BY progress.target_id`).all() as RawBacklogProgress[]
    ).map(toProgress);
  }

  startFromLatest(targetId: number, bottomCursor: string | null, now: string): void {
    this.db
      .query(
        `UPDATE backlog_progress
         SET next_cursor = $bottomCursor,
             state = CASE WHEN $bottomCursor IS NULL THEN 'complete' ELSE 'pending' END,
             last_stop_reason = CASE WHEN $bottomCursor IS NULL THEN 'bottom_cursor_missing' ELSE 'page_saved' END,
             updated_at = $now
         WHERE target_id = $targetId AND next_cursor IS NULL`,
      )
      .run({ targetId, bottomCursor, now });
  }

  acquire(
    targetId: number,
    receiverId: number,
    now: string,
    leaseUntil: string,
  ): BacklogProgress | null {
    return this.db.transaction(() => {
      const changed = this.db
        .query(
          `UPDATE backlog_progress
           SET lease_receiver_id = $receiverId, lease_until = $leaseUntil, updated_at = $now
           WHERE target_id = $targetId AND state = 'pending' AND next_cursor IS NOT NULL
             AND (lease_until IS NULL OR lease_until <= $now OR lease_receiver_id = $receiverId)`,
        )
        .run({ targetId, receiverId, now, leaseUntil }).changes;
      return changed === 1 ? this.get(targetId) : null;
    })();
  }

  savePage(input: {
    targetId: number;
    receiverId: number;
    requestedCursor: string;
    bottomCursor: string | null;
    regularPostIds: readonly string[];
    /** 固定投稿以外の投稿枠の投稿時刻 (Snowflake から復元)。復元できない枠は null。 */
    unpinnedPostTimesMs: ReadonlyArray<number | null>;
    hasUnknownEntries: boolean;
    now: string;
  }): void {
    const progress = this.get(input.targetId);
    // リース所有者だけで絞ると、期限切れ後に同じカーソルを保存した先行取得の進捗を捨ててしまう。
    if (
      progress === null ||
      progress.state !== "pending" ||
      progress.nextCursor !== input.requestedCursor
    ) {
      return;
    }
    const known = new Set(progress.knownPostIds);
    const overlap = input.regularPostIds.filter((postId) => known.has(postId)).length;
    const seen = new Set(progress.seenCursors);
    seen.add(input.requestedCursor);
    const cursorCycle =
      input.bottomCursor !== null &&
      (input.bottomCursor === input.requestedCursor || seen.has(input.bottomCursor));
    // 履歴の末尾で X は固定投稿だけのページと、数値を 1 ずつ変えた Bottom カーソルを返し続ける。
    // カーソルの一致では循環を検出できないため、ページの中身で終端を判定する。
    // 判別できないエントリがあれば末尾とも古いとも決めない。停止中の投稿かもしれないため。
    const timelineExhausted = !input.hasUnknownEntries && input.unpinnedPostTimesMs.length === 0;
    const notBeforeMs = new Date(progress.notBefore).getTime();
    const notBeforeReached =
      !input.hasUnknownEntries &&
      input.unpinnedPostTimesMs.length > 0 &&
      input.unpinnedPostTimesMs.every((timeMs) => timeMs !== null && timeMs < notBeforeMs);
    const reason =
      overlap >= 3
        ? "known_posts_overlap"
        : input.bottomCursor === null
          ? "bottom_cursor_missing"
          : cursorCycle
            ? "cursor_cycle"
            : timelineExhausted
              ? "timeline_exhausted"
              : notBeforeReached
                ? "not_before_reached"
                : progress.pagesFetched + 1 >= BACKLOG_PAGE_LIMIT
                  ? "page_limit_reached"
                  : "page_saved";
    const complete = reason !== "page_saved";
    this.db
      .query(
        `UPDATE backlog_progress
         SET next_cursor = $nextCursor, state = $state, seen_cursors_json = $seenCursorsJson,
             pages_fetched = pages_fetched + 1, last_stop_reason = $reason,
             lease_receiver_id = NULL, lease_until = NULL, updated_at = $now
         WHERE target_id = $targetId AND state = 'pending' AND next_cursor = $requestedCursor`,
      )
      .run({
        targetId: input.targetId,
        requestedCursor: input.requestedCursor,
        nextCursor: complete ? null : input.bottomCursor,
        state: complete ? "complete" : "pending",
        seenCursorsJson: JSON.stringify([...seen]),
        reason,
        now: input.now,
      });
  }

  stop(targetId: number, receiverId: number, reason: string, now: string): void {
    this.db
      .query(
        `UPDATE backlog_progress
         SET last_stop_reason = $reason, lease_receiver_id = NULL, lease_until = NULL, updated_at = $now
         WHERE target_id = $targetId AND lease_receiver_id = $receiverId`,
      )
      .run({ targetId, receiverId, reason, now });
  }
}

function toProgress(row: RawBacklogProgress): BacklogProgress {
  return {
    targetId: row.targetId,
    targetHandle: row.targetHandle,
    notBefore: row.notBefore,
    nextCursor: row.nextCursor,
    state: row.state,
    knownPostIds: parseStringArray(row.knownPostIdsJson),
    seenCursors: parseStringArray(row.seenCursorsJson),
    pagesFetched: row.pagesFetched,
    lastStopReason: row.lastStopReason,
    leaseReceiverId: row.leaseReceiverId,
    leaseUntil: row.leaseUntil,
    updatedAt: row.updatedAt,
  };
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("補完進捗の配列が不正です");
  }
  return parsed;
}
