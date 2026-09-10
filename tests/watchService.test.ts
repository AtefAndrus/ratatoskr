import { describe, expect, test } from "bun:test";

import type { ReceiverRecord } from "../src/db/repositories/receivers";
import { WatchService, WatchServiceError } from "../src/services/watchService";
import { addReceiver, createTestContext } from "./helpers/database";

function createSupervisor(fail = false) {
  const calls: string[] = [];
  let reconciles = 0;
  return {
    calls,
    reconciles: () => reconciles,
    async configureTarget(receiver: ReceiverRecord, handle: string) {
      calls.push(`${receiver.label}:${handle}`);
      if (fail) throw new Error("HTTP 403");
      return { userId: `id-${handle}`, handle, displayName: handle.toUpperCase() };
    },
    requestReconcile(): void {
      reconciles += 1;
    },
  };
}

describe("WatchService", () => {
  test("受信アカウントが無ければ追加を拒否する", async () => {
    const context = createTestContext();
    try {
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        createSupervisor(),
        context.guildSettings,
      );
      await expect(
        service.add({ handle: "example", guildId: "g", channelId: "c" }),
      ).rejects.toBeInstanceOf(WatchServiceError);
    } finally {
      context.db.close();
    }
  });

  test("追加は X 側設定、対象登録、経路追加をまとめて行い、削除で経路が無くなれば監視を止める", async () => {
    const context = createTestContext();
    try {
      addReceiver(context, "a");
      addReceiver(context, "b");
      const supervisor = createSupervisor();
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        supervisor,
        context.guildSettings,
      );

      const first = await service.add({
        handle: "@Example",
        guildId: "g1",
        channelId: "c1",
        requestedBy: "u",
      });
      expect(first).toMatchObject({
        created: true,
        configuredBy: "a",
        target: { handle: "example", displayName: "EXAMPLE" },
      });
      expect(supervisor.calls).toEqual(["a:example"]);
      expect(supervisor.reconciles()).toBe(1);
      expect(
        context.targets.listUnconfiguredForReceiver(context.receivers.getByLabel("b")!.id),
      ).toHaveLength(1);

      const second = await service.add({ handle: "example", guildId: "g1", channelId: "c1" });
      expect(second.created).toBe(false);
      await service.add({ handle: "example", guildId: "g2", channelId: "c2" });
      expect(service.list("g1").map((route) => route.channelId)).toEqual(["c1"]);
      expect(service.list("g2").map((route) => route.channelId)).toEqual(["c2"]);

      expect(service.remove({ handle: "example", channelId: "c1" })).toEqual({
        removed: true,
        targetDisabled: false,
        handle: "example",
        displayName: "EXAMPLE",
      });
      expect(service.remove({ handle: "@Example (EXAMPLE)", channelId: "c2" })).toEqual({
        removed: true,
        targetDisabled: true,
        handle: "example",
        displayName: "EXAMPLE",
      });
      expect(context.targets.listEnabled()).toEqual([]);
      expect(service.remove({ handle: "example", channelId: "c2" })).toEqual({
        removed: false,
        targetDisabled: false,
      });
      expect(() => service.remove({ handle: "invalid handle", channelId: "c2" })).toThrow(
        "不正な X アカウント名です: invalid handle",
      );

      const revived = await service.add({ handle: "example", guildId: "g1", channelId: "c1" });
      expect(revived.target.enabled).toBe(true);
    } finally {
      context.db.close();
    }
  });

  test("全受信アカウントで X 側設定に失敗したらエラーを返す", async () => {
    const context = createTestContext();
    try {
      addReceiver(context, "a");
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        createSupervisor(true),
        context.guildSettings,
      );
      await expect(
        service.add({ handle: "example", guildId: "g", channelId: "c" }),
      ).rejects.toThrow("HTTP 403");
      expect(context.targets.listAll()).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  test("追加はプロフィール URL を受け取り、アカウント名にして X 側設定へ渡す", async () => {
    const context = createTestContext();
    try {
      addReceiver(context, "a");
      const supervisor = createSupervisor();
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        supervisor,
        context.guildSettings,
      );

      const result = await service.add({
        handle: "https://x.com/Kashiyuki_Yuki/media?filter=photo",
        guildId: "g",
        channelId: "c",
      });

      expect(supervisor.calls).toEqual(["a:kashiyuki_yuki"]);
      expect(result.target.handle).toBe("kashiyuki_yuki");
    } finally {
      context.db.close();
    }
  });

  test("削除は URL を受け取らない。既存の監視対象はアカウント名だけで引く", async () => {
    const context = createTestContext();
    try {
      addReceiver(context, "a");
      const service = new WatchService(
        context.receivers,
        context.targets,
        context.routes,
        createSupervisor(),
        context.guildSettings,
      );
      await service.add({ handle: "example", guildId: "g", channelId: "c" });

      expect(() => service.remove({ handle: "https://x.com/example", channelId: "c" })).toThrow(
        "不正な X アカウント名です",
      );
      expect(() => context.targets.findByHandle("https://x.com/example")).toThrow(
        "不正な X アカウント名です",
      );
      expect(service.remove({ handle: "example", channelId: "c" })).toMatchObject({
        removed: true,
      });
    } finally {
      context.db.close();
    }
  });
});
