import type { Database } from "bun:sqlite";

export interface NewAutopushFrame {
  receiverId: number;
  receivedAt: string;
  rawText: string;
  messageType: string | null;
  channelId: string | null;
  version: string | null;
  encryptedData: string | null;
  headersJson: string | null;
}

export interface NewParsedNotification {
  frameId: number;
  parsedAt: string;
  parserVersion: string;
  decryptedText: string | null;
  payloadJson: string | null;
  notificationKind: string;
  postId: string | null;
  postUrl: string | null;
  authorHandle: string | null;
  notificationPostId: string | null;
  notificationTitle: string | null;
  targetId: number | null;
  parseError: string | null;
}

export interface ParsedNotificationView {
  id: number;
  frameId: number;
  receiverId: number;
  receivedAt: string;
  parsedAt: string;
  parserVersion: string;
  notificationKind: string;
  postId: string | null;
  postUrl: string | null;
  authorHandle: string | null;
  notificationPostId: string | null;
  notificationTitle: string | null;
  targetId: number | null;
  targetHandle: string | null;
  parseError: string | null;
  decryptedText: string | null;
  headersJson: string | null;
}

export class NotificationRepository {
  constructor(private readonly db: Database) {}

  insertFrame(frame: NewAutopushFrame): number {
    const row = this.db
      .query(
        `INSERT INTO autopush_frames (
           receiver_id, received_at, raw_text, message_type, channel_id, version,
           encrypted_data_base64url, headers_json
         ) VALUES (
           $receiverId, $receivedAt, $rawText, $messageType, $channelId, $version,
           $encryptedData, $headersJson
         )
         RETURNING id`,
      )
      .get({ ...frame }) as { id: number };
    return row.id;
  }

  insertParsed(notification: NewParsedNotification): number {
    const row = this.db
      .query(
        `INSERT INTO parsed_notifications (
           frame_id, parsed_at, parser_version, decrypted_text, payload_json,
           notification_kind, post_id, post_url, author_handle,
           notification_post_id, notification_title, target_id, parse_error
         ) VALUES (
           $frameId, $parsedAt, $parserVersion, $decryptedText, $payloadJson,
           $notificationKind, $postId, $postUrl, $authorHandle,
           $notificationPostId, $notificationTitle, $targetId, $parseError
         )
         RETURNING id`,
      )
      .get({ ...notification }) as { id: number };
    return row.id;
  }

  listRecent(limit: number, kind?: string): ParsedNotificationView[] {
    return this.db
      .query(
        `SELECT parsed.id, parsed.frame_id AS frameId, frames.receiver_id AS receiverId,
                frames.received_at AS receivedAt, parsed.parsed_at AS parsedAt,
                parsed.parser_version AS parserVersion, parsed.notification_kind AS notificationKind,
                parsed.post_id AS postId, parsed.post_url AS postUrl, parsed.author_handle AS authorHandle,
                parsed.notification_post_id AS notificationPostId,
                parsed.notification_title AS notificationTitle, parsed.target_id AS targetId,
                targets.handle AS targetHandle, parsed.parse_error AS parseError,
                parsed.decrypted_text AS decryptedText, frames.headers_json AS headersJson
         FROM parsed_notifications AS parsed
         JOIN autopush_frames AS frames ON frames.id = parsed.frame_id
         LEFT JOIN watch_targets AS targets ON targets.id = parsed.target_id
         WHERE ($kind IS NULL OR parsed.notification_kind = $kind)
         ORDER BY parsed.id DESC
         LIMIT $limit`,
      )
      .all({ limit, kind: kind ?? null }) as ParsedNotificationView[];
  }

  countSince(receivedSince: string): number {
    const row = this.db
      .query("SELECT count(*) AS count FROM autopush_frames WHERE received_at >= $receivedSince")
      .get({ receivedSince }) as { count: number };
    return row.count;
  }
}
