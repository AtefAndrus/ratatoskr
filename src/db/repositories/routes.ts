import type { Database } from "bun:sqlite";

import type { RouteKinds } from "../../postKinds";

export interface RouteRecord {
  id: number;
  targetId: number;
  guildId: string;
  channelId: string;
  enabled: boolean;
  kinds: RouteKinds;
  createdBy: string | null;
  createdAt: string;
}

export interface RouteWithTarget extends RouteRecord {
  handle: string;
  displayName: string;
}

interface RawRoute {
  id: number;
  targetId: number;
  guildId: string;
  channelId: string;
  enabled: number;
  allowPosts: number;
  allowQuotes: number;
  allowReposts: number;
  allowReplies: number;
  createdBy: string | null;
  createdAt: string;
}

interface RawRouteWithTarget extends RawRoute {
  handle: string;
  displayName: string;
}

const ROUTE_COLUMNS = `
  routes.id, routes.target_id AS targetId, routes.guild_id AS guildId,
  routes.channel_id AS channelId, routes.enabled,
  routes.allow_posts AS allowPosts, routes.allow_quotes AS allowQuotes,
  routes.allow_reposts AS allowReposts, routes.allow_replies AS allowReplies,
  routes.created_by AS createdBy, routes.created_at AS createdAt
`;

const SELECT_ROUTE = `SELECT ${ROUTE_COLUMNS} FROM routes`;

const SELECT_ROUTE_WITH_TARGET = `
  SELECT ${ROUTE_COLUMNS}, targets.handle, targets.display_name AS displayName
  FROM routes
  JOIN watch_targets AS targets ON targets.id = routes.target_id
`;

function toRecord(row: RawRoute): RouteRecord {
  return {
    id: row.id,
    targetId: row.targetId,
    guildId: row.guildId,
    channelId: row.channelId,
    enabled: row.enabled === 1,
    kinds: {
      posts: row.allowPosts === 1,
      quotes: row.allowQuotes === 1,
      reposts: row.allowReposts === 1,
      replies: row.allowReplies === 1,
    },
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function toRecordWithTarget(row: RawRouteWithTarget): RouteWithTarget {
  return { ...toRecord(row), handle: row.handle, displayName: row.displayName };
}

export class RouteRepository {
  constructor(private readonly db: Database) {}

  /**
   * 経路を追加する。既存の組なら有効化し、種別が指定されていればその項目だけ更新する。
   * 種別を省略した再登録は既存の設定を変えない。
   */
  add(input: {
    targetId: number;
    guildId: string;
    channelId: string;
    createdBy?: string;
    kinds?: Partial<RouteKinds>;
  }): { route: RouteRecord; created: boolean } {
    const existed = this.exists(input.targetId, input.channelId);
    const inserted = this.db
      .query(
        `INSERT INTO routes (target_id, guild_id, channel_id, created_by)
         VALUES ($targetId, $guildId, $channelId, $createdBy)
         ON CONFLICT (target_id, channel_id) DO UPDATE SET enabled = 1, guild_id = excluded.guild_id
         RETURNING id`,
      )
      .get({
        targetId: input.targetId,
        guildId: input.guildId,
        channelId: input.channelId,
        createdBy: input.createdBy ?? null,
      }) as { id: number };
    if (input.kinds !== undefined && Object.keys(input.kinds).length > 0) {
      const current = this.getById(inserted.id)!.kinds;
      this.updateKinds(inserted.id, { ...current, ...input.kinds });
    }
    return { route: this.getById(inserted.id)!, created: !existed };
  }

  updateKinds(id: number, kinds: RouteKinds): void {
    this.db
      .query(
        `UPDATE routes
         SET allow_posts = $posts, allow_quotes = $quotes, allow_reposts = $reposts, allow_replies = $replies
         WHERE id = $id`,
      )
      .run({
        id,
        posts: kinds.posts ? 1 : 0,
        quotes: kinds.quotes ? 1 : 0,
        reposts: kinds.reposts ? 1 : 0,
        replies: kinds.replies ? 1 : 0,
      });
  }

  remove(targetId: number, channelId: string): boolean {
    const result = this.db
      .query("DELETE FROM routes WHERE target_id = $targetId AND channel_id = $channelId")
      .run({ targetId, channelId });
    return result.changes > 0;
  }

  getById(id: number): RouteRecord | null {
    const row = this.db
      .query(`${SELECT_ROUTE} WHERE routes.id = $id`)
      .get({ id }) as RawRoute | null;
    return row === null ? null : toRecord(row);
  }

  exists(targetId: number, channelId: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM routes WHERE target_id = $targetId AND channel_id = $channelId")
        .get({ targetId, channelId }) !== null
    );
  }

  listEnabledByTarget(targetId: number): RouteRecord[] {
    return (
      this.db
        .query(
          `${SELECT_ROUTE} WHERE routes.target_id = $targetId AND routes.enabled = 1 ORDER BY routes.id`,
        )
        .all({ targetId }) as RawRoute[]
    ).map(toRecord);
  }

  countByTarget(targetId: number): number {
    const row = this.db
      .query("SELECT count(*) AS count FROM routes WHERE target_id = $targetId")
      .get({ targetId }) as { count: number };
    return row.count;
  }

  listByGuild(guildId: string): RouteWithTarget[] {
    return (
      this.db
        .query(
          `${SELECT_ROUTE_WITH_TARGET} WHERE routes.guild_id = $guildId ORDER BY targets.handle, routes.id`,
        )
        .all({ guildId }) as RawRouteWithTarget[]
    ).map(toRecordWithTarget);
  }

  listAll(): RouteWithTarget[] {
    return (
      this.db.query(`${SELECT_ROUTE_WITH_TARGET} ORDER BY routes.id`).all() as RawRouteWithTarget[]
    ).map(toRecordWithTarget);
  }
}
