import { asArrayBuffer, concatenate, decodeBase64url } from "../utils/base64url";
import { validateWebPushKeys, type WebPushKeys } from "./keys";

const HEADER_FIXED_LENGTH = 21;
const AUTH_TAG_LENGTH = 16;
const textEncoder = new TextEncoder();

export async function decryptAes128Gcm(
  encoded: Uint8Array,
  keys: WebPushKeys,
): Promise<Uint8Array> {
  validateWebPushKeys(keys);
  if (encoded.length < HEADER_FIXED_LENGTH + 65 + AUTH_TAG_LENGTH + 1) {
    throw new Error("aes128gcmペイロードが短すぎます");
  }

  const salt = encoded.slice(0, 16);
  const recordSize = new DataView(encoded.buffer, encoded.byteOffset + 16, 4).getUint32(0, false);
  const keyIdLength = encoded[20];
  if (keyIdLength === undefined || keyIdLength === 0) {
    throw new Error("送信者公開鍵がありません");
  }
  if (recordSize <= AUTH_TAG_LENGTH + 1) {
    throw new Error("レコードサイズが小さすぎます");
  }

  const contentOffset = HEADER_FIXED_LENGTH + keyIdLength;
  if (contentOffset >= encoded.length) {
    throw new Error("暗号文がありません");
  }

  const senderPublicKey = encoded.slice(HEADER_FIXED_LENGTH, contentOffset);
  if (senderPublicKey.length !== 65 || senderPublicKey[0] !== 0x04) {
    throw new Error("送信者公開鍵がP-256の非圧縮形式ではありません");
  }

  const receiverPublicKey = decodeBase64url(keys.publicKey);
  const authSecret = decodeBase64url(keys.authSecret);
  const sharedSecret = await deriveSharedSecret(keys.privateKeyJwk, senderPublicKey);
  const keyInfo = concatenate(
    textEncoder.encode("WebPush: info"),
    new Uint8Array([0]),
    receiverPublicKey,
    senderPublicKey,
  );
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const contentEncryptionKey = await hkdf(
    inputKeyMaterial,
    salt,
    concatenate(textEncoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const baseNonce = await hkdf(
    inputKeyMaterial,
    salt,
    concatenate(textEncoder.encode("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );

  const plaintextRecords: Uint8Array[] = [];
  let sequence = 0n;
  for (let offset = contentOffset; offset < encoded.length; offset += recordSize) {
    const end = Math.min(offset + recordSize, encoded.length);
    const final = end === encoded.length;
    const ciphertext = encoded.slice(offset, end);
    if (ciphertext.length <= AUTH_TAG_LENGTH) {
      throw new Error("暗号化レコードが短すぎます");
    }

    const aesKey = await crypto.subtle.importKey(
      "raw",
      asArrayBuffer(contentEncryptionKey),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    let decrypted: Uint8Array;
    try {
      decrypted = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: asArrayBuffer(nonceForSequence(baseNonce, sequence)),
            tagLength: 128,
          },
          aesKey,
          asArrayBuffer(ciphertext),
        ),
      );
    } catch (error) {
      throw new Error("aes128gcmの認証または復号に失敗しました", { cause: error });
    }

    plaintextRecords.push(removePadding(decrypted, final));
    sequence += 1n;
  }

  return concatenate(...plaintextRecords);
}

export async function decryptAesGcm(
  encoded: Uint8Array,
  keys: WebPushKeys,
  parameters: { salt: string; senderPublicKey: string },
): Promise<Uint8Array> {
  // Xはメタデータを本文へ埋め込むRFC 8291形式ではなく、draft-04の分離ヘッダー形式で送信する。
  validateWebPushKeys(keys);
  if (encoded.length <= AUTH_TAG_LENGTH + 2) {
    throw new Error("aesgcmペイロードが短すぎます");
  }

  const salt = decodeBase64url(parameters.salt);
  const senderPublicKey = decodeBase64url(parameters.senderPublicKey);
  const receiverPublicKey = decodeBase64url(keys.publicKey);
  const authSecret = decodeBase64url(keys.authSecret);
  if (salt.length !== 16) {
    throw new Error("aesgcmのsaltは16バイトである必要があります");
  }
  if (senderPublicKey.length !== 65 || senderPublicKey[0] !== 0x04) {
    throw new Error("aesgcmの送信者公開鍵がP-256の非圧縮形式ではありません");
  }

  const sharedSecret = await deriveSharedSecret(keys.privateKeyJwk, senderPublicKey);
  const inputKeyMaterial = await hkdf(
    sharedSecret,
    authSecret,
    concatenate(textEncoder.encode("Content-Encoding: auth"), new Uint8Array([0])),
    32,
  );
  const context = concatenate(
    textEncoder.encode("P-256"),
    new Uint8Array([0]),
    lengthPrefix(receiverPublicKey),
    lengthPrefix(senderPublicKey),
  );
  const contentEncryptionKey = await hkdf(
    inputKeyMaterial,
    salt,
    concatenate(textEncoder.encode("Content-Encoding: aesgcm"), new Uint8Array([0]), context),
    16,
  );
  const nonce = await hkdf(
    inputKeyMaterial,
    salt,
    concatenate(textEncoder.encode("Content-Encoding: nonce"), new Uint8Array([0]), context),
    12,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(contentEncryptionKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  let decrypted: Uint8Array;
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asArrayBuffer(nonce), tagLength: 128 },
        aesKey,
        asArrayBuffer(encoded),
      ),
    );
  } catch (error) {
    throw new Error("aesgcmの認証または復号に失敗しました", { cause: error });
  }
  return removeLegacyPadding(decrypted);
}

async function deriveSharedSecret(
  privateJwk: JsonWebKey,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const senderKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, privateKey, 256),
  );
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
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(salt), info: asArrayBuffer(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function nonceForSequence(baseNonce: Uint8Array, sequence: bigint): Uint8Array {
  if (sequence < 0n || sequence >= 1n << 96n) {
    throw new Error("レコードシーケンスが96ビットを超えました");
  }
  const nonce = baseNonce.slice();
  let remaining = sequence;
  for (let index = nonce.length - 1; index >= 0; index -= 1) {
    nonce[index] = (nonce[index] ?? 0) ^ Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return nonce;
}

function removePadding(record: Uint8Array, final: boolean): Uint8Array {
  let delimiterIndex = record.length - 1;
  while (delimiterIndex >= 0 && record[delimiterIndex] === 0) {
    delimiterIndex -= 1;
  }
  if (delimiterIndex < 0) {
    throw new Error("パディング区切りがありません");
  }
  const expected = final ? 2 : 1;
  if (record[delimiterIndex] !== expected) {
    throw new Error(`パディング区切りが不正です: ${record[delimiterIndex]}`);
  }
  return record.slice(0, delimiterIndex);
}

function lengthPrefix(value: Uint8Array): Uint8Array {
  if (value.length > 0xffff) {
    throw new Error("公開鍵が長すぎます");
  }
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, value.length, false);
  return concatenate(prefix, value);
}

function removeLegacyPadding(record: Uint8Array): Uint8Array {
  if (record.length < 2) {
    throw new Error("aesgcmのパディング長がありません");
  }
  const paddingLength = new DataView(record.buffer, record.byteOffset, 2).getUint16(0, false);
  const contentOffset = 2 + paddingLength;
  if (contentOffset > record.length) {
    throw new Error("aesgcmのパディングがレコード長を超えています");
  }
  for (let index = 2; index < contentOffset; index += 1) {
    if (record[index] !== 0) {
      throw new Error("aesgcmのパディングが不正です");
    }
  }
  return record.slice(contentOffset);
}
