import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import { startHostHttpService } from "../packages/server/src/index.js";
import {
  createFakeTmuxAdapter,
  parseSessionIdFromTmuxSessionName,
  type RealTmuxTargetDiscovery,
  tmuxSessionNameForSession
} from "../packages/tmux-adapter/src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("service-mode CLI smoke", () => {
  it("reports status while the foreground service is running, fails unavailable after stop, and works after restart", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const stateDir = tempDir("hostdeck-service-cli-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const service = await startHostHttpService({
      version: "0.0.0-service-cli-smoke",
      ...localPaths(),
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: fixedNow,
      startOutputReader: noopOutputReader
    });

    try {
      const status = await runCli(["--api-url", service.baseUrl.toString(), "status"], { env: {} });

      expect(status.exitCode).toBe(cliExitCodes.ok);
      expect(status.stdout).toContain("HostDeck daemon: ready");
      expect(status.stdout).toContain(`Bind: localhost (127.0.0.1:${port})`);
    } finally {
      await service.close();
    }

    const unavailable = await runCli(["--api-url", `http://127.0.0.1:${port}`, "status"], { env: {} });
    expect(unavailable.exitCode).toBe(cliExitCodes.daemonUnavailable);
    expect(unavailable.stderr).toContain("HostDeck CLI error (daemon_unavailable)");

    const restarted = await startHostHttpService({
      version: "0.0.0-service-cli-smoke",
      ...localPaths(),
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: laterNow,
      startOutputReader: noopOutputReader
    });

    try {
      const status = await runCli(["--api-url", restarted.baseUrl.toString(), "status"], { env: {} });
      expect(status.exitCode).toBe(cliExitCodes.ok);
      expect(status.stdout).toContain("HostDeck daemon: ready");
    } finally {
      await restarted.close();
    }
  });

  it("runs CLI start, list, send, and stop through the foreground HTTP service", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const stateDir = tempDir("hostdeck-service-cli-routes-state-");
    const fakeTmux = createFakeTmuxAdapter({ now: fixedNow });
    const service = await startHostHttpService({
      version: "0.0.0-service-cli-routes",
      ...localPaths(),
      stateDir,
      databasePath: join(stateDir, "hostdeck.sqlite"),
      bindPort: port,
      discovery: emptyDiscovery(),
      tmux: fakeTmux,
      now: fixedNow
    });

    try {
      const start = await runCli(["--api-url", service.baseUrl.toString(), "start", "--name", "cli-http-demo", "--cwd", stateDir], {
        env: {}
      });
      expect(start.exitCode).toBe(cliExitCodes.ok);
      expect(start.stdout).toContain("Started session: cli-http-demo");

      const list = await runCli(["--api-url", service.baseUrl.toString(), "list"], { env: {} });
      expect(list.exitCode).toBe(cliExitCodes.ok);
      expect(list.stdout).toContain("cli-http-demo");
      expect(list.stdout).toContain("lifecycle=running");

      const send = await runCli(["--api-url", service.baseUrl.toString(), "send", "cli-http-demo", "Continue", "from", "CLI"], {
        env: {}
      });
      expect(send.exitCode).toBe(cliExitCodes.ok);
      expect(send.stdout).toContain("prompt accepted");
      expect(fakeTmux.sentInputs()).toHaveLength(1);
      expect(fakeTmux.sentInputs()[0]).toMatchObject({
        text: "Continue from CLI",
        enter: true
      });

      const stop = await runCli(["--api-url", service.baseUrl.toString(), "stop", "cli-http-demo"], { env: {} });
      expect(stop.exitCode).toBe(cliExitCodes.ok);
      expect(stop.stdout).toContain("stop accepted");
    } finally {
      await service.close();
    }
  });
});

function emptyDiscovery(): RealTmuxTargetDiscovery {
  return {
    tmuxSessionNameForSession,
    parseSessionIdFromTmuxSessionName,
    async listTargets() {
      return [];
    },
    async getTargetBySessionId() {
      return null;
    },
    async reconcileTargets() {
      return {
        liveTargets: [],
        staleTargets: [],
        unmanagedTargets: []
      };
    }
  };
}

function noopOutputReader(): void {
  return;
}

async function getAvailablePort(host: string): Promise<number> {
  const server = await listenOn(host, 0);
  const address = server.address();
  await closeServer(server);

  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate an ephemeral TCP port.");
  }

  return address.port;
}

function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    let settled = false;

    function settle(error?: unknown): void {
      if (settled) {
        return;
      }

      settled = true;

      if (error !== undefined) {
        rejectListen(error);
        return;
      }

      resolveListen(server);
    }

    server.once("error", settle);
    server.listen(
      {
        host,
        port,
        exclusive: true
      },
      () => settle()
    );
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function localPaths(): { readonly configDir: string; readonly runtimeDir: string } {
  const runtimeParent = tempDir("hostdeck-mode-runtime-parent-");
  return {
    configDir: tempDir("hostdeck-mode-config-"),
    runtimeDir: join(runtimeParent, "hostdeck")
  };
}

function fixedNow(): Date {
  return new Date("2026-07-09T08:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-09T08:05:00.000Z");
}
