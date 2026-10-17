import { logger } from "./logger";

const CHECK_INTERVAL_MS = 250;
const STALL_THRESHOLD_MS = 1_000;

let lastActivity: { label: string; at: number } | null = null;

/**
 * 同期で重くなりうる処理の手前で呼ぶ。bun:sqlite は同期で動くので、イベントループが止まったとき、
 * 止まる直前に記録した処理がその原因の候補になる。
 */
export function noteActivity(label: string): void {
  lastActivity = { label, at: Date.now() };
}

/**
 * タイマーの遅れでイベントループの停止を検出し、長さと直前の処理をログに出す。
 * 停止中は HTTP にも応答できず、Coolify のヘルスチェックが 5 秒で落ちる。
 * 停止の後でしか検出できないので、止めた処理そのものはログの時刻と `lastActivity` から推定する。
 */
export function startStallWatch(signal: AbortSignal): void {
  let expectedAt = Date.now() + CHECK_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = Date.now();
    const stalledMs = now - expectedAt;
    if (stalledMs >= STALL_THRESHOLD_MS) {
      logger.warn("Event loop stalled", {
        stalledMs,
        from: new Date(expectedAt).toISOString(),
        lastActivity:
          lastActivity === null
            ? null
            : { label: lastActivity.label, at: new Date(lastActivity.at).toISOString() },
      });
    }
    expectedAt = now + CHECK_INTERVAL_MS;
  }, CHECK_INTERVAL_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
