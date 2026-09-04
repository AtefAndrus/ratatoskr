export const PARSER_VERSION = "poc-3-target-attribution";

export interface ParsedXNotification {
  kind: "post" | "other" | "malformed";
  postId: string | null;
  postUrl: string | null;
  authorHandle: string | null;
  notificationPostId: string | null;
  notificationTitle: string | null;
  targetHandle: string | null;
  payload: unknown;
  error: string | null;
}

export function parseXNotification(text: string): ParsedXNotification {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return {
      kind: "malformed",
      postId: null,
      postUrl: null,
      authorHandle: null,
      notificationPostId: null,
      notificationTitle: null,
      targetHandle: null,
      payload: text,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const uri = findStringAtPaths(payload, [["data", "uri"], ["uri"], ["data", "url"], ["url"]]);
  if (uri === null) {
    return emptyResult("other", payload);
  }

  const reference = parsePostUri(uri);
  if (reference === null) {
    return emptyResult("other", payload);
  }

  const tag = findStringAtPaths(payload, [["data", "tag"], ["tag"]]);
  const notificationPostId = tag?.match(/^tweet-(\d+)$/i)?.[1] ?? reference.postId;
  const notificationTitle = findStringAtPaths(payload, [["data", "title"], ["title"]]);

  return {
    kind: "post",
    ...reference,
    notificationPostId,
    notificationTitle,
    targetHandle: null,
    payload,
    error: null,
  };
}

function emptyResult(kind: "other", payload: unknown): ParsedXNotification {
  return {
    kind,
    postId: null,
    postUrl: null,
    authorHandle: null,
    notificationPostId: null,
    notificationTitle: null,
    targetHandle: null,
    payload,
    error: null,
  };
}

export function parsePostUri(uri: string): {
  postId: string;
  postUrl: string;
  authorHandle: string | null;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(uri, "https://x.com");
  } catch {
    return null;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (
      parsed.hostname !== "x.com" &&
      parsed.hostname !== "twitter.com" &&
      parsed.hostname !== "www.x.com" &&
      parsed.hostname !== "www.twitter.com"
    ) {
      return null;
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/i);
    if (match?.[1] && match[2]) {
      return {
        postId: match[2],
        postUrl: `https://x.com/${match[1]}/status/${match[2]}`,
        authorHandle: match[1].toLowerCase(),
      };
    }
    return null;
  }

  if (parsed.protocol !== "twitter:") {
    return null;
  }

  const postId =
    parsed.searchParams.get("status_id") ??
    parsed.searchParams.get("id") ??
    parsed.pathname.match(/\d+/)?.[0] ??
    null;
  if (postId === null || !/^\d+$/.test(postId)) {
    return null;
  }

  const author = parsed.searchParams.get("screen_name") ?? parsed.searchParams.get("username");
  return {
    postId,
    postUrl: author
      ? `https://x.com/${author}/status/${postId}`
      : `https://x.com/i/status/${postId}`,
    authorHandle: author?.toLowerCase() ?? null,
  };
}

function findStringAtPaths(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (typeof current !== "object" || current === null || !(key in current)) {
        current = null;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === "string") {
      return current;
    }
  }
  return null;
}
