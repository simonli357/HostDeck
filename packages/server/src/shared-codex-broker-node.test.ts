import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SharedCodexEndpointLocation } from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckSharedCodexBrokerError,
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "./shared-codex-broker-lifecycle.js";

const describeLinux =
  process.platform === "linux" && process.arch === "x64"
    ? describe
    : describe.skip;

const roots = new Set<string>();
const ownedLocations = new Map<string, SharedCodexEndpointLocation>();
const externalChildren = new Set<ChildProcess>();

afterEach(async () => {
  for (const location of ownedLocations.values()) {
    await stopOwnedSharedCodexBroker(
      { location, stop_timeout_ms: 3_000 },
      {}
    ).catch(() => undefined);
  }
  ownedLocations.clear();
  for (const child of externalChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child).catch(() => undefined);
    }
  }
  externalChildren.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describeLinux("node shared Codex broker lifecycle", () => {
  it("starts one detached owner, survives attachment close, reattaches, and stops explicitly", async () => {
    const fixture = createFixture("serve");
    const first = await start(fixture);
    ownedLocations.set(fixture.root, fixture.location);
    expect(first.endpoint).toMatchObject({
      state: "ready",
      ownership: "owned",
      observed_version: "0.148.0"
    });
    expect(mode(fixture.controlDirectory)).toBe(0o700);
    expect(mode(fixture.location.socket_path)).toBe(0o600);
    expect(mode(fixture.ownerRecord)).toBe(0o600);
    const owner = readOwner(fixture.ownerRecord);
    expect(processIsAlive(owner.pid)).toBe(true);

    await first.close();
    expect(processIsAlive(owner.pid)).toBe(true);
    expect(await canConnect(fixture.location.socket_path)).toBe(true);

    const second = await start(fixture);
    expect(second.endpoint).toMatchObject({
      state: "ready",
      ownership: "owned",
      generation: first.endpoint.generation
    });
    expect(readStartCount(fixture.startLog)).toBe(1);

    await stopOwnedSharedCodexBroker({
      location: fixture.location,
      stop_timeout_ms: 3_000
    });
    ownedLocations.delete(fixture.root);
    expect(processIsAlive(owner.pid)).toBe(false);
    expect(existsSync(fixture.location.socket_path)).toBe(false);
    expect(existsSync(fixture.ownerRecord)).toBe(false);
  });

  it("serializes concurrent starts across the filesystem lock", async () => {
    const fixture = createFixture("serve");
    const [left, right] = await Promise.all([start(fixture), start(fixture)]);
    ownedLocations.set(fixture.root, fixture.location);
    expect(left.endpoint.ownership).toBe("owned");
    expect(right.endpoint.ownership).toBe("owned");
    expect(left.endpoint.generation).toBe(right.endpoint.generation);
    expect(readStartCount(fixture.startLog)).toBe(1);
  });

  it("attaches to an external active broker and refuses to stop it", async () => {
    const fixture = createFixture("serve", true);
    const external = spawn(fixture.executable, [
      "app-server",
      "--listen",
      `unix://${fixture.location.socket_path}`
    ], {
      cwd: fixture.codexHome,
      env: { ...process.env, CODEX_HOME: fixture.codexHome },
      stdio: "ignore"
    });
    externalChildren.add(external);
    await waitForSocket(fixture.location.socket_path);

    const attachment = await start(fixture, "attach_only");
    expect(attachment.endpoint.ownership).toBe("attached");
    await attachment.close();
    expect(external.exitCode).toBeNull();
    await expectBrokerError(
      stopOwnedSharedCodexBroker({
        location: fixture.location,
        stop_timeout_ms: 1_000
      }),
      "broker_not_owned"
    );
    expect(external.exitCode).toBeNull();
  });

  it("rejects stale and insecure socket state without repairing or unlinking it", async () => {
    const stale = createFixture("leave_stale", true);
    const staleChild = spawn(stale.executable, [
      "app-server",
      "--listen",
      `unix://${stale.location.socket_path}`
    ], {
      cwd: stale.codexHome,
      env: { ...process.env, CODEX_HOME: stale.codexHome },
      stdio: "ignore"
    });
    await waitForChildExit(staleChild);
    expect(existsSync(stale.location.socket_path)).toBe(true);
    await expectBrokerError(start(stale, "attach_only"), "socket_stale");
    expect(existsSync(stale.location.socket_path)).toBe(true);

    const insecure = createFixture("serve", true);
    const external = spawn(insecure.executable, [
      "app-server",
      "--listen",
      `unix://${insecure.location.socket_path}`
    ], {
      cwd: insecure.codexHome,
      env: { ...process.env, CODEX_HOME: insecure.codexHome },
      stdio: "ignore"
    });
    externalChildren.add(external);
    await waitForSocket(insecure.location.socket_path);
    chmodSync(insecure.location.socket_path, 0o666);
    await expectBrokerError(start(insecure, "attach_only"), "insecure_path");
    expect(mode(insecure.location.socket_path)).toBe(0o666);
  });

  it("rejects insecure control-directory permissions without repairing them", async () => {
    const fixture = createFixture("serve", true);
    chmodSync(fixture.controlDirectory, 0o755);
    await expectBrokerError(start(fixture), "insecure_path");
    expect(mode(fixture.controlDirectory)).toBe(0o755);
    expect(readStartCount(fixture.startLog)).toBe(0);
  });

  it("does not signal a process after durable ownership proof is altered", async () => {
    const fixture = createFixture("serve");
    await start(fixture);
    ownedLocations.set(fixture.root, fixture.location);
    const original = readFileSync(fixture.ownerRecord, "utf8");
    const owner = JSON.parse(original) as Record<string, unknown>;
    const pid = owner.pid as number;
    writeFileSync(
      fixture.ownerRecord,
      `${JSON.stringify({ ...owner, start_ticks: "1" })}\n`,
      { mode: 0o600 }
    );

    await expectBrokerError(
      stopOwnedSharedCodexBroker({
        location: fixture.location,
        stop_timeout_ms: 1_000
      }),
      "ownership_ambiguous"
    );
    expect(processIsAlive(pid)).toBe(true);

    writeFileSync(fixture.ownerRecord, original, { mode: 0o600 });
  });

  it("cleans a proven child that exits before readiness without leaving ownership metadata", async () => {
    const fixture = createFixture("exit");
    await expectBrokerError(start(fixture), "broker_exited");
    expect(existsSync(fixture.ownerRecord)).toBe(false);
    expect(existsSync(fixture.location.socket_path)).toBe(false);
    expect(readStartCount(fixture.startLog)).toBe(1);
  });
});

