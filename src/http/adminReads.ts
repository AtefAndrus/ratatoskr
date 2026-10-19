import { z } from "zod";

import type { BacklogRepository } from "../db/repositories/backlog";
import type { DeliveryRepository } from "../db/repositories/deliveries";
import type { ExchangeRepository } from "../db/repositories/exchanges";
import type { InternalGraphqlRepository } from "../db/repositories/internalGraphql";
import type { MaintenanceRepository } from "../db/repositories/maintenance";
import type { NotificationRepository } from "../db/repositories/notifications";
import type { ReceiverRepository } from "../db/repositories/receivers";
import type { RouteRepository } from "../db/repositories/routes";
import type { TargetRepository } from "../db/repositories/targets";
import { xSnowflakeTimestampMs } from "../services/deliveryService";

export interface AdminReadRepositories {
  receivers: ReceiverRepository;
  targets: TargetRepository;
  routes: RouteRepository;
  notifications: NotificationRepository;
  deliveries: DeliveryRepository;
  backlog: BacklogRepository;
  observations: InternalGraphqlRepository;
  exchanges: ExchangeRepository;
  maintenance: MaintenanceRepository;
}

const limitSchema = z.number().int().min(1).max(1_000);
export const adminReadRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("metrics") }),
  z.object({ op: z.literal("backlog") }),
  z.object({ op: z.literal("receivers") }),
  z.object({ op: z.literal("targets") }),
  z.object({ op: z.literal("notifications"), limit: limitSchema, kind: z.string().optional() }),
  z.object({
    op: z.literal("deliveries"),
    limit: limitSchema,
    status: z.enum(["sent", "failed", "skipped_duplicate"]).optional(),
  }),
  z.object({
    op: z.literal("observations"),
    limit: limitSchema,
    targetHandle: z.string().optional(),
    errorsOnly: z.boolean(),
  }),
  z.object({ op: z.literal("observation"), id: z.number().int().nonnegative() }),
  z.object({ op: z.literal("posts"), postId: z.string().regex(/^\d+$/), limit: limitSchema }),
  z.object({ op: z.literal("exchanges"), limit: limitSchema, source: z.string().optional() }),
]);

export type AdminReadRequest = z.infer<typeof adminReadRequestSchema>;

export interface AdminReadResponse {
  status: number;
  body: Uint8Array<ArrayBuffer> | string;
  headers: Record<string, string>;
}

function json(body: unknown, status = 200): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

export function executeAdminRead(
  repositories: AdminReadRepositories,
  request: AdminReadRequest,
): { status: number; body: string } {
  switch (request.op) {
    case "metrics":
      return json({
        tables: repositories.maintenance.tableCounts(),
        backlog: {
          queue: repositories.deliveries.queueCounts(),
          progress: repositories.backlog.list(),
        },
      });
    case "backlog":
      return json({
        queue: repositories.deliveries.queueCounts(),
        progress: repositories.backlog.list(),
      });
    case "receivers":
      return json({ receivers: repositories.receivers.listSummaries() });
    case "targets":
      return json({
        targets: repositories.targets.listAll(),
        routes: repositories.routes.listAll(),
      });
    case "notifications":
      return json({
        notifications: repositories.notifications.listRecent(request.limit, request.kind),
      });
    case "deliveries":
      return json({
        deliveries: repositories.deliveries.listRecent(request.limit, request.status),
      });
    case "observations":
      return json({
        observations: repositories.observations.listRecent(request.limit, {
          targetHandle: request.targetHandle,
          errorsOnly: request.errorsOnly,
        }),
      });
    case "observation": {
      const observation = repositories.observations.getResponseText(request.id);
      if (observation === null) return json({ error: "Observation not found" }, 404);
      return json({
        ...observation,
        posts: repositories.observations.listPostsForObservation(request.id),
      });
    }
    case "posts": {
      const { postId, limit } = request;
      const notifications = repositories.notifications.listByPostId(postId);
      const notifiedIds = [
        ...new Set([postId, ...notifications.flatMap((n) => n.notificationPostId ?? [])]),
      ];
      let queue = repositories.deliveries.listQueueByPostIds(notifiedIds);
      const postIds = [...new Set([...notifiedIds, ...queue.map((entry) => entry.postId)])];
      // 元投稿の URL を持たない移行済みの行もあるため、キューで見つけたリポスト ID でも引き直す。
      if (postIds.length > notifiedIds.length)
        queue = repositories.deliveries.listQueueByPostIds(postIds);
      return json({
        postId,
        postIds: postIds.map((id) => {
          const postedAt = new Date(xSnowflakeTimestampMs(id) ?? Number.NaN);
          return {
            postId: id,
            postedAt: Number.isNaN(postedAt.getTime()) ? null : postedAt.toISOString(),
          };
        }),
        notifications,
        observations: repositories.observations.listPostSightings(postIds, limit),
        // 関連する記録が保持期間で消えると投稿先を落とすため、投稿先では絞り込まない。
        routes: repositories.routes.listAll().map((route) => ({
          ...route,
          queue: queue
            .filter((entry) => entry.routeId === route.id)
            .map((entry) => ({
              ...entry,
              attempts: repositories.deliveries.listAttemptsForQueueEntry(
                entry,
                notifications
                  .filter((n) => (n.notificationPostId ?? n.postId) === entry.postId)
                  .map((n) => n.id),
              ),
            })),
        })),
      });
    }
    case "exchanges":
      return json({ exchanges: repositories.exchanges.listRecent(request.limit, request.source) });
  }
  throw new Error("Unsupported admin read operation");
}
