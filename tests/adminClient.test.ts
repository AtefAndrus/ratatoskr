import { describe, expect, test } from "bun:test";

import { canonicalizeQuery, verifyAdminRequest } from "../src/http/adminAuth";
import { requestAdmin, resolveAdminUrl, runAdminCommand } from "../src/http/adminClient";

const SECRET = "test-secret";

function verifyingFetch(seen: Request[]): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    const result = await verifyAdminRequest(request, SECRET);
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : result.status });
  }) as typeof fetch;
}

describe("管理 API のクライアント", () => {
  test("組み立てた署名が検証側で通る", async () => {
    const seen: Request[] = [];
    const response = await requestAdmin(
      { baseUrl: "http://localhost:3000", secret: SECRET, path: "/admin/metrics" },
      verifyingFetch(seen),
    );

    expect(response.status).toBe(200);
    expect(new URL(seen[0]!.url).pathname).toBe("/admin/metrics");
    expect(seen[0]!.headers.get("X-Admin-Signature")).toStartWith("sha256=");
  });

  test("クエリの並び順が違っても検証側で通り、クエリ自体も送られる", async () => {
    for (const query of ["source=x_tweet_lookup&limit=3", "limit=3&source=x_tweet_lookup"]) {
      const seen: Request[] = [];
      const response = await requestAdmin(
        { baseUrl: "http://localhost:3000", secret: SECRET, path: "/admin/exchanges", query },
        verifyingFetch(seen),
      );

      expect(response.status).toBe(200);
      const sent = new URL(seen[0]!.url).searchParams;
      expect(sent.get("source")).toBe("x_tweet_lookup");
      expect(sent.get("limit")).toBe("3");
    }
  });

  test("鍵が違えば検証側が 401 を返す", async () => {
    const response = await requestAdmin(
      { baseUrl: "http://localhost:3000", secret: "wrong", path: "/admin/metrics" },
      verifyingFetch([]),
    );

    expect(response.status).toBe(401);
    expect(response.body).toContain("Signature mismatch");
  });

  test("ドリフト窓を外れた時刻では検証側が 401 を返す", async () => {
    const response = await requestAdmin(
      {
        baseUrl: "http://localhost:3000",
        secret: SECRET,
        path: "/admin/metrics",
        now: () => Date.now() - 10 * 60_000,
      },
      verifyingFetch([]),
    );

    expect(response.status).toBe(401);
  });

  test("宛先の末尾スラッシュとパスの先頭スラッシュが重なっても壊れない", async () => {
    const seen: Request[] = [];
    await requestAdmin(
      { baseUrl: "http://localhost:3000/", secret: SECRET, path: "/admin/metrics" },
      verifyingFetch(seen),
    );

    expect(seen[0]!.url).toBe("http://localhost:3000/admin/metrics");
  });
});

describe("管理 API の宛先の解決", () => {
  test("宛先の末尾スラッシュとパスの先頭スラッシュが重なっても壊れない", () => {
    expect(resolveAdminUrl("http://localhost:3000/", "/admin/metrics").href).toBe(
      "http://localhost:3000/admin/metrics",
    );
  });

  test("クエリやパスの付いた宛先は拒む", () => {
    // 文字列連結だと https://host?tenant=x が https://host/?tenant=x/admin/metrics になる
    expect(() => resolveAdminUrl("https://host?tenant=x", "/admin/metrics")).toThrow();
    expect(() => resolveAdminUrl("https://host/prefix", "/admin/metrics")).toThrow();
    expect(() => resolveAdminUrl("https://host#a", "/admin/metrics")).toThrow();
  });

  test("http と https 以外の宛先は拒む", () => {
    expect(() => resolveAdminUrl("file:///etc/passwd", "/admin/metrics")).toThrow();
  });

  test("URL として読めない宛先は拒む", () => {
    expect(() => resolveAdminUrl("localhost:3000", "/admin/metrics")).toThrow();
  });

  test("宛先の外を指すパスは拒む", () => {
    // new URL(path, base) は絶対 URL や //host を渡すと base を捨てるため、
    // 署名付きの要求が別ホストへ飛び、5 分以内なら本来の宛先へ再利用できる
    for (const path of [
      "https://attacker.example/admin/metrics",
      "//attacker.example/admin/metrics",
      String.raw`\\attacker.example\admin\metrics`,
      "http://localhost:3001/admin/metrics",
    ]) {
      expect(() => resolveAdminUrl("http://localhost:3000", path)).toThrow();
    }
  });

  test("path にクエリやフラグメントを書くのは拒む", () => {
    // 通してしまうと、第 2 引数のクエリが path 側のものを黙って上書きする
    expect(() =>
      resolveAdminUrl("http://localhost:3000", "/admin/observations?errors=1"),
    ).toThrow();
    expect(() => resolveAdminUrl("http://localhost:3000", "/admin/metrics#a")).toThrow();
  });

  test("正規化の結果 /admin/ の外へ出るパスは拒む", () => {
    expect(() => resolveAdminUrl("http://localhost:3000", "/admin/../health")).toThrow();
    expect(() => resolveAdminUrl("http://localhost:3000", "/admin/../..//evil")).toThrow();
    expect(() => resolveAdminUrl("http://localhost:3000", "/health")).toThrow();
  });
});

