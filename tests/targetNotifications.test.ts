import { describe, expect, test } from "bun:test";

import { configureTargetNotifications } from "../src/x/targetNotifications";

const credentials = {
  authToken: "auth",
  csrfToken: "csrf",
  bearerToken: "bearer",
};

describe("configureTargetNotifications", () => {
  test("フォローと投稿通知を有効にして再取得結果を検証する", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    let lookupCount = 0;
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body?.toString() ?? null });
      if (url.includes("UserByScreenName")) {
        lookupCount += 1;
        return jsonResponse(userResponse(lookupCount > 1));
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const result = await configureTargetNotifications(credentials, "example", mockFetch);

    expect(result.before).toEqual({
      userId: "42",
      handle: "example",
      displayName: "Example Account",
      following: false,
      notifications: false,
      wantRetweets: false,
    });
    expect(result.after.following).toBe(true);
    expect(result.after.notifications).toBe(true);
    expect(result.after.wantRetweets).toBe(true);
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "POST", "GET"]);
    expect(requests[1]?.body).toContain("user_id=42");
    expect(requests[2]?.body).toContain("device=true");
    expect(requests[2]?.body).toContain("retweets=true");
  });

  test("設定済みなら変更APIを呼ばない", async () => {
    const requests: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return jsonResponse(userResponse(true));
    }) as typeof fetch;

    await configureTargetNotifications(credentials, "example", mockFetch);

    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.includes("UserByScreenName"))).toBe(true);
  });
});

function userResponse(enabled: boolean): object {
  return {
    data: {
      user: {
        result: {
          rest_id: "42",
          core: { screen_name: "example", name: "Example Account" },
          relationship_perspectives: { following: enabled },
          legacy: { notifications: enabled, want_retweets: enabled },
        },
      },
    },
  };
}

function jsonResponse(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
