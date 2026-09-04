export function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    throw new Error("不正なbase64url文字列です");
  }
  const unpadded = value.replace(/=+$/, "");
  const padding = "=".repeat((4 - (unpadded.length % 4)) % 4);
  return new Uint8Array(
    Buffer.from(unpadded.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64"),
  );
}

export function encodeBase64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function concatenate(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

export function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}
