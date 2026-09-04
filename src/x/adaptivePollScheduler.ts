export type PollOutcome = "items" | "empty" | "error" | "rate_limited";

export interface RateLimitSnapshot {
  remaining: number;
  resetAtMs: number;
}

export interface PollCompletion {
  outcome: PollOutcome;
  rateLimit?: RateLimitSnapshot;
}

export interface ScheduledPoll {
  target: string;
  scheduledAtMs: number;
  waitMs: number;
}

export interface PollTargetSnapshot {
  target: string;
  nextDueAtMs: number;
  quietStreak: number;
  failureStreak: number;
}

export interface AdaptivePollSchedulerOptions {
  activeIntervalMs?: number;
  quietIntervalsMs?: readonly number[];
  errorIntervalsMs?: readonly number[];
  minimumRequestSpacingMs?: number;
  rateLimitReserve?: number;
  rateLimitFallbackMs?: number;
  intervalJitterRatio?: number;
  resetJitterMs?: number;
  random?: () => number;
}

interface TargetState extends PollTargetSnapshot {
  order: number;
}

const DEFAULT_OPTIONS = {
  activeIntervalMs: 60_000,
  quietIntervalsMs: [90_000, 120_000, 180_000] as readonly number[],
  errorIntervalsMs: [30_000, 60_000, 120_000, 300_000] as readonly number[],
  minimumRequestSpacingMs: 3_000,
  rateLimitReserve: 100,
  rateLimitFallbackMs: 15 * 60_000,
  intervalJitterRatio: 0.1,
  resetJitterMs: 5_000,
};

export class AdaptivePollScheduler {
  private readonly targets = new Map<string, TargetState>();
  private readonly options: typeof DEFAULT_OPTIONS & { random: () => number };
  private nextOrder = 0;
  private nextRequestAtMs = 0;
  private rateLimitBlockedUntilMs = 0;
  private requestSpacingMs: number;

  constructor(
    targets: readonly string[],
    startedAtMs = Date.now(),
    options: AdaptivePollSchedulerOptions = {},
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      quietIntervalsMs: options.quietIntervalsMs ?? DEFAULT_OPTIONS.quietIntervalsMs,
      errorIntervalsMs: options.errorIntervalsMs ?? DEFAULT_OPTIONS.errorIntervalsMs,
      random: options.random ?? Math.random,
    };
    validateOptions(this.options);
    this.requestSpacingMs = this.options.minimumRequestSpacingMs;

