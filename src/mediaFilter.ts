/** 経路ごとに選べるメディアの絞り込み。 */
export type MediaFilter = "all" | "photo";

export const MEDIA_FILTERS: readonly MediaFilter[] = ["all", "photo"];

export const MEDIA_FILTER_LABELS: Record<MediaFilter, string> = {
  all: "すべて",
  photo: "画像付きのみ",
};

export function isMediaFilter(value: string): value is MediaFilter {
  return (MEDIA_FILTERS as readonly string[]).includes(value);
}

/**
 * 投稿が持つ添付メディアの種別。
 * null は判定できなかったことを表し、空配列は添付が無いと確定したことを表す。
 * 引き直せば読める保証は無いので、この 2 つを同じ値にまとめない。
 */
export type MediaTypes = readonly string[] | null;

export function isMediaAllowed(filter: MediaFilter, mediaTypes: MediaTypes): boolean {
  if (filter === "all") return true;
  return mediaTypes !== null && mediaTypes.includes("photo");
}

export function mediaTypesFromJson(value: string | null): MediaTypes {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((entry): entry is string => typeof entry === "string");
}
