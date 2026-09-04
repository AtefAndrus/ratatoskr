import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertEnvValue } from "../src/utils/envFile";

describe("upsertEnvValue", () => {
  test("既存行を残したまま変数を追加・更新し、権限 0600 で保存する", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ratatoskr-env-")), ".env.local");
    await upsertEnvValue(file, "DISCORD_TOKEN", "first");
    await upsertEnvValue(file, "DISCORD_APPLICATION_ID", "123");
    await upsertEnvValue(file, "DISCORD_TOKEN", "second value");

    expect(readFileSync(file, "utf8")).toBe(
      'DISCORD_TOKEN="second value"\nDISCORD_APPLICATION_ID=123\n',
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(upsertEnvValue(file, "bad-name", "x")).rejects.toThrow("環境変数名が不正です");
    await expect(upsertEnvValue(file, "X", "a\nb")).rejects.toThrow("改行");
  });
});
