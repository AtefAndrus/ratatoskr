import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 5;

const TIMESTAMP_DEFAULT = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const MIGRATIONS: ReadonlyArray<(database: Database) => void> = [
  (database) => {
    database.exec(`
      CREATE TABLE receivers (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        auth_token TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        bearer_token TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        push_uaid TEXT,
        push_channel_id TEXT,
        push_endpoint TEXT,
        push_private_key_jwk TEXT,
        push_public_key TEXT,
        push_auth_secret TEXT,
        push_registered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        updated_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      CREATE TABLE watch_targets (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        updated_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      CREATE INDEX watch_targets_display_name_idx ON watch_targets(display_name);

      CREATE TABLE receiver_targets (
        id INTEGER PRIMARY KEY,
        receiver_id INTEGER NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES watch_targets(id) ON DELETE CASCADE,
        configured_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        UNIQUE (receiver_id, target_id)
      ) STRICT;

      CREATE TABLE routes (
        id INTEGER PRIMARY KEY,
        target_id INTEGER NOT NULL REFERENCES watch_targets(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        UNIQUE (target_id, channel_id)
      ) STRICT;

      CREATE INDEX routes_guild_idx ON routes(guild_id);

      CREATE TABLE autopush_frames (
        id INTEGER PRIMARY KEY,
        receiver_id INTEGER NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
        received_at TEXT NOT NULL,
        raw_text TEXT,
        message_type TEXT,
        channel_id TEXT,
        version TEXT,
        encrypted_data_base64url TEXT,
        headers_json TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      CREATE INDEX autopush_frames_received_idx ON autopush_frames(received_at);

      CREATE TABLE parsed_notifications (
        id INTEGER PRIMARY KEY,
        frame_id INTEGER NOT NULL REFERENCES autopush_frames(id) ON DELETE CASCADE,
        parsed_at TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        decrypted_text TEXT,
        payload_json TEXT,
        notification_kind TEXT NOT NULL,
        post_id TEXT,
        post_url TEXT,
        author_handle TEXT,
        notification_post_id TEXT,
        notification_title TEXT,
        target_id INTEGER REFERENCES watch_targets(id) ON DELETE SET NULL,
        parse_error TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        UNIQUE (frame_id, parser_version)
      ) STRICT;

      CREATE INDEX parsed_notifications_target_idx
        ON parsed_notifications(target_id, notification_post_id);

      CREATE TABLE delivery_claims (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('webpush', 'internal_graphql')),
        source_record_id INTEGER NOT NULL CHECK (source_record_id > 0),
        route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent')),
        UNIQUE (route_id, dedupe_key)
      ) STRICT;

      CREATE TABLE discord_deliveries (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('webpush', 'internal_graphql')),
        source_record_id INTEGER NOT NULL CHECK (source_record_id > 0),
        route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        attempted_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped_duplicate')),
        discord_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      CREATE INDEX discord_deliveries_attempted_idx ON discord_deliveries(attempted_at);

      CREATE TABLE internal_graphql_observations (
        id INTEGER PRIMARY KEY,
        receiver_id INTEGER NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES watch_targets(id) ON DELETE CASCADE,
        fetched_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        query_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        variables_json TEXT NOT NULL,
        features_json TEXT NOT NULL,
        transaction_id TEXT,
        response_status INTEGER,
        response_text TEXT,
        rate_limit_limit INTEGER,
        rate_limit_remaining INTEGER,
        rate_limit_reset_at TEXT,
        error TEXT,
        parse_error TEXT,
        post_count INTEGER NOT NULL DEFAULT 0 CHECK (post_count >= 0),
        target_post_count INTEGER NOT NULL DEFAULT 0 CHECK (target_post_count >= 0),
        new_post_count INTEGER NOT NULL DEFAULT 0 CHECK (new_post_count >= 0),
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      CREATE INDEX internal_graphql_observations_target_idx
        ON internal_graphql_observations(receiver_id, target_id, fetched_at);
      CREATE INDEX internal_graphql_observations_fetched_idx
        ON internal_graphql_observations(fetched_at);

      CREATE TABLE internal_graphql_observation_posts (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES internal_graphql_observations(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL,
        created_at TEXT,
        author_user_id TEXT,
        author_handle TEXT,
        types_json TEXT NOT NULL,
        referenced_post_ids_json TEXT NOT NULL,
        raw_result_json TEXT,
        is_new INTEGER NOT NULL CHECK (is_new IN (0, 1)),
        is_target_author INTEGER NOT NULL DEFAULT 0 CHECK (is_target_author IN (0, 1)),
        UNIQUE (observation_id, post_id)
      ) STRICT;

      CREATE INDEX internal_graphql_posts_post_idx
        ON internal_graphql_observation_posts(post_id, observation_id);

      CREATE TABLE external_exchanges (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        receiver_id INTEGER REFERENCES receivers(id) ON DELETE SET NULL,
        occurred_at TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        request_summary_json TEXT,
        response_status INTEGER,
        response_text TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      CREATE INDEX external_exchanges_occurred_idx ON external_exchanges(occurred_at);
    `);
  },
  (database) => {
    database.exec(`
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY,
        link_domain TEXT NOT NULL DEFAULT 'x.com',
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        updated_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;
    `);
  },
  (database) => {
    database.exec(`
      ALTER TABLE internal_graphql_observation_posts ADD COLUMN referenced_author_handle TEXT;
    `);
  },
  (database) => {
    database.exec(`
      ALTER TABLE routes ADD COLUMN allow_posts INTEGER NOT NULL DEFAULT 1 CHECK (allow_posts IN (0, 1));
      ALTER TABLE routes ADD COLUMN allow_quotes INTEGER NOT NULL DEFAULT 1 CHECK (allow_quotes IN (0, 1));
      ALTER TABLE routes ADD COLUMN allow_reposts INTEGER NOT NULL DEFAULT 1 CHECK (allow_reposts IN (0, 1));
      ALTER TABLE routes ADD COLUMN allow_replies INTEGER NOT NULL DEFAULT 1 CHECK (allow_replies IN (0, 1));
    `);
  },
  (database) => {
    database.exec(`
      CREATE TABLE delivery_queue (
        id INTEGER PRIMARY KEY,
        target_id INTEGER NOT NULL REFERENCES watch_targets(id) ON DELETE CASCADE,
        route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL,
        post_url TEXT NOT NULL,
        kinds_json TEXT NOT NULL,
        post_created_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('webpush', 'internal_graphql')),
        source_record_id INTEGER NOT NULL CHECK (source_record_id > 0),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'failed', 'sent')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        sending_started_at TEXT,
        last_attempted_at TEXT,
        discord_message_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        updated_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        UNIQUE (route_id, post_id)
      ) STRICT;

      CREATE INDEX delivery_queue_ready_idx ON delivery_queue(state, post_created_at, id);
      CREATE INDEX delivery_queue_target_idx ON delivery_queue(target_id, state);

      INSERT INTO delivery_queue (
        target_id, route_id, post_id, post_url, kinds_json, post_created_at,
        source, source_record_id, state, attempt_count, last_attempted_at, created_at, updated_at
      )
      SELECT routes.target_id, claims.route_id, substr(claims.dedupe_key, 6),
             'https://x.com/' || targets.handle || '/status/' || substr(claims.dedupe_key, 6),
             '["posts"]', claims.claimed_at, claims.source, claims.source_record_id,
             claims.state, CASE WHEN claims.state = 'sent' THEN 1 ELSE 0 END,
             CASE WHEN claims.state = 'sent' THEN claims.claimed_at ELSE NULL END,
             claims.claimed_at, claims.claimed_at
      FROM delivery_claims AS claims
      JOIN routes ON routes.id = claims.route_id
      JOIN watch_targets AS targets ON targets.id = routes.target_id
      WHERE claims.dedupe_key LIKE 'post:%';

      CREATE TABLE backlog_progress (
        target_id INTEGER PRIMARY KEY REFERENCES watch_targets(id) ON DELETE CASCADE,
        not_before TEXT NOT NULL,
        next_cursor TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
        known_post_ids_json TEXT NOT NULL DEFAULT '[]',
        seen_cursors_json TEXT NOT NULL DEFAULT '[]',
        pages_fetched INTEGER NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
        last_stop_reason TEXT,
        lease_receiver_id INTEGER REFERENCES receivers(id) ON DELETE SET NULL,
        lease_until TEXT,
        created_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT}),
        updated_at TEXT NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
      ) STRICT;

      WITH route_starts AS (
        SELECT target_id, min(created_at) AS route_created_at
        FROM routes
        GROUP BY target_id
      ), baselines AS (
        SELECT route_starts.target_id, route_starts.route_created_at,
               (
                 SELECT observations.id
                 FROM internal_graphql_observations AS observations
                 WHERE observations.target_id = route_starts.target_id
                   AND observations.fetched_at >= route_starts.route_created_at
                   AND observations.response_status = 200
                   AND observations.error IS NULL AND observations.parse_error IS NULL
                 ORDER BY observations.fetched_at, observations.id
                 LIMIT 1
               ) AS observation_id
        FROM route_starts
      )
      INSERT INTO backlog_progress (target_id, not_before, known_post_ids_json)
      SELECT baselines.target_id,
             coalesce(observations.fetched_at, baselines.route_created_at),
             coalesce(
               (
                 SELECT json_group_array(post_id)
                 FROM (
                   SELECT posts.post_id
                   FROM internal_graphql_observation_posts AS posts
                   WHERE posts.observation_id = baselines.observation_id
                     AND posts.is_target_author = 1
                   ORDER BY posts.id
                 )
               ),
               '[]'
             )
      FROM baselines
      LEFT JOIN internal_graphql_observations AS observations ON observations.id = baselines.observation_id;

      CREATE TRIGGER clear_backlog_progress_after_last_route
      AFTER DELETE ON routes
      WHEN NOT EXISTS (SELECT 1 FROM routes WHERE target_id = OLD.target_id)
      BEGIN
        DELETE FROM backlog_progress WHERE target_id = OLD.target_id;
      END;
    `);
  },
];

export function applyMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER NOT NULL
    ) STRICT;

    INSERT INTO schema_meta (version)
    SELECT 0
    WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
  `);

  const current = database.query("SELECT version FROM schema_meta").get() as { version: number };
  if (current.version > SCHEMA_VERSION) {
    throw new Error(`SQLite スキーマが新しすぎます: ${current.version}`);
  }
  for (let version = current.version; version < MIGRATIONS.length; version += 1) {
    const migrate = MIGRATIONS[version]!;
    database.transaction(() => {
      migrate(database);
      database.query("UPDATE schema_meta SET version = $version").run({ version: version + 1 });
    })();
  }
}
