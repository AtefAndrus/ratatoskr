export interface XSessionCredentials {
  authToken: string;
  csrfToken: string;
  bearerToken: string;
}

// XのWebクライアントが埋め込んでいる公開Bearer。アカウントごとの秘密ではないため既定値として持つ。
export const X_WEB_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export function normalizeBearer(value: string): string {
  const trimmed = value.trim();
  return /^Bearer /i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export function xSessionHeaders(credentials: XSessionCredentials): Record<string, string> {
  return {
    Authorization: normalizeBearer(credentials.bearerToken),
    Cookie: `auth_token=${credentials.authToken}; ct0=${credentials.csrfToken}`,
    Origin: "https://x.com",
    Referer: "https://x.com/",
    "x-csrf-token": credentials.csrfToken,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "ja",
  };
}
