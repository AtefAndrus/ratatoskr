import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EmbedRepairClient, MessageCheck } from "../src/bot/postSender";
import { EmbedRepairService } from "../src/services/embedRepairService";
import { metrics } from "../src/utils/metrics";

class FakeClock {
  time = 0;
  private waits: Array<{
    at: number;
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
  }> = [];

  now = (): number => this.time;

  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const wait = { at: this.time + ms, resolve, reject, signal };
      this.waits.push(wait);
      signal?.addEventListener(
        "abort",
        () => {
          this.waits = this.waits.filter((item) => item !== wait);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  advance(ms: number): void {
    this.time += ms;
    const due = this.waits.filter((wait) => wait.at <= this.time);
    this.waits = this.waits.filter((wait) => wait.at > this.time);
    for (const wait of due) wait.resolve();
  }
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function harness(checks: MessageCheck[]) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const client: EmbedRepairClient = {
    async checkMessage(_channelId, messageId) {
      calls.push(`check:${messageId}`);
      return checks.shift() ?? { status: "found", hasEmbeds: false, suppressed: false };
    },
    async setEmbedsSuppressed(_channelId, messageId, suppressed) {
      calls.push(`${suppressed ? "suppress" : "unsuppress"}:${messageId}`);
    },
  };
  const service = new EmbedRepairService(client, clock);
  const controller = new AbortController();
  const run = service.run(controller.signal);
  const schedule = (messageId = "m", sentAtMs = 0): void => {
    service.schedule({ channelId: "c", messageId, sentAtMs });
  };
  const stop = async (): Promise<void> => {
    controller.abort();
    await run;
  };
  return {
    clock,
    calls,
    client,
    service,
    controller,
    run,
    schedule,
    stop,
  };
}

const empty: MessageCheck = { status: "found", hasEmbeds: false, suppressed: false };
const embedded: MessageCheck = { status: "found", hasEmbeds: true, suppressed: false };

beforeEach(() => metrics.reset());
afterEach(() => metrics.reset());

describe("EmbedRepairService", () => {
  test("最初の確認で埋め込みがあれば終了する", async () => {
    const h = harness([embedded]);
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    h.clock.advance(600_000);
    await settle();
    expect(h.calls).toEqual(["check:m"]);
    expect(metrics.snapshot().counters["embed_repair.ok_before_repair"]).toBe(1);
    await h.stop();
  });

  test("空なら抑止、1 秒待機、解除し、次の確認で埋め込みを見つける", async () => {
    const h = harness([empty, embedded]);
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress:m"]);
    h.clock.advance(999);
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress:m"]);
    h.clock.advance(1);
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress:m", "unsuppress:m"]);
    h.clock.advance(59_000);
    await settle();
    expect(h.calls.at(-1)).toBe("check:m");
    expect(metrics.snapshot().counters["embed_repair.ok_after_repair"]).toBe(1);
    expect(metrics.snapshot().counters["embed_repair.toggle_attempts"]).toBe(1);
    await h.stop();
  });

  test("取得 error は空とみなさず次回確認する", async () => {
    const h = harness([{ status: "error", error: new Error("network") }, embedded]);
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    expect(h.calls).toEqual(["check:m"]);
    h.clock.advance(60_000);
    await settle();
    expect(h.calls).toEqual(["check:m", "check:m"]);
    expect(metrics.snapshot().counters["embed_repair.ok_before_repair"]).toBe(1);
    await h.stop();
  });

  test("管理者が抑止したメッセージは付け外ししない", async () => {
    const h = harness([{ status: "found", hasEmbeds: false, suppressed: true }]);
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    expect(h.calls).toEqual(["check:m"]);
    expect(metrics.snapshot().counters["embed_repair.skipped"]).toBe(1);
    await h.stop();
  });

  test("11 分遅れの空メッセージは最終確認だけ行う", async () => {
    const h = harness([empty]);
    h.schedule();
    h.clock.advance(660_000);
    await settle();
    expect(h.calls).toEqual(["check:m"]);
    expect(metrics.snapshot().counters["embed_repair.empty_final"]).toBe(1);
    await h.stop();
  });

  test("最終確認の取得失敗を分類する", async () => {
    const h = harness([{ status: "error", error: new Error("network") }]);
    h.schedule();
    h.clock.advance(600_000);
    await settle();
    expect(metrics.snapshot().counters["embed_repair.final_fetch_failed"]).toBe(1);
    await h.stop();
  });

  test("取得できないメッセージは終了する", async () => {
    const h = harness([{ status: "unavailable" }]);
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    h.clock.advance(600_000);
    await settle();
    expect(h.calls).toEqual(["check:m"]);
    expect(metrics.snapshot().counters["embed_repair.skipped"]).toBe(1);
    await h.stop();
  });

  test("抑止 PATCH が失敗しても解除を送る", async () => {
    const h = harness([empty]);
    h.client.setEmbedsSuppressed = async (_channelId, _messageId, suppressed) => {
      h.calls.push(suppressed ? "suppress" : "unsuppress");
      if (suppressed) throw new Error("failed");
    };
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    h.clock.advance(1_000);
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress", "unsuppress"]);
    await h.stop();
  });

  test("解除失敗は分類して以後確認しない", async () => {
    const h = harness([empty]);
    h.client.setEmbedsSuppressed = async (_channelId, _messageId, suppressed) => {
      h.calls.push(suppressed ? "suppress" : "unsuppress");
      if (!suppressed) throw new Error("failed");
    };
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    h.clock.advance(1_000);
    await settle();
    h.clock.advance(600_000);
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress", "unsuppress"]);
    expect(metrics.snapshot().counters["embed_repair.unsuppress_failed"]).toBe(1);
    await h.stop();
  });

  test("付け外し中の停止でも 1 秒待って解除してから終了する", async () => {
    const h = harness([empty]);
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    h.controller.abort();
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress:m"]);
    h.clock.advance(1_000);
    await h.run;
    expect(h.calls).toEqual(["check:m", "suppress:m", "unsuppress:m"]);
    expect(metrics.snapshot().counters["embed_repair.dropped_on_shutdown"]).toBe(1);
  });

  test("停止後の予約を破棄する", async () => {
    const h = harness([]);
    await h.stop();
    h.schedule();
    expect(metrics.snapshot().counters["embed_repair.dropped_on_shutdown"]).toBe(1);
    expect(metrics.snapshot().counters["embed_repair.scheduled"]).toBeUndefined();
  });

  test("早い期限が追加されたら待機を起こす", async () => {
    const h = harness([embedded]);
    h.schedule("later", 100_000);
    await settle();
    h.schedule("earlier", 0);
    h.clock.advance(30_000);
    await settle();
    expect(h.calls).toEqual(["check:earlier"]);
    await h.stop();
  });

  test("抑止 PATCH 中に停止しても解除 PATCH の完了を待つ", async () => {
    const h = harness([empty]);
    let releaseSuppress: (() => void) | undefined;
    let releaseUnsuppress: (() => void) | undefined;
    h.client.setEmbedsSuppressed = async (_channelId, _messageId, suppressed) => {
      h.calls.push(suppressed ? "suppress" : "unsuppress");
      await new Promise<void>((resolve) => {
        if (suppressed) releaseSuppress = resolve;
        else releaseUnsuppress = resolve;
      });
    };
    h.schedule();
    h.clock.advance(30_000);
    await settle();
    h.controller.abort();
    let finished = false;
    const completion = h.run.then(() => {
      finished = true;
      return undefined;
    });
    await settle();
    expect(finished).toBe(false);
    releaseSuppress?.();
    await settle();
    h.clock.advance(1_000);
    await settle();
    expect(h.calls).toEqual(["check:m", "suppress", "unsuppress"]);
    expect(finished).toBe(false);
    releaseUnsuppress?.();
    await completion;
    expect(finished).toBe(true);
  });

  test("古い送信から 1 件ずつ処理し、前の確認が終わるまで次を呼ばない", async () => {
    const h = harness([]);
    const releases: Array<() => void> = [];
    h.client.checkMessage = async (_channelId, messageId) => {
      h.calls.push(`check:${messageId}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      return embedded;
    };
    h.schedule("new", 10_000);
    h.schedule("old", 0);
    h.clock.advance(40_000);
    await settle();
    expect(h.calls).toEqual(["check:old"]);
    releases.shift()?.();
    await settle();
    expect(h.calls).toEqual(["check:old", "check:new"]);
    releases.shift()?.();
    await h.stop();
  });

  test("空が続けば 30 秒、90 秒、240 秒で付け外しし、600 秒は確認だけで終える", async () => {
    const h = harness([]);
    h.schedule();
    for (const at of [30_000, 90_000, 240_000]) {
      h.clock.advance(at - 1 - h.clock.time);
      await settle();
      const before = h.calls.length;
      h.clock.advance(1);
      await settle();
      expect(h.calls.slice(before)).toEqual(["check:m", "suppress:m"]);
      h.clock.advance(1_000);
      await settle();
      expect(h.calls.at(-1)).toBe("unsuppress:m");
    }
    h.clock.advance(600_000 - h.clock.time);
    await settle();
    expect(h.calls.at(-1)).toBe("check:m");
    expect(metrics.snapshot().counters["embed_repair.toggle_attempts"]).toBe(3);
    expect(metrics.snapshot().counters["embed_repair.empty_final"]).toBe(1);
    h.clock.advance(600_000);
    await settle();
    expect(h.calls.filter((call) => call === "check:m")).toHaveLength(4);
    await h.stop();
  });

  test("最終確認で取得できなければ対象外ではなく最終取得失敗に数える", async () => {
    const h = harness([{ status: "unavailable" }]);
    h.schedule();
    h.clock.advance(600_000);
    await settle();
    expect(metrics.snapshot().counters["embed_repair.final_fetch_failed"]).toBe(1);
    expect(metrics.snapshot().counters["embed_repair.skipped"]).toBeUndefined();
    await h.stop();
  });
});
