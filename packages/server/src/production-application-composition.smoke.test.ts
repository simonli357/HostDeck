import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  codexBindingDescriptor,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline, type OperationDeadline } from "@hostdeck/core";
import {
  createRuntimeCompatibilityRepository,
  createSelectedAuditRepository,
  createSelectedStateRepository
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import { startHostDeckForegroundResources } from "./foreground-resource-bootstrap.js";
import {
  createHostDeckProductionApplication,
  type HostDeckProductionApplication
} from "./production-application-composition.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_PRODUCTION_COMPOSITION_SMOKE === "1";

describe.skipIf(!requireSmoke)("exact production application composition smoke", () => {
  it(
    "reaches durable runtime readiness without a model call and leaves no residue",
    async () => {
      const codexBin = requireExactCodexBinary(
        process.env.HOSTDECK_CODEX_BIN
      );
      const root = mkdtempSync(join(tmpdir(), "hd-pg-"));
      chmodSync(root, 0o700);
      const configDir = join(root, "config");
      const stateDir = join(root, "state");
      const runtimeDir = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const buildRoot = join(root, "build");
      const databasePath = join(stateDir, "hostdeck.sqlite");
      const socketPath = join(runtimeDir, "app-server.sock");
      mkdirSync(codexHome, { mode: 0o700 });
      createStaticFixture(buildRoot);
      const port = await availableLoopbackPort();
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      let application: HostDeckProductionApplication | null = null;
      let resources: Awaited<
        ReturnType<typeof startHostDeckForegroundResources>
      > | null = null;
      let primary: unknown = null;
      const cleanupErrors: unknown[] = [];

      try {
        resources = await startHostDeckForegroundResources({
          codex_bin: codexBin,
          config_dir: configDir,
          database_path: databasePath,
          loopback_port: port,
          resource_budget: defaultResourceBudget,
          runtime_dir: runtimeDir,
          state_dir: stateDir
        });
        expect(lstatSync(socketPath).isSocket()).toBe(true);
        const auditRepository = createSelectedAuditRepository(resources.database);
        const stateRepository = createSelectedStateRepository(resources.database);
        auditRepository.recordAccepted(pendingAuditRecord());
        stateRepository.create(missingRuntimeSession());
        application = createHostDeckProductionApplication({
          browser_routes: ["/"],
          observe_issue: () => undefined,
          resources,
          static_build_root: buildRoot
        });

        const started = await withStartupDeadline((deadline) =>
          application?.runtime.start({
            deadline,
            resourceBudget: defaultResourceBudget
          })
        );
        expect(started?.context).toBe(application);
        expect(started?.bind).toEqual({
          host: "127.0.0.1",
          port,
          transport: "http"
        });
        expect(application.snapshot()).toMatchObject({
          phase: "runtime_ready",
          reported_issue_count: 0,
          observer_failure_count: 0,
          startup_maintenance: {
            status: "ready",
            orphan: {
              status: "complete",
              actionable_remaining: false,
              failure: false
            },
            retention: {
              status: "complete",
              output_actionable_remaining: false,
              audit_actionable_remaining: false,
              failure: false
            },
            storage_observation: { state: "ready", reasons: [] }
          },
          reconnect: {
            phase: "ready",
            connection_state: "ready",
            current_generation: 1,
            admitted_generation: 1,
            connect_attempts: 1,
            completed_reconnects: 0,
            last_failure: null
          },
          reconciliation: {
            phase: "ready",
            generation: 1,
            continuity: "boundary_required",
            gap_reason: "restart",
            cycle_count: 1,
            durable_session_count: 1,
            recoverable_session_count: 0,
            unmanaged_runtime_count: 0,
            boundary_count: 1,
            ready_count: 0,
            audits_reconciled: 1,
            issues: {
              archived: 0,
              contradictions: 0,
              missing: 1,
              stale: 1,
              unavailable: 0
            },
            last_failure: null
          }
        });
        expect(application.listener.snapshot()).toBe("not_ready");
        expect(application.remote.snapshot()).toMatchObject({
          phase: "idle",
          poll_cycles: 0,
          poll_failures: 0
        });
        expect(application.health.localSnapshot()).toMatchObject({
          readiness: "not_ready",
          mutation_admission: "closed"
        });
        expect(
          Object.fromEntries(
            application.health.localSnapshot().components.map((component) => [
              component.component,
              component.state
            ])
          )
        ).toEqual({
          compatibility: "ready",
          fanout: "ready",
          lease: "ready",
          listener: "degraded",
          projector: "ready",
          runtime: "ready",
          storage: "ready"
        });
        expect(
          createRuntimeCompatibilityRepository(resources.database).get()
        ).toMatchObject({
          id: "hostdeck_runtime",
          compatibility: {
            state: "ready",
            mutation_policy: "allowed",
            observed_version: codexBindingDescriptor.codex_version,
            binding_id: codexBindingDescriptor.binding_id
          }
        });
        expect(
          auditRepository.require("op_production_reconcile_001")
        ).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", outcome: "accepted", error_code: null },
            {
              phase: "terminal",
              outcome: "incomplete",
              error_code: "runtime_unavailable"
            }
          ]
        });
        expect(
          stateRepository.require("sess_production_reconcile_001")
        ).toMatchObject({
          mapping: { disposition: "recovery_required", archived_at: null },
          projection: {
            session: {
              session_state: "unknown",
              turn_state: "unknown",
              freshness: "stale",
              freshness_reason: "Managed Codex thread is unavailable."
            }
          }
        });
        expect(
          stateRepository
            .listEvents("sess_production_reconcile_001")
            .events.map((event) => event.type)
        ).toEqual(["replay_boundary"]);
        expect(
          JSON.stringify({
            application: application.snapshot(),
            audit: auditRepository.require("op_production_reconcile_001").state,
            events: stateRepository
              .listEvents("sess_production_reconcile_001")
              .events.map((event) => event.type)
          })
        ).not.toContain(root);
        expect(existsSync(socketPath)).toBe(true);
        await assertLoopbackPortAvailable(port);

        await closeApplication(application);
        await resources.runtime.process_exit;
        expect(application.snapshot()).toMatchObject({
          phase: "closed",
          shutdown: {
            phase: "closed",
            completed_stage_count: 10,
            failed_stage_count: 0
          }
        });
        expect(resources.snapshot()).toMatchObject({
          phase: "closed",
          database_open: false,
          lease_held: false,
          runtime: {
            phase: "closed",
            process_state: "exited",
            cleanup_failures: 0
          }
        });
        expect(existsSync(socketPath)).toBe(false);
      } catch (error) {
        primary = error;
      } finally {
        if (application !== null && application.snapshot().phase !== "closed") {
          try {
            await closeApplication(application);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (resources !== null) {
          try {
            await resources.close();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        rmSync(root, { force: true, recursive: true });
      }

      if (primary !== null && cleanupErrors.length === 0) throw primary;
      if (primary !== null || cleanupErrors.length > 0) {
        throw new AggregateError(
          primary === null ? cleanupErrors : [primary, ...cleanupErrors],
          "Production composition smoke cleanup failed."
        );
      }
      expect(existsSync(root)).toBe(false);
    },
    90_000
  );
});

function requireExactCodexBinary(candidate: string | undefined): string {
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError(
      "Production composition smoke requires an absolute Codex binary."
    );
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError("Production composition Codex binary is unavailable.");
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new TypeError("Production composition Codex binary is insecure.");
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
    throw new TypeError("Production composition Codex version is unsupported.");
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
    "<!doctype html><html><body>production composition smoke</body></html>\n",
    { mode: 0o600 }
  );
  writeFileSync(join(buildRoot, "assets", "app-12345678.js"), "export {};\n", {
    mode: 0o600
  });
}

function pendingAuditRecord(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: "audit:production:reconcile:accepted",
    operation_id: "op_production_reconcile_001",
    at: "2026-07-01T12:00:00.000Z",
    actor: {
      type: "dashboard",
      device_id: "device:production:phone",
      permission: "write",
      origin: "https://hostdeck.local"
    },
    action: "prompt",
    target: {
      type: "managed_session",
      session_id: "sess_production_reconcile_001",
      codex_thread_id: "thread-production-reconcile-001"
    },
    phase: "accepted",
    outcome: "accepted",
    payload_summary: { text_length: 8, source: "dashboard" },
    error_code: null
  });
}

