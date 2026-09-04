const CTRL_C = String.fromCharCode(3);
const DELETE = String.fromCharCode(127);

/** 端末のエコーを止めて 1 行読む。コマンド引数や履歴に秘密情報を残さないため。 */
export async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("秘密情報の入力には対話端末が必要です");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          process.stdout.write("\n");
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === CTRL_C) {
          cleanup();
          reject(new Error("入力を中断しました"));
          return;
        }
        if (character === DELETE || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
