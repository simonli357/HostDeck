import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import { createCodexAppServerConnection } from "./connection.js";
import { type CodexTransportEvent, createCodexUnixWebSocketTransport } from "./transport.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_IPC_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex Unix IPC smoke", () => {
  it(
    "reaches compatibility-ready through the production private-socket stack",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const runtimeDirectory = await mkdtemp(join(tmpdir(), "hostdeck-codex-"));
      const socketPath = join(runtimeDirectory, "app.sock");
      const child = spawn(codexBin, ["app-server", "--listen", `unix://${socketPath}`], {
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
      });

      const transport = createCodexUnixWebSocketTransport({ socket_path: socketPath });
      const transportEvents: string[] = [];
      transport.subscribe((event) => transportEvents.push(summarizeTransportEvent(event)));
      const connection = createCodexAppServerConnection({
        transport,
        observed_version: version
      });
      try {
        await waitForSocket(socketPath, child, () => stderr);
        expect((await stat(runtimeDirectory)).mode & 0o077).toBe(0);
        expect((await lstat(socketPath)).isSocket()).toBe(true);
        let compatibility: (typeof connection)["compatibility"];
        try {
          compatibility = await connection.connect();
        } catch (error) {
          throw new Error(
            `Codex Unix IPC handshake failed (exit=${child.exitCode ?? "running"}, signal=${child.signalCode ?? "none"}, events=${transportEvents.join(";") || "none"}, stderr=${stderr || "empty"}).`,
            { cause: error }
          );
        }
        expect(compatibility).toMatchObject({ state: "ready", mutation_policy: "allowed" });
        expect(connection.state).toBe("ready");
        expect(connection.generation).toBe(1);
      } finally {
        try {
          await connection.close("HostDeck Unix IPC smoke completed.");
        } finally {
          await stopChild(child);
          await rm(runtimeDirectory, { recursive: true, force: true });
        }
      }
    },
    20_000
  );
});

function summarizeTransportEvent(event: CodexTransportEvent): string {
  if (event.type === "message") return `message:${Buffer.byteLength(event.text, "utf8")}`;
  if (event.type === "error") return `error:${event.error.code}`;
  if (event.type === "close") return `close:${event.code}:${event.clean}:${event.reason}`;
  return `open:${event.generation}`;
}

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 5_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before creating its Unix socket: ${readStderr()}`);
    }
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex app-server did not create its Unix socket: ${readStderr()}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex app-server did not exit after SIGKILL.");
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}
