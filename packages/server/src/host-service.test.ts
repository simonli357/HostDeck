import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSessionIdFromTmuxSessionName,
  type RealTmuxTargetDiscovery,
  tmuxSessionNameForSession
} from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { startHostHttpService } from "./host-service.js";
import { isHostReady } from "./startup.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("foreground host service smoke", () => {
  it("starts, reports status, stays reachable until stopped, fails unavailable after stop, and restarts from durable state", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const stateDir = tempDir("hostdeck-service-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const first = await startHostHttpService({
      version: "0.0.0-service-smoke",
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: fixedNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(first.baseUrl.toString()).toBe(`http://127.0.0.1:${port}/`);
      expect(isHostReady(first.status())).toBe(true);
      await expect(fetchStatus(first.baseUrl)).resolves.toMatchObject({
        version: "0.0.0-service-smoke",
        bind: {
          mode: "localhost",
          host: "127.0.0.1",
          port
        },
        storage: { state: "ok" },
        tmux: { state: "ok" },
        stream: { state: "ok" },
        last_error: null
      });

      await wait(25);
      await expect(fetchStatus(first.baseUrl)).resolves.toMatchObject({
        version: "0.0.0-service-smoke"
      });
    } finally {
      await first.close();
    }

    await expect(fetchStatus(new URL(`http://127.0.0.1:${port}`))).rejects.toThrow();

    const restarted = await startHostHttpService({
      version: "0.0.0-service-smoke",
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: laterNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(isHostReady(restarted.status())).toBe(true);
      await expect(fetchStatus(restarted.baseUrl)).resolves.toMatchObject({
        version: "0.0.0-service-smoke",
        bind: {
          host: "127.0.0.1",
          port
        },
        last_error: null
      });
    } finally {
      await restarted.close();
    }
  });
});

async function fetchStatus(baseUrl: URL): Promise<unknown> {
  const response = await fetch(new URL("/api/host/status", baseUrl));

  if (!response.ok) {
    throw new Error(`Unexpected service status HTTP ${response.status}.`);
  }

  return response.json();
}

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

function fixedNow(): Date {
  return new Date("2026-07-09T08:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-09T08:05:00.000Z");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
