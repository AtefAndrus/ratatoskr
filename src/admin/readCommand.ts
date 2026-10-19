import { Database } from "bun:sqlite";

import { loadConfig } from "../config";
import { BacklogRepository } from "../db/repositories/backlog";
import { DeliveryRepository } from "../db/repositories/deliveries";
import { ExchangeRepository } from "../db/repositories/exchanges";
import { InternalGraphqlRepository } from "../db/repositories/internalGraphql";
import { MaintenanceRepository } from "../db/repositories/maintenance";
import { NotificationRepository } from "../db/repositories/notifications";
import { ReceiverRepository } from "../db/repositories/receivers";
import { RouteRepository } from "../db/repositories/routes";
import { TargetRepository } from "../db/repositories/targets";
import { adminReadRequestSchema, executeAdminRead } from "../http/adminReads";
import { logger } from "../utils/logger";

try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  const request = adminReadRequestSchema.parse(input);
  const config = loadConfig();
  const db = new Database(config.databasePath, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const result = executeAdminRead(
      {
        receivers: new ReceiverRepository(db, config.xWebBearerToken),
        targets: new TargetRepository(db),
        routes: new RouteRepository(db),
        notifications: new NotificationRepository(db),
        deliveries: new DeliveryRepository(db),
        backlog: new BacklogRepository(db),
        observations: new InternalGraphqlRepository(db),
        exchanges: new ExchangeRepository(db),
        maintenance: new MaintenanceRepository(db),
      },
      request,
    );
    await Bun.write(Bun.stdout, `${result.status}\n${result.body}`);
  } finally {
    db.close();
  }
} catch (error) {
  logger.error("Admin database read failed", { error });
  process.exitCode = 1;
}
