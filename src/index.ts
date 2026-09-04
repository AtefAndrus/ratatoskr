import { Events } from "discord.js";

import { createBotClient } from "./bot/client";
import { registerCommands } from "./bot/commands";
import { createInteractionCreateHandler } from "./bot/events/interactionCreate";
import { onReady } from "./bot/events/ready";
import { DiscordChannelPostSender } from "./bot/postSender";
import { loadConfigFromEnvFiles } from "./config";
import { openDatabase } from "./db";
import { DeliveryRepository } from "./db/repositories/deliveries";
import { ExchangeRepository } from "./db/repositories/exchanges";
import { GuildSettingsRepository } from "./db/repositories/guildSettings";
import { InternalGraphqlRepository } from "./db/repositories/internalGraphql";
import { MaintenanceRepository } from "./db/repositories/maintenance";
import { NotificationRepository } from "./db/repositories/notifications";
import { ReceiverRepository } from "./db/repositories/receivers";
import { RouteRepository } from "./db/repositories/routes";
import { TargetRepository } from "./db/repositories/targets";
import { createAdminRouter } from "./http/adminEndpoints";
import { startHttpServer } from "./http/server";
import { runRetentionLoop } from "./maintenance/retention";
import { DeliveryService } from "./services/deliveryService";
import { ReceiverSupervisor } from "./services/receiverSupervisor";
import { WatchService } from "./services/watchService";
import { logger } from "./utils/logger";
import { metrics } from "./utils/metrics";
import { InternalGraphqlConfigurationProvider } from "./x/internalGraphql";

async function bootstrap(): Promise<void> {
  const config = loadConfigFromEnvFiles();
  logger.info("Configuration loaded", {
    nodeEnv: config.nodeEnv,
    internalPollEnabled: config.internalPollEnabled,
  });

  const db = openDatabase(config.databasePath);
  metrics.attach({ databasePath: config.databasePath });
  const receivers = new ReceiverRepository(db, config.xWebBearerToken);
  const targets = new TargetRepository(db);
  const routes = new RouteRepository(db);
  const notifications = new NotificationRepository(db);
  const deliveries = new DeliveryRepository(db);
  const observations = new InternalGraphqlRepository(db);
  const exchanges = new ExchangeRepository(db);
  const maintenance = new MaintenanceRepository(db);
  const guildSettings = new GuildSettingsRepository(db);
  logger.info("Database initialized", { path: config.databasePath });

  const client = createBotClient();
  metrics.attach({ client });
  const delivery = new DeliveryService(
    routes,
    deliveries,
    new DiscordChannelPostSender(client),
    guildSettings,
  );
  const supervisor = new ReceiverSupervisor({
    receivers,
    targets,
    exchanges,
    notifications,
    observations,
    delivery,
    internalGraphqlConfiguration: new InternalGraphqlConfigurationProvider((exchange) =>
      exchanges.record({ ...exchange, receiverId: null, requestSummaryJson: null }),
    ),
    internalPollEnabled: config.internalPollEnabled,
    // 起動前に作成された投稿は保存だけして送らない。AutoPush の再配信でバックログが流れるのを防ぐ。
    deliveryNotBefore: new Date().toISOString(),
  });
  const watchService = new WatchService(receivers, targets, routes, supervisor, guildSettings);

  client.once(Events.ClientReady, () => onReady(client));
  const onInteractionCreate = createInteractionCreateHandler(watchService);
  client.on(Events.InteractionCreate, (interaction) => {
    void onInteractionCreate(interaction);
  });

  await registerCommands(config.discordApplicationId, config.discordToken);
  logger.info("Slash commands registered");
  await client.login(config.discordToken);

  const httpServer = startHttpServer({
    client,
    port: config.healthPort,
    receiverStatuses: () => supervisor.statuses(),
    adminRouter: createAdminRouter({
      adminApiSecret: config.adminApiSecret,
      receivers,
      targets,
      routes,
      notifications,
      deliveries,
      observations,
      exchanges,
      maintenance,
      receiverStatuses: () => supervisor.statuses(),
    }),
  });

  const abortController = new AbortController();
  const background = Promise.all([
    supervisor.run(abortController.signal),
    runRetentionLoop({
      maintenance,
      rawRetentionDays: config.rawRetentionDays,
      retentionDays: config.retentionDays,
      signal: abortController.signal,
    }),
  ]);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { reason });
    abortController.abort();
    void background
      .catch((error: unknown) => logger.error("Background task failed during shutdown", { error }))
      .then(async () => {
        await httpServer.stop();
        await client.destroy();
        db.close();
        logger.info("Shutdown complete");
        process.exit(0);
      });
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled rejection", { reason });
  });
  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception, shutting down", { error });
    shutdown("uncaughtException");
  });

  await background;
}

bootstrap().catch((error: unknown) => {
  logger.error("ratatoskr failed to start", { error });
  process.exitCode = 1;
});
