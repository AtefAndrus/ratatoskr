import { describe, expect, test } from "bun:test";

import { decodeBase64url, encodeBase64url } from "../src/utils/base64url";
import { decryptAes128Gcm, decryptAesGcm } from "../src/webpush/decrypt";
import type { WebPushKeys } from "../src/webpush/keys";

describe("RFC 8291 Web Push復号", () => {
  test("RFC 8291第5節のテストベクトルを復号する", async () => {
    const receiverPublicKey =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const receiverPrivateKey = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const publicBytes = decodeBase64url(receiverPublicKey);
    const keys: WebPushKeys = {
      publicKey: receiverPublicKey,
      authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
      privateKeyJwk: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(publicBytes.slice(1, 33)).toString("base64url"),
        y: Buffer.from(publicBytes.slice(33, 65)).toString("base64url"),
        d: receiverPrivateKey,
        ext: true,
      },
    };
    const encoded = decodeBase64url(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );

    const plaintext = await decryptAes128Gcm(encoded, keys);

    expect(new TextDecoder().decode(plaintext)).toBe("When I grow up, I want to be a watermelon");
  });

  test("改ざんされた暗号文を拒否する", async () => {
    const receiverPublicKey =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const publicBytes = decodeBase64url(receiverPublicKey);
    const keys: WebPushKeys = {
      publicKey: receiverPublicKey,
      authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
      privateKeyJwk: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(publicBytes.slice(1, 33)).toString("base64url"),
        y: Buffer.from(publicBytes.slice(33, 65)).toString("base64url"),
        d: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
      },
    };
    const encoded = decodeBase64url(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    encoded[encoded.length - 1] = (encoded[encoded.length - 1] ?? 0) ^ 1;

    expect(decryptAes128Gcm(encoded, keys)).rejects.toThrow("認証または復号");
  });
});

describe("旧Web Push aesgcm復号", () => {
  test("draft-ietf-webpush-encryption-04付録Aのテストベクトルを復号する", async () => {
    const receiverPublicKey = decodeBase64url(
      "BCEkBjzL8Z3C-oi2Q7oE5t2Np-p7osjGLg93qUP0wvqRT21EEWyf0cQDQcakQMqz4hQKYOQ3il2nNZct4HgAUQU",
    );
    const keys: WebPushKeys = {
      publicKey: encodeBase64url(receiverPublicKey),
      authSecret: "R29vIGdvbyBnJyBqb29iIQ",
      privateKeyJwk: {
        kty: "EC",
        crv: "P-256",
        x: encodeBase64url(receiverPublicKey.slice(1, 33)),
        y: encodeBase64url(receiverPublicKey.slice(33, 65)),
        d: "9FWl15_QUQAWDaD3k3l50ZBZQJ4au27F1V4F0uLSD_M",
        ext: true,
        key_ops: ["deriveBits"],
      },
    };

    const plaintext = await decryptAesGcm(
      decodeBase64url("6nqAQUME8hNqw5J3kl8cpVVJylXKYqZOeseZG8UueKpA"),
      keys,
      {
        salt: "lngarbyKfMoi9Z75xYXmkg",
        senderPublicKey:
          "BNoRDbb84JGm8g5Z5CFxurSqsXWJ11ItfXEWYVLE85Y7CYkDjXsIEc4aqxYaQ1G8BqkXCJ6DPpDrWtdWj_mugHU",
      },
    );

    expect(new TextDecoder().decode(plaintext)).toBe("I am the walrus");
  });
});
