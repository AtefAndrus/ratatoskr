import { loadEnvFile } from "./config";
import { openDatabase } from "./db";
import { ReceiverRepository } from "./db/repositories/receivers";
import { RouteRepository } from "./db/repositories/routes";
import { TargetRepository } from "./db/repositories/targets";
import { upsertEnvValue } from "./utils/envFile";
import { readHiddenLine } from "./utils/hiddenInput";
import { X_WEB_BEARER_TOKEN } from "./x/credentials";

const USAGE = `使用方法:
  bun run cli receiver:add <label>      受信用 X アカウントを登録する (auth_token / ct0 を入力)
  bun run cli receiver:update <label>   受信用 X アカウントの認証情報を更新する
  bun run cli receiver:list             受信用 X アカウントの一覧を表示する
  bun run cli receiver:enable <label>   受信用 X アカウントを有効にする
  bun run cli receiver:disable <label>  受信用 X アカウントを無効にする
  bun run cli receiver:remove <label>   受信用 X アカウントを削除する
  bun run cli watch:list                監視対象と投稿先チャンネルの一覧を表示する
  bun run cli env:set <NAME> [file]     値を非表示入力して .env.local (既定) に書き込む

認証情報は対話端末では非表示入力で受け取る。端末が無い場合は環境変数 X_AUTH_TOKEN と X_CT0 から読む。`;

loadEnvFile();
const [, , command, ...args] = process.argv;
const databasePath = process.env.DATABASE_PATH?.trim() || "data/ratatoskr.db";

try {
  await main(command, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(name: string | undefined, rest: string[]): Promise<void> {
  if (name === undefined || name === "help" || name === "--help") {
    console.log(USAGE);
    return;
  }
  if (name === "env:set") {
    const variable = requireArgument(rest[0], "環境変数名");
    const file = rest[1] ?? ".env.local";
    const value = await readHiddenLine(`${variable}: `);
    if (value.length === 0) throw new Error("空の値は保存できません");
    await upsertEnvValue(file, variable, value);
    console.log(`${variable} を ${file} に保存しました。`);
    return;
  }
  const db = openDatabase(databasePath);
  try {
    const receivers = new ReceiverRepository(
      db,
      process.env.X_WEB_BEARER_TOKEN?.trim() || X_WEB_BEARER_TOKEN,
    );
    switch (name) {
      case "receiver:add": {
        const label = requireArgument(rest[0], "受信アカウントのラベル");
        const receiver = receivers.add(label, await readCredentials());
        console.log(
          `${receiver.label} を登録しました。Bot が動作中なら 1 分以内に受信を開始します。`,
        );
        break;
      }
      case "receiver:update": {
        const label = requireArgument(rest[0], "受信アカウントのラベル");
        if (!receivers.updateCredentials(label, await readCredentials())) {
          throw new Error(`受信アカウントがありません: ${label}`);
        }
        console.log(`${label} の認証情報を更新しました。反映には Bot の再起動が必要です。`);
        break;
      }
      case "receiver:list": {
        const summaries = receivers.listSummaries();
        if (summaries.length === 0) {
          console.log("受信アカウントはありません。");
          break;
        }
        for (const summary of summaries) {
          console.log(
            [
              summary.label,
              summary.enabled ? "enabled" : "disabled",
              summary.pushRegisteredAt === null
                ? "push:unregistered"
                : `push:${summary.pushRegisteredAt}`,
            ].join("\t"),
          );
        }
        break;
      }
      case "receiver:enable":
      case "receiver:disable": {
        const label = requireArgument(rest[0], "受信アカウントのラベル");
        const enabled = name === "receiver:enable";
        if (!receivers.setEnabled(label, enabled))
          throw new Error(`受信アカウントがありません: ${label}`);
        console.log(`${label} を${enabled ? "有効" : "無効"}にしました。`);
        break;
      }
      case "receiver:remove": {
        const label = requireArgument(rest[0], "受信アカウントのラベル");
        if (!receivers.remove(label)) throw new Error(`受信アカウントがありません: ${label}`);
        console.log(`${label} を削除しました。`);
        break;
      }
      case "watch:list": {
        const targets = new TargetRepository(db);
        const routes = new RouteRepository(db);
        const all = routes.listAll();
        if (all.length === 0) {
          console.log("監視対象はありません。");
          break;
        }
        for (const route of all) {
          console.log(
            `@${route.handle}\t${route.displayName}\tguild:${route.guildId}\tchannel:${route.channelId}`,
          );
        }
        const disabled = targets.listAll().filter((target) => !target.enabled);
        for (const target of disabled)
          console.log(`@${target.handle}\t${target.displayName}\t(disabled)`);
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

async function readCredentials(): Promise<{
  authToken: string;
  csrfToken: string;
  bearerToken?: string;
}> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const authToken = await readHiddenLine("X auth_token: ");
    const csrfToken = await readHiddenLine("X ct0: ");
    return { authToken, csrfToken };
  }
  const authToken = process.env.X_AUTH_TOKEN?.trim();
  const csrfToken = process.env.X_CT0?.trim();
  if (!authToken || !csrfToken) {
    throw new Error("対話端末が無いため、環境変数 X_AUTH_TOKEN と X_CT0 を指定してください");
  }
  const bearerToken = process.env.X_BEARER_TOKEN?.trim();
  return bearerToken ? { authToken, csrfToken, bearerToken } : { authToken, csrfToken };
}

function requireArgument(value: string | undefined, description: string): string {
  if (!value) throw new Error(`${description}を指定してください`);
  return value;
}
