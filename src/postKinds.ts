import type { InternalPostType } from "./x/internalGraphql";

/** 経路ごとに送るかどうかを選べる投稿の種別。 */
export type PostKind = "posts" | "quotes" | "reposts" | "replies";

export const POST_KINDS: readonly PostKind[] = ["posts", "quotes", "reposts", "replies"];

export type RouteKinds = Record<PostKind, boolean>;

export const ALL_KINDS: RouteKinds = { posts: true, quotes: true, reposts: true, replies: true };

export const POST_KIND_LABELS: Record<PostKind, string> = {
  posts: "通常投稿",
  quotes: "引用",
  reposts: "リポスト",
  replies: "返信",
};

/** 内部 GraphQL の分類 (original / quote / repost / reply) を経路の種別に対応づける。 */
export function kindsFromInternalTypes(types: readonly InternalPostType[]): PostKind[] {
  const kinds = new Set<PostKind>();
  for (const type of types) {
    if (type === "original") kinds.add("posts");
    if (type === "quote") kinds.add("quotes");
    if (type === "repost") kinds.add("reposts");
    if (type === "reply") kinds.add("replies");
  }
  return [...kinds];
}

export function kindsFromTypesJson(typesJson: string): PostKind[] {
  const parsed = JSON.parse(typesJson) as unknown;
  if (!Array.isArray(parsed)) return [];
  return kindsFromInternalTypes(
    parsed.filter(
      (value): value is InternalPostType =>
        value === "original" || value === "quote" || value === "repost" || value === "reply",
    ),
  );
}

/** 投稿が持つ種別のどれかを経路が許可していれば送る (OR 条件)。 */
export function isKindAllowed(routeKinds: RouteKinds, postKinds: readonly PostKind[]): boolean {
  return postKinds.some((kind) => routeKinds[kind]);
}

/** 一覧表示用。すべて許可なら「すべて」、そうでなければ除外している種別を並べる。 */
export function describeKinds(kinds: RouteKinds): string {
  const excluded = POST_KINDS.filter((kind) => !kinds[kind]).map((kind) => POST_KIND_LABELS[kind]);
  return excluded.length === 0 ? "すべて" : `除外: ${excluded.join(", ")}`;
}
