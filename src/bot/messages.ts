import type { LinkDomain } from "../db/repositories/guildSettings";
import type { RouteWithTarget } from "../db/repositories/routes";
import { POST_KIND_LABELS, POST_KINDS, type RouteKinds } from "../postKinds";

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
  return `**@${handle}**  ${displayName}`;
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

export function watchRemovedMessage(input: { handle: string; channelId: string }): string {
  return ["### 監視対象から外しました", `**@${input.handle}** → <#${input.channelId}>`].join("\n");
}

export function watchListMessage(input: {
  routes: RouteWithTarget[];
  linkDomain: LinkDomain;
}): string {
  const lines = ["### 監視対象の一覧", `-# 投稿 URL のドメイン: ${input.linkDomain}`];
  if (input.routes.length === 0) {
    lines.push("監視対象はありません。`/watch add` で追加できます。");
    return lines.join("\n");
  }
  const byHandle = new Map<string, RouteWithTarget[]>();
  for (const route of input.routes) {
    const group = byHandle.get(route.handle) ?? [];
    group.push(route);
    byHandle.set(route.handle, group);
  }
  for (const routes of byHandle.values()) {
    const first = routes[0]!;
    lines.push("", accountLine(first.handle, first.displayName));
    for (const route of routes) {
      lines.push(`- <#${route.channelId}>  送る種別: ${formatKinds(route.kinds)}`);
    }
  }
  return lines.join("\n");
}

export function linkDomainMessage(linkDomain: LinkDomain, changed: boolean): string {
  return changed
    ? `### 投稿 URL のドメインを変更しました\n**${linkDomain}**`
    : `投稿 URL のドメインは **${linkDomain}** です。`;
}

export function errorMessage(detail: string): string {
  return `**エラー**\n${detail}`;
}
