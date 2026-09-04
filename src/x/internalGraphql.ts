import {
  generateClientTransactionId,
  parseTransactionPairs,
  type TransactionPair,
} from "./clientTransactionId";
import { normalizeBearer, type XSessionCredentials } from "./credentials";

const API_DOCUMENT_URL =
  "https://raw.githubusercontent.com/fa0311/TwitterInternalAPIDocument/refs/heads/develop/docs/json/API.json";
const TRANSACTION_PAIRS_URL =
  "https://raw.githubusercontent.com/fa0311/x-client-transaction-pair-dict/refs/heads/main/pair.json";

export const OPERATION_NAMES = ["UserTweetsAndReplies", "TweetResultByRestId"] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export type InternalPostType = "original" | "reply" | "quote" | "repost";

export interface InternalTimelinePost {
  postId: string;
  createdAt: string | null;
  authorUserId: string | null;
  authorHandle: string | null;
  types: InternalPostType[];
  referencedPostIds: string[];
  /** リポストのとき、元投稿の投稿者ハンドル。URL を通常投稿と同じ形にするために使う。 */
  referencedAuthorHandle: string | null;
  rawResult: unknown;
}

export interface InternalGraphqlOperation {
  queryId: string;
  features: Record<string, boolean>;
}

export interface InternalGraphqlConfiguration {
  operations: Record<OperationName, InternalGraphqlOperation>;
  pairs: TransactionPair[];
}

interface InternalGraphqlResponse {
  fetchedAt: string;
  completedAt: string;
  queryId: string;
  endpoint: string;
  variables: Record<string, unknown>;
  features: Record<string, boolean>;
  transactionId: string | null;
  responseStatus: number | null;
  responseText: string | null;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  error: string | null;
}

export interface InternalTimelineFetchResult extends InternalGraphqlResponse {
  parseError: string | null;
  posts: InternalTimelinePost[];
}

export interface InternalTweetLookupResult extends InternalGraphqlResponse {
  parseError: string | null;
  post: InternalTimelinePost | null;
}

export interface InternalTimelineTarget {
  userId: string;
  handle: string;
}

export interface ExchangeRecorder {
  (exchange: {
    source: string;
    occurredAt: string;
    method: string;
    url: string;
    responseStatus: number | null;
    responseText: string | null;
    error: string | null;
  }): void;
}

export class XInternalGraphqlClient {
  constructor(
    private readonly credentials: XSessionCredentials,
    private readonly configuration:
      | InternalGraphqlConfiguration
      | (() => Promise<InternalGraphqlConfiguration>),
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly random: () => number = Math.random,
  ) {}

  async fetchUserTweetsAndReplies(
    target: InternalTimelineTarget,
  ): Promise<InternalTimelineFetchResult> {
    const response = await this.request({
      operation: "UserTweetsAndReplies",
      variables: {
        userId: target.userId,
        count: 20,
        includePromotedContent: false,
        withCommunity: true,
        withVoice: true,
        withV2Timeline: true,
      },
      fieldToggles: { withArticlePlainText: false },
      referer: `https://x.com/${target.handle}/with_replies`,
    });
    let posts: InternalTimelinePost[] = [];
    let parseError: string | null = null;
    if (response.error === null && response.responseText !== null) {
      try {
        posts = extractTimelinePosts(JSON.parse(response.responseText));
      } catch (failure) {
        parseError = errorMessage(failure);
      }
    }
    return { ...response, parseError, posts };
  }

  /** 投稿 1 件を引いて種別を確定する。Web Push では通常投稿と引用を区別できないときに使う。 */
  async fetchTweetResult(postId: string): Promise<InternalTweetLookupResult> {
    const response = await this.request({
      operation: "TweetResultByRestId",
      variables: {
        tweetId: postId,
        withCommunity: false,
        includePromotedContent: false,
        withVoice: false,
      },
      fieldToggles: { withArticlePlainText: false },
      referer: `https://x.com/i/web/status/${postId}`,
    });
    let post: InternalTimelinePost | null = null;
    let parseError: string | null = null;
    if (response.error === null && response.responseText !== null) {
      try {
        post = extractTweetResult(JSON.parse(response.responseText));
        if (post === null) parseError = "応答に投稿が含まれていません";
      } catch (failure) {
        parseError = errorMessage(failure);
      }
    }
    return { ...response, parseError, post };
  }

