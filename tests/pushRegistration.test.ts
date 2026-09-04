import { describe, expect, test } from "bun:test";

import { registerXPushSubscription } from "../src/x/pushRegistration";

describe("X Web Push登録", () => {
  test("ブラウザと同じprivate API形式で登録する", async () => {
    let captured: Request | null = null;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = new Request(input, init);
      return new Response('{"success":true}', { status: 200 });
    }) as typeof fetch;

    const result = await registerXPushSubscription(
      { authToken: "auth-value", csrfToken: "csrf-value", bearerToken: "web-bearer" },
      { uaid: "uaid", channelId: "channel", endpoint: "https://push.example/subscription" },
      { privateKeyJwk: {}, publicKey: "p256dh", authSecret: "auth-secret" },
      fakeFetch,
    );

    expect(result.status).toBe(200);
    expect(captured).not.toBeNull();
    const request = captured as unknown as Request;
    expect(request.url).toBe("https://x.com/i/api/1.1/notifications/settings/login.json");
    expect(request.headers.get("authorization")).toBe("Bearer web-bearer");
    expect(request.headers.get("cookie")).toBe("auth_token=auth-value; ct0=csrf-value");
    expect(await request.json()).toEqual({
      push_device_info: {
        os_version: "Linux/Firefox",
        udid: "Linux/Firefox",
        env: 3,
        locale: "ja",
        protocol_version: 1,
        token: "https://push.example/subscription",
        encryption_key1: "p256dh",
        encryption_key2: "auth-secret",
      },
    });
  });
});
