import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexProtocolIssue,
  type CodexRequestInput,
  createCodexAppServerConnection,
  createCodexLoadedThreadClient,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  nativeCodexThreadIdSchema,
  type SharedCodexEndpointLocation
} from "@hostdeck/contracts";
import {
  createProductionProjectionAppendPort,
  createSelectedAuditRepository,
  createSelectedStateRepository,
  deriveAutomaticSessionIdentity,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type AutomaticSessionEnrollmentService,
  createAutomaticSessionEnrollmentService
} from "./automatic-session-enrollment-service.js";
import { createCodexEventPipeline } from "./codex-event-pipeline.js";
import {
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "./shared-codex-broker-lifecycle.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_SHARED_CODEX_SESSIONS_SMOKE === "1";

describe.skipIf(!requireSmoke)("real automatic shared-session enrollment", () => {
  it(
    "enrolls loaded-before and created-after roots, then reconnects without duplicate identity or model work",
    async () => {
      const codexBin = realpathSync.native(resolve(process.env.HOSTDECK_CODEX_BIN ?? which("codex")));
      const version = parseCodexCliVersionOutput(execFileSync(codexBin, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1_024
      }));
      expect(version).toBe("0.147.0");

      const root = mkdtempSync(join(tmpdir(), "hostdeck-shared-enrollment-"));
      const codexHome = join(root, "codex-home");
      const project = join(root, "side-cue-app");
      const databasePath = join(root, "hostdeck.sqlite");
      mkdirSync(codexHome, { mode: 0o700 });
      mkdirSync(project, { mode: 0o700 });
      chmodSync(codexHome, 0o700);
      writeFileSync(
        join(codexHome, "auth.json"),
        `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "hostdeck-smoke-not-a-key" })}\n`,
        { mode: 0o600 }
      );
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          "check_for_update_on_startup = false",
          "[features]",
          "plugins = false",
          `[projects.${JSON.stringify(project)}]`,
          'trust_level = "trusted"',
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      const location: SharedCodexEndpointLocation = Object.freeze({
        kind: "standard_unix",
        codex_home: codexHome,
        socket_path: join(codexHome, "app-server-control", "app-server-control.sock")
      });

      let brokerOwned = false;
      let nativeConnection: CodexAppServerConnection | null = null;
      let hostConnection: CodexAppServerConnection | null = null;
      let restartedConnection: CodexAppServerConnection | null = null;
      let loadedBeforeTui: PlainCodexTui | null = null;
      let createdAfterTui: PlainCodexTui | null = null;
      let service: AutomaticSessionEnrollmentService | null = null;
      let restartedService: AutomaticSessionEnrollmentService | null = null;
      let database: ReturnType<typeof openMigratedDatabase> | null = null;
      const cleanupErrors: unknown[] = [];
      let smokeFailure: Error | null = null;

      try {
        const attachment = await startSharedCodexBroker({
          codex_bin: codexBin,
          location,
          mode: "attach_or_start",
          observed_version: version,
          startup_timeout_ms: 15_000
        });
        brokerOwned = attachment.endpoint.ownership === "owned";
        expect(attachment.endpoint).toMatchObject({ state: "ready", ownership: "owned" });

        nativeConnection = createConnection(location, version);
        await nativeConnection.connect();
        const nativeRequests: CodexRequestInput[] = [];
        loadedBeforeTui = await startPlainCodexThread(
          codexBin,
          codexHome,
          project,
          join(root, "loaded-before-tmux.sock"),
          nativeConnection,
          nativeRequests
        );
        const loadedBefore = loadedBeforeTui.thread_id;
        await materializeWithoutTurn(nativeConnection, nativeRequests, loadedBefore);

        database = openMigratedDatabase(databasePath);
        const states = createSelectedStateRepository(database.db);
        const audit = createSelectedAuditRepository(database.db);
        const events = createCodexEventPipeline({
          repository: states,
          append_port: createProductionProjectionAppendPort({ repository: states, publish() {} }),
          normalizer: { now: () => new Date().toISOString() }
        });
        let operationOrdinal = 0;
        let recordOrdinal = 0;
        const createOperationId = () => {
          operationOrdinal += 1;
          return `op_session_enroll_smoke_${String(operationOrdinal).padStart(4, "0")}`;
        };
        const createRecordId = () => {
          recordOrdinal += 1;
          return `audit_session_enroll_smoke_${String(recordOrdinal).padStart(4, "0")}`;
        };

        const observedMethods: string[] = [];
        const hostRequests: CodexRequestInput[] = [];
        const callback = notificationCallback(observedMethods);
        hostConnection = createConnection(location, version, callback.handle, callback.issues);
        const loaded = createCodexLoadedThreadClient(requestPort(hostConnection, hostRequests));
        service = createAutomaticSessionEnrollmentService({
          loaded,
          states,
          audit,
          events,
          create_operation_id: createOperationId,
          create_record_id: createRecordId,
          capture_branch: () => "main"
        });
        callback.attach(service, () => hostConnection?.generation ?? 0);
        await hostConnection.connect();

        const first = await service.reconcileLoaded("loaded_before", hostConnection.generation);
        if (first.outcomes[0]?.state !== "enrolled") {
          throw new Error(`Loaded-before CLI root was not eligible: ${JSON.stringify(first.outcomes[0])}`);
        }
        expect(first.outcomes).toMatchObject([
          {
            state: "enrolled",
            session: { native_thread_id: loadedBefore, enrollment_origin: "loaded_before" },
            subscribed: true
          }
        ]);
        expect(states.getByThreadId(loadedBefore)?.mapping.id).toBe(
          deriveAutomaticSessionIdentity(loadedBefore, "side-cue-app").internal_session_id
        );

        createdAfterTui = await startPlainCodexThread(
          codexBin,
          codexHome,
          project,
          join(root, "created-after-tmux.sock"),
          nativeConnection,
          nativeRequests
        );
        const createdAfter = createdAfterTui.thread_id;
        await materializeWithoutTurn(nativeConnection, nativeRequests, createdAfter);
        await callback.drain();
        if (states.getByThreadId(createdAfter) === null) {
          await expect(service.retryPending(createdAfter)).resolves.toMatchObject({
            state: "enrolled",
            session: { native_thread_id: createdAfter, enrollment_origin: "created_after" }
          });
        }
        await callback.drain();

        const memberships = states.listSharedMemberships();
        expect(memberships.every((entry) => entry.origin === "automatic")).toBe(true);
        expect(
          memberships
            .flatMap((entry) => (entry.origin === "automatic" ? [entry.native_thread_id] : []))
            .sort()
        ).toEqual([loadedBefore, createdAfter].sort());
        expect(states.list()).toHaveLength(2);
        expect(audit.require("op_session_enroll_smoke_0001")).toMatchObject({
          records: [{ outcome: "accepted" }, { outcome: "succeeded", payload_summary: { created: true } }]
        });
        expect(audit.require("op_session_enroll_smoke_0002")).toMatchObject({
          records: [{ outcome: "accepted" }, { outcome: "succeeded", payload_summary: { created: true } }]
        });
        expect(callback.failures).toEqual([]);
        expect(callback.issues).toEqual([]);
        expect(observedMethods).not.toContain("turn/started");
        expect([...nativeRequests, ...hostRequests].some((request) => request.method === "turn/start")).toBe(false);

        service.close();
        service = null;
        await hostConnection.close("Automatic enrollment smoke reconnecting HostDeck.");
        hostConnection = null;

        const restartObservedMethods: string[] = [];
        const restartRequests: CodexRequestInput[] = [];
        const restartCallback = notificationCallback(restartObservedMethods);
        restartedConnection = createConnection(location, version, restartCallback.handle, restartCallback.issues);
        restartedService = createAutomaticSessionEnrollmentService({
          loaded: createCodexLoadedThreadClient(requestPort(restartedConnection, restartRequests)),
          states,
          audit,
          events,
          create_operation_id: createOperationId,
          create_record_id: createRecordId,
          capture_branch: () => "main"
        });
        restartCallback.attach(restartedService, () => restartedConnection?.generation ?? 0);
        await restartedConnection.connect();
        const restarted = await restartedService.reconcileLoaded("reconciliation", restartedConnection.generation);
        expect(restarted.outcomes).toHaveLength(2);
        expect(restarted.outcomes.every((outcome) => outcome.state === "enrolled")).toBe(true);
        expect(states.list()).toHaveLength(2);
        expect(states.listSharedMemberships()).toHaveLength(2);
        expect(audit.require("op_session_enroll_smoke_0003").records[1]).toMatchObject({
          outcome: "succeeded",
          payload_summary: { created: false }
        });
        expect(audit.require("op_session_enroll_smoke_0004").records[1]).toMatchObject({
          outcome: "succeeded",
          payload_summary: { created: false }
        });
        expect(restartCallback.failures).toEqual([]);
        expect(restartCallback.issues).toEqual([]);
        expect(restartObservedMethods).not.toContain("turn/started");
        expect(restartRequests.some((request) => request.method === "turn/start")).toBe(false);
      } catch (error) {
        smokeFailure = new Error("Real automatic shared-session enrollment failed.", { cause: error });
      }

      if (restartedService !== null) collectSyncCleanup(() => restartedService?.close(), cleanupErrors);
      if (service !== null) collectSyncCleanup(() => service?.close(), cleanupErrors);
      if (restartedConnection !== null) {
        await collectCleanup(restartedConnection.close("Automatic enrollment smoke completed."), cleanupErrors);
      }
      if (hostConnection !== null) {
        await collectCleanup(hostConnection.close("Automatic enrollment smoke completed."), cleanupErrors);
      }
      if (createdAfterTui !== null) collectSyncCleanup(() => createdAfterTui?.close(), cleanupErrors);
      if (loadedBeforeTui !== null) collectSyncCleanup(() => loadedBeforeTui?.close(), cleanupErrors);
      if (nativeConnection !== null) {
        await collectCleanup(nativeConnection.close("Automatic enrollment smoke completed."), cleanupErrors);
      }
      if (database !== null) collectSyncCleanup(() => database?.db.close(), cleanupErrors);
      if (brokerOwned) {
        await collectCleanup(stopOwnedSharedCodexBroker({ location, stop_timeout_ms: 5_000 }), cleanupErrors);
      }
      collectSyncCleanup(() => rmSync(root, { recursive: true, force: true }), cleanupErrors);

      if (smokeFailure !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeFailure, ...cleanupErrors], "Shared-session smoke and cleanup failed.");
      }
      if (smokeFailure !== null) throw smokeFailure;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Shared-session smoke cleanup failed.");
    },
    40_000
  );
});

