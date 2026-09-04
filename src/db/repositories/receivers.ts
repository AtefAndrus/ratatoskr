import type { Database } from "bun:sqlite";

import type { AutopushSession } from "../../autopush/protocol";
import type { WebPushKeys } from "../../webpush/keys";
import type { XSessionCredentials } from "../../x/credentials";
import { normalizeLabel } from "../handle";

export interface ReceiverRecord {
  id: number;
  label: string;
  enabled: boolean;
  credentials: XSessionCredentials;
  push: { session: AutopushSession; keys: WebPushKeys; registeredAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** 秘密情報を含まない一覧表示用の形。 */
export interface ReceiverSummary {
  id: number;
  label: string;
  enabled: boolean;
  pushEndpoint: string | null;
  pushRegisteredAt: string | null;
  createdAt: string;
}

interface RawReceiver {
  id: number;
  label: string;
  enabled: number;
  authToken: string;
  csrfToken: string;
  bearerToken: string | null;
  pushUaid: string | null;
  pushChannelId: string | null;
  pushEndpoint: string | null;
  pushPrivateKeyJwk: string | null;
  pushPublicKey: string | null;
  pushAuthSecret: string | null;
  pushRegisteredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT_RECEIVER = `
  SELECT
    id, label, enabled,
    auth_token AS authToken, csrf_token AS csrfToken, bearer_token AS bearerToken,
    push_uaid AS pushUaid, push_channel_id AS pushChannelId, push_endpoint AS pushEndpoint,
    push_private_key_jwk AS pushPrivateKeyJwk, push_public_key AS pushPublicKey,
    push_auth_secret AS pushAuthSecret, push_registered_at AS pushRegisteredAt,
    created_at AS createdAt, updated_at AS updatedAt
  FROM receivers
`;

export class ReceiverRepository {
  constructor(
    private readonly db: Database,
    private readonly defaultBearerToken: string,
  ) {}

  add(
    label: string,
    credentials: { authToken: string; csrfToken: string; bearerToken?: string },
  ): ReceiverRecord {
    const normalized = normalizeLabel(label);
    if (!credentials.authToken.trim() || !credentials.csrfToken.trim()) {
      throw new Error("auth_token と ct0 は空にできません");
    }
    const row = this.db
      .query(
        `INSERT INTO receivers (label, auth_token, csrf_token, bearer_token)
         VALUES ($label, $authToken, $csrfToken, $bearerToken)
         RETURNING id`,
      )
      .get({
        label: normalized,
        authToken: credentials.authToken.trim(),
        csrfToken: credentials.csrfToken.trim(),
        bearerToken: credentials.bearerToken?.trim() || null,
      }) as { id: number };
    return this.getById(row.id)!;
  }

  updateCredentials(
    label: string,
    credentials: { authToken: string; csrfToken: string; bearerToken?: string },
  ): boolean {
    const result = this.db
      .query(
        `UPDATE receivers
         SET auth_token = $authToken, csrf_token = $csrfToken, bearer_token = $bearerToken,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE label = $label`,
      )
      .run({
        label: normalizeLabel(label),
        authToken: credentials.authToken.trim(),
        csrfToken: credentials.csrfToken.trim(),
        bearerToken: credentials.bearerToken?.trim() || null,
      });
    return result.changes > 0;
  }

  remove(label: string): boolean {
    const result = this.db
      .query("DELETE FROM receivers WHERE label = $label")
      .run({ label: normalizeLabel(label) });
    return result.changes > 0;
  }

  setEnabled(label: string, enabled: boolean): boolean {
    const result = this.db
      .query(
        `UPDATE receivers SET enabled = $enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE label = $label`,
      )
      .run({ label: normalizeLabel(label), enabled: enabled ? 1 : 0 });
    return result.changes > 0;
  }

  getById(id: number): ReceiverRecord | null {
    const row = this.db
      .query(`${SELECT_RECEIVER} WHERE id = $id`)
      .get({ id }) as RawReceiver | null;
    return row === null ? null : this.toRecord(row);
  }

  getByLabel(label: string): ReceiverRecord | null {
    const row = this.db
      .query(`${SELECT_RECEIVER} WHERE label = $label`)
      .get({ label: normalizeLabel(label) }) as RawReceiver | null;
    return row === null ? null : this.toRecord(row);
  }

  listEnabled(): ReceiverRecord[] {
    const rows = this.db
      .query(`${SELECT_RECEIVER} WHERE enabled = 1 ORDER BY id`)
      .all() as RawReceiver[];
    return rows.map((row) => this.toRecord(row));
  }

  listSummaries(): ReceiverSummary[] {
    return this.db
      .query(
        `SELECT id, label, enabled, push_endpoint AS pushEndpoint,
                push_registered_at AS pushRegisteredAt, created_at AS createdAt
         FROM receivers ORDER BY id`,
      )
      .all()
      .map((row) => {
        const raw = row as Omit<ReceiverSummary, "enabled"> & { enabled: number };
        return { ...raw, enabled: raw.enabled === 1 };
      });
  }

  savePushSubscription(id: number, session: AutopushSession, keys: WebPushKeys): void {
    this.db
      .query(
        `UPDATE receivers
         SET push_uaid = $uaid, push_channel_id = $channelId, push_endpoint = $endpoint,
             push_private_key_jwk = $privateKeyJwk, push_public_key = $publicKey,
             push_auth_secret = $authSecret, push_registered_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = $id`,
      )
      .run({
        id,
        uaid: session.uaid,
        channelId: session.channelId,
        endpoint: session.endpoint,
        privateKeyJwk: JSON.stringify(keys.privateKeyJwk),
        publicKey: keys.publicKey,
        authSecret: keys.authSecret,
      });
  }

  markPushRegistered(id: number, registeredAt: string): void {
    this.db
      .query(
        `UPDATE receivers SET push_registered_at = $registeredAt,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = $id`,
      )
      .run({ id, registeredAt });
  }

  private toRecord(row: RawReceiver): ReceiverRecord {
    const hasPush =
      row.pushUaid !== null &&
      row.pushChannelId !== null &&
      row.pushEndpoint !== null &&
      row.pushPrivateKeyJwk !== null &&
      row.pushPublicKey !== null &&
      row.pushAuthSecret !== null;
    return {
      id: row.id,
      label: row.label,
      enabled: row.enabled === 1,
      credentials: {
        authToken: row.authToken,
        csrfToken: row.csrfToken,
        bearerToken: row.bearerToken ?? this.defaultBearerToken,
      },
      push: hasPush
        ? {
            session: {
              uaid: row.pushUaid!,
              channelId: row.pushChannelId!,
              endpoint: row.pushEndpoint!,
            },
            keys: {
              privateKeyJwk: JSON.parse(row.pushPrivateKeyJwk!) as JsonWebKey,
              publicKey: row.pushPublicKey!,
              authSecret: row.pushAuthSecret!,
            },
            registeredAt: row.pushRegisteredAt,
          }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
