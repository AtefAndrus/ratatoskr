import type { Database } from "bun:sqlite";

export interface RouteRecord {
  id: number;
  targetId: number;
  guildId: string;
  channelId: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface RouteWithTarget extends RouteRecord {
  handle: string;
  displayName: string;
}

interface RawRoute extends Omit<RouteRecord, "enabled"> {
  enabled: number;
}

interface RawRouteWithTarget extends RawRoute {
  handle: string;
  displayName: string;
}

const SELECT_ROUTE = `
  SELECT routes.id, routes.target_id AS targetId, routes.guild_id AS guildId,
         routes.channel_id AS channelId, routes.enabled, routes.created_by AS createdBy,
         routes.created_at AS createdAt
  FROM routes
`;

const SELECT_ROUTE_WITH_TARGET = `
  SELECT routes.id, routes.target_id AS targetId, routes.guild_id AS guildId,
         routes.channel_id AS channelId, routes.enabled, routes.created_by AS createdBy,
         routes.created_at AS createdAt,
         targets.handle, targets.display_name AS displayName
  FROM routes
  JOIN watch_targets AS targets ON targets.id = routes.target_id
`;

export class RouteRepository {
  constructor(private readonly db: Database) {}

  add(input: { targetId: number; guildId: string; channelId: string; createdBy?: string }): {
    route: RouteRecord;
    created: boolean;
  } {
    const existed = this.exists(input.targetId, input.channelId);
    const inserted = this.db
      .query(
        `INSERT INTO routes (target_id, guild_id, channel_id, created_by)
         VALUES ($targetId, $guildId, $channelId, $createdBy)
         ON CONFLICT (target_id, channel_id) DO UPDATE SET enabled = 1, guild_id = excluded.guild_id
         RETURNING id`,
      )
      .get({ ...input, createdBy: input.createdBy ?? null }) as { id: number };
    return { route: this.getById(inserted.id)!, created: !existed };
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
    return row === null ? null : { ...row, enabled: row.enabled === 1 };
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
    ).map((row) => ({ ...row, enabled: row.enabled === 1 }));
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
    ).map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  listAll(): RouteWithTarget[] {
    return (
      this.db.query(`${SELECT_ROUTE_WITH_TARGET} ORDER BY routes.id`).all() as RawRouteWithTarget[]
    ).map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }
}