function createConnection(
  location: SharedCodexEndpointLocation,
  version: string,
  onNotification?: (notification: CodexConnectionNotification) => void,
  issues?: CodexProtocolIssue[]
): CodexAppServerConnection {
  return createCodexAppServerConnection({
    transport: createCodexUnixWebSocketTransport({ socket_path: location.socket_path }),
    observed_version: version,
    expected_codex_home: location.codex_home,
    ...(onNotification === undefined ? {} : { on_notification: onNotification }),
    ...(issues === undefined ? {} : { on_protocol_issue: (issue: CodexProtocolIssue) => issues.push(issue) })
  });
}

function requestPort(connection: CodexAppServerConnection, requests: CodexRequestInput[]) {
  return {
    get compatibility() {
      return connection.compatibility;
    },
    request(input: CodexRequestInput) {
      requests.push(input);
      return connection.request(input);
    }
  };
}

function notificationCallback(observedMethods: string[]) {
  const failures: unknown[] = [];
  const issues: CodexProtocolIssue[] = [];
  const pending = new Set<Promise<unknown>>();
  let service: AutomaticSessionEnrollmentService | null = null;
  let generation: (() => number) | null = null;
  return {
    failures,
    issues,
    attach(value: AutomaticSessionEnrollmentService, readGeneration: () => number) {
      service = value;
      generation = readGeneration;
    },
    handle(notification: CodexConnectionNotification) {
      observedMethods.push(notification.method);
      if (service === null || generation === null) {
        failures.push(new Error("Codex notification arrived before automatic enrollment was attached."));
        return;
      }
      const operation = service.observeNotification(notification, generation());
      pending.add(operation);
      void operation.catch((error: unknown) => failures.push(error)).finally(() => pending.delete(operation));
    },
    async drain() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const work = [...pending];
        if (work.length === 0) return;
        await Promise.allSettled(work);
      }
      throw new Error("Automatic enrollment notification callback did not drain.");
    }
  };
}

