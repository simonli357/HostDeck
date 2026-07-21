import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultResourceBudget } from "../packages/contracts/src/index.js";
import type { HostDeckForegroundResources } from "../packages/server/src/index.js";
import { startHostDeckForegroundResources } from "../packages/server/src/index.js";
import { acquireHostDeckDaemonLease } from "../packages/storage/src/index.js";

const roots: string[] = [];
const activeResources: HostDeckForegroundResources[] = [];

afterEach(async () => {
  for (const resources of activeResources.splice(0).reverse()) {
    await resources.close().catch(() => undefined);
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("foreground resource bootstrap Linux boundary", () => {
  it("owns one real foreground process/socket and restarts after reverse cleanup", async () => {
    const port = await reserveUnusedPort();
    const layout = fixtureLayout(port);
    const first = await startHostDeckForegroundResources(layout.input);
    activeResources.push(first);

    expect(JSON.parse(readFileSync(layout.argvPath, "utf8"))).toEqual([
      "app-server",
      "--listen",
      `unix://${layout.socketPath}`
    ]);
    expect(first.bind).toEqual({
      host: "127.0.0.1",
      port,
      transport: "http"
    });
    expect(first.runtime).toMatchObject({
      mode: "foreground_child",
      ownership: "foreground_child",
      socket_path: layout.socketPath,
      socket_mode_repaired: true
    });
    expect(first.snapshot()).toMatchObject({
      phase: "ready",
      database_open: true,
      lease_held: true,
      runtime: {
        phase: "ready",
        process_state: "running",
        socket_ready: true,
        spawn_attempts: 1
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

    await expect(startHostDeckForegroundResources(layout.input)).rejects.toMatchObject(
      {
        name: "HostDeckForegroundResourceError",
        code: "lease_held",
        stage: "lease"
      }
    );
    await provePortIsUnused(port);

    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await firstClose;
    await expect(first.runtime.process_exit).resolves.toMatchObject({
      kind: "exited",
      expected: true,
      code: 0,
      signal: null
    });
    expect(first.database.open).toBe(false);
    expect(existsSync(layout.socketPath)).toBe(false);
    expect(first.snapshot()).toMatchObject({
      phase: "closed",
      database_open: false,
      lease_held: false,
      runtime: {
        phase: "closed",
        process_state: "exited",
        term_signals: 1,
        kill_signals: 0,
        cleanup_failures: 0
      }
    });

    const second = await startHostDeckForegroundResources(layout.input);
    activeResources.push(second);
    expect(second.migration.applied).toEqual([]);
    expect(second.snapshot()).toMatchObject({
      phase: "ready",
      database_open: true,
      lease_held: true
    });
    await second.close();
    await expect(second.runtime.process_exit).resolves.toMatchObject({
      expected: true,
      code: 0
    });
    expect(existsSync(layout.socketPath)).toBe(false);
    acquireAndRelease(layout.leasePath);
    await provePortIsUnused(port);
  });
});

function fixtureLayout(port: number): {
  readonly configDir: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly databasePath: string;
  readonly leasePath: string;
  readonly socketPath: string;
  readonly argvPath: string;
  readonly input: Parameters<typeof startHostDeckForegroundResources>[0];
} {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-bootstrap-integration-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const databasePath = join(stateDir, "hostdeck.sqlite");
  const leasePath = join(stateDir, "hostdeck.lock");
  const socketPath = join(runtimeDir, "app-server.sock");
  const argvPath = `${socketPath}.argv`;
  const executable = join(root, "codex-fixture.mjs");
  writeFileSync(executable, fixtureSource(), { mode: 0o700 });
  chmodSync(executable, 0o700);
  return {
    configDir,
    stateDir,
    runtimeDir,
    databasePath,
    leasePath,
    socketPath,
    argvPath,
    input: Object.freeze({
      config_dir: configDir,
      state_dir: stateDir,
      runtime_dir: runtimeDir,
      database_path: databasePath,
      codex_bin: executable,
      loopback_port: port,
      resource_budget: defaultResourceBudget
    })
  };
}

function fixtureSource(): string {
  return `#!/usr/bin/env node
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "app-server" || args[1] !== "--listen" || !args[2].startsWith("unix://")) process.exit(64);
const socketPath = args[2].slice("unix://".length);
writeFileSync(socketPath + ".argv", JSON.stringify(args), { mode: 0o600 });
const server = createServer((socket) => socket.destroy());
server.on("error", () => process.exit(70));
server.listen(socketPath, () => chmodSync(socketPath, 0o666));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

async function reserveUnusedPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address() as AddressInfo;
  await closeServer(server);
  return address.port;
}

async function provePortIsUnused(port: number): Promise<void> {
  const server = createServer();
  await listen(server, port);
  await closeServer(server);
}

async function listen(server: ReturnType<typeof createServer>, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
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
