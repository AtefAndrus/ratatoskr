import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * .env 系ファイルの 1 変数を書き換える。
 * 秘密情報をコマンド引数や履歴に残さずに保存するための経路で、値はファイル全体を一時ファイルへ書いてから rename する。
 * 既存の他の行はそのまま残す。
 */
export async function upsertEnvValue(filePath: string, name: string, value: string): Promise<void> {
  if (!ENV_NAME.test(name)) throw new Error(`環境変数名が不正です: ${name}`);
  if (value.includes("\n") || value.includes("\r")) throw new Error("値に改行は含められません");
  const absolute = resolve(filePath);
  let lines: string[] = [];
  try {
    lines = (await readFile(absolute, "utf8")).split("\n");
    if (lines.at(-1) === "") lines.pop();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const line = `${name}=${quoteIfNeeded(value)}`;
  const index = lines.findIndex((existing) => existing.trimStart().startsWith(`${name}=`));
  if (index >= 0) {
    lines[index] = line;
  } else {
    lines.push(line);
  }

  await mkdir(dirname(absolute), { recursive: true });
  const temporary = resolve(dirname(absolute), `.${basename(absolute)}.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${lines.join("\n")}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, absolute);
    await chmod(absolute, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function quoteIfNeeded(value: string): string {
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
