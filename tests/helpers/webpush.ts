import { asArrayBuffer, concatenate, decodeBase64url } from "../../src/utils/base64url";
import type { WebPushKeys } from "../../src/webpush/keys";

const textEncoder = new TextEncoder();

/**
 * 受信側の鍵で復号できる aes128gcm ペイロードを組み立てる。
 * 通知の中身を差し替えながら WebPushPipeline を端から端まで通すために使う。
 * 手順は RFC 8188 と RFC 8291 で、src/webpush/decrypt.ts の逆にあたる。
 */
export async function encryptAes128Gcm(payload: string, keys: WebPushKeys): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const senderKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const senderPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", senderKeyPair.publicKey),
  );
  const receiverPublicKey = decodeBase64url(keys.publicKey);
  const authSecret = decodeBase64url(keys.authSecret);

  const receiverKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(receiverPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiverKey },
      senderKeyPair.privateKey,
      256,
    ),
  );

  const inputKeyMaterial = await hkdf(
    sharedSecret,
    authSecret,
    concatenate(
      textEncoder.encode("WebPush: info"),
      new Uint8Array([0]),
      receiverPublicKey,
      senderPublicKey,
    ),
    32,
  );
  const contentEncryptionKey = await hkdf(
    inputKeyMaterial,
    salt,
    concatenate(textEncoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    inputKeyMaterial,
    salt,
    concatenate(textEncoder.encode("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(contentEncryptionKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  // 1 レコードで送るので、末尾の区切りは最終レコードを表す 0x02 にする。
  const record = concatenate(textEncoder.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asArrayBuffer(nonce), tagLength: 128 },
      aesKey,
      asArrayBuffer(record),
    ),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, ciphertext.length, false);
  header[20] = senderPublicKey.length;
  return Buffer.from(concatenate(header, senderPublicKey, ciphertext)).toString("base64url");
}

async function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", asArrayBuffer(inputKeyMaterial), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(salt), info: asArrayBuffer(info) },
      key,
      length * 8,
    ),
  );
}
