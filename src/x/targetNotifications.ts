import { normalizeBearer, type XSessionCredentials } from "./credentials";

// 応答が返らないままだと受信ループが終わらず、認証情報の載せ替えも停止処理も待ち続ける。
// 呼び出し側の停止指示も合成する。要求を最大 4 回続けるため、timeout だけだとその総和ぶん待つ。
const REQUEST_TIMEOUT_MS = 20_000;

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

const USER_BY_SCREEN_NAME_URL =
  "https://x.com/i/api/graphql/2qvSHpkWTMS9i0zJAwDNiA/UserByScreenName";
const FOLLOW_URL = "https://x.com/i/api/1.1/friendships/create.json";
const UPDATE_FRIENDSHIP_URL = "https://x.com/i/api/1.1/friendships/update.json";

const USER_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const RELATIONSHIP_RESPONSE_FIELDS = {
  cursor: "-1",
  include_profile_interstitial_type: "1",
  include_blocking: "1",
  include_blocked_by: "1",
  include_followed_by: "1",
  include_want_retweets: "1",
  include_mute_edge: "1",
  include_can_dm: "1",
  include_can_media_tag: "1",
  include_ext_has_nft_avatar: "1",
  include_ext_is_blue_verified: "1",
  include_ext_verified_type: "1",
  skip_status: "1",
};

export interface TargetNotificationState {
  userId: string;
  handle: string;
  displayName: string;
  following: boolean;
  notifications: boolean;
  wantRetweets: boolean;
}

export interface XTargetExchange {
  occurredAt: string;
  method: "GET" | "POST";
  url: string;
  status: number;
  responseText: string;
}

export interface ConfigureTargetResult {
  before: TargetNotificationState;
  after: TargetNotificationState;
  exchanges: XTargetExchange[];
}

export async function configureTargetNotifications(
  credentials: XSessionCredentials,
  handle: string,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ConfigureTargetResult> {
  const exchanges: XTargetExchange[] = [];
  const before = await lookupTarget(credentials, handle, exchanges, fetchImplementation, signal);
  if (!before.following) {
    await postForm(
      credentials,
      FOLLOW_URL,
      {
        ...RELATIONSHIP_RESPONSE_FIELDS,
        user_id: before.userId,
      },
      exchanges,
      fetchImplementation,
      signal,
    );
  }
  if (!before.notifications || !before.wantRetweets) {
    await postForm(
      credentials,
      UPDATE_FRIENDSHIP_URL,
      {
        ...RELATIONSHIP_RESPONSE_FIELDS,
        id: before.userId,
        device: "true",
        retweets: "true",
      },
      exchanges,
      fetchImplementation,
      signal,
    );
  }
  const after = await lookupTarget(credentials, handle, exchanges, fetchImplementation, signal);
  if (!after.following || !after.notifications || !after.wantRetweets) {
    throw new Error(`Xの通知設定を確認できませんでした: @${after.handle}`);
  }
  return { before, after, exchanges };
}

async function lookupTarget(
  credentials: XSessionCredentials,
  handle: string,
  exchanges: XTargetExchange[],
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<TargetNotificationState> {
  const url = new URL(USER_BY_SCREEN_NAME_URL);
  url.searchParams.set(
    "variables",
    JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true }),
  );
  url.searchParams.set("features", JSON.stringify(USER_FEATURES));
  url.searchParams.set("fieldToggles", JSON.stringify({ withAuxiliaryUserLabels: false }));
  const responseText = await request(
    credentials,
    url.toString(),
    "GET",
    undefined,
    exchanges,
    fetchImplementation,
    signal,
  );
  const value: unknown = JSON.parse(responseText);
  if (
    !isObject(value) ||
    !isObject(value.data) ||
    !isObject(value.data.user) ||
    !isObject(value.data.user.result)
  ) {
    throw new Error(`Xアカウントの取得結果が不正です: @${handle}`);
  }
  const result = value.data.user.result;
  const core = isObject(result.core) ? result.core : {};
  const relationship = isObject(result.relationship_perspectives)
    ? result.relationship_perspectives
    : {};
  const legacy = isObject(result.legacy) ? result.legacy : {};
  if (
    typeof result.rest_id !== "string" ||
    typeof core.screen_name !== "string" ||
    typeof core.name !== "string"
  ) {
    throw new Error(`Xアカウントの識別子がありません: @${handle}`);
  }
  return {
    userId: result.rest_id,
    handle: core.screen_name,
    displayName: core.name,
    following: relationship.following === true,
    notifications: legacy.notifications === true,
    wantRetweets: legacy.want_retweets === true,
  };
}

async function postForm(
  credentials: XSessionCredentials,
  url: string,
  fields: Record<string, string>,
  exchanges: XTargetExchange[],
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  await request(
    credentials,
    url,
    "POST",
    new URLSearchParams(fields),
    exchanges,
    fetchImplementation,
    signal,
  );
}

async function request(
  credentials: XSessionCredentials,
  url: string,
  method: "GET" | "POST",
  body: URLSearchParams | undefined,
  exchanges: XTargetExchange[],
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const occurredAt = new Date().toISOString();
  const response = await fetchImplementation(url, {
    method,
    signal: requestSignal(signal),
    headers: {
      Authorization: normalizeBearer(credentials.bearerToken),
      Cookie: `auth_token=${credentials.authToken}; ct0=${credentials.csrfToken}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      Origin: "https://x.com",
      Referer: "https://x.com/",
      "x-csrf-token": credentials.csrfToken,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "ja",
    },
    body,
  });
  const responseText = await response.text();
  exchanges.push({ occurredAt, method, url, status: response.status, responseText });
  if (!response.ok) {
    throw new Error(
      `X非公開APIの呼び出しが失敗しました: ${method} ${new URL(url).pathname} HTTP ${response.status}`,
    );
  }
  return responseText;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
