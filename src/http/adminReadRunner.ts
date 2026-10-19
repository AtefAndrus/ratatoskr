import { logger } from "../utils/logger";
import type { AdminReadRequest, AdminReadResponse } from "./adminReads";

let running = false;
const JSON_HEADERS = { "Content-Type": "application/json" };

function errorResponse(status: number, error: string): AdminReadResponse {
  return { status, body: JSON.stringify({ error }), headers: { ...JSON_HEADERS } };
}

async function readOutput(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function readStderr(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  let tail: Uint8Array<ArrayBuffer> = new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = Uint8Array.from(Buffer.concat([tail, value]).subarray(-2_048));
  }
  return new TextDecoder().decode(tail);
}

export function createChildProcessAdminReader(
  options: { command?: string[]; deadlineMs?: number } = {},
): (request: AdminReadRequest) => Promise<AdminReadResponse> {
  const command = options.command ?? [
    process.execPath,
    "run",
    new URL("../admin/readCommand.ts", import.meta.url).pathname,
  ];
  const deadlineMs = options.deadlineMs ?? 20_000;

  return async (request) => {
    if (running) {
      const response = errorResponse(503, "Admin database reader is busy");
      response.headers["Retry-After"] = "5";
      return response;
    }
    running = true;
    const startedAt = performance.now();
    let child: Bun.Subprocess<Uint8Array<ArrayBuffer>, "pipe", "pipe"> | undefined;
    let stdoutReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    let stderrReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    let timedOut = false;
    const cancelOutput = async (): Promise<void> => {
      await Promise.allSettled([stdoutReader?.cancel(), stderrReader?.cancel()]);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
      // 終了した子から継承されたパイプが開いたままでも、読み取りを期限後に待ち続けない。
      void cancelOutput();
    }, deadlineMs);
    try {
      child = Bun.spawn({
        cmd: command,
        env: process.env,
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        stdout: "pipe",
        stderr: "pipe",
      });
      stdoutReader = child.stdout.getReader();
      stderrReader = child.stderr.getReader();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readOutput(stdoutReader),
        readStderr(stderrReader),
      ]);
      if (timedOut || performance.now() - startedAt >= deadlineMs)
        return errorResponse(504, "Admin database read deadline exceeded");
      if (exitCode !== 0) {
        logger.error("Admin database reader failed", { exitCode, stderr });
        return errorResponse(500, "Admin database read failed");
      }
      const separator = stdout.indexOf(10);
      const statusText = new TextDecoder().decode(stdout.subarray(0, separator));
      if (separator < 0 || !/^[2-5]\d\d$/.test(statusText))
        throw new Error("Invalid admin database reader response");
      return {
        status: Number(statusText),
        body: stdout.subarray(separator + 1),
        headers: { ...JSON_HEADERS },
      };
    } catch (error) {
      child?.kill("SIGKILL");
      if (child !== undefined) await child.exited;
      await cancelOutput();
      if (timedOut) return errorResponse(504, "Admin database read deadline exceeded");
      logger.error("Admin database reader failed", { error });
      return errorResponse(500, "Admin database read failed");
    } finally {
      clearTimeout(timer);
      running = false;
    }
  };
}