async function startPlainCodexThread(
  codexBin: string,
  codexHome: string,
  cwd: string,
  tmuxSocketPath: string,
  connection: CodexAppServerConnection,
  requests: CodexRequestInput[]
): Promise<PlainCodexTui> {
  const before = new Set(await loadedThreadIds(connection, requests));
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  const command = [codexBin, "--no-alt-screen", "-C", cwd].map(shellQuote).join(" ");
  execFileSync(
    "tmux",
    ["-S", tmuxSocketPath, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "codex", command],
    { cwd, env: environment, timeout: 5_000, stdio: "ignore" }
  );

  let threadId: string | null = null;
  let failure: unknown = null;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ids = await loadedThreadIds(connection, requests);
      const created = ids.filter((id) => !before.has(id));
      if (created.length > 1) throw new Error("Plain Codex created more than one loaded root.");
      if (created[0] !== undefined) {
        threadId = created[0];
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    if (threadId === null) throw new Error("Plain Codex did not create one loaded root before timeout.");
  } catch (error) {
    failure = error;
  }

  if (failure !== null) {
    try {
      stopTmux(tmuxSocketPath, environment);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], "Plain Codex startup and cleanup failed.");
    }
    throw failure;
  }
  if (threadId === null) throw new Error("Plain Codex loaded root identity is missing.");
  let closed = false;
  return Object.freeze({
    thread_id: threadId,
    close() {
      if (closed) return;
      stopTmux(tmuxSocketPath, environment);
      closed = true;
    }
  });
}

