import type { LinkDomain } from "../db/repositories/guildSettings";
import type { RouteWithTarget } from "../db/repositories/routes";
import { POST_KIND_LABELS, POST_KINDS, type RouteKinds } from "../postKinds";

/** Discord の 1 メッセージあたりの文字数上限。 */
const MESSAGE_CHARACTER_LIMIT = 2000;
/** 分割時に末尾へ付けるページ番号のために空けておく幅。 */
const PAGE_SUFFIX_BUDGET = 16;
const BLOCK_SEPARATOR = "\n\n";

/** 送る種別を表示用の文字列にする。すべて許可なら「すべて」、それ以外は許可している種別を並べる。 */
export function formatKinds(kinds: RouteKinds): string {
  const allowed = POST_KINDS.filter((kind) => kinds[kind]);
  if (allowed.length === POST_KINDS.length) return "すべて";
  if (allowed.length === 0) return "なし";
  return allowed.map((kind) => POST_KIND_LABELS[kind]).join(", ");
}

function excludedKinds(kinds: RouteKinds): string | null {
  const excluded = POST_KINDS.filter((kind) => !kinds[kind]);
  if (excluded.length === 0) return null;
  return excluded.map((kind) => POST_KIND_LABELS[kind]).join(", ");
}

function accountLine(handle: string, displayName: string): string {
  return `**${displayName} ([@${handle}](https://x.com/${handle}))**`;
}

export function watchAddedMessage(input: {
  handle: string;
  displayName: string;
  channelId: string;
  kinds: RouteKinds;
  created: boolean;
}): string {
  const excluded = excludedKinds(input.kinds);
  return [
    `### ${input.created ? "監視対象を追加しました" : "監視対象の設定を更新しました"}`,
    accountLine(input.handle, input.displayName),
    `- 投稿先: <#${input.channelId}>`,
    `- 送る種別: ${formatKinds(input.kinds)}`,
    ...(excluded === null ? [] : [`-# 除外: ${excluded}`]),
  ].join("\n");
}

export function watchRemovedMessage(input: {
  handle: string;
  displayName: string;
  channelId: string;
}): string {
  return [
    "### 監視対象から外しました",
    accountLine(input.handle, input.displayName),
    `- 投稿先: <#${input.channelId}>`,
  ].join("\n");
}

/**
 * 監視対象の一覧を、Discord の 1 メッセージ上限に収まる複数のメッセージに分けて返す。
 * 先頭を応答、残りを追送する想定で、並び順のまま読める前提で組み立てる。
 */
export function watchListMessage(input: {
  routes: RouteWithTarget[];
  linkDomain: LinkDomain;
}): string[] {
  const header = ["### 監視対象の一覧", `-# 投稿 URL のドメイン: ${input.linkDomain}`].join("\n");
  if (input.routes.length === 0) {
    return [`${header}\n監視対象はありません。\`/watch add\` で追加できます。`];
  }
  return paginate([header, ...accountBlocks(input.routes)]);
}

function accountBlocks(routes: RouteWithTarget[]): string[] {
  const byHandle = new Map<string, RouteWithTarget[]>();
  for (const route of routes) {
    const group = byHandle.get(route.handle) ?? [];
    group.push(route);
    byHandle.set(route.handle, group);
  }
  return [...byHandle.values()].map((group) => {
    const first = group[0]!;
    return [
      accountLine(first.handle, first.displayName),
      ...group.map((route) => `- <#${route.channelId}>  送る種別: ${formatKinds(route.kinds)}`),
    ].join("\n");
  });
}

/** ブロックを空行で連結しつつ上限で切る。ページ番号は 2 通以上になったときだけ付ける。 */
function paginate(blocks: string[]): string[] {
  // ページ番号を詰め終わってから付けると上限を超えうるので、詰める段階でその分を引いておく。
  const limit = MESSAGE_CHARACTER_LIMIT - PAGE_SUFFIX_BUDGET;
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    for (const piece of splitBlock(block, limit)) {
      if (current === "") {
        current = piece;
      } else if (current.length + BLOCK_SEPARATOR.length + piece.length <= limit) {
        current += BLOCK_SEPARATOR + piece;
      } else {
        messages.push(current);
        current = piece;
      }
    }
  }
  if (current !== "") messages.push(current);
  if (messages.length <= 1) return messages;
  return messages.map((message, index) => `${message}\n-# (${index + 1}/${messages.length})`);
}

/**
 * 1 アカウントのブロックが単独で上限を超えるときだけ行で割る。
 * 1 行が上限を超えるには表示名が数十倍長い必要があるため、行より細かくは割らない。
 */
function splitBlock(block: string, limit: number): string[] {
  if (block.length <= limit) return [block];
  const pieces: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    if (current === "") {
      current = line;
    } else if (current.length + 1 + line.length <= limit) {
      current += `\n${line}`;
    } else {
      pieces.push(current);
      current = line;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

export function linkDomainMessage(linkDomain: LinkDomain, changed: boolean): string {
  return changed
    ? `### 投稿 URL のドメインを変更しました\n**${linkDomain}**`
    : `投稿 URL のドメインは **${linkDomain}** です。`;
}

export function errorMessage(detail: string): string {
  return `**エラー**\n${detail}`;
}
