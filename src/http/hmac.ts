import { timingSafeEqual } from "node:crypto";

/**
 * Compute HMAC-SHA256 of `message` with `secret`, return lowercase hex.
 * Uses Web Crypto API (available in Bun / browsers / modern Node).
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Timing-safe comparison of two hex strings.
 * Returns false on length mismatch or any decode error without leaking timing.
 */
export function timingSafeEqualHex(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) {
    return false;
  }
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const actual = Buffer.from(actualHex, "hex");
    if (expected.length !== actual.length || expected.length === 0) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
