import { hmacSha256Hex, timingSafeEqualHex } from "./hmac";

export type AdminAuthResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

const DRIFT_WINDOW_MS = 5 * 60_000;
const TIMESTAMP_REGEX = /^\d{1,15}$/;

/**
 * Build the canonical query string used as part of the HMAC signing input.
 * Pairs are sorted by key (ascending), then by value (ascending, stable),
 * with duplicate keys preserved, then encoded with `encodeURIComponent`.
 */
export function canonicalizeQuery(searchParams: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of searchParams) {
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] === b[1]) return 0;
    return a[1] < b[1] ? -1 : 1;
  });
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

function isValidTimestamp(raw: string | null, nowMs: number): boolean {
  if (!raw) return false;
  if (!TIMESTAMP_REGEX.test(raw)) return false;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  return Math.abs(nowMs - n) <= DRIFT_WINDOW_MS;
}

export async function verifyAdminRequest(
  req: Request,
  secret: string | undefined,
): Promise<AdminAuthResult> {
  if (!secret || secret.length === 0) {
    return { ok: false, status: 503, reason: "ADMIN_API_SECRET not configured" };
  }

  const tsHeader = req.headers.get("X-Admin-Timestamp");
  if (!isValidTimestamp(tsHeader, Date.now())) {
    return { ok: false, status: 401, reason: "Invalid or missing timestamp" };
  }

  const sigHeader = req.headers.get("X-Admin-Signature");
  if (!sigHeader?.startsWith("sha256=")) {
    return { ok: false, status: 401, reason: "Invalid or missing signature" };
  }
  const provided = sigHeader.slice(7);

  const url = new URL(req.url);
  const canonicalQuery = canonicalizeQuery(url.searchParams);
  const message = `${req.method}\n${url.pathname}\n${canonicalQuery}\n${tsHeader as string}`;
  const expected = await hmacSha256Hex(secret, message);

  if (!timingSafeEqualHex(expected, provided)) {
    return { ok: false, status: 401, reason: "Signature mismatch" };
  }

  return { ok: true };
}
