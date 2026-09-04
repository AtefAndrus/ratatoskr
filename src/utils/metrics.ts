import { statSync } from "node:fs";

export interface MetricsSnapshot {
  uptime: number;
  memory: { rss: number; heapUsed: number };
  discord: { ping: number | null };
  counters: Record<string, number>;
  dbBytes: number;
}

interface MetricsContext {
  client?: { ws: { ping: number } };
  databasePath?: string;
}

class Metrics {
  private readonly cumulative = new Map<string, number>();
  private startedAtMs = Date.now();
  private context: MetricsContext = {};

  attach(context: MetricsContext): void {
    this.context = { ...this.context, ...context };
  }

  reset(): void {
    this.cumulative.clear();
    this.startedAtMs = Date.now();
    this.context = {};
  }

  increment(name: string, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return;
    this.cumulative.set(name, (this.cumulative.get(name) ?? 0) + by);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of [...this.cumulative].toSorted(([a], [b]) => a.localeCompare(b))) {
      counters[key] = value;
    }
    const memory = process.memoryUsage();
    const pingRaw = this.context.client?.ws.ping;
    const ping =
      typeof pingRaw === "number" && Number.isFinite(pingRaw) && pingRaw >= 0 ? pingRaw : null;
    return {
      uptime: Math.floor((Date.now() - this.startedAtMs) / 1000),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
      discord: { ping },
      counters,
      dbBytes: this.computeDbBytes(),
    };
  }

  private computeDbBytes(): number {
    const path = this.context.databasePath;
    if (!path) return 0;
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += statSync(path + suffix).size;
      } catch {
        // 不在ファイルは 0 として扱う
      }
    }
    return total;
  }
}

export const metrics = new Metrics();
