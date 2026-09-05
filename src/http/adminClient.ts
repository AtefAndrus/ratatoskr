import { buildAdminSigningInput } from "./adminAuth";
import { hmacSha256Hex } from "./hmac";

const REQUEST_TIMEOUT_MS = 30_000;

export interface AdminRequest {
  /** `http://localhost:3000` の形。パス、クエリ、フラグメントは付けられない。 */
  baseUrl: string;
  secret: string;
  /** `/admin/metrics` の形。 */
  path: string;
  /** `errors=1&limit=20` の形。並び順は署名側で正規化するので呼び出し側で揃えなくてよい。 */
  query?: string;
  now?: () => number;
}

export interface AdminResponse {
  status: number;
  body: string;
}

/** 管理 API を叩く。署名の組み立ては検証側 (`verifyAdminRequest`) と同じ関数を通す。 */
export async function requestAdmin(
  request: AdminRequest,
  fetchImplementation: typeof fetch = fetch,
): Promise<AdminResponse> {
  const url = resolveAdminUrl(request.baseUrl, request.path, request.query);
  const timestamp = String(request.now?.() ?? Date.now());
  const signature = await hmacSha256Hex(
    request.secret,
    buildAdminSigningInput({
      method: "GET",
      pathname: url.pathname,
      searchParams: url.searchParams,
      timestamp,
    }),
  );
  const response = await fetchImplementation(url, {
    headers: {
      "X-Admin-Timestamp": timestamp,
      "X-Admin-Signature": `sha256=${signature}`,
    },
    // 署名は host を含まず 5 分間有効なので、追従すると転送先へ再利用できる署名が渡る。
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

export function resolveAdminUrl(baseUrl: string, path: string, query?: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`管理 API の宛先が URL として読めません: ${baseUrl}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`管理 API の宛先は http か https である必要があります: ${baseUrl}`);
  }
  if (base.search !== "" || base.hash !== "" || base.pathname !== "/") {
    throw new Error(`管理 API の宛先にパスやクエリは付けられません: ${baseUrl}`);
  }
  // 解決前に見る。`new URL(path, base)` は絶対 URL や `//host` を渡すと base を捨てるため、
  // 解決後の pathname だけを見ても、署名付きの要求が別ホストへ飛ぶのを止められない。
  if (!path.startsWith("/admin/")) {
    throw new Error(`管理 API のパスは /admin/ で始まる必要があります: ${path}`);
  }
  // クエリは第 2 引数で受ける。path 側にも書けると、片方がもう片方を黙って上書きする。
  if (path.includes("?") || path.includes("#")) {
    throw new Error(`クエリは第 2 引数で渡してください: ${path}`);
  }
  const url = new URL(path, base);
  if (query !== undefined && query.length > 0) url.search = query;
  if (url.origin !== base.origin) {
    throw new Error(`管理 API のパスが宛先の外を指しています: ${path}`);
  }
  // `..` を含むパスは正規化で /admin/ の外へ出られる。
  if (!url.pathname.startsWith("/admin/")) {
    throw new Error(`管理 API のパスは /admin/ で始まる必要があります: ${path}`);
  }
  return url;
}

export interface AdminCommandResult {
  stdout: string | null;
  stderr: string | null;
  exitCode: 0 | 1;
}

/**
 * CLI の `admin` サブコマンドの中身。
 * 200 以外は状態コードと本文を標準エラーへ回して非ゼロで終わる。本文だけを標準出力へ流すと、
 * 呼び出し側が jq へ繋いだときに異常がパースエラーとしてしか見えず、状態も本文も失われる。
 * secret は環境変数の値をそのまま使う。CLI 側だけで前後空白を落とすと、同じ値を渡しても
 * サーバ側 (config は値を加工しない) と署名が食い違う。
 */
export async function runAdminCommand(
  input: { path: string | undefined; query?: string; env: NodeJS.ProcessEnv },
  request: typeof requestAdmin = requestAdmin,
): Promise<AdminCommandResult> {
  if (input.path === undefined || input.path.length === 0) {
    return {
      stdout: null,
      stderr: "管理 API のパスを指定してください (例: /admin/metrics)",
      exitCode: 1,
    };
  }
  const secret = input.env.ADMIN_API_SECRET;
  if (secret === undefined || secret.length === 0) {
    return { stdout: null, stderr: "ADMIN_API_SECRET が設定されていません", exitCode: 1 };
  }
  const baseUrl = input.env.ADMIN_BASE_URL || "http://localhost:3000";
  const response = await request({ baseUrl, secret, path: input.path, query: input.query });
  if (response.status !== 200) {
    return { stdout: null, stderr: `HTTP ${response.status}\n${response.body}`, exitCode: 1 };
  }
  return { stdout: response.body, stderr: null, exitCode: 0 };
}