interface PlainCodexTui {
  readonly thread_id: string;
  readonly close: () => void;
}

async function loadedThreadIds(
  connection: CodexAppServerConnection,
  requests: CodexRequestInput[]
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const result = requireRecord(
      await trackedRequest(connection, requests, {
        method: "thread/loaded/list",
        params: { cursor, limit: 100 },
        kind: "read",
        timeout_ms: 10_000
      }),
      "thread/loaded/list result"
    );
    if (!Array.isArray(result.data)) throw new TypeError("thread/loaded/list data must be an array.");
    ids.push(...result.data.map((id) => nativeCodexThreadIdSchema.parse(id)));
    if (result.nextCursor !== null && typeof result.nextCursor !== "string") {
      throw new TypeError("thread/loaded/list cursor is invalid.");
    }
    cursor = result.nextCursor as string | null;
  } while (cursor !== null);
  return ids;
}

async function materializeWithoutTurn(
  connection: CodexAppServerConnection,
  requests: CodexRequestInput[],
  threadId: string
): Promise<void> {
  await trackedRequest(connection, requests, {
    method: "thread/goal/set",
    params: {
      threadId,
      objective: "Verify automatic shared-session enrollment without model work.",
      status: "paused"
    },
    kind: "mutation",
    timeout_ms: 10_000
  });
  await trackedRequest(connection, requests, {
    method: "thread/goal/clear",
    params: { threadId },
    kind: "mutation",
    timeout_ms: 10_000
  });
}

function trackedRequest(
  connection: CodexAppServerConnection,
  requests: CodexRequestInput[],
  input: CodexRequestInput
): Promise<unknown> {
  requests.push(input);
  return connection.request(input);
}

function requireRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return candidate as Record<string, unknown>;
}

function which(command: string): string {
  return execFileSync("which", [command], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1_024
  }).trim();
}

function stopTmux(tmuxSocketPath: string, environment: NodeJS.ProcessEnv): void {
  spawnSync("tmux", ["-S", tmuxSocketPath, "kill-server"], {
    env: environment,
    encoding: "utf8",
    timeout: 5_000
  });
  const stillRunning = spawnSync("tmux", ["-S", tmuxSocketPath, "has-session"], {
    env: environment,
    encoding: "utf8",
    timeout: 5_000
  });
  if (stillRunning.status === 0) throw new Error("Plain Codex tmux process remained active after cleanup.");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function collectCleanup(promise: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    errors.push(error);
  }
}

function collectSyncCleanup(cleanup: () => unknown, errors: unknown[]): void {
  try {
    cleanup();
  } catch (error) {
    errors.push(error);
  }
}
