import { REST, Routes } from "discord.js";

import { watchCommand } from "./watch";

export const commandDefinitions = [watchCommand];

export async function registerCommands(applicationId: string, token: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), {
    body: commandDefinitions.map((command) => command.toJSON()),
  });
}
