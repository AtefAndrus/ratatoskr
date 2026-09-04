import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { X_WEB_BEARER_TOKEN } from "../x/credentials";

/**
 * .env を手動で読む。`bun run` 経由では Bun の自動読み込みが効かないケースがある。
 * See: https://github.com/oven-sh/bun/issues/23962
 */
export function loadEnvFile(): void {
  for (const envFile of [".env.local", ".env"]) {
    if (!existsSync(envFile)) continue;
    try {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // 読めないファイルは無視する
    }
  }
}

const booleanString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no", "on", "off"]))
  .transform((value) => value === "true" || value === "1" || value === "yes" || value === "on");

const configSchema = z.object({
  discordToken: z.string().min(1),
  discordApplicationId: z.string().min(1),
  nodeEnv: z.enum(["development", "production"]).default("development"),
  databasePath: z.string().min(1).default("data/ratatoskr.db"),
  healthPort: z.coerce.number().int().min(1).max(65535).default(3000),
  adminApiSecret: z.string().min(1).optional(),
  internalPollEnabled: booleanString.default(true),
  rawRetentionDays: z.coerce.number().int().min(1).default(3),
  retentionDays: z.coerce.number().int().min(1).default(30),
  xWebBearerToken: z.string().min(1).default(X_WEB_BEARER_TOKEN),
});

export type AppConfig = z.infer<typeof configSchema>;

export interface EnvVarDefinition {
  name: string;
  required: boolean;
  description: string;
  default?: string;
}

// README と .env.example の元になる定義。値の検証は configSchema が担う。
export const envVarDefinitions: EnvVarDefinition[] = [
  { name: "DISCORD_TOKEN", required: true, description: "Discord Bot Token" },
  { name: "DISCORD_APPLICATION_ID", required: true, description: "Discord Application ID" },
  {
    name: "NODE_ENV",
    required: false,
    description: "動作モード (development または production)",
    default: "development",
  },
  {
    name: "DATABASE_PATH",
    required: false,
    description: "SQLite パス。受信アカウントの認証情報と Web Push 鍵もここに保存する",
    default: "data/ratatoskr.db",
  },
  {
    name: "HEALTH_PORT",
    required: false,
    description: "HTTP ポート (/health, /admin/*)",
    default: "3000",
  },
  {
    name: "ADMIN_API_SECRET",
    required: false,
    description: "管理 API の HMAC 共通シークレット (未設定時は /admin/* が 503)",
  },
  {
    name: "INTERNAL_POLL_ENABLED",
    required: false,
    description: "X 内部 GraphQL による返信補完ポーリングを行うか",
    default: "true",
  },
  {
    name: "RAW_RETENTION_DAYS",
    required: false,
    description: "生応答本文 (GraphQL 応答、暗号文、投稿の生 JSON) を保持する日数",
    default: "3",
  },
  {
    name: "RETENTION_DAYS",
    required: false,
    description: "通知・観測・配信の各記録行を保持する日数",
    default: "30",
  },
  {
    name: "X_WEB_BEARER_TOKEN",
    required: false,
    description: "X Web クライアントの公開 Bearer。既定値は X が長期間使い続けている値",
    default: "(組み込み値)",
  },
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    discordToken: env.DISCORD_TOKEN,
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    nodeEnv: env.NODE_ENV ?? "development",
    databasePath: env.DATABASE_PATH,
    healthPort: env.HEALTH_PORT,
    adminApiSecret: env.ADMIN_API_SECRET || undefined,
    internalPollEnabled: env.INTERNAL_POLL_ENABLED,
    rawRetentionDays: env.RAW_RETENTION_DAYS,
    retentionDays: env.RETENTION_DAYS,
    xWebBearerToken: env.X_WEB_BEARER_TOKEN || undefined,
  });
}

export function loadConfigFromEnvFiles(): AppConfig {
  loadEnvFile();
  return loadConfig();
}
