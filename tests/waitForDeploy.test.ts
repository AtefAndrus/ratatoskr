import { describe, expect, test } from "bun:test";

const SCRIPT = new URL("../scripts/wait-for-deploy.sh", import.meta.url).pathname;

const OLD = { version: "1.2.2", startedAt: "2026-10-13T00:00:00.000Z" };
const NEW = { version: "1.2.3", startedAt: "2026-10-13T01:00:00.000Z" };

type Reply = (
  | { version: string; startedAt: string; status?: number }
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
        { status: status === 200 ? "ok" : "unhealthy", ...reply, uptime: 10 },
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
  const child = Bun.spawn(["bash", SCRIPT, ...args], {
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
  previousStartedAt: string,
  timing: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  return await runScript([url, version, previousStartedAt], timing);
}

describe("wait-for-deploy.sh", () => {
  test("新しい版のプロセスだけが正常に応答し続ければ成功する", async () => {
    const result = await withHealthServer(
      () => NEW,
      async (url) => await waitForDeploy(url, NEW.version, OLD.startedAt),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("デプロイは完了した");
  }, 15_000);

  test("新しい版が一度現れても旧プロセスへ戻されたら失敗する", async () => {
    const result = await withHealthServer(
      (call) => (call <= 2 ? NEW : OLD),
      async (url) => await waitForDeploy(url, NEW.version, OLD.startedAt),
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("v1.2.2");
  }, 15_000);

  test("同じ版でも、デプロイ前に動いていたプロセスなら成功としない", async () => {
    const result = await withHealthServer(
      () => OLD,
      async (url) => await waitForDeploy(url, OLD.version, OLD.startedAt),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("新しいプロセスが 503 を返し続ける間は成功としない", async () => {
    const result = await withHealthServer(
      () => ({ ...NEW, status: 503 }),
      async (url) => await waitForDeploy(url, NEW.version, OLD.startedAt),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("旧プロセスや読めない応答を挟むたびに待ち直す", async () => {
    const result = await withHealthServer(
      (call) => (call % 3 === 0 ? (call % 2 === 0 ? OLD : { raw: "<html>" }) : NEW),
      async (url) => await waitForDeploy(url, NEW.version, OLD.startedAt),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("期限の後に届いた応答では成功としない", async () => {
    const result = await withHealthServer(
      (call) => (call === 1 ? NEW : { ...NEW, delayMs: 4_000 }),
      async (url) =>
        await waitForDeploy(url, NEW.version, OLD.startedAt, {
          TIMEOUT_SECONDS: "3",
          STABLE_SECONDS: "1",
        }),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);

  test("デプロイ前のプロセスの起動時刻を記録し、読めなければ失敗する", async () => {
    const known = await withHealthServer(
      () => OLD,
      async (url) => await runScript(["--snapshot", url]),
    );
    expect(known).toMatchObject({ exitCode: 0, stdout: `${OLD.startedAt}\n` });

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
});