  private async request(input: {
    operation: OperationName;
    variables: Record<string, unknown>;
    fieldToggles: Record<string, boolean>;
    referer: string;
  }): Promise<InternalGraphqlResponse> {
    const fetchedAt = new Date().toISOString();
    const configuration =
      typeof this.configuration === "function" ? await this.configuration() : this.configuration;
    const operation = configuration.operations[input.operation];
    const url = new URL(`/i/api/graphql/${operation.queryId}/${input.operation}`, "https://x.com");
    url.searchParams.set("variables", JSON.stringify(input.variables));
    url.searchParams.set("features", JSON.stringify(operation.features));
    url.searchParams.set("fieldToggles", JSON.stringify(input.fieldToggles));
    const pair = configuration.pairs[Math.floor(this.random() * configuration.pairs.length)]!;
    let transactionId: string | null = null;
    let responseStatus: number | null = null;
    let responseText: string | null = null;
    let rateLimitLimit: number | null = null;
    let rateLimitRemaining: number | null = null;
    let rateLimitResetAt: string | null = null;
    let error: string | null = null;
    try {
      transactionId = await generateClientTransactionId("GET", url.pathname, pair);
      const response = await this.fetchImplementation(url, {
        headers: {
          Accept: "application/json",
          Authorization: normalizeBearer(this.credentials.bearerToken),
          Cookie: `auth_token=${this.credentials.authToken}; ct0=${this.credentials.csrfToken}`,
          Origin: "https://x.com",
          Referer: input.referer,
          "x-client-transaction-id": transactionId,
          "x-csrf-token": this.credentials.csrfToken,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-client-language": "ja",
        },
        signal: AbortSignal.timeout(20_000),
      });
      responseStatus = response.status;
      responseText = await response.text();
      rateLimitLimit = parseIntegerHeader(response.headers.get("x-rate-limit-limit"));
      rateLimitRemaining = parseIntegerHeader(response.headers.get("x-rate-limit-remaining"));
      rateLimitResetAt = parseResetHeader(response.headers.get("x-rate-limit-reset"));
      if (!response.ok) error = `X内部GraphQL APIがHTTP ${response.status}を返しました`;
    } catch (requestFailure) {
      error = errorMessage(requestFailure);
    }
    return {
      fetchedAt,
      completedAt: new Date().toISOString(),
      queryId: operation.queryId,
      endpoint: url.toString(),
      variables: input.variables,
      features: operation.features,
      transactionId,
      responseStatus,
      responseText,
      rateLimitLimit,
      rateLimitRemaining,
      rateLimitResetAt,
      error,
    };
  }
}

export async function loadInternalGraphqlConfiguration(
  recordExchange: ExchangeRecorder,
  fetchImplementation: typeof fetch = fetch,
): Promise<InternalGraphqlConfiguration> {
  const apiDocument = await fetchSource(
    recordExchange,
    fetchImplementation,
    "x_internal_api_document",
    API_DOCUMENT_URL,
  );
  const transactionPairs = await fetchSource(
    recordExchange,
    fetchImplementation,
    "x_transaction_pairs",
    TRANSACTION_PAIRS_URL,
  );
  const document = JSON.parse(apiDocument) as unknown;
  const operations = Object.fromEntries(
    OPERATION_NAMES.map((name) => [name, readOperation(document, name)]),
  ) as Record<OperationName, InternalGraphqlOperation>;
  return { operations, pairs: parseTransactionPairs(JSON.parse(transactionPairs)) };
}

export function extractTimelinePosts(payload: unknown): InternalTimelinePost[] {
  const results: unknown[] = [];
  visitTimelineEntries(payload, results);
  const posts = new Map<string, InternalTimelinePost>();
  for (const raw of results) {
    const post = classifyTweetResult(raw);
    if (post !== null) posts.set(post.postId, post);
  }
  return [...posts.values()];
}

/** TweetResultByRestId の応答 (`data.tweetResult.result`) から投稿 1 件を取り出す。 */
export function extractTweetResult(payload: unknown): InternalTimelinePost | null {
  if (!isObject(payload) || !isObject(payload.data) || !isObject(payload.data.tweetResult)) {
    return null;
  }
  return classifyTweetResult(payload.data.tweetResult.result);
}

/** 投稿の生 JSON から ID、投稿者、種別 (通常/返信/引用/リポスト) を読み取る。 */
export function classifyTweetResult(raw: unknown): InternalTimelinePost | null {
  const result = unwrapTweetResult(raw);
  if (!isObject(result) || typeof result.rest_id !== "string") return null;
  const legacy = isObject(result.legacy) ? result.legacy : null;
  if (legacy === null) return null;
  const types: InternalPostType[] = [];
  if (isObject(legacy.retweeted_status_result)) {
    types.push("repost");
  } else {
    if (typeof legacy.in_reply_to_status_id_str === "string") types.push("reply");
    if (legacy.is_quote_status === true || isObject(result.quoted_status_result)) {
      types.push("quote");
    }
  }
  if (types.length === 0) types.push("original");
  const core = isObject(result.core) ? result.core : null;
  const userResult =
    core !== null && isObject(core.user_results) && isObject(core.user_results.result)
      ? core.user_results.result
      : null;
  const userLegacy = userResult !== null && isObject(userResult.legacy) ? userResult.legacy : null;
  const userCore = userResult !== null && isObject(userResult.core) ? userResult.core : null;
  const referencedPostIds = types.includes("repost")
    ? [readNestedRestId(legacy.retweeted_status_result)]
    : [legacy.in_reply_to_status_id_str, readNestedRestId(result.quoted_status_result)];
  return {
    postId: result.rest_id,
    createdAt: parseXDate(legacy.created_at),
    authorUserId: typeof legacy.user_id_str === "string" ? legacy.user_id_str : null,
    authorHandle:
      readFirstString(userCore?.screen_name, userLegacy?.screen_name)?.toLowerCase() ?? null,
    types,
    referencedPostIds: [
      ...new Set(referencedPostIds.filter((value): value is string => typeof value === "string")),
    ],
    referencedAuthorHandle: types.includes("repost")
      ? readNestedAuthorHandle(legacy.retweeted_status_result)
      : null,
    rawResult: raw,
  };
}

