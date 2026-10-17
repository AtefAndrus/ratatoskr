import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { clearRecentLogs, getRecentLogs } from "../src/utils/logger";
import { noteActivity, startStallWatch } from "../src/utils/stallWatch";

test("イベントループが止まると、長さと直前に記録した処理をログに出す", async () => {
  clearRecentLogs();
  const controller = new AbortController();
  try {
    startStallWatch(controller.signal);
    await delay(300);
    expect(getRecentLogs({ level: "warn" })).toEqual([]);

    noteActivity("blocking work");
    const until = Date.now() + 1_500;
    while (Date.now() < until) {
      // 同期の重い処理の代わりにイベントループを止める
    }
    await delay(300);

    const stalls = getRecentLogs({ level: "warn" }).filter((line) =>
      line.includes("Event loop stalled"),
    );
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toContain('"label":"blocking work"');
  } finally {
    controller.abort();
  }
});
