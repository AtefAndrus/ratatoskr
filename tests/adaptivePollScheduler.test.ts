import { describe, expect, test } from "bun:test";

import { AdaptivePollScheduler } from "../src/x/adaptivePollScheduler";

const noJitter = { intervalJitterRatio: 0, resetJitterMs: 0, random: () => 0.5 };

describe("適応ポーリングスケジューラ", () => {
  test("少数の対象は1分へ均等配置する", () => {
    const scheduler = new AdaptivePollScheduler(["one", "two", "three", "four"], 1_000, noJitter);

    expect(scheduler.snapshot().map((target) => target.nextDueAtMs)).toEqual([
      1_000, 16_000, 31_000, 46_000,
    ]);
  });

  test("対象が増えると全体の3秒間隔を守って巡回時間を延ばす", () => {
    const targets = Array.from({ length: 100 }, (_, index) => `user_${index}`);
    const scheduler = new AdaptivePollScheduler(targets, 0, noJitter);
    const dueTimes = scheduler.snapshot().map((target) => target.nextDueAtMs);

    expect(dueTimes[1]! - dueTimes[0]!).toBe(3_000);
    expect(dueTimes.at(-1)).toBe(297_000);
  });

  test("投稿がなければ最大3分まで段階的に間隔を延ばし投稿発見で1分へ戻す", () => {
    const scheduler = new AdaptivePollScheduler(["quiet"], 0, noJitter);

    for (const [completedAtMs, expectedNext] of [
      [0, 90_000],
      [90_000, 210_000],
      [210_000, 390_000],
      [390_000, 570_000],
      [570_000, 750_000],
    ] as const) {
      scheduler.complete("quiet", { outcome: "empty" }, completedAtMs);
      expect(scheduler.snapshot()[0]!.nextDueAtMs).toBe(expectedNext);
    }

    scheduler.complete("quiet", { outcome: "items" }, 750_000);
    expect(scheduler.snapshot()[0]).toMatchObject({
      nextDueAtMs: 810_000,
      quietStreak: 0,
      failureStreak: 0,
    });
  });

  test("残量を予約分まで使い切らないよう全体間隔を広げる", () => {
    const scheduler = new AdaptivePollScheduler(["one"], 0, noJitter);
    scheduler.complete(
      "one",
      {
        outcome: "items",
        rateLimit: { remaining: 150, resetAtMs: 600_000 },
      },
      0,
    );
    scheduler.addTarget("two", 0);

    expect(scheduler.next(0)).toEqual({
      target: "two",
      scheduledAtMs: 12_000,
      waitMs: 12_000,
    });
  });

  test("429ではreset時刻より前に別対象も実行しない", () => {
    const scheduler = new AdaptivePollScheduler(["one", "two"], 0, noJitter);
    scheduler.complete(
      "one",
      {
        outcome: "rate_limited",
        rateLimit: { remaining: 0, resetAtMs: 120_000 },
      },
      0,
    );

    expect(scheduler.next(0)).toMatchObject({ scheduledAtMs: 120_000, waitMs: 120_000 });
  });

  test("実行失敗は対象単位で指数的に後退する", () => {
    const scheduler = new AdaptivePollScheduler(["unstable"], 0, noJitter);
    scheduler.complete("unstable", { outcome: "error" }, 0);
    expect(scheduler.snapshot()[0]!.nextDueAtMs).toBe(30_000);
    scheduler.complete("unstable", { outcome: "error" }, 30_000);
    expect(scheduler.snapshot()[0]!.nextDueAtMs).toBe(90_000);
  });
});