function visitTimelineEntries(value: unknown, output: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) visitTimelineEntries(item, output);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.entryId === "string") {
    collectEntryResults(value.content, output);
    return;
  }
  for (const child of Object.values(value)) visitTimelineEntries(child, output);
}

function collectEntryResults(value: unknown, output: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEntryResults(item, output);
    return;
  }
  if (!isObject(value)) return;
  if (isObject(value.tweet_results) && value.tweet_results.result !== undefined) {
    output.push(value.tweet_results.result);
    return;
  }
  for (const child of Object.values(value)) collectEntryResults(child, output);
}

function unwrapTweetResult(value: unknown): unknown {
  if (isObject(value) && isObject(value.tweet)) return value.tweet;
  return value;
}

function readNestedAuthorHandle(value: unknown): string | null {
  if (!isObject(value)) return null;
  const result = unwrapTweetResult(value.result);
  if (!isObject(result) || !isObject(result.core)) return null;
  const userResults = result.core.user_results;
  const user = isObject(userResults) && isObject(userResults.result) ? userResults.result : null;
  if (user === null) return null;
  const userCore = isObject(user.core) ? user.core : null;
  const userLegacy = isObject(user.legacy) ? user.legacy : null;
  return readFirstString(userCore?.screen_name, userLegacy?.screen_name)?.toLowerCase() ?? null;
}

function readNestedRestId(value: unknown): string | null {
  if (!isObject(value)) return null;
  const result = unwrapTweetResult(value.result);
  return isObject(result) && typeof result.rest_id === "string" ? result.rest_id : null;
}

/**
 * query ID と feature 一覧、transaction ID の素材を外部リポジトリから取得し、TTL 付きでキャッシュする。
 * X 側の変更に追従できるよう、失敗時は前回の値を使い続けて次回また取り直す。
 */
export class InternalGraphqlConfigurationProvider {
  private cached: { value: InternalGraphqlConfiguration; loadedAtMs: number } | null = null;
  private inflight: Promise<InternalGraphqlConfiguration> | null = null;

  constructor(
    private readonly recordExchange: ExchangeRecorder,
    private readonly ttlMs = 6 * 60 * 60_000,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<InternalGraphqlConfiguration> {
    if (this.cached !== null && this.now() - this.cached.loadedAtMs < this.ttlMs) {
      return this.cached.value;
    }
    if (this.inflight === null) {
      this.inflight = loadInternalGraphqlConfiguration(
        this.recordExchange,
        this.fetchImplementation,
      )
        .then((value) => {
          this.cached = { value, loadedAtMs: this.now() };
          return value;
        })
        .catch((error: unknown) => {
          if (this.cached !== null) {
            this.cached = { value: this.cached.value, loadedAtMs: this.now() };
            return this.cached.value;
          }
          throw error;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return await this.inflight;
  }
}

async function fetchSource(
  recordExchange: ExchangeRecorder,
  fetchImplementation: typeof fetch,
  source: string,
  url: string,
): Promise<string> {
  const occurredAt = new Date().toISOString();
  let status: number | null = null;
  let responseText: string | null = null;
  let error: string | null = null;
  try {
    const response = await fetchImplementation(url, { signal: AbortSignal.timeout(20_000) });
    status = response.status;
    responseText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return responseText;
  } catch (failure) {
    error = errorMessage(failure);
    throw failure;
  } finally {
    recordExchange({
      source,
      occurredAt,
      method: "GET",
      url,
      responseStatus: status,
      responseText,
      error,
    });
  }
}

function readOperation(document: unknown, name: OperationName): InternalGraphqlOperation {
  if (!isObject(document) || !isObject(document.graphql) || !isObject(document.graphql[name])) {
    throw new Error(`${name}がAPI文書にありません`);
  }
  const operation = document.graphql[name];
  if (typeof operation.queryId !== "string" || !isObject(operation.features)) {
    throw new Error(`${name}のAPI文書形式が不正です`);
  }
  const entries = Object.entries(operation.features);
  if (!entries.every((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) {
    throw new Error(`${name}のfeatures形式が不正です`);
  }
  return { queryId: operation.queryId, features: Object.fromEntries(entries) };
}

function parseIntegerHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function parseResetHeader(value: string | null): string | null {
  const seconds = parseIntegerHeader(value);
  if (seconds === null) return null;
  return new Date(seconds * 1_000).toISOString();
}

function parseXDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readFirstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string") ?? null;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
