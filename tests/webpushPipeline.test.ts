import { describe, expect, test } from "bun:test";

import { WebPushPipeline } from "../src/pipeline/webpushPipeline";
import { DeliveryService } from "../src/services/deliveryService";
import { decodeBase64url } from "../src/utils/base64url";
import type { WebPushKeys } from "../src/webpush/keys";
import { addReceiver, createRecordingSender, createTestContext } from "./helpers/database";

const RFC_PUBLIC_KEY =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const publicBytes = decodeBase64url(RFC_PUBLIC_KEY);
const keys: WebPushKeys = {
  publicKey: RFC_PUBLIC_KEY,
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  privateKeyJwk: {
    kty: "EC",
    crv: "P-256",
    x: Buffer.from(publicBytes.slice(1, 33)).toString("base64url"),
    y: Buffer.from(publicBytes.slice(33, 65)).toString("base64url"),
    d: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    ext: true,
  },
};
const RFC_CIPHERTEXT =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

describe("WebPushPipeline", () => {
  test("復号結果と解析結果を保存し、ACK コードを返す", async () => {
    const context = createTestContext();
    try {
      const receiverId = addReceiver(context);
      const pipeline = new WebPushPipeline({
        notifications: context.notifications,
        targets: context.targets,
        delivery: new DeliveryService(context.routes, context.deliveries, createRecordingSender()),
        deliveryNotBefore: "2026-09-01T00:00:00.000Z",
      });
      const base = {
        rawText: "{}",
        channelId: "channel",
        version: "1",
        headers: { encoding: "aes128gcm" },
      };

      expect(
        await pipeline.process({ receiverId, keys, notification: { ...base, data: null } }),
      ).toBe(100);
      expect(
        await pipeline.process({ receiverId, keys, notification: { ...base, data: "AAAA" } }),
      ).toBe(101);
      expect(
        await pipeline.process({
          receiverId,
          keys,
          notification: { ...base, data: RFC_CIPHERTEXT },
        }),
      ).toBe(100);

      const stored = context.notifications.listRecent(10);
      expect(stored.map((notification) => notification.notificationKind)).toEqual([
        "malformed",
        "malformed",
        "other",
      ]);
      expect(stored[0]?.decryptedText).toBe("When I grow up, I want to be a watermelon");
      expect(stored[1]?.parseError).not.toBeNull();
      expect(stored[1]?.decryptedText).toBeNull();
    } finally {
      context.db.close();
    }
  });
});
