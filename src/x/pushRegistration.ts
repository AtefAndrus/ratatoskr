import type { AutopushSession } from "../autopush/protocol";
import type { WebPushKeys } from "../webpush/keys";
import { normalizeBearer, type XSessionCredentials } from "./credentials";

const PUSH_REGISTRATION_URL = "https://x.com/i/api/1.1/notifications/settings/login.json";

export interface XPushRegistrationResult {
  requestedAt: string;
  status: number;
  responseText: string;
}

export async function registerXPushSubscription(
  credentials: XSessionCredentials,
  session: AutopushSession,
  keys: WebPushKeys,
  fetchImplementation: typeof fetch = fetch,
): Promise<XPushRegistrationResult> {
  const requestedAt = new Date().toISOString();
  const response = await fetchImplementation(PUSH_REGISTRATION_URL, {
    method: "POST",
    headers: {
      Authorization: normalizeBearer(credentials.bearerToken),
      Cookie: `auth_token=${credentials.authToken}; ct0=${credentials.csrfToken}`,
      "Content-Type": "application/json",
      Origin: "https://x.com",
      Referer: "https://x.com/",
      "x-csrf-token": credentials.csrfToken,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "ja",
    },
    body: JSON.stringify({
      push_device_info: {
        os_version: "Linux/Firefox",
        udid: "Linux/Firefox",
        env: 3,
        locale: "ja",
        protocol_version: 1,
        token: session.endpoint,
        encryption_key1: keys.publicKey,
        encryption_key2: keys.authSecret,
      },
    }),
  });
  const responseText = await response.text();
  const result = { requestedAt, status: response.status, responseText };
  if (!response.ok) {
    throw new XPushRegistrationError(result);
  }
  return result;
}

export class XPushRegistrationError extends Error {
  constructor(readonly result: XPushRegistrationResult) {
    super(`XへのWeb Push登録が失敗しました: HTTP ${result.status}`);
  }
}
