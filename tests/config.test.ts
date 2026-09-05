import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";
import { X_WEB_BEARER_TOKEN } from "../src/x/credentials";

describe("loadConfig", () => {
  test("必須値以外は既定値で埋める", () => {
    const config = loadConfig({ DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a" });
    expect(config).toMatchObject({
      nodeEnv: "development",
      databasePath: "data/ratatoskr.db",
      healthPort: 3000,
      adminApiSecret: undefined,
      internalPollEnabled: true,
      rawRetentionDays: 1,
      retentionDays: 30,
      xWebBearerToken: X_WEB_BEARER_TOKEN,
    });
  });

  test("真偽値と数値の文字列を解釈する", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "t",
      DISCORD_APPLICATION_ID: "a",
      INTERNAL_POLL_ENABLED: "off",
      RAW_RETENTION_DAYS: "7",
      HEALTH_PORT: "8080",
      ADMIN_API_SECRET: "",
    });
    expect(config.internalPollEnabled).toBe(false);
    expect(config.rawRetentionDays).toBe(7);
    expect(config.healthPort).toBe(8080);
    expect(config.adminApiSecret).toBeUndefined();
    expect(() =>
      loadConfig({
        DISCORD_TOKEN: "t",
        DISCORD_APPLICATION_ID: "a",
        INTERNAL_POLL_ENABLED: "maybe",
      }),
    ).toThrow();
    expect(() => loadConfig({ DISCORD_APPLICATION_ID: "a" })).toThrow();
  });
});
