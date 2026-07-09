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
import { HostDeckStartupError, isHostReady, startHostAgent } from "./startup.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("localhost and LAN network smoke", () => {
  it("starts with a localhost-only bind by default and proves the port is available", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const result = await startHostAgent({
      version: "0.0.0-network-smoke",
      stateDir: tempDir("hostdeck-network-state-"),
      bindPort: port,
      discovery: emptyDiscovery(),
      now: fixedNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(isHostReady(result.status)).toBe(true);
      expect(result.status).toMatchObject({
        bind: {
          mode: "localhost",
          host: "127.0.0.1",
          port
        },
        lan_enabled: false,
        last_error: null
      });
      expect(result.status.startup_checks).toContainEqual(expect.objectContaining({ name: "network_bind", state: "ok" }));
    } finally {
      result.close();
    }
  });

  it("persists LAN on and off bind visibility across startup checks", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const stateDir = tempDir("hostdeck-network-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const localhost = await startHostAgent({
      version: "0.0.0-network-smoke",
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: fixedNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(localhost.status).toMatchObject({
        bind: {
          mode: "localhost",
          host: "127.0.0.1",
          port
        },
        lan_enabled: false
      });
      localhost.settings.setLanEnabled(true, { bindHost: "0.0.0.0", now: laterNow });
    } finally {
      localhost.close();
    }

    const lan = await startHostAgent({
      version: "0.0.0-network-smoke",
      stateDir,
      databasePath,
      discovery: emptyDiscovery(),
      now: laterNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(lan.status).toMatchObject({
        bind: {
          mode: "lan",
          host: "0.0.0.0",
          port
        },
        lan_enabled: true
      });
      lan.settings.setLanEnabled(false, { now: laterNow });
    } finally {
      lan.close();
    }

    const lanOff = await startHostAgent({
      version: "0.0.0-network-smoke",
      stateDir,
      databasePath,
      discovery: emptyDiscovery(),
      now: laterNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(lanOff.status).toMatchObject({
        bind: {
          mode: "localhost",
          host: "127.0.0.1",
          port
        },
        lan_enabled: false
      });
    } finally {
      lanOff.close();
    }
  });

  it("fails startup for invalid and duplicate bind ports before claiming ready", async () => {
    const invalidPortError = await expectStartupFailure(
      startHostAgent({
        version: "0.0.0-network-smoke",
        stateDir: tempDir("hostdeck-network-state-"),
        bindPort: 0,
        discovery: emptyDiscovery(),
        now: fixedNow,
        startOutputReader: noopOutputReader
      })
    );

    expect(invalidPortError).toMatchObject({
      code: "invalid_settings",
      status: {
        last_error: {
          code: "invalid_config",
          field: "settings"
        }
      }
    });
    expect(isHostReady(invalidPortError.status)).toBe(false);

    const port = await getAvailablePort("127.0.0.1");
    const blocker = await listenOn("127.0.0.1", port);

    try {
      const duplicatePortError = await expectStartupFailure(
        startHostAgent({
          version: "0.0.0-network-smoke",
          stateDir: tempDir("hostdeck-network-state-"),
          bindPort: port,
          discovery: emptyDiscovery(),
          now: fixedNow,
          startOutputReader: noopOutputReader
        })
      );

      expect(duplicatePortError).toMatchObject({
        code: "network_bind_failed",
        status: {
          bind: {
            host: "127.0.0.1",
            port
          },
          last_error: {
            code: "invalid_config",
            field: "bind"
          }
        }
      });
      expect(isHostReady(duplicatePortError.status)).toBe(false);
      expect(duplicatePortError.status.startup_checks.at(-1)).toMatchObject({
        name: "network_bind",
        state: "error"
      });
    } finally {
      await closeServer(blocker);
    }
  });
});

async function expectStartupFailure(startup: Promise<unknown>): Promise<HostDeckStartupError> {
  try {
    await startup;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckStartupError);
    return error as HostDeckStartupError;
  }

  throw new Error("Expected startup to fail.");
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
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
