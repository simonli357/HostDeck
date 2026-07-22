import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  codexBindingDescriptor,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  remoteIngressAdmissionProofSchema,
  remoteIngressStateSchema,
  resolveResourceBudget
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, expect, it, vi } from "vitest";
import { hostDeckDeviceCookieName } from "./fastify-request-authentication.js";
import type { HostDeckProcessTerminationSignal } from "./production-foreground-serve.js";
import {
  type HostDeckProductionForegroundServe,
  startHostDeckProductionForegroundServe
} from "./production-foreground-serve.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_PRODUCTION_SERVE_SMOKE === "1";
const rawDeviceToken = "S".repeat(43);
const rawCsrfToken = "C".repeat(43);
const sessionId = "sess_production_serve_smoke_001";
const remoteEnableOperationId =
  "op_production_serve_smoke_remote_enable_001";

describe.skipIf(!requireSmoke)("exact production foreground serve smoke", () => {
  it(
    "serves local API/static/SSE without Tailscale and signal-closes for same-port restart",
    async () => {
      const codexCandidate = process.env.HOSTDECK_CODEX_BIN;
      const root = mkdtempSync(
        join(process.cwd(), "node_modules", ".hd-ps-")
      );
      const configDir = join(root, "config");
      const stateDir = join(root, "state");
      const runtimeDir = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const buildRoot = join(root, "build");
      const commandDir = join(root, "bin");
      const homeDir = join(root, "home");
      const databasePath = join(stateDir, "hostdeck.sqlite");
      const socketPath = join(runtimeDir, "app-server.sock");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousHome = process.env.HOME;
      const previousPath = process.env.PATH;
      let service: HostDeckProductionForegroundServe | null = null;
      let restarted: HostDeckProductionForegroundServe | null = null;
      let emitSignal: ((signal: HostDeckProcessTerminationSignal) => void) | null =
        null;
      let signalSubscriptions = 0;
      let signalUnsubscriptions = 0;
      let primary: unknown = null;
      const cleanupErrors: unknown[] = [];

      try {
        chmodSync(root, 0o700);
        mkdirSync(codexHome, { mode: 0o700 });
        mkdirSync(commandDir, { mode: 0o700 });
        mkdirSync(homeDir, { mode: 0o700 });
        symlinkSync(process.execPath, join(commandDir, "node"));
        process.env.CODEX_HOME = codexHome;
        process.env.HOME = homeDir;
        process.env.PATH = commandDir;
        const codexBin = requireExactCodexBinary(codexCandidate);
        createStaticFixture(buildRoot);
        const port = await availableLoopbackPort();
        createDurableFixture(databasePath, port);
        const budget = resolveResourceBudget({
          sse_heartbeat_interval_ms: 1_000
        });
        const signalDependencies = {
          subscribe_termination_signals(
            listener: (signal: HostDeckProcessTerminationSignal) => void
          ) {
            signalSubscriptions += 1;
            emitSignal = listener;
            let closed = false;
            return () => {
              if (closed) return;
              closed = true;
              signalUnsubscriptions += 1;
              emitSignal = null;
            };
          }
        };
        const start = () =>
          startHostDeckProductionForegroundServe(
            {
              browser_routes: ["/", "/sessions/:session_id"],
              codex_bin: codexBin,
              config_dir: configDir,
              database_path: databasePath,
              loopback_port: port,
              observe_issue: () => undefined,
              resource_budget: budget,
              runtime_dir: runtimeDir,
              state_dir: stateDir,
              static_build_root: buildRoot
            },
            signalDependencies
          );

        service = await start();
        expect(service.snapshot()).toMatchObject({
          phase: "ready",
          application: {
            phase: "runtime_ready",
            route_registration_count: 23,
            reconnect: { phase: "ready", current_generation: 1 },
            reconciliation: { phase: "ready", cycle_count: 1 }
          },
          listener: {
            bound: { host: "127.0.0.1", port, transport: "http" },
            listening: true,
            phase: "ready"
          },
          listener_health: "ready",
          remote_phase: "running",
          reported_issue_count: 0,
          observer_failure_count: 0
        });
        await vi.waitFor(
          () => {
            expect(service?.snapshot()).toMatchObject({
              phase: "ready",
              remote_availability: "unavailable",
              remote_reason: "client_not_installed"
            });
          },
          { interval: 25, timeout: 5_000 }
        );
        expect(existsSync(socketPath)).toBe(true);

        const live = await fetch(
          `${service.local_origin}/api/v1/health/live`,
          { headers: { connection: "close" } }
        );
        expect(live.status).toBe(200);
        expect(await live.json()).toEqual({ status: "alive" });
        const index = await fetch(`${service.local_origin}/`, {
          headers: { connection: "close" }
        });
        expect(index.status).toBe(200);
        expect(await index.text()).toContain("PRODUCTION_SERVE_SMOKE");
        const asset = await fetch(
          `${service.local_origin}/assets/app-12345678.js`,
          { headers: { connection: "close" } }
        );
        expect(asset.status).toBe(200);
        expect(asset.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable"
        );

        const sse = openAuthenticatedSse(service.local_origin, port);
        await expect(withTimeout(sse.started, 5_000)).resolves.toMatchObject({
          status: 200,
          contentType: "text/event-stream"
        });
        const firstSnapshot = JSON.stringify(service.snapshot());
        expect(firstSnapshot).not.toContain(root);
        expect(firstSnapshot).not.toContain(rawDeviceToken);
        expect(firstSnapshot).not.toContain(rawCsrfToken);
        expect(firstSnapshot).not.toContain("external_origin");
        expect(firstSnapshot).not.toContain("ts.net");

        requireSignalEmitter(emitSignal)("SIGTERM");
        await expect(service.terminated).resolves.toMatchObject({
          phase: "closed",
          termination_trigger: "sigterm",
          listener: { listening: false, phase: "closed" },
          listener_health: "closed",
          remote_phase: "closed",
          application: {
            phase: "closed",
            shutdown: {
              phase: "closed",
              completed_stage_count: 10,
              failed_stage_count: 0
            }
          }
        });
        await expect(withTimeout(sse.ended, 5_000)).resolves.toBeUndefined();
        service = null;
        expect(signalSubscriptions).toBe(1);
        expect(signalUnsubscriptions).toBe(1);
        expect(existsSync(socketPath)).toBe(false);
        await assertLoopbackPortAvailable(port);

        restarted = await start();
        expect(restarted.snapshot()).toMatchObject({
          phase: "ready",
          listener: { listening: true, phase: "ready" },
          listener_health: "ready"
        });
        const restartedLive = await fetch(
          `${restarted.local_origin}/api/v1/health/live`,
          { headers: { connection: "close" } }
        );
        expect(restartedLive.status).toBe(200);
        await restarted.close();
        restarted = null;
        expect(signalSubscriptions).toBe(2);
        expect(signalUnsubscriptions).toBe(2);
        expect(existsSync(socketPath)).toBe(false);
        await assertLoopbackPortAvailable(port);
        assertObservationOnlyRemoteState(databasePath);
        expect(
          readdirSync(codexHome, { recursive: true }).some((entry) =>
            String(entry).endsWith(".jsonl")
          )
        ).toBe(false);
      } catch (error) {
        primary = error;
      } finally {
        if (service !== null) {
          try {
            await service.close();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (restarted !== null) {
          try {
            await restarted.close();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        try {
          rmSync(root, { force: true, recursive: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (primary !== null && cleanupErrors.length === 0) throw primary;
      if (primary !== null || cleanupErrors.length > 0) {
        throw new AggregateError(
          primary === null ? cleanupErrors : [primary, ...cleanupErrors],
          "Production foreground serve smoke cleanup failed."
        );
      }
      expect(existsSync(root)).toBe(false);
    },
    120_000
  );
});

function requireExactCodexBinary(candidate: string | undefined): string {
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError(
      "Production foreground serve smoke requires an absolute Codex binary."
    );
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError(
      "Production foreground serve Codex binary is unavailable."
    );
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new TypeError(
      "Production foreground serve Codex binary is insecure."
    );
  }
  const version = parseCodexCliVersionOutput(
    execFileSync(path, ["--version"], {
      cwd: "/",
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1_024
    })
  );
  if (version !== codexBindingDescriptor.codex_version) {
    throw new TypeError(
      "Production foreground serve Codex version is unsupported."
    );
  }
  return path;
}

function createStaticFixture(buildRoot: string): void {
  mkdirSync(join(buildRoot, "assets"), {
    recursive: true,
    mode: 0o700
  });
  writeFileSync(
    join(buildRoot, "index.html"),
    "<!doctype html><html><body>PRODUCTION_SERVE_SMOKE</body></html>\n",
    { mode: 0o600 }
  );
  writeFileSync(join(buildRoot, "assets", "app-12345678.js"), "export {};\n", {
    mode: 0o600
  });
}

function createDurableFixture(databasePath: string, port: number): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const opened = openMigratedDatabase(databasePath, {
    now: () => new Date("2026-07-20T12:00:00.000Z")
  });
  try {
    createAuthDeviceRepository(opened.db).create({
      id: "device:production:serve-smoke",
      rawDeviceToken,
      rawCsrfToken,
      permission: "read",
      clientLabel: "Android phone",
      createdAt: new Date()
    });
    createSelectedStateRepository(opened.db).create(missingRuntimeSession());
    seedEnabledRemoteIngress(opened.db, port);
  } finally {
    opened.db.close();
  }
  chmodSync(databasePath, 0o600);
}

function seedEnabledRemoteIngress(
  db: Parameters<typeof createRemoteIngressStateRepository>[0],
  port: number
): void {
  const externalOrigin = "https://hostdeck-smoke.fixture-tailnet.ts.net";
  const profileKey = `sha256:${"1".repeat(64)}`;
  const stateAt = "2026-07-20T12:00:02.000Z";
  createRemoteIngressStateRepository(db).compareAndSet({
    expected_generation: null,
    state: remoteIngressStateSchema.parse({
      schema_version: 1,
      generation: 1,
      intent: "enabled",
      availability: "ready",
      admission: "open",
      observation: "current",
      client: "available",
      profile: {
        state: "dedicated",
        comparison: {
          relation: "match",
          expected_profile_key: profileKey,
          active_profile_key: profileKey
        }
      },
      serve: "exact",
      expected_serve: {
        external_origin: externalOrigin,
        https_port: 443,
        path: "/",
        proxy_origin: `http://127.0.0.1:${port}`,
        visibility: "private"
      },
      external_origin: externalOrigin,
      operation_failure: null,
      reason: null,
      observed_at: stateAt,
      updated_at: stateAt
    })
  });
  const audits = createSelectedAuditRepository(db);
  const actor = {
    type: "cli",
    device_id: null,
    permission: "local_admin",
    origin: null
  } as const;
  const target = { type: "host", host_id: "local_host" } as const;
  audits.recordAccepted({
    id: `audit:${remoteEnableOperationId}:remote_enable:accepted`,
    operation_id: remoteEnableOperationId,
    at: "2026-07-20T12:00:01.000Z",
    actor,
    action: "remote_enable",
    target,
    phase: "accepted",
    outcome: "accepted",
    payload_summary: {
      schema_version: 1,
      action: "remote_enable",
      requested_intent: "enabled",
      profile_state: "dedicated",
      serve_state: "absent",
      phase: "accepted",
      outcome: "accepted"
    },
    error_code: null
  });
  audits.recordTerminal({
    id: `audit:${remoteEnableOperationId}:remote_enable:terminal`,
    operation_id: remoteEnableOperationId,
    at: "2026-07-20T12:00:03.000Z",
    actor,
    action: "remote_enable",
    target,
    phase: "terminal",
    outcome: "succeeded",
    payload_summary: {
      schema_version: 1,
      action: "remote_enable",
      requested_intent: "enabled",
      profile_state: "dedicated",
      serve_state: "exact",
      phase: "terminal",
      outcome: "succeeded",
      admission: "open",
      intent_persisted: true,
      serve_result: "applied",
      reason: null
    },
    error_code: null
  });
  createRemoteIngressAdmissionProofRepository(db).prove(
    remoteIngressAdmissionProofSchema.parse({
      schema_version: 1,
      operation_id: remoteEnableOperationId,
      generation: 1,
      proven_at: "2026-07-20T12:00:04.000Z"
    })
  );
}

function assertObservationOnlyRemoteState(databasePath: string): void {
  const opened = openMigratedDatabase(databasePath, {
    now: () => new Date("2026-07-20T12:00:05.000Z")
  });
  try {
    expect(createRemoteIngressStateRepository(opened.db).read()).toMatchObject({
      generation: 2,
      intent: "enabled",
      availability: "unavailable",
      admission: "closed",
      client: "not_installed",
      operation_failure: null,
      reason: "client_not_installed"
    });
    expect(
      createRemoteIngressAdmissionProofRepository(opened.db).read()
    ).toMatchObject({
      operation_id: remoteEnableOperationId,
      generation: 1
    });
    expect(
      opened.db
        .prepare(
          "SELECT COUNT(*) AS count FROM selected_audit_events WHERE action IN ('remote_enable', 'remote_disable')"
        )
        .get()
    ).toEqual({ count: 2 });
  } finally {
    opened.db.close();
  }
}

function missingRuntimeSession(): Readonly<Record<string, unknown>> {
  const createdAt = "2026-07-20T12:00:00.000Z";
  const mapping = {
    id: sessionId,
    name: "production-serve-smoke",
    codex_thread_id: "thread-production-serve-smoke-001",
    cwd: "/tmp/hostdeck-production-serve-smoke-session",
    runtime_source: "codex_app_server",
    runtime_version: codexBindingDescriptor.codex_version,
    disposition: "selected",
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null
  } as const;
  return Object.freeze({
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: mapping.archived_at,
        session_state: "active",
        turn_state: "in_progress",
        attention: "watch",
        freshness: "current",
        freshness_reason: null,
        updated_at: mapping.updated_at,
        last_activity_at: createdAt,
        branch: "main",
        model: null,
        settings: null,
        goal: null,
        recent_summary: "Managed projection created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  });
}

function openAuthenticatedSse(
  origin: string,
  port: number
): {
  readonly ended: Promise<void>;
  readonly started: Promise<Readonly<{ status: number; contentType: string }>>;
} {
  let resolveEnded!: () => void;
  let resolveStarted!: (value: Readonly<{
    status: number;
    contentType: string;
  }>) => void;
  let rejectStarted!: (cause: unknown) => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const started = new Promise<Readonly<{ status: number; contentType: string }>>(
    (resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    }
  );
  const request = httpRequest(
    new URL(`/api/v1/sessions/${sessionId}/events/stream`, origin),
    {
      headers: {
        accept: "text/event-stream",
        cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
        host: `127.0.0.1:${port}`
      },
      method: "GET"
    },
    (response) => {
      resolveStarted({
        status: response.statusCode ?? 0,
        contentType: String(response.headers["content-type"] ?? "")
      });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveEnded();
      };
      response.once("end", finish);
      response.once("close", finish);
      response.once("error", finish);
      response.resume();
    }
  );
  request.once("error", (error) => {
    rejectStarted(error);
    resolveEnded();
  });
  request.end();
  return { ended, started };
}

function requireSignalEmitter(
  candidate: ((signal: HostDeckProcessTerminationSignal) => void) | null
): (signal: HostDeckProcessTerminationSignal) => void {
  if (candidate === null) {
    throw new Error("Production serve signal owner was not installed.");
  }
  return candidate;
}

function availableLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected an IPv4 loopback test address."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolveAvailable();
      });
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Production serve smoke operation timed out.")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