describe("CLI の admin サブコマンド", () => {
  const ok = { status: 200, body: '{"uptime":1}' };

  test("200 は本文だけを標準出力へ流す", async () => {
    const result = await runAdminCommand(
      { path: "/admin/metrics", env: { ADMIN_API_SECRET: "s" } },
      async () => ok,
    );

    expect(result).toEqual({ stdout: '{"uptime":1}', stderr: null, exitCode: 0 });
  });

  test("200 以外は状態と本文を標準エラーへ回して非ゼロで終わる", async () => {
    const result = await runAdminCommand(
      { path: "/admin/metrics", env: { ADMIN_API_SECRET: "s" } },
      async () => ({ status: 401, body: '{"error":"Signature mismatch"}' }),
    );

    expect(result.stdout).toBeNull();
    expect(result.stderr).toContain("HTTP 401");
    expect(result.stderr).toContain("Signature mismatch");
    expect(result.exitCode).toBe(1);
  });

  test("鍵とパスが無ければ要求を出さずに終わる", async () => {
    const calls: unknown[] = [];
    const record = async (request: unknown): Promise<typeof ok> => {
      calls.push(request);
      return ok;
    };

    expect(
      (await runAdminCommand({ path: undefined, env: { ADMIN_API_SECRET: "s" } }, record)).exitCode,
    ).toBe(1);
    expect((await runAdminCommand({ path: "/admin/metrics", env: {} }, record)).exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  test("secret は環境変数の値をそのまま使う", async () => {
    const seen: string[] = [];
    await runAdminCommand(
      { path: "/admin/metrics", env: { ADMIN_API_SECRET: " padded " } },
      async (request) => {
        seen.push(request.secret);
        return ok;
      },
    );

    // CLI 側だけ前後空白を落とすと、同じ値を渡してもサーバ側と署名が食い違う
    expect(seen).toEqual([" padded "]);
  });

  test("宛先は ADMIN_BASE_URL、無ければ localhost", async () => {
    const seen: string[] = [];
    const record = async (request: { baseUrl: string }): Promise<typeof ok> => {
      seen.push(request.baseUrl);
      return ok;
    };

    await runAdminCommand({ path: "/admin/metrics", env: { ADMIN_API_SECRET: "s" } }, record);
    await runAdminCommand(
      { path: "/admin/metrics", env: { ADMIN_API_SECRET: "s", ADMIN_BASE_URL: "https://host" } },
      record,
    );

    expect(seen).toEqual(["http://localhost:3000", "https://host"]);
  });
});

describe("署名対象のクエリ正規化", () => {
  // 往復テストは両側が同じ関数を使うため、規則を壊しても同じ壊れ方をして通る。
  // 期待文字列を直に固定して、規則そのものを押さえる。
  test("key 昇順、同一 key 内は value 昇順に並べる", () => {
    expect(canonicalizeQuery(new URLSearchParams("limit=3&errors=1"))).toBe("errors=1&limit=3");
    expect(canonicalizeQuery(new URLSearchParams("k=b&k=a"))).toBe("k=a&k=b");
  });

  test("重複キーは落とさない", () => {
    expect(canonicalizeQuery(new URLSearchParams("k=a&k=a"))).toBe("k=a&k=a");
  });

  test("クエリが無ければ空文字", () => {
    expect(canonicalizeQuery(new URLSearchParams(""))).toBe("");
  });

  test("空の key と value を保つ", () => {
    expect(canonicalizeQuery(new URLSearchParams("a=&=b"))).toBe("=b&a=");
  });

  test("decode してから encodeURIComponent で入れ直す", () => {
    // + は空白として decode され、%20 へ入れ直る
    expect(canonicalizeQuery(new URLSearchParams("q=a+b"))).toBe("q=a%20b");
    expect(canonicalizeQuery(new URLSearchParams("q=a%20b"))).toBe("q=a%20b");
    // コロンは encodeURIComponent の対象なので %3A になる
    expect(canonicalizeQuery(new URLSearchParams("since=2026-09-05T00:00:00Z"))).toBe(
      "since=2026-09-05T00%3A00%3A00Z",
    );
  });

  test("非 ASCII を percent-encoding する", () => {
    expect(canonicalizeQuery(new URLSearchParams("q=日本語"))).toBe(
      "q=%E6%97%A5%E6%9C%AC%E8%AA%9E",
    );
  });
});