    const normalizedTargets = [...new Set(targets.map(normalizeTarget))];
    const roundMs = Math.max(
      this.options.activeIntervalMs,
      normalizedTargets.length * this.options.minimumRequestSpacingMs,
    );
    const initialSpacingMs =
      normalizedTargets.length === 0 ? 0 : roundMs / normalizedTargets.length;
    normalizedTargets.forEach((target, index) => {
      this.targets.set(target, {
        target,
        nextDueAtMs: startedAtMs + Math.floor(index * initialSpacingMs),
        quietStreak: 0,
        failureStreak: 0,
        order: this.nextOrder++,
      });
    });
  }

  addTarget(target: string, nowMs = Date.now()): void {
    const normalized = normalizeTarget(target);
    if (this.targets.has(normalized)) return;
    this.targets.set(normalized, {
      target: normalized,
      nextDueAtMs: Math.max(nowMs, this.nextRequestAtMs),
      quietStreak: 0,
      failureStreak: 0,
      order: this.nextOrder++,
    });
  }

  removeTarget(target: string): boolean {
    return this.targets.delete(normalizeTarget(target));
  }

  next(nowMs = Date.now()): ScheduledPoll | null {
    const state = [...this.targets.values()].toSorted(
      (left, right) => left.nextDueAtMs - right.nextDueAtMs || left.order - right.order,
    )[0];
    if (state === undefined) return null;
    const scheduledAtMs = Math.max(
      state.nextDueAtMs,
      this.nextRequestAtMs,
      this.rateLimitBlockedUntilMs,
    );
    return {
      target: state.target,
      scheduledAtMs,
      waitMs: Math.max(0, scheduledAtMs - nowMs),
    };
  }

  complete(target: string, completion: PollCompletion, completedAtMs = Date.now()): void {
    const normalized = normalizeTarget(target);
    const state = this.targets.get(normalized);
    if (state === undefined) throw new Error(`未登録の監視対象です: ${normalized}`);

    if (completion.rateLimit !== undefined) {
      this.applyRateLimit(completion.rateLimit, completedAtMs);
    }
    this.nextRequestAtMs = Math.max(this.nextRequestAtMs, completedAtMs + this.requestSpacingMs);

    switch (completion.outcome) {
      case "items":
        state.quietStreak = 0;
        state.failureStreak = 0;
        state.nextDueAtMs = completedAtMs + this.jitter(this.options.activeIntervalMs);
        break;
      case "empty":
        state.quietStreak += 1;
        state.failureStreak = 0;
        state.nextDueAtMs =
          completedAtMs +
          this.jitter(pickInterval(this.options.quietIntervalsMs, state.quietStreak - 1));
        break;
      case "error":
        state.failureStreak += 1;
        state.nextDueAtMs =
          completedAtMs +
          this.jitter(pickInterval(this.options.errorIntervalsMs, state.failureStreak - 1));
        break;
      case "rate_limited": {
        if (completion.rateLimit === undefined || this.rateLimitBlockedUntilMs <= completedAtMs) {
          const fallback = completedAtMs + this.options.rateLimitFallbackMs + this.resetJitter();
          this.rateLimitBlockedUntilMs = Math.max(this.rateLimitBlockedUntilMs, fallback);
        }
        state.failureStreak += 1;
        state.nextDueAtMs = this.rateLimitBlockedUntilMs;
        break;
      }
    }
  }

  snapshot(): PollTargetSnapshot[] {
    return [...this.targets.values()]
      .toSorted((left, right) => left.order - right.order)
      .map(({ order: _order, ...state }) => ({ ...state }));
  }

  private applyRateLimit(snapshot: RateLimitSnapshot, nowMs: number): void {
    if (!Number.isInteger(snapshot.remaining) || snapshot.remaining < 0) {
      throw new Error("rate limit remainingは0以上の整数である必要があります");
    }
    if (!Number.isFinite(snapshot.resetAtMs)) {
      throw new Error("rate limit resetAtMsは有限値である必要があります");
    }
    if (snapshot.resetAtMs <= nowMs) {
      this.requestSpacingMs = this.options.minimumRequestSpacingMs;
      return;
    }
    if (snapshot.remaining <= this.options.rateLimitReserve) {
      this.rateLimitBlockedUntilMs = Math.max(
        this.rateLimitBlockedUntilMs,
        snapshot.resetAtMs + this.resetJitter(),
      );
      return;
    }
    const spendableRequests = snapshot.remaining - this.options.rateLimitReserve;
    this.requestSpacingMs = Math.max(
      this.options.minimumRequestSpacingMs,
      Math.ceil((snapshot.resetAtMs - nowMs) / spendableRequests),
    );
  }

  private jitter(intervalMs: number): number {
    const offset = (this.options.random() * 2 - 1) * this.options.intervalJitterRatio;
    return Math.max(1, Math.round(intervalMs * (1 + offset)));
  }

  private resetJitter(): number {
    return Math.floor(this.options.random() * this.options.resetJitterMs);
  }
}

function pickInterval(intervals: readonly number[], index: number): number {
  return intervals[Math.min(index, intervals.length - 1)]!;
}

function normalizeTarget(value: string): string {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalized)) {
    throw new Error(`不正なXアカウント名です: ${value}`);
  }
  return normalized;
}

function validateOptions(options: typeof DEFAULT_OPTIONS & { random: () => number }): void {
  const positiveValues = [
    options.activeIntervalMs,
    options.minimumRequestSpacingMs,
    options.rateLimitFallbackMs,
    ...options.quietIntervalsMs,
    ...options.errorIntervalsMs,
  ];
  if (options.quietIntervalsMs.length === 0 || options.errorIntervalsMs.length === 0) {
    throw new Error("ポーリング間隔の配列は空にできません");
  }
  if (positiveValues.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("ポーリング間隔は正の有限値である必要があります");
  }
  if (!Number.isInteger(options.rateLimitReserve) || options.rateLimitReserve < 0) {
    throw new Error("rateLimitReserveは0以上の整数である必要があります");
  }
  if (options.intervalJitterRatio < 0 || options.intervalJitterRatio >= 1) {
    throw new Error("intervalJitterRatioは0以上1未満である必要があります");
  }
  if (!Number.isFinite(options.resetJitterMs) || options.resetJitterMs < 0) {
    throw new Error("resetJitterMsは0以上の有限値である必要があります");
  }
}
