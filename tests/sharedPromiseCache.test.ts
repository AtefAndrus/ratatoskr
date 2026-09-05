import { describe, expect, test } from "bun:test";

import { SharedPromiseCache } from "../src/utils/sharedPromiseCache";

describe("キーごとに取得を 1 回へ畳むキャッシュ", () => {
  test("同じキーへの取得は解決後も再利用する", async () => {
    const cache = new SharedPromiseCache<string>(10);
    let calls = 0;
    const load = (): Promise<string> => {
      calls += 1;
      return Promise.resolve("posts");
    };

    expect(await cache.get("1", load)).toBe("posts");
    expect(await cache.get("1", load)).toBe("posts");
    expect(calls).toBe(1);
  });

  test("解決前に重なった取得も 1 回にまとまる", async () => {
    const cache = new SharedPromiseCache<string>(10);
    const { promise, resolve } = Promise.withResolvers<string>();
    let calls = 0;
    const load = (): Promise<string> => {
      calls += 1;
      return promise;
    };

    const first = cache.get("1", load);
    const second = cache.get("1", load);
    resolve("quotes");

    expect(await Promise.all([first, second])).toEqual(["quotes", "quotes"]);
    expect(calls).toBe(1);
  });

  test("失敗したキーは残さず、次の呼び出しで引き直せる", async () => {
    const cache = new SharedPromiseCache<string>(10);
    let calls = 0;
    const load = (): Promise<string> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("lookup failed")) : Promise.resolve("posts");
    };

    await expect(cache.get("1", load)).rejects.toThrow("lookup failed");
    expect(cache.size).toBe(0);
    expect(await cache.get("1", load)).toBe("posts");
    expect(calls).toBe(2);
  });

  test("上限を超えたら古いキーから外す", async () => {
    const cache = new SharedPromiseCache<string>(2);
    let calls = 0;
    const load = (): Promise<string> => {
      calls += 1;
      return Promise.resolve("posts");
    };

    await cache.get("1", load);
    await cache.get("2", load);
    await cache.get("3", load);
    expect(cache.size).toBe(2);

    await cache.get("3", load);
    expect(calls).toBe(3);
    await cache.get("1", load);
    expect(calls).toBe(4);
  });

  test("上限が 1 未満なら組み立てを拒む", () => {
    expect(() => new SharedPromiseCache<string>(0)).toThrow();
  });
});
