import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

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
