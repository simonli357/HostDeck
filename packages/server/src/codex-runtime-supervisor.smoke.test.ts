import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { createCodexRuntimeSupervisor } from "./codex-runtime-supervisor.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_CODEX_SUPERVISOR_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("exact Codex runtime supervisor smoke", () => {
  it(
    "proves foreground ownership and service non-ownership without a model call",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024
        })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const foregroundDir = privateRuntimeDirectory("foreground");
      const foregroundSocket = join(foregroundDir, "app-server.sock");
      const foreground = createCodexRuntimeSupervisor({
        mode: "foreground_child",
        codex_bin: codexBin,
        socket_path: foregroundSocket
      });
      let foregroundStarted:
        | Awaited<ReturnType<typeof foreground.start>>
        | undefined;
      try {
        foregroundStarted = await startSupervisor(foreground);
        expect(lstatSync(foregroundSocket).isSocket()).toBe(true);
        expect(lstatSync(foregroundSocket).mode & 0o7777).toBe(0o600);
        await proveCompatibility(foregroundSocket, version);
        await closeSupervisor(foreground);
        await expect(foregroundStarted.process_exit).resolves.toMatchObject({
          expected: true
        });
        expect(existsSync(foregroundSocket)).toBe(false);
        expect(foreground.snapshot()).toMatchObject({
          phase: "closed",
          claim_held: false,
          process_state: "exited",
          spawn_attempts: 1,
          cleanup_failures: 0
        });
      } finally {
        if (foreground.snapshot().phase !== "closed") {
          await closeSupervisor(foreground).catch(() => undefined);
        }
        rmSync(foregroundDir, { recursive: true, force: true });
      }

      const serviceDir = privateRuntimeDirectory("service");
      const serviceSocket = join(serviceDir, "app-server.sock");
      const sibling = spawn(
        codexBin,
        ["app-server", "--listen", `unix://${serviceSocket}`],
        {
          cwd: "/",
          shell: false,
          stdio: ["ignore", "ignore", "ignore"]
        }
      );
      const service = createCodexRuntimeSupervisor({
        mode: "service_owned",
        socket_path: serviceSocket
      });
      try {
        const serviceStarted = await startSupervisor(service);
        expect(serviceStarted.process_exit).toBeNull();
        expect(lstatSync(serviceSocket).isSocket()).toBe(true);
        expect(lstatSync(serviceSocket).mode & 0o7777).toBe(0o600);
        await proveCompatibility(serviceSocket, version);
        await closeSupervisor(service);
        expect(sibling.exitCode).toBeNull();
        expect(sibling.signalCode).toBeNull();
        expect(existsSync(serviceSocket)).toBe(true);
        expect(service.snapshot()).toMatchObject({
          phase: "closed",
          process_state: "not_applicable",
          spawn_attempts: 0,
          term_signals: 0,
          kill_signals: 0,
          cleanup_failures: 0
        });
      } finally {
        if (service.snapshot().phase !== "closed") {
          await closeSupervisor(service).catch(() => undefined);
        }
        await stopExternalChild(sibling);
        rmSync(serviceDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});

async function proveCompatibility(
  socketPath: string,
  observedVersion: string
): Promise<void> {
  const transport = createCodexUnixWebSocketTransport({
    socket_path: socketPath
  });
  const connection = createCodexAppServerConnection({
    transport,
    observed_version: observedVersion
  });
  try {
    await expect(connection.connect()).resolves.toMatchObject({
      state: "ready",
      mutation_policy: "allowed"
    });
    expect(connection.state).toBe("ready");
  } finally {
    await connection.close("HostDeck runtime supervisor smoke completed.");
  }
}

async function startSupervisor(
  supervisor: ReturnType<typeof createCodexRuntimeSupervisor>
) {
  const deadline = createOperationDeadline({ timeoutMs: 10_000 });
  try {
    return await supervisor.start({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function closeSupervisor(
  supervisor: ReturnType<typeof createCodexRuntimeSupervisor>
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 3_000 });
  try {
    await supervisor.close({ deadline });
  } finally {
    deadline.dispose();
  }
}

function privateRuntimeDirectory(label: string): string {
  const directory = mkdtempSync(
    join(tmpdir(), `hostdeck-supervisor-smoke-${label}-`)
  );
  chmodSync(directory, 0o700);
  return directory;
}

async function stopExternalChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(closed, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(closed, 1_000))) {
    throw new Error("Exact service-owned Codex app-server did not exit.");
  }
}

async function settlesWithin(
  promise: Promise<void>,
  milliseconds: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  const result = await Promise.race([promise.then(() => true as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
