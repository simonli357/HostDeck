import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import { createCodexAppServerConnection } from "./connection.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";
import { createCodexUsageClient } from "./usage-client.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_USAGE_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("exact Codex structured usage smoke", () => {
  it(
    "reads bounded account usage without starting model or thread work",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const runtimeDirectory = await mkdtemp(join(tmpdir(), "hostdeck-codex-usage-"));
      const socketPath = join(runtimeDirectory, "app.sock");
      const child = spawn(codexBin, ["app-server", "--listen", `unix://${socketPath}`], {
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
      });

      const observedMethods: string[] = [];
      let notificationOverflow = false;
      const transport = createCodexUnixWebSocketTransport({ socket_path: socketPath });
      const connection = createCodexAppServerConnection({
        transport,
        observed_version: version,
        on_notification(message) {
          if (observedMethods.length >= 128) notificationOverflow = true;
          else observedMethods.push(message.method);
        }
      });
      try {
        await waitForSocket(socketPath, child, () => stderr);
        await connection.connect();
        const usage = createCodexUsageClient(connection);
        const snapshot = await usage.readAccount();

        expect(snapshot.runtime_version).toBe("0.144.0");
        expect(snapshot.connection_generation).toBe(connection.generation);
        expect(snapshot.account.scope).toBe("account");
        expect(snapshot.account.daily_buckets === null || snapshot.account.daily_buckets.length <= 2_000).toBe(true);
        expect(Object.values(snapshot.account.summary).every((value) => value === null || Number.isSafeInteger(value))).toBe(true);
        expect(notificationOverflow).toBe(false);
        expect(observedMethods).not.toContain("turn/started");
        expect(observedMethods).not.toContain("thread/tokenUsage/updated");
        expect(observedMethods).not.toContain("item/agentMessage/delta");
      } finally {
        try {
          await connection.close("HostDeck usage smoke completed.");
        } finally {
          await stopChild(child);
          await rm(runtimeDirectory, { recursive: true, force: true });
        }
      }
    },
    20_000
  );
});

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 5_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before creating its usage-smoke socket: ${readStderr()}`);
    }
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex app-server did not create its usage-smoke socket: ${readStderr()}`);
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
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex usage-smoke app-server did not exit after SIGKILL.");
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
