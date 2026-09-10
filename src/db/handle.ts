import { LINK_DOMAINS } from "./repositories/guildSettings";

/**
 * URL 形式の入力で受け付けるホスト。書き換え先ドメインを含めるのは、
 * Bot が Discord へ流したリンクをそのまま貼り戻せるようにするため。
 */
const ACCEPTED_URL_HOSTS: readonly string[] = [...LINK_DOMAINS, "twitter.com"];

const PROFILE_URL_PATTERN = new RegExp(
  `^(?:https?://)?(?:www\\.)?(?:${ACCEPTED_URL_HOSTS.map((host) => host.replaceAll(".", "\\.")).join("|")})/([^/?#]*)`,
  "i",
);

/** 1 つめのパス要素がアカウント名にならない URL。/i/web/status/... は Bot 自身が組み立てる形。 */
const RESERVED_PATH_SEGMENTS = new Set([
  "i",
  "home",
  "explore",
  "search",
  "notifications",
  "messages",
  "settings",
  "compose",
  "intent",
]);

export function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new Error(`不正な X アカウント名です: ${value}`);
  }
  return handle;
}

/**
 * 監視対象の新規追加でユーザーが入力したアカウント指定を読む。
 * アカウント名のほか、プロフィールとそのタブ、個別投稿の URL を貼り付けても通す。
 * 既存の監視対象を引くときはアカウント名だけを受け付けるので、この関数は使わない。
 */
export function parseHandleInput(value: string): string {
  const match = PROFILE_URL_PATTERN.exec(value.trim());
  if (match === null) return normalizeHandle(value);
  const segment = match[1] ?? "";
  if (segment === "") throw new Error(`URL にアカウント名が含まれていません: ${value}`);
  const handle = normalizeHandle(segment);
  if (RESERVED_PATH_SEGMENTS.has(handle)) {
    throw new Error(`URL からアカウント名を特定できません: ${value}`);
  }
  return handle;
}

export function normalizeLabel(value: string): string {
  const label = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) {
    throw new Error(`不正な受信アカウントラベルです: ${value}`);
  }
  return label;
}
