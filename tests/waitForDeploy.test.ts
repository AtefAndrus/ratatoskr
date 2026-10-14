import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/wait-for-deploy.sh", import.meta.url).pathname;
// PATH を差し替えるテストでも bash を起動できるように、絶対パスで持つ
const BASH = Bun.which("bash") ?? "/bin/bash";

/** デプロイ直前に /health から読んだサーバーの時刻。 */
const BASELINE = "2026-10-13T00:30:00.000Z";
const OLD = { version: "1.2.2", startedAt: "2026-10-13T00:00:00.000Z" };
const NEW = { version: "1.2.3", startedAt: "2026-10-13T01:00:00.000Z" };

type Reply = (
  | { version: string; startedAt?: string; status?: number }
  | { raw: string; status?: number }
) & { delayMs?: number };

/** 呼ばれるたびに `next(呼び出し回数)` が返す内容を /health として返す。 */
async function withHealthServer<T>(
  next: (call: number) => Reply,
  run: (url: string) => Promise<T>,
): Promise<T> {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      const reply = next(calls);
      if (reply.delayMs !== undefined) await Bun.sleep(reply.delayMs);
      const status = reply.status ?? 200;
      if ("raw" in reply) return new Response(reply.raw, { status });
      return Response.json(
        { status: status === 200 ? "ok" : "unhealthy", ...reply, uptime: 10, now: BASELINE },
        { status },
      );
    },
  });
  try {
    return await run(`http://127.0.0.1:${server.port}/health`);
  } finally {
    await server.stop(true);
  }
}

async function runScript(
  args: string[],
  timing: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; output: string }> {
  const child = Bun.spawn([BASH, SCRIPT, ...args], {
    env: {
      ...process.env,
      TIMEOUT_SECONDS: "8",
      STABLE_SECONDS: "3",
      INTERVAL_SECONDS: "1",
      ...timing,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, output: stdout + stderr };
}

async function waitForDeploy(
  url: string,
  version: string,
  baseline: string,
  timing: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  return await runScript([url, version, baseline], timing);
}

describe("wait-for-deploy.sh", () => {
  test("新しい版のプロセスだけが正常に応答し続ければ成功する", async () => {
    const result = await withHealthServer(
      () => NEW,
      async (url) => await waitForDeploy(url, NEW.version, BASELINE),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("デプロイは完了した");
  }, 15_000);

  test("新しい版が一度現れても旧プロセスへ戻されたら失敗する", async () => {
    const result = await withHealthServer(
      (call) => (call <= 2 ? NEW : OLD),
      async (url) => await waitForDeploy(url, NEW.version, BASELINE),
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("v1.2.2");
  }, 15_000);

  test("同じ版でも、デプロイ前に起動していたプロセスなら成功としない", async () => {
    const result = await withHealthServer(
      () => OLD,
      async (url) => await waitForDeploy(url, OLD.version, BASELINE),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("同じ版の出し直しでも、デプロイ後に起動したプロセスなら成功する", async () => {
    const result = await withHealthServer(
      () => ({ ...NEW, version: OLD.version }),
      async (url) => await waitForDeploy(url, OLD.version, BASELINE),
    );
    expect(result.exitCode).toBe(0);
  }, 15_000);

  test("前のデプロイの候補が応答している間に記録しても、ロールバックで残った元のプロセスを成功としない", async () => {
    // 前のデプロイで起動した同じ版の候補。元のプロセスと重なって応答している
    const candidate = { version: OLD.version, startedAt: "2026-10-13T00:20:00.000Z" };
    const result = await withHealthServer(
      (call) => (call === 1 ? candidate : OLD),
      async (url) => {
        const snapshot = await runScript(["--snapshot", url]);
        return await waitForDeploy(url, OLD.version, snapshot.stdout.trim());
      },
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("起動時刻の形式が違う応答は新しいプロセスとしない", async () => {
    const result = await withHealthServer(
      () => ({ ...NEW, startedAt: "later" }),
      async (url) => await waitForDeploy(url, NEW.version, BASELINE),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("デプロイ前の版が時刻を返さなかったときは、起動時刻を返すプロセスを新しいとみなす", async () => {
    const result = await withHealthServer(
      (call) => (call <= 2 ? { version: NEW.version } : NEW),
      async (url) => await waitForDeploy(url, NEW.version, ""),
    );
    expect(result.exitCode).toBe(0);

    const legacy = await withHealthServer(
      () => ({ version: NEW.version }),
      async (url) => await waitForDeploy(url, NEW.version, ""),
    );
    expect(legacy.exitCode).toBe(1);
  }, 30_000);

  test("新しいプロセスが 503 を返し続ける間は成功としない", async () => {
    const result = await withHealthServer(
      () => ({ ...NEW, status: 503 }),
      async (url) => await waitForDeploy(url, NEW.version, BASELINE),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("旧プロセスや読めない応答を挟むたびに待ち直す", async () => {
    const result = await withHealthServer(
      (call) => (call % 3 === 0 ? (call % 2 === 0 ? OLD : { raw: "<html>" }) : NEW),
      async (url) => await waitForDeploy(url, NEW.version, BASELINE),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("期限の後に届いた応答では成功としない", async () => {
    const result = await withHealthServer(
      (call) => (call === 1 ? NEW : { ...NEW, delayMs: 4_000 }),
      async (url) =>
        await waitForDeploy(url, NEW.version, BASELINE, {
          TIMEOUT_SECONDS: "3",
          STABLE_SECONDS: "1",
        }),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("デプロイ前のサーバーの時刻を記録し、読めなければ失敗する", async () => {
    const known = await withHealthServer(
      () => OLD,
      async (url) => await runScript(["--snapshot", url]),
    );
    expect(known).toMatchObject({ exitCode: 0, stdout: `${BASELINE}\n` });

    const legacy = await withHealthServer(
      () => ({ raw: JSON.stringify({ status: "ok", uptime: 1 }) }),
      async (url) => await runScript(["--snapshot", url]),
    );
    expect(legacy).toMatchObject({ exitCode: 0, stdout: "\n" });

    const unreadable = await withHealthServer(
      () => ({ raw: "<html>", status: 502 }),
      async (url) => await runScript(["--snapshot", url]),
    );
    expect(unreadable.exitCode).toBe(1);
  }, 15_000);

  test("jq が無ければすぐに失敗する", async () => {
    const bin = mkdtempSync(join(tmpdir(), "wait-for-deploy-"));
    try {
      symlinkSync(Bun.which("curl") ?? "/usr/bin/curl", join(bin, "curl"));
      const result = await runScript(["--snapshot", "http://127.0.0.1:9/health"], { PATH: bin });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("jq が見つからない");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
