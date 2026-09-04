import type { Client } from "discord.js";

import type { ReceiverStatus } from "../services/receiverSupervisor";
import { logger } from "../utils/logger";

export interface HealthStatus {
  status: "ok" | "unhealthy";
  discord: { connected: boolean; ping: number | null };
  receivers: Array<Pick<ReceiverStatus, "label" | "autopushConnected" | "lastNotificationAt">>;
  uptime: number;
}

export interface HttpServerOptions {
  client: Client;
  port: number;
  receiverStatuses: () => ReceiverStatus[];
  adminRouter: (req: Request) => Promise<Response>;
}

/**
 * /health は Discord 接続だけで判定する。AutoPush の再接続はプロセス内で完結するため、
 * その最中にコンテナを再起動しても回復が早まらない。受信状態は本文に載せて観測できるようにする。
 */
export function startHttpServer(options: HttpServerOptions): ReturnType<typeof Bun.serve> {
  const startedAt = Date.now();
  const server = Bun.serve({
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const connected = options.client.isReady();
        const ping = options.client.ws.ping;
        const body: HealthStatus = {
          status: connected ? "ok" : "unhealthy",
          discord: { connected, ping: ping >= 0 ? ping : null },
          receivers: options.receiverStatuses().map((status) => ({
            label: status.label,
            autopushConnected: status.autopushConnected,
            lastNotificationAt: status.lastNotificationAt,
          })),
          uptime: Math.floor((Date.now() - startedAt) / 1000),
        };
        return new Response(JSON.stringify(body), {
          status: connected ? 200 : 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/admin/")) {
        return await options.adminRouter(req);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  logger.info("HTTP server started", { port: options.port });
  return server;
}
