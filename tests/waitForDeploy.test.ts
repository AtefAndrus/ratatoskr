import { describe, expect, test } from "bun:test";

const SCRIPT = new URL("../scripts/wait-for-deploy.sh", import.meta.url).pathname;

interface Process {
  version: string;
  /** プロセスの起動時刻 (epoch 秒)。 */
  startedAt: number;
}

/** 呼ばれるたびに `current()` が返すプロセスの版と uptime を /health として返す。 */
async function withHealthServer<T>(
  current: () => Process,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const process = current();
      return Response.json({
        status: "ok",
        version: process.version,
        uptime: Math.floor(Date.now() / 1000) - process.startedAt,
      });
    },
  });
  try {
    return await run(`http://127.0.0.1:${server.port}/health`);
  } finally {
    await server.stop(true);
  }
}

async function waitForDeploy(
  url: string,
  version: string,
  triggeredAt: number,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bash", SCRIPT, url, version, String(triggeredAt)], {
    env: { ...process.env, TIMEOUT_SECONDS: "6", STABLE_SECONDS: "2", INTERVAL_SECONDS: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("wait-for-deploy.sh", () => {
  test("新しい版のプロセスが安定して動き続ければ成功する", async () => {
    const triggeredAt = nowSeconds();
    const result = await withHealthServer(
      () => ({ version: "1.2.3", startedAt: triggeredAt + 1 }),
      async (url) => await waitForDeploy(url, "1.2.3", triggeredAt),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("デプロイは完了した");
  }, 15_000);

  test("新しい版が一度現れても旧プロセスへ戻されたら失敗する", async () => {
    const triggeredAt = nowSeconds();
    const old = { version: "1.2.2", startedAt: triggeredAt - 3_600 };
    let calls = 0;
    const result = await withHealthServer(
      () => {
        calls += 1;
        return calls <= 2 ? { version: "1.2.3", startedAt: triggeredAt + 1 } : old;
      },
      async (url) => await waitForDeploy(url, "1.2.3", triggeredAt),
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("v1.2.2");
  }, 15_000);

  test("同じ版でもデプロイより前に起動したプロセスなら成功としない", async () => {
    const triggeredAt = nowSeconds();
    const result = await withHealthServer(
      () => ({ version: "1.2.3", startedAt: triggeredAt - 3_600 }),
      async (url) => await waitForDeploy(url, "1.2.3", triggeredAt),
    );
    expect(result.exitCode).toBe(1);
  }, 15_000);
});
