import type { Database } from "bun:sqlite";

import { openDatabase } from "../../src/db";
import { DeliveryRepository } from "../../src/db/repositories/deliveries";
import { ExchangeRepository } from "../../src/db/repositories/exchanges";
import { GuildSettingsRepository } from "../../src/db/repositories/guildSettings";
import { InternalGraphqlRepository } from "../../src/db/repositories/internalGraphql";
import { MaintenanceRepository } from "../../src/db/repositories/maintenance";
import { NotificationRepository } from "../../src/db/repositories/notifications";
import { ReceiverRepository } from "../../src/db/repositories/receivers";
import { RouteRepository } from "../../src/db/repositories/routes";
import { TargetRepository } from "../../src/db/repositories/targets";
import type { DiscordPostSender } from "../../src/services/deliveryService";

export interface TestContext {
  db: Database;
  receivers: ReceiverRepository;
  targets: TargetRepository;
  routes: RouteRepository;
  notifications: NotificationRepository;
  deliveries: DeliveryRepository;
  observations: InternalGraphqlRepository;
  exchanges: ExchangeRepository;
  maintenance: MaintenanceRepository;
  guildSettings: GuildSettingsRepository;
}

export function createTestContext(): TestContext {
  const db = openDatabase(":memory:");
  return {
    db,
    receivers: new ReceiverRepository(db, "default-bearer"),
    targets: new TargetRepository(db),
    routes: new RouteRepository(db),
    notifications: new NotificationRepository(db),
    deliveries: new DeliveryRepository(db),
    observations: new InternalGraphqlRepository(db),
    exchanges: new ExchangeRepository(db),
    maintenance: new MaintenanceRepository(db),
    guildSettings: new GuildSettingsRepository(db),
  };
}

export function createRecordingSender(): DiscordPostSender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async sendPostUrl(channelId: string, postUrl: string): Promise<{ messageId: string }> {
      sent.push(`${channelId}:${postUrl}`);
      return { messageId: `message-${sent.length}` };
    },
  };
}

export function addReceiver(context: TestContext, label = "receiver-a"): number {
  return context.receivers.add(label, { authToken: "auth", csrfToken: "csrf" }).id;
}

export function addTarget(
  context: TestContext,
  input: { userId?: string; handle: string; displayName?: string } = { handle: "example" },
): number {
  return context.targets.upsert({
    userId: input.userId ?? `user-${input.handle}`,
    handle: input.handle,
    displayName: input.displayName ?? input.handle,
  }).id;
}
