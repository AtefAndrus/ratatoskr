import type { Database } from "bun:sqlite";

import { normalizeHandle } from "../handle";

export interface TargetRecord {
  id: number;
  userId: string;
  handle: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawTarget extends Omit<TargetRecord, "enabled"> {
  enabled: number;
}

const SELECT_TARGET = `
  SELECT id, user_id AS userId, handle, display_name AS displayName, enabled,
         created_at AS createdAt, updated_at AS updatedAt
  FROM watch_targets
`;

function toRecord(row: RawTarget): TargetRecord {
  return { ...row, enabled: row.enabled === 1 };
}

export class TargetRepository {
  constructor(private readonly db: Database) {}

  upsert(input: { userId: string; handle: string; displayName: string }): TargetRecord {
    const row = this.db
      .query(
        `INSERT INTO watch_targets (user_id, handle, display_name)
         VALUES ($userId, $handle, $displayName)
         ON CONFLICT (user_id) DO UPDATE SET
           handle = excluded.handle,
           display_name = excluded.display_name,
           enabled = 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         RETURNING id`,
      )
      .get({
        userId: input.userId,
        handle: normalizeHandle(input.handle),
        displayName: input.displayName.trim(),
      }) as { id: number };
    return this.getById(row.id)!;
  }

  getById(id: number): TargetRecord | null {
    const row = this.db.query(`${SELECT_TARGET} WHERE id = $id`).get({ id }) as RawTarget | null;
    return row === null ? null : toRecord(row);
  }

  findByHandle(handle: string): TargetRecord | null {
    const row = this.db
      .query(`${SELECT_TARGET} WHERE handle = $handle`)
      .get({ handle: normalizeHandle(handle) }) as RawTarget | null;
    return row === null ? null : toRecord(row);
  }

  listAll(): TargetRecord[] {
    return (this.db.query(`${SELECT_TARGET} ORDER BY id`).all() as RawTarget[]).map(toRecord);
  }

  listEnabled(): TargetRecord[] {
    return (
      this.db.query(`${SELECT_TARGET} WHERE enabled = 1 ORDER BY id`).all() as RawTarget[]
    ).map(toRecord);
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db
      .query(
        `UPDATE watch_targets SET enabled = $enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = $id`,
      )
      .run({ id, enabled: enabled ? 1 : 0 });
  }

  /**
   * Web Push 通知の主体を確定する。
   * 通知タイトル (表示名) との一致を優先し、一意でなければ URI の投稿者ハンドルで解決する。
   * 表示名が重複していて一意に決まらない場合は null を返し、Discord へは送らない。
   */
  resolveNotificationTarget(input: {
    authorHandle: string | null;
    notificationTitle: string | null;
  }): TargetRecord | null {
    const targets = this.listEnabled();
    if (input.notificationTitle !== null) {
      const byTitle = targets.filter((target) => target.displayName === input.notificationTitle);
      if (byTitle.length === 1) return byTitle[0]!;
    }
    if (input.authorHandle !== null) {
      const authorHandle = input.authorHandle.toLowerCase();
      const byAuthor = targets.find((target) => target.handle === authorHandle);
      if (byAuthor !== undefined) return byAuthor;
    }
    return null;
  }

  markReceiverConfigured(receiverId: number, targetId: number): void {
    this.db
      .query(
        `INSERT INTO receiver_targets (receiver_id, target_id) VALUES ($receiverId, $targetId)
         ON CONFLICT (receiver_id, target_id) DO UPDATE SET configured_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run({ receiverId, targetId });
  }

  listUnconfiguredForReceiver(receiverId: number): TargetRecord[] {
    return (
      this.db
        .query(
          `${SELECT_TARGET}
           WHERE enabled = 1
             AND NOT EXISTS (
               SELECT 1 FROM receiver_targets
               WHERE receiver_targets.receiver_id = $receiverId
                 AND receiver_targets.target_id = watch_targets.id
             )
           ORDER BY id`,
        )
        .all({ receiverId }) as RawTarget[]
    ).map(toRecord);
  }
}
