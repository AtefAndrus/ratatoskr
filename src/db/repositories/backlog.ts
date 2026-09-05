import type { Database } from "bun:sqlite";

export type BacklogState = "pending" | "complete";

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
  constructor(private readonly db: Database) {}

  ensure(targetId: number, now = new Date().toISOString()): BacklogProgress | null {
    const route = this.db
      .query("SELECT min(created_at) AS createdAt FROM routes WHERE target_id = $targetId")
      .get({ targetId }) as { createdAt: string | null };
    if (route.createdAt === null) return null;
    const existing = this.get(targetId);
    if (existing?.state === "pending") return existing;
    const latestBaseline = existing === null ? 0 : 1;
    const baseline = this.db
      .query(
        `SELECT id, fetched_at AS fetchedAt
         FROM internal_graphql_observations
         WHERE target_id = $targetId AND fetched_at >= $routeCreatedAt
           AND fetched_at < $now
           AND response_status = 200 AND error IS NULL AND parse_error IS NULL
           AND ($latestBaseline = 0 OR json_type(variables_json, '$.cursor') IS NULL)
         ORDER BY CASE WHEN $latestBaseline = 0 THEN fetched_at END,
                  CASE WHEN $latestBaseline = 1 THEN fetched_at END DESC,
                  CASE WHEN $latestBaseline = 0 THEN id END,
                  CASE WHEN $latestBaseline = 1 THEN id END DESC
         LIMIT 1`,
      )
      .get({ targetId, routeCreatedAt: route.createdAt, now, latestBaseline }) as {
      id: number;
      fetchedAt: string;
    } | null;
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
    now: string;
  }): void {
    const progress = this.get(input.targetId);
    if (progress === null || progress.leaseReceiverId !== input.receiverId) return;
    const known = new Set(progress.knownPostIds);
    const overlap = input.regularPostIds.filter((postId) => known.has(postId)).length;
    const seen = new Set(progress.seenCursors);
    seen.add(input.requestedCursor);
    const cursorCycle =
      input.bottomCursor !== null &&
      (input.bottomCursor === input.requestedCursor || seen.has(input.bottomCursor));
    const complete = overlap >= 3 || input.bottomCursor === null || cursorCycle;
    const reason =
      overlap >= 3
        ? "known_posts_overlap"
        : input.bottomCursor === null
          ? "bottom_cursor_missing"
          : cursorCycle
            ? "cursor_cycle"
            : "page_saved";
    this.db
      .query(
        `UPDATE backlog_progress
         SET next_cursor = $nextCursor, state = $state, seen_cursors_json = $seenCursorsJson,
             pages_fetched = pages_fetched + 1, last_stop_reason = $reason,
             lease_receiver_id = NULL, lease_until = NULL, updated_at = $now
         WHERE target_id = $targetId AND lease_receiver_id = $receiverId`,
      )
      .run({
        targetId: input.targetId,
        receiverId: input.receiverId,
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