function createFixture(
  behavior: "exit" | "leave_stale" | "serve",
  createControlDirectory = false
) {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-shared-broker-"));
  roots.add(root);
  const codexHome = join(root, "codex-home");
  const controlDirectory = join(codexHome, "app-server-control");
  const socketPath = join(controlDirectory, "app-server-control.sock");
  const startLog = join(root, "starts.log");
  const executable = join(root, `fake-codex-${behavior}`);
  mkdirSync(codexHome, { mode: 0o700 });
  if (createControlDirectory) mkdirSync(controlDirectory, { mode: 0o700 });
  writeFileSync(executable, fakeCodexSource(behavior, startLog), {
    mode: 0o700
  });
  const location: SharedCodexEndpointLocation = Object.freeze({
    kind: "standard_unix",
    codex_home: codexHome,
    socket_path: socketPath
  });
  return Object.freeze({
    root,
    codexHome,
    controlDirectory,
    startLog,
    executable,
    location,
    ownerRecord: join(controlDirectory, "hostdeck-broker-owner.json")
  });
}

function fakeCodexSource(
  behavior: "exit" | "leave_stale" | "serve",
  startLog: string
): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const endpoint = process.argv.find((value) => value.startsWith("unix://"));
if (!endpoint) process.exit(64);
const socketPath = endpoint.slice("unix://".length);
fs.appendFileSync(${JSON.stringify(startLog)}, "started\\n", { mode: 0o600 });
if (${JSON.stringify(behavior)} === "exit") {
  setTimeout(() => process.exit(23), 75);
} else {
  process.umask(0o177);
  const server = net.createServer((socket) => socket.end());
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    if (${JSON.stringify(behavior)} === "leave_stale") process.exit(0);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
`;
}

async function start(
  fixture: ReturnType<typeof createFixture>,
  mode: "attach_only" | "attach_or_start" = "attach_or_start"
) {
  return startSharedCodexBroker(
    {
      codex_bin: fixture.executable,
      location: fixture.location,
      mode,
      observed_version: "0.148.0",
      startup_timeout_ms: 3_000
    },
    { compatibilityProbe: async () => undefined }
  );
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() <= deadline) {
    if (
      existsSync(path) &&
      lstatSync(path).isSocket() &&
      mode(path) === 0o600 &&
      (await canConnect(path))
    ) {
      return;
    }
    await delay(20);
  }
  throw new Error("Fake broker socket did not become ready.");
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fake broker process did not exit.")),
      3_000
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(path: string): { readonly pid: number } {
  return JSON.parse(readFileSync(path, "utf8")) as { readonly pid: number };
}

function readStartCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectBrokerError(
  promise: Promise<unknown>,
  code: HostDeckSharedCodexBrokerError["code"]
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HostDeckSharedCodexBrokerError);
  expect(failure).toMatchObject({ code });
}
