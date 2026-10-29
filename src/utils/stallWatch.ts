import { logger } from "./logger";

const CHECK_INTERVAL_MS = 250;
const STALL_THRESHOLD_MS = 1_000;
const ACTIVITY_CAPACITY = 32;

interface Activity {
  label: string;
  atMs: number;
  at: number;
}

const activities: Activity[] = [];

/**
 * 同期で重くなりうる処理の手前で呼ぶ。bun:sqlite は同期で動くので、イベントループが止まったとき、
 * 止まっていた区間に記録した処理と記録どうしの間隔から、どこで時間がかかったかを推定する。
 */
export function noteActivity(label: string): void {
  activities.push({ label, atMs: performance.now(), at: Date.now() });
  if (activities.length > ACTIVITY_CAPACITY) activities.shift();
}

/**
 * タイマーの遅れでイベントループの停止を検出し、長さと、止まる直前からの記録をログに出す。
 * 停止中は HTTP にも応答できず、/health を見るヘルスチェックが期限切れで落ちる。
 * 停止の後でしか検出できないので、止めた処理そのものはログの時刻と記録から推定する。
 * 時計の補正で誤検出しないよう、遅れは単調な performance.now() で測る。
 */
export function startStallWatch(signal: AbortSignal): void {
  if (signal.aborted) return;
  let lastTickMs = performance.now();
  const timer = setInterval(() => {
    const nowMs = performance.now();
    const stalledMs = Math.round(nowMs - lastTickMs - CHECK_INTERVAL_MS);
    if (stalledMs >= STALL_THRESHOLD_MS) {
      logger.warn("Event loop stalled", {
        stalledMs,
        lastTickAt: new Date(Date.now() - (nowMs - lastTickMs)).toISOString(),
        activities: activities
          .filter((activity) => activity.atMs >= lastTickMs)
          .map((activity) => ({ label: activity.label, at: new Date(activity.at).toISOString() })),
        lastActivityBefore: (() => {
          const before = activities.findLast((activity) => activity.atMs < lastTickMs);
          return before === undefined
            ? null
            : { label: before.label, at: new Date(before.at).toISOString() };
        })(),
      });
    }
    lastTickMs = nowMs;
  }, CHECK_INTERVAL_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