function missingRuntimeSession(): Readonly<Record<string, unknown>> {
  const createdAt = "2026-07-01T12:00:00.000Z";
  const mapping = {
    id: "sess_production_reconcile_001",
    name: "production-reconcile",
    codex_thread_id: "thread-production-reconcile-001",
    cwd: "/tmp/hostdeck-production-reconcile",
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

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.port < 1_024) {
    server.close();
    throw new TypeError("Production composition could not reserve a test port.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
  return address.port;
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => resolvePromise());
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

async function closeApplication(
  application: HostDeckProductionApplication
): Promise<void> {
  application.runtime.beginDrain();
  await withCleanupDeadline((deadline) =>
    application.runtime.closeSse(deadline)
  );
  await withCleanupDeadline((deadline) =>
    application.runtime.closeRuntime(deadline)
  );
  await withCleanupDeadline((deadline) =>
    application.runtime.closeStartup(deadline)
  );
}

async function withStartupDeadline<T>(
  operation: (deadline: OperationDeadline) => T | Promise<T>
): Promise<T> {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_startup_timeout_ms
  });
  try {
    return await operation(deadline);
  } finally {
    deadline.dispose();
  }
}

async function withCleanupDeadline<T>(
  operation: (deadline: OperationDeadline) => T | Promise<T>
): Promise<T> {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
  });
  try {
    return await operation(deadline);
  } finally {
    deadline.dispose();
  }
}
