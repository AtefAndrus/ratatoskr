import { describe, expect, test } from "bun:test";

import { waitFor } from "../src/utils/waitFor";

const NEVER_MS = 60_000;

describe("上限つきの待機", () => {
  test("abort 済みの signal なら待たずに返る", async () => {
    const controller = new AbortController();
    controller.abort();
    let registered = false;

    // 過去の abort は addEventListener へ再通知されないため、ここで待つと満了まで戻らない
    await waitFor(NEVER_MS, controller.signal, () => {
      registered = true;
    });

    expect(registered).toBe(false);
  });

  test("待機中の abort で切り上げる", async () => {
    const controller = new AbortController();
    const waiting = waitFor(NEVER_MS, controller.signal, () => undefined);
    controller.abort();
    await waiting;
  });

  test("外からの起床で切り上げる", async () => {
    const controller = new AbortController();
    const registered = Promise.withResolvers<() => void>();
    const waiting = waitFor(NEVER_MS, controller.signal, (wake) => registered.resolve(wake));
    (await registered.promise)();
    await waiting;
  });

  test("切り上げたら register が返した後始末を呼ぶ", async () => {
    const controller = new AbortController();
    const waiters = new Set<() => void>();
    const registered = Promise.withResolvers<() => void>();

    const waiting = waitFor(NEVER_MS, controller.signal, (wake) => {
      waiters.add(wake);
      registered.resolve(wake);
      return () => waiters.delete(wake);
    });
    expect(waiters.size).toBe(1);
    (await registered.promise)();
    await waiting;

    // 外さないと、待機のたびに起床の登録が積み上がる
    expect(waiters.size).toBe(0);
  });

  test("abort で切り上げたときも後始末を呼ぶ", async () => {
    const controller = new AbortController();
    const waiters = new Set<() => void>();
    const waiting = waitFor(NEVER_MS, controller.signal, (wake) => {
      waiters.add(wake);
      return () => waiters.delete(wake);
    });
    controller.abort();
    await waiting;

    expect(waiters.size).toBe(0);
  });

  test("register が同期的に起こしても後始末を呼び、リスナを残さない", async () => {
    const controller = new AbortController();
    const waiters = new Set<() => void>();
    let listeners = 0;
    const signal = {
      get aborted(): boolean {
        return controller.signal.aborted;
      },
      addEventListener(...args: Parameters<AbortSignal["addEventListener"]>): void {
        listeners += 1;
        controller.signal.addEventListener(...args);
      },
      removeEventListener(...args: Parameters<AbortSignal["removeEventListener"]>): void {
        listeners -= 1;
        controller.signal.removeEventListener(...args);
      },
    } as unknown as AbortSignal;

    await waitFor(NEVER_MS, signal, (wake) => {
      waiters.add(wake);
      wake();
      return () => waiters.delete(wake);
    });

    expect(waiters.size).toBe(0);
    expect(listeners).toBe(0);
  });

  test("上限に達すれば自分で切り上げる", async () => {
    const controller = new AbortController();
    await waitFor(1, controller.signal, () => undefined);
  });

  test("切り上げたあと abort のリスナを残さない", async () => {
    const controller = new AbortController();
    let listeners = 0;
    const signal = {
      get aborted(): boolean {
        return controller.signal.aborted;
      },
      addEventListener(...args: Parameters<AbortSignal["addEventListener"]>): void {
        listeners += 1;
        controller.signal.addEventListener(...args);
      },
      removeEventListener(...args: Parameters<AbortSignal["removeEventListener"]>): void {
        listeners -= 1;
        controller.signal.removeEventListener(...args);
      },
    } as unknown as AbortSignal;
    const registered = Promise.withResolvers<() => void>();

    const waiting = waitFor(NEVER_MS, signal, (wake) => registered.resolve(wake));
    expect(listeners).toBe(1);
    (await registered.promise)();
    await waiting;

    // 起床で切り上げたあともリスナが残ると、長寿命の signal に積み上がる
    expect(listeners).toBe(0);
  });
});
