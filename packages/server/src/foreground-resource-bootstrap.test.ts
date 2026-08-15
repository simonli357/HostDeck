import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type SharedCodexEndpoint,
  sharedCodexEndpointSchema,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import {
  acquireHostDeckDaemonLease,
  defaultMigrations,
  HostDeckDaemonLeaseError,
  prepareHostDeckDaemonLeasePath,
  resolveHostDeckLocalPaths
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostDeckForegroundResources,
  assertHostDeckServiceResources,
  HostDeckForegroundResourceError,
  type StartHostDeckForegroundResourcesInput,
  startHostDeckForegroundResources,
  startHostDeckServiceResources
} from "./foreground-resource-bootstrap.js";
import type {
  SharedCodexBrokerAttachment,
  StartSharedCodexBrokerInput
} from "./shared-codex-broker-lifecycle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("HostDeck foreground resource bootstrap", () => {
  it("rejects hostile or unusable configuration before owned mutation", async () => {
    const layout = fixtureLayout("invalid");
    const broker = fakeBroker();
    const nonExecutable = join(layout.root, "not-executable");
    const executableLink = join(layout.root, "codex-link");
    writeFileSync(nonExecutable, "not executable", { mode: 0o600 });
    symlinkSync(layout.executable, executableLink);

    let accessorRead = false;
    const hostile = Object.defineProperty({ ...layout.input }, "codex_bin", {
      enumerable: true,
      get() {
        accessorRead = true;
        return layout.executable;
      }
    });
    for (const candidate of [
      { ...layout.input, codex_bin: "codex" },
      { ...layout.input, codex_bin: join(layout.root, "missing") },
      { ...layout.input, codex_bin: nonExecutable },
      { ...layout.input, codex_bin: executableLink },
      { ...layout.input, codex_home: "relative" },
      { ...layout.input, loopback_port: 80 },
      { ...layout.input, resource_budget: { ...defaultResourceBudget } },
      { ...layout.input, unexpected: true },
      hostile
    ]) {
      const error = await captureStartError(
        candidate as StartHostDeckForegroundResourcesInput,
        broker.start
      );
      expect(error).toMatchObject({
        name: "HostDeckForegroundResourceError",
        code: "invalid_config",
        stage: "configuration"
      });
      expect(String(error)).not.toContain(layout.root);
      expect(existsSync(layout.stateDir)).toBe(false);
    }

    let dependencyAccessorRead = false;
    const hostileDependencies = Object.defineProperty({}, "startSharedBroker", {
      enumerable: true,
      get() {
        dependencyAccessorRead = true;
        return broker.start;
      }
    });
    await expect(
      startHostDeckForegroundResources(layout.input, hostileDependencies as never)
    ).rejects.toMatchObject({ code: "invalid_config", stage: "configuration" });
    expect(accessorRead).toBe(false);
    expect(dependencyAccessorRead).toBe(false);
    expect(broker.startCalls).toBe(0);
  });

  it("acquires resources in order and closes only its broker attachment before storage and lease", async () => {
    const layout = fixtureLayout("success");
    const events: string[] = [];
    const broker = fakeBroker({
      onStart() {
        events.push("broker:attach");
        expect(existsSync(layout.configDir)).toBe(true);
        expect(existsSync(layout.runtimeDir)).toBe(true);
        expect(existsSync(layout.databasePath)).toBe(true);
        expectLeaseHeld(layout.leasePath);
      },
      onClose() {
        events.push("broker:detach");
        expect(existsSync(layout.databasePath)).toBe(true);
        expectLeaseHeld(layout.leasePath);
      }
    });

    const resources = await startHostDeckForegroundResources(layout.input, {
      startSharedBroker: broker.start,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      pid: 12_345
    });

    expect(broker.inputs).toEqual([
      {
        codex_bin: layout.executable,
        location: {
          kind: "standard_unix",
          codex_home: layout.codexHome,
          socket_path: layout.socketPath
        },
        mode: "attach_or_start",
        observed_version: sharedCodexRuntimeVersion,
        startup_timeout_ms: defaultResourceBudget.lifecycle_startup_timeout_ms
      }
    ]);
    expect(resources.bind).toEqual({
      host: "127.0.0.1",
      port: layout.input.loopback_port,
      transport: "http"
    });
    expect(resources.paths.database_path).toBe(layout.databasePath);
    expect(resources.codex_bin).toBe(layout.executable);
    expect(resources.codex_version).toBe(sharedCodexRuntimeVersion);
    expect(resources.database.open).toBe(true);
    expect(resources.migration.currentVersion).toBe(
      defaultMigrations.at(-1)?.version
    );
    expect(resources.runtime).toEqual({
      preparation: "ready",
      endpoint: broker.endpoint,
      location: broker.inputs[0]?.location,
      socket_path: layout.socketPath
    });
    expect(Object.isFrozen(resources.runtime)).toBe(true);
    expect(() => assertHostDeckForegroundResources(resources)).not.toThrow();
    expect(() => assertHostDeckServiceResources(resources)).toThrow(TypeError);
    expect(lstatSync(layout.databasePath).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(readFileSync(layout.leasePath, "utf8"))).toEqual({
      pid: 12_345,
      acquired_at: "2026-07-20T12:00:00.000Z"
    });
    expect(resources.snapshot()).toMatchObject({
      phase: "ready",
      codex_version: sharedCodexRuntimeVersion,
      database_open: true,
      lease_held: true,
      runtime_preparation: "ready",
      runtime: { state: "ready", ownership: "owned" }
    });

    const firstClose = resources.close();
    expect(resources.close()).toBe(firstClose);
    await firstClose;

    expect(events).toEqual(["broker:attach", "broker:detach"]);
    expect(broker.closeCalls).toBe(1);
    expect(resources.database.open).toBe(false);
    expect(resources.snapshot()).toMatchObject({
      phase: "closed",
      database_open: false,
      lease_held: false
    });
    acquireAndRelease(layout.leasePath);
  });

  it("retains valid version drift without touching the shared endpoint", async () => {
    const layout = fixtureLayout("version-drift");
    const broker = fakeBroker();
    const resources = await startHostDeckForegroundResources(layout.input, {
      codexVersionProbe: async () => "0.145.0",
      startSharedBroker: broker.start
    });

    expect(broker.startCalls).toBe(0);
    expect(resources.runtime).toMatchObject({
      preparation: "version_incompatible",
      socket_path: layout.socketPath,
      endpoint: {
        state: "failed",
        ownership: "none",
        observed_version: "0.145.0"
      }
    });
    await resources.close();
    expect(broker.closeCalls).toBe(0);
    acquireAndRelease(layout.leasePath);
  });

  it("exposes ordered idempotent shutdown ports", async () => {
    const layout = fixtureLayout("staged-shutdown");
    const broker = fakeBroker();
    const resources = await startHostDeckForegroundResources(layout.input, {
      startSharedBroker: broker.start
    });

    const earlyStorage = cleanupDeadline();
    await expect(resources.shutdown.storage.close(earlyStorage)).rejects.toThrow(
      "cannot close before"
    );
    earlyStorage.dispose();

    const runtimeDeadline = cleanupDeadline();
    const detached = resources.shutdown.supervisor.close(runtimeDeadline);
    expect(resources.shutdown.supervisor.close(runtimeDeadline)).toBe(detached);
    await detached;
    runtimeDeadline.dispose();
    expect(broker.closeCalls).toBe(1);
    expect(resources.database.open).toBe(true);

    const storageDeadline = cleanupDeadline();
    await resources.shutdown.storage.close(storageDeadline);
    storageDeadline.dispose();
    const leaseDeadline = cleanupDeadline();
    await resources.shutdown.lease.release(leaseDeadline);
    leaseDeadline.dispose();
    await resources.close();
    expect(broker.closeCalls).toBe(1);
    acquireAndRelease(layout.leasePath);
  });

  it("stops before broker access for lease, path, and database failures", async () => {
    const held = fixtureLayout("held");
    prepareHostDeckDaemonLeasePath(localPaths(held));
    const owner = acquireHostDeckDaemonLease({ lease_path: held.leasePath });
    const heldBroker = fakeBroker();
    try {
      await expect(
        startHostDeckForegroundResources(held.input, {
          startSharedBroker: heldBroker.start
        })
      ).rejects.toMatchObject({ code: "lease_held", stage: "lease" });
      expect(heldBroker.startCalls).toBe(0);
    } finally {
      owner.release();
    }

    const insecure = fixtureLayout("insecure-parent");
    const runtimeParent = join(insecure.root, "runtime-parent");
    const runtimeDir = join(runtimeParent, "runtime");
    mkdirSync(runtimeParent, { mode: 0o755 });
    chmodSync(runtimeParent, 0o755);
    const insecureBroker = fakeBroker();
    await expect(
      startHostDeckForegroundResources(
        { ...insecure.input, runtime_dir: runtimeDir },
        { startSharedBroker: insecureBroker.start }
      )
    ).rejects.toMatchObject({ code: "path_failed", stage: "paths" });
    expect(insecureBroker.startCalls).toBe(0);
    acquireAndRelease(insecure.leasePath);

    const corrupt = fixtureLayout("corrupt-database");
    mkdirSync(corrupt.stateDir, { mode: 0o700 });
    writeFileSync(corrupt.databasePath, "not sqlite", { mode: 0o600 });
    const corruptBroker = fakeBroker();
    await expect(
      startHostDeckForegroundResources(corrupt.input, {
        startSharedBroker: corruptBroker.start
      })
    ).rejects.toMatchObject({ code: "database_failed", stage: "database" });
    expect(corruptBroker.startCalls).toBe(0);
    expect(readFileSync(corrupt.databasePath, "utf8")).toBe("not sqlite");
    acquireAndRelease(corrupt.leasePath);
  });

  it("rolls back broker failures and invalid attachment state", async () => {
    for (const testCase of ["rejected", "aborted", "invalid"] as const) {
      const layout = fixtureLayout(testCase);
      const controller = new AbortController();
      const broker = fakeBroker({
        ...(testCase === "rejected"
          ? { startError: new Error("private broker failure") }
          : {}),
        ...(testCase === "aborted"
          ? {
              onStart() {
                controller.abort(new Error("private abort reason"));
                throw controller.signal.reason;
              }
            }
          : {}),
        ...(testCase === "invalid"
          ? {
              endpoint: sharedCodexEndpointSchema.parse({
                kind: "standard_unix",
                state: "absent",
                ownership: "none",
                generation: 0,
                observed_version: null,
                reason: null
              })
            }
          : {})
      });
      await expect(
        startHostDeckForegroundResources(
          {
            ...layout.input,
            ...(testCase === "aborted" ? { signal: controller.signal } : {})
          },
          { startSharedBroker: broker.start }
        )
      ).rejects.toMatchObject({
        code: testCase === "aborted" ? "startup_aborted" : "runtime_failed",
        stage: "runtime"
      });
      expect(broker.startCalls).toBe(1);
      expect(broker.closeCalls).toBe(testCase === "invalid" ? 1 : 0);
      acquireAndRelease(layout.leasePath);
    }
  });

  it("continues storage and lease cleanup when attachment close fails", async () => {
    const layout = fixtureLayout("cleanup-failure");
    const broker = fakeBroker({ closeError: new Error("private close failure") });
    const resources = await startHostDeckForegroundResources(layout.input, {
      startSharedBroker: broker.start
    });

    await expect(resources.close()).rejects.toBeInstanceOf(
      HostDeckForegroundResourceError
    );
    expect(resources.database.open).toBe(false);
    expect(resources.snapshot()).toMatchObject({
      phase: "failed",
      database_open: false,
      lease_held: false
    });
    acquireAndRelease(layout.leasePath);
  });
});

