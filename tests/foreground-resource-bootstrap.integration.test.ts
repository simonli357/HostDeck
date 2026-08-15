import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultResourceBudget,
  sharedCodexEndpointSchema,
  sharedCodexRuntimeVersion
} from "../packages/contracts/src/index.js";
import {
  type HostDeckForegroundResources,
  type SharedCodexBrokerAttachment,
  type StartSharedCodexBrokerInput,
  startHostDeckForegroundResources
} from "../packages/server/src/index.js";
import { acquireHostDeckDaemonLease } from "../packages/storage/src/index.js";

const roots: string[] = [];
const activeResources: HostDeckForegroundResources[] = [];
const activeBrokers: SharedBrokerFixture[] = [];

afterEach(async () => {
  for (const resources of activeResources.splice(0).reverse()) {
    await resources.close().catch(() => undefined);
  }
  for (const broker of activeBrokers.splice(0).reverse()) {
    await broker.stop().catch(() => undefined);
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("foreground resource bootstrap Linux boundary", () => {
  it("attaches to one shared standard socket and leaves it alive across HostDeck restarts", async () => {
    const port = await reserveUnusedPort();
    const layout = fixtureLayout(port);
    const dependencies = {
      codexVersionProbe: async () => sharedCodexRuntimeVersion,
      startSharedBroker: layout.broker.start
    };
    const first = await startHostDeckForegroundResources(
      layout.input,
      dependencies
    );
    activeResources.push(first);

    expect(layout.broker.inputs).toEqual([
      {
        codex_bin: process.execPath,
        location: {
          kind: "standard_unix",
          codex_home: layout.codexHome,
          socket_path: layout.socketPath
        },
        mode: "attach_or_start",
        observed_version: sharedCodexRuntimeVersion,
        startup_timeout_ms:
          defaultResourceBudget.lifecycle_startup_timeout_ms
      }
    ]);
    expect(first.bind).toEqual({
      host: "127.0.0.1",
      port,
      transport: "http"
    });
    expect(first.runtime).toEqual({
      preparation: "ready",
      endpoint: layout.broker.endpoint,
      location: layout.broker.inputs[0]?.location,
      socket_path: layout.socketPath
    });
    expect(first.snapshot()).toMatchObject({
      phase: "ready",
      codex_version: sharedCodexRuntimeVersion,
      database_open: true,
      lease_held: true,
      runtime_preparation: "ready",
      runtime: {
        state: "ready",
        ownership: "owned",
        generation: 1
      }
    });
    expect(lstatSync(layout.configDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.stateDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.runtimeDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.databasePath).mode & 0o7777).toBe(0o600);
    expect(lstatSync(layout.leasePath).mode & 0o7777).toBe(0o600);
    expect(lstatSync(layout.socketPath).isSocket()).toBe(true);
    expect(lstatSync(layout.socketPath).mode & 0o7777).toBe(0o600);
    expect(first.database.pragma("foreign_keys", { simple: true })).toBe(1);

    await expect(
      startHostDeckForegroundResources(layout.input, dependencies)
    ).rejects.toMatchObject({
      name: "HostDeckForegroundResourceError",
      code: "lease_held",
      stage: "lease"
    });
    await provePortIsUnused(port);

    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await firstClose;
    expect(first.database.open).toBe(false);
    expect(first.snapshot()).toMatchObject({
      phase: "closed",
      database_open: false,
      lease_held: false,
      runtime: {
        state: "ready",
        ownership: "owned",
        generation: 1
      }
    });
    expect(layout.broker.attachmentCloseCalls).toBe(1);
    expect(existsSync(layout.socketPath)).toBe(true);

    const second = await startHostDeckForegroundResources(
      layout.input,
      dependencies
    );
    activeResources.push(second);
    expect(second.migration.applied).toEqual([]);
    expect(second.snapshot()).toMatchObject({
      phase: "ready",
      database_open: true,
      lease_held: true,
      runtime: { state: "ready", generation: 1 }
    });
    await second.close();
    expect(layout.broker.inputs).toHaveLength(2);
    expect(layout.broker.attachmentCloseCalls).toBe(2);
    expect(existsSync(layout.socketPath)).toBe(true);
    acquireAndRelease(layout.leasePath);
    await provePortIsUnused(port);

    await layout.broker.stop();
    expect(existsSync(layout.socketPath)).toBe(false);
  });
});

interface SharedBrokerFixture {
  readonly endpoint: ReturnType<typeof sharedCodexEndpointSchema.parse>;
  readonly inputs: StartSharedCodexBrokerInput[];
  readonly attachmentCloseCalls: number;
  readonly start: typeof import("../packages/server/src/shared-codex-broker-lifecycle.js").startSharedCodexBroker;
  readonly stop: () => Promise<void>;
}

function fixtureLayout(port: number): {
  readonly configDir: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly databasePath: string;
  readonly leasePath: string;
  readonly codexHome: string;
  readonly socketPath: string;
  readonly broker: SharedBrokerFixture;
  readonly input: Parameters<typeof startHostDeckForegroundResources>[0];
} {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-bootstrap-integration-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const codexHome = join(root, "codex-home");
  const databasePath = join(stateDir, "hostdeck.sqlite");
  const leasePath = join(stateDir, "hostdeck.lock");
  const socketPath = join(
    codexHome,
    "app-server-control",
    "app-server-control.sock"
  );
  mkdirSync(codexHome, { mode: 0o700 });
  const broker = createSharedBrokerFixture(socketPath);
  activeBrokers.push(broker);
  return {
    configDir,
    stateDir,
    runtimeDir,
    databasePath,
    leasePath,
    codexHome,
    socketPath,
    broker,
    input: Object.freeze({
      config_dir: configDir,
      state_dir: stateDir,
      runtime_dir: runtimeDir,
      database_path: databasePath,
      codex_bin: process.execPath,
      codex_home: codexHome,
      loopback_port: port,
      resource_budget: defaultResourceBudget
    })
  };
}

function createSharedBrokerFixture(socketPath: string): SharedBrokerFixture {
  const server = createServer((socket) => socket.destroy());
  const endpoint = sharedCodexEndpointSchema.parse({
    kind: "standard_unix",
    state: "ready",
    ownership: "owned",
    generation: 1,
    observed_version: sharedCodexRuntimeVersion,
    reason: null
  });
  const inputs: StartSharedCodexBrokerInput[] = [];
  let listening = false;
  let attachmentCloseCalls = 0;
  const fixture: SharedBrokerFixture = {
    endpoint,
    inputs,
    get attachmentCloseCalls() {
      return attachmentCloseCalls;
    },
    start: (async (input: StartSharedCodexBrokerInput) => {
      inputs.push(input);
      if (input.location.socket_path !== socketPath) {
        throw new Error("Shared broker fixture received the wrong socket.");
      }
      if (!listening) {
        mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
        await listenUnix(server, socketPath);
        chmodSync(socketPath, 0o600);
        listening = true;
      }
      let closed = false;
      const attachment: SharedCodexBrokerAttachment = Object.freeze({
        endpoint,
        location: input.location,
        get closed() {
          return closed;
        },
        async close() {
          if (closed) return;
          closed = true;
          attachmentCloseCalls += 1;
        }
      });
      return attachment;
    }) as SharedBrokerFixture["start"],
    async stop() {
      if (!listening) return;
      await closeServer(server);
      listening = false;
      rmSync(socketPath, { force: true });
    }
  };
  return fixture;
}

async function reserveUnusedPort(): Promise<number> {
  const server = createServer();
  await listenTcp(server, 0);
  const address = server.address() as AddressInfo;
  await closeServer(server);
  return address.port;
}

async function provePortIsUnused(port: number): Promise<void> {
  const server = createServer();
  await listenTcp(server, port);
  await closeServer(server);
}

async function listenTcp(
  server: ReturnType<typeof createServer>,
  port: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function listenUnix(
  server: ReturnType<typeof createServer>,
  socketPath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(
  server: ReturnType<typeof createServer>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function acquireAndRelease(leasePath: string): void {
  const lease = acquireHostDeckDaemonLease({ lease_path: leasePath });
  lease.release();
}
