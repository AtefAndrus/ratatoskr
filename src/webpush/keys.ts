import { decodeBase64url, encodeBase64url } from "../utils/base64url";

export interface WebPushKeys {
  privateKeyJwk: JsonWebKey;
  publicKey: string;
  authSecret: string;
}

export async function generateWebPushKeys(): Promise<WebPushKeys> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  return {
    privateKeyJwk,
    publicKey: encodeBase64url(publicKey),
    authSecret: encodeBase64url(authSecret),
  };
}

export function validateWebPushKeys(keys: WebPushKeys): void {
  const publicKey = decodeBase64url(keys.publicKey);
  const authSecret = decodeBase64url(keys.authSecret);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Web Push公開鍵はP-256の非圧縮形式である必要があります");
  }
  if (authSecret.length !== 16) {
    throw new Error("Web Push認証シークレットは16バイトである必要があります");
  }
  if (
    keys.privateKeyJwk.kty !== "EC" ||
    keys.privateKeyJwk.crv !== "P-256" ||
    typeof keys.privateKeyJwk.d !== "string"
  ) {
    throw new Error("Web Push秘密鍵はP-256のJWKである必要があります");
  }
}