describe("HostDeck service resource bootstrap", () => {
  it("attaches only and never claims broker process ownership", async () => {
    const layout = fixtureLayout("service-success");
    mkdirSync(layout.runtimeDir, { mode: 0o700 });
    const broker = fakeBroker({ ownership: "attached" });

    const resources = await startHostDeckServiceResources(layout.input, {
      startSharedBroker: broker.start
    });

    expect(broker.inputs[0]?.mode).toBe("attach_only");
    expect(resources.runtime.endpoint).toMatchObject({
      state: "ready",
      ownership: "attached"
    });
    expect(() => assertHostDeckServiceResources(resources)).not.toThrow();
    expect(() => assertHostDeckForegroundResources(resources)).toThrow(TypeError);
    await resources.close();
    expect(broker.closeCalls).toBe(1);
    expect(existsSync(layout.runtimeDir)).toBe(true);
    acquireAndRelease(layout.leasePath);
  });

  it("requires the service runtime directory before broker attachment", async () => {
    const layout = fixtureLayout("service-missing-runtime");
    const broker = fakeBroker({ ownership: "attached" });
    await expect(
      startHostDeckServiceResources(layout.input, {
        startSharedBroker: broker.start
      })
    ).rejects.toMatchObject({ code: "path_failed", stage: "paths" });
    expect(broker.startCalls).toBe(0);
  });
});

