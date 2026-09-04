export interface TransactionPair {
  verification: string;
  animationKey: string;
}

const TRANSACTION_EPOCH_SECONDS = 1_682_924_400;
const KEYWORD = "obfiowerehiring";

export async function generateClientTransactionId(
  method: string,
  path: string,
  pair: TransactionPair,
  now = new Date(),
  randomByte = crypto.getRandomValues(new Uint8Array(1))[0]!,
): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1_000) - TRANSACTION_EPOCH_SECONDS;
  const timeBytes = [
    seconds & 0xff,
    (seconds >> 8) & 0xff,
    (seconds >> 16) & 0xff,
    (seconds >> 24) & 0xff,
  ];
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${method.toUpperCase()}!${path}!${seconds}${KEYWORD}${pair.animationKey}`,
    ),
  );
  const verification = Buffer.from(pair.verification, "base64");
  if (verification.length === 0) throw new Error("transaction verification keyが空です");
  const plain = [...verification, ...timeBytes, ...new Uint8Array(digest).slice(0, 16), 3];
  return Buffer.from([randomByte, ...plain.map((byte) => byte ^ randomByte)])
    .toString("base64")
    .replace(/=/g, "");
}

export function parseTransactionPairs(value: unknown): TransactionPair[] {
  if (!Array.isArray(value)) throw new Error("transaction pair一覧が配列ではありません");
  const pairs = value.filter(
    (item): item is TransactionPair =>
      isObject(item) &&
      typeof item.verification === "string" &&
      typeof item.animationKey === "string",
  );
  if (pairs.length !== value.length || pairs.length === 0) {
    throw new Error("transaction pair一覧の形式が不正です");
  }
  return pairs;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
