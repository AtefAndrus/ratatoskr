import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { clearRecentLogs, getRecentLogs } from "../src/utils/logger";
import { noteActivity, startStallWatch } from "../src/utils/stallWatch";

function stallLines(): string[] {
  return getRecentLogs({ level: "warn" }).filter((line) => line.includes("Event loop stalled"));
}

function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // 同期の重い処理の代わりにイベントループを止める
  }
}

test("イベントループが止まると、長さと止まっていた区間に記録した処理をログに出す", async () => {
  clearRecentLogs();
  const controller = new AbortController();
  try {
    startStallWatch(controller.signal);
    noteActivity("before stall");
    await delay(300);
    expect(stallLines()).toEqual([]);

    noteActivity("first blocking step");
    block(700);
    noteActivity("second blocking step");
    block(800);
    await delay(300);

    const stalls = stallLines();
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toContain('"label":"first blocking step"');
    expect(stalls[0]).toContain('"label":"second blocking step"');
    expect(stalls[0]).toContain('"lastActivityBefore":{"label":"before stall"');
  } finally {
    controller.abort();
  }
});
