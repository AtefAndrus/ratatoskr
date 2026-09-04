import { ActivityType, type Client } from "discord.js";

import packageJson from "../../../package.json";
import { logger } from "../../utils/logger";

export function onReady(client: Client): void {
  logger.info("Discord client ready", {
    user: client.user?.tag ?? "unknown",
    version: packageJson.version,
  });
  client.user?.setActivity(`v${packageJson.version}`, { type: ActivityType.Watching });
}
