import { describe, expect, test } from "bun:test";

import { ActivityType } from "discord.js";

import packageJson from "../package.json";
import { createBotClient } from "../src/bot/client";

describe("Discord クライアントの初期設定", () => {
  test("再 IDENTIFY でも復元されるようにバージョン表示を ClientOptions に持たせる", () => {
    const client = createBotClient();

    expect(client.options.presence?.activities).toEqual([
      { name: `v${packageJson.version}`, type: ActivityType.Watching },
    ]);
  });
});
