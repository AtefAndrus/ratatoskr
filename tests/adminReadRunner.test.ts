import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../src/db";
import { TargetRepository } from "../src/db/repositories/targets";
import { createChildProcessAdminReader } from "../src/http/adminReadRunner";
import { logger } from "../src/utils/logger";

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ratatoskr-admin-read-"));
  const databasePath = join(directory, "test.db");
  const previous = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID,
    NODE_ENV: process.env.NODE_ENV,
  };
  const db = openDatabase(databasePath);
  try {
    new TargetRepository(db).upsert({
      userId: "user-example",
      handle: "example",
      displayName: "Example",
    });
    process.env.DATABASE_PATH = databasePath;
    process.env.DISCORD_TOKEN = "unused";
    process.env.DISCORD_APPLICATION_ID = "unused";
    process.env.NODE_ENV = "development";
    await run();
  } finally {
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("child process admin reader", () => {
  test("実際の読み取り専用の子プロセスから監視対象の JSON を返す", async () => {
    await withDatabase(async () => {
      const result = await createChildProcessAdminReader()({ op: "targets" });
      expect(result.status).toBe(200);
      expect(result.body).toBeInstanceOf(Uint8Array);
      expect(result.headers["Content-Type"]).toBe("application/json");
      expect(await new Response(result.body).json()).toMatchObject({
        targets: [{ userId: "user-example", handle: "example", displayName: "Example" }],
        routes: [],
      });
    });
  });

  test("実際の子プロセスは存在しない観測に 404 を返す", async () => {
    await withDatabase(async () => {
      const result = await createChildProcessAdminReader()({ op: "observation", id: 999 });
      expect(result.status).toBe(404);
      expect(await new Response(result.body).json()).toEqual({ error: "Observation not found" });
    });
  });

  test("stdout の終端まで読み、本文を JSON としてパースせずに返す", async () => {
    const read = createChildProcessAdminReader({
      command: [
        process.execPath,
        "-e",
        `
        await Bun.stdin.text();
        await Bun.write(Bun.stdout, "200\\n  [");
        await Bun.sleep(50);
        await Bun.write(Bun.stdout, '"日本語" ]\\n');
      `,
      ],
    });
    const result = await read({ op: "targets" });
    expect(result.status).toBe(200);
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(await new Response(result.body).text()).toBe('  ["日本語" ]\n');
  });

  test("期限を超えた子プロセスを SIGKILL で終了させて 504 を返す", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ratatoskr-admin-deadline-"));
    const pidPath = join(directory, "pid");
    const finishedPath = join(directory, "finished");
    const read = createChildProcessAdminReader({
      command: [
        process.execPath,
        "-e",
        `
        await Bun.stdin.text();
        await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
        await Bun.write(Bun.stdout, "200\\n{}");
        await Bun.sleep(6000);
        await Bun.write(${JSON.stringify(finishedPath)}, "finished");
      `,
      ],
      // 子プロセスの起動と pid の書き込みが負荷の高い環境でも間に合うよう、期限に余裕を持たせる
      deadlineMs: 2_000,
    });
    const startedAt = performance.now();
    try {
      const result = await read({ op: "targets" });
      expect(result.status).toBe(504);
      expect(performance.now() - startedAt).toBeLessThan(4_000);
      expect(existsSync(finishedPath)).toBe(false);
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      const next = createChildProcessAdminReader({
        command: [process.execPath, "-e", 'console.log("200\\n{}")'],
      });
      expect((await next({ op: "targets" })).status).toBe(200);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("同時に来た 2 件目は待たずに 503 と Retry-After を返す", async () => {
    const read = createChildProcessAdminReader({
      command: [
        process.execPath,
        "-e",
        'await Bun.stdin.text(); await Bun.sleep(200); console.log("200\\n{}")',
      ],
    });
    const first = read({ op: "targets" });
    try {
      const second = await read({ op: "metrics" });
      expect(second.status).toBe(503);
      expect(second.headers["Retry-After"]).toBe("5");
      const anotherReader = createChildProcessAdminReader();
      expect((await anotherReader({ op: "backlog" })).status).toBe(503);
    } finally {
      expect((await first).status).toBe(200);
    }
    expect((await read({ op: "targets" })).status).toBe(200);
  });

  test("子プロセスの異常終了は 500 と stderr の末尾 2 KB を記録する", async () => {
    const log = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const read = createChildProcessAdminReader({
        command: [
          process.execPath,
          "-e",
          'await Bun.stdin.text(); console.log("200\\n{}"); console.error("x".repeat(3000) + "END"); process.exit(7)',
        ],
      });
      const result = await read({ op: "targets" });
      expect(result.status).toBe(500);
      expect(await new Response(result.body).json()).toEqual({
        error: "Admin database read failed",
      });
      expect(log).toHaveBeenCalledWith("Admin database reader failed", {
        exitCode: 7,
        stderr: `${"x".repeat(2044)}END\n`,
      });
    } finally {
      log.mockRestore();
    }
  });
});
