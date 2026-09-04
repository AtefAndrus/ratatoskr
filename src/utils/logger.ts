export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const RING_CAPACITY = 5_000;
const LINE_REGEX = /^\[([^\]]+)\] \[([A-Z]+)\]/;

export interface RecentLogsOptions {
  level?: LogLevel;
  lines?: number;
  since?: Date;
}

// 直近のログ行はメモリ上のリングバッファに保持し、/admin/logs から読めるようにする。
// ファイルへは書かない。永続ログは Coolify (docker logs) 側に任せる。
const ring: string[] = [];

function serializeMeta(meta: unknown): string {
  if (meta === undefined) return "";
  try {
    return ` ${JSON.stringify(meta, replaceErrors)}`;
  } catch {
    return " [unserializable meta]";
  }
}

function replaceErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${serializeMeta(meta)}`;
  console[level](line);
  ring.push(line);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
}

export const logger = {
  debug: (message: string, meta?: unknown): void => log("debug", message, meta),
  info: (message: string, meta?: unknown): void => log("info", message, meta),
  warn: (message: string, meta?: unknown): void => log("warn", message, meta),
  error: (message: string, meta?: unknown): void => log("error", message, meta),
};

export function getRecentLogs(options: RecentLogsOptions = {}): string[] {
  const minimumRank = options.level === undefined ? 0 : LEVEL_RANK[options.level];
  const sinceMs = options.since?.getTime();
  const filtered = ring.filter((line) => {
    const match = LINE_REGEX.exec(line);
    if (match === null) return false;
    const rank = LEVEL_RANK[match[2]!.toLowerCase() as LogLevel] ?? 0;
    if (rank < minimumRank) return false;
    if (sinceMs !== undefined && new Date(match[1]!).getTime() < sinceMs) return false;
    return true;
  });
  const lines = options.lines ?? 200;
  return filtered.slice(-lines);
}

export function clearRecentLogs(): void {
  ring.length = 0;
}
