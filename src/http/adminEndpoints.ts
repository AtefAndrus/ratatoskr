import type { DeliveryRepository, DeliveryStatus } from "../db/repositories/deliveries";
import type { ExchangeRepository } from "../db/repositories/exchanges";
import type { InternalGraphqlRepository } from "../db/repositories/internalGraphql";
import type { MaintenanceRepository } from "../db/repositories/maintenance";
import type { NotificationRepository } from "../db/repositories/notifications";
import type { ReceiverRepository } from "../db/repositories/receivers";
import type { RouteRepository } from "../db/repositories/routes";
import type { TargetRepository } from "../db/repositories/targets";
import type { ReceiverStatus } from "../services/receiverSupervisor";
import { getRecentLogs, type LogLevel } from "../utils/logger";
import { metrics } from "../utils/metrics";
import { verifyAdminRequest } from "./adminAuth";

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const VALID_STATUSES: ReadonlySet<string> = new Set(["sent", "failed", "skipped_duplicate"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1_000;
const MAX_LOG_LINES = 5_000;

export interface AdminEndpointDependencies {
  adminApiSecret: string | undefined;
  receivers: ReceiverRepository;
  targets: TargetRepository;
  routes: RouteRepository;
  notifications: NotificationRepository;
  deliveries: DeliveryRepository;
  observations: InternalGraphqlRepository;
  exchanges: ExchangeRepository;
  maintenance: MaintenanceRepository;
  receiverStatuses: () => ReceiverStatus[];
}

type Handler = (url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

function readLimit(url: URL): number | Response {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    return jsonError(400, "Invalid limit");
  return value;
}

function readId(url: URL, prefix: string): number | null {
  const rest = url.pathname.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  const value = Number(rest);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * HMAC 認証付きの読み取り専用 API。運用データを外から確認し、X 側の仕様変更を調査するための窓口。
 * 認証方式は disqord の /admin/* と同じ (X-Admin-Timestamp / X-Admin-Signature)。
 */
export function createAdminRouter(
  deps: AdminEndpointDependencies,
): (req: Request) => Promise<Response> {
  const handlers: Array<{ match: (pathname: string) => boolean; handle: Handler }> = [
    {
      match: (pathname) => pathname === "/admin/metrics",
      handle: () =>
        json({
          ...metrics.snapshot(),
          receivers: deps.receiverStatuses(),
          tables: deps.maintenance.tableCounts(),
        }),
    },
    {
      match: (pathname) => pathname === "/admin/logs",
      handle: (url) => {
        const levelRaw = url.searchParams.get("level");
        if (levelRaw !== null && !VALID_LEVELS.has(levelRaw))
          return jsonError(400, "Invalid level");
        const linesRaw = url.searchParams.get("lines");
        let lines = 200;
        if (linesRaw !== null) {
          lines = Number(linesRaw);
          if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES)
            return jsonError(400, "Invalid lines");
        }
        const sinceRaw = url.searchParams.get("since");
        let since: Date | undefined;
        if (sinceRaw !== null) {
          const ms = Date.parse(sinceRaw);
          if (Number.isNaN(ms)) return jsonError(400, "Invalid since");
          since = new Date(ms);
        }
        const recent = getRecentLogs({
          level: (levelRaw as LogLevel | null) ?? undefined,
          lines,
          since,
        });
        return new Response(recent.length > 0 ? `${recent.join("\n")}\n` : "", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    },
    {
      match: (pathname) => pathname === "/admin/receivers",
      handle: () =>
        json({ receivers: deps.receivers.listSummaries(), status: deps.receiverStatuses() }),
    },
    {
      match: (pathname) => pathname === "/admin/targets",
      handle: () => json({ targets: deps.targets.listAll(), routes: deps.routes.listAll() }),
    },
    {
      match: (pathname) => pathname === "/admin/notifications",
      handle: (url) => {
        const limit = readLimit(url);
        if (limit instanceof Response) return limit;
        const kind = url.searchParams.get("kind") ?? undefined;
        return json({ notifications: deps.notifications.listRecent(limit, kind) });
      },
    },
    {
      match: (pathname) => pathname === "/admin/deliveries",
      handle: (url) => {
        const limit = readLimit(url);
        if (limit instanceof Response) return limit;
        const status = url.searchParams.get("status");
        if (status !== null && !VALID_STATUSES.has(status)) return jsonError(400, "Invalid status");
        return json({
          deliveries: deps.deliveries.listRecent(
            limit,
            (status as DeliveryStatus | null) ?? undefined,
          ),
        });
      },
    },
    {
      match: (pathname) => pathname === "/admin/observations",
      handle: (url) => {
        const limit = readLimit(url);
        if (limit instanceof Response) return limit;
        return json({
          observations: deps.observations.listRecent(limit, {
            targetHandle: url.searchParams.get("target") ?? undefined,
            errorsOnly: url.searchParams.get("errors") === "1",
          }),
        });
      },
    },
    {
      match: (pathname) => pathname.startsWith("/admin/observations/"),
      handle: (url) => {
        const id = readId(url, "/admin/observations/");
        if (id === null) return jsonError(400, "Invalid observation id");
        const observation = deps.observations.getResponseText(id);
        if (observation === null) return jsonError(404, "Observation not found");
        return json({ ...observation, posts: deps.observations.listPostsForObservation(id) });
      },
    },
    {
      match: (pathname) => pathname === "/admin/exchanges",
      handle: (url) => {
        const limit = readLimit(url);
        if (limit instanceof Response) return limit;
        return json({
          exchanges: deps.exchanges.listRecent(limit, url.searchParams.get("source") ?? undefined),
        });
      },
    },
  ];

  return async function handleAdminRequest(req: Request): Promise<Response> {
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { Allow: "GET", "Content-Type": "application/json" },
      });
    }
    const auth = await verifyAdminRequest(req, deps.adminApiSecret);
    if (!auth.ok) return jsonError(auth.status, auth.reason);
    const url = new URL(req.url);
    const handler = handlers.find((candidate) => candidate.match(url.pathname));
    if (handler === undefined) return jsonError(404, "Not Found");
    return await handler.handle(url);
  };
}