interface FixtureLayout {
  readonly root: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly databasePath: string;
  readonly leasePath: string;
  readonly codexHome: string;
  readonly socketPath: string;
  readonly executable: string;
  readonly input: StartHostDeckForegroundResourcesInput;
}

function fixtureLayout(label: string): FixtureLayout {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-bootstrap-${label}-`));
  roots.push(root);
  chmodSync(root, 0o700);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const databasePath = join(stateDir, "hostdeck.sqlite");
  const leasePath = join(stateDir, "hostdeck.lock");
  const codexHome = join(root, "codex-home");
  const socketPath = join(
    codexHome,
    "app-server-control",
    "app-server-control.sock"
  );
  const executable = join(root, "codex-fixture");
  writeFileSync(
    executable,
    "#!/bin/sh\nprintf 'codex-cli 0.147.0\\n'\n",
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  return {
    root,
    configDir,
    stateDir,
    runtimeDir,
    databasePath,
    leasePath,
    codexHome,
    socketPath,
    executable,
    input: Object.freeze({
      config_dir: configDir,
      state_dir: stateDir,
      runtime_dir: runtimeDir,
      database_path: databasePath,
      codex_bin: executable,
      codex_home: codexHome,
      loopback_port: 46_217,
      resource_budget: defaultResourceBudget
    })
  };
}

interface FakeBrokerOptions {
  readonly ownership?: "attached" | "owned";
  readonly endpoint?: SharedCodexEndpoint;
  readonly startError?: unknown;
  readonly closeError?: unknown;
  readonly onStart?: (input: StartSharedCodexBrokerInput) => void | Promise<void>;
  readonly onClose?: () => void | Promise<void>;
}

function fakeBroker(options: FakeBrokerOptions = {}) {
  const endpoint =
    options.endpoint ??
    sharedCodexEndpointSchema.parse({
      kind: "standard_unix",
      state: "ready",
      ownership: options.ownership ?? "owned",
      generation: 1,
      observed_version: sharedCodexRuntimeVersion,
      reason: null
    });
  const inputs: StartSharedCodexBrokerInput[] = [];
  const harness = {
    endpoint,
    inputs,
    startCalls: 0,
    closeCalls: 0,
    start: (async (input: StartSharedCodexBrokerInput) => {
      harness.startCalls += 1;
      inputs.push(input);
      await options.onStart?.(input);
      if (options.startError !== undefined) throw options.startError;
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
          harness.closeCalls += 1;
          await options.onClose?.();
          if (options.closeError !== undefined) throw options.closeError;
        }
      });
      return attachment;
    }) as typeof import("./shared-codex-broker-lifecycle.js").startSharedCodexBroker
  };
  return harness;
}

function localPaths(layout: FixtureLayout) {
  return resolveHostDeckLocalPaths({
    config_dir: layout.configDir,
    database_path: layout.databasePath,
    runtime_dir: layout.runtimeDir,
    state_dir: layout.stateDir
  });
}

async function captureStartError(
  input: StartHostDeckForegroundResourcesInput,
  startSharedBroker: typeof import("./shared-codex-broker-lifecycle.js").startSharedCodexBroker
): Promise<unknown> {
  try {
    await startHostDeckForegroundResources(input, { startSharedBroker });
  } catch (error) {
    return error;
  }
  throw new Error("Expected HostDeck foreground resource startup to fail.");
}

function expectLeaseHeld(leasePath: string): void {
  try {
    acquireHostDeckDaemonLease({ lease_path: leasePath });
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckDaemonLeaseError);
    expect(error).toMatchObject({ code: "lease_held" });
    return;
  }
  throw new Error("Expected HostDeck daemon lease to be held.");
}

function acquireAndRelease(leasePath: string): void {
  const lease = acquireHostDeckDaemonLease({ lease_path: leasePath });
  lease.release();
}

function cleanupDeadline(): ReturnType<typeof createOperationDeadline> {
  return createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
  });
}
