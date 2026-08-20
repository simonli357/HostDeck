import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { assertPrivateLifecycleDirectory } from "./codex-runtime-lifecycle-files.js";
import { createSessionCatalogStateReader } from "./session-catalog-state-reader.js";
import {
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "./shared-codex-broker-lifecycle.js";
import {
  parseSharedRuntimeRealReport,
  type SharedRuntimeRealReport
} from "./shared-runtime-hardening.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_SHARED_CODEX_SESSIONS_SMOKE === "1";

describe.skipIf(!requireSmoke)("real automatic shared-session enrollment", () => {
  it(
    "shares three ordinary project roots across start, resume, detach, and reconnect without model work",
    async () => {
      const codexBin = realpathSync.native(resolve(process.env.HOSTDECK_CODEX_BIN ?? which("codex")));
      const version = parseCodexCliVersionOutput(execFileSync(codexBin, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1_024
      }));
      expect(version).toBe("0.148.0");
      const reportContext = resolveReportContext();
      const desktopBaseline = currentDesktopProcessIdentities();

      const root = mkdtempSync(join(tmpdir(), "hostdeck-shared-enrollment-"));
      const codexHome = join(root, "codex-home");
      const projects = [
        join(root, "side_cue_app"),
        join(root, "MarketPilot"),
        join(root, "ScandyControl")
      ] as const;
      const databasePath = join(root, "hostdeck.sqlite");
      mkdirSync(codexHome, { mode: 0o700 });
      for (const project of projects) mkdirSync(project, { mode: 0o700 });
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
          ...projects.flatMap((project) => [
            `[projects.${JSON.stringify(project)}]`,
            'trust_level = "trusted"'
          ]),
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      const location: SharedCodexEndpointLocation = Object.freeze({
        kind: "standard_unix",
        codex_home: codexHome,
        socket_path: join(codexHome, "app-server-control", "app-server-control.sock")
      });
      const sensitiveValues = [root, codexHome, databasePath, location.socket_path, ...projects];

      let brokerOwned = false;
      let nativeConnection: CodexAppServerConnection | null = null;
      let hostConnection: CodexAppServerConnection | null = null;
      let restartedConnection: CodexAppServerConnection | null = null;
      let sideCueTui: PlainCodexTui | null = null;
      let initialScandyTui: PlainCodexTui | null = null;
      let resumedScandyTui: PlainCodexTui | null = null;
      let marketPilotTui: PlainCodexTui | null = null;
      let service: AutomaticSessionEnrollmentService | null = null;
      let restartedService: AutomaticSessionEnrollmentService | null = null;
      let database: ReturnType<typeof openMigratedDatabase> | null = null;
      let brokerPid: number | null = null;
      let socketInode: bigint | null = null;
      let reportFacts: Omit<SharedRuntimeRealReport, "cleanup" | "privacy"> | null = null;
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
        const ownerPath = join(
          codexHome,
          "app-server-control",
          "hostdeck-broker-owner.json"
        );
        brokerPid = readBrokerPid(ownerPath);
        sensitiveValues.push(ownerPath);
        socketInode = lstatSync(location.socket_path, { bigint: true }).ino;
        expect(lstatSync(location.socket_path).mode & 0o7777).toBe(0o600);

        nativeConnection = createConnection(location, version);
        await nativeConnection.connect();
        const nativeRequests: CodexRequestInput[] = [];
        sideCueTui = await startPlainCodexThread(
          codexBin,
          codexHome,
          projects[0],
          join(root, "side-cue-tmux.sock"),
          nativeConnection,
          nativeRequests
        );
        const sideCueThread = sideCueTui.thread_id;
        sensitiveValues.push(sideCueThread);
        await materializeWithoutTurn(nativeConnection, nativeRequests, sideCueThread);
        initialScandyTui = await startPlainCodexThread(
          codexBin,
          codexHome,
          projects[2],
          join(root, "scandy-initial-tmux.sock"),
          nativeConnection,
          nativeRequests
        );
        const scandyThread = initialScandyTui.thread_id;
        sensitiveValues.push(scandyThread);
        await materializeWithoutTurn(nativeConnection, nativeRequests, scandyThread);
        initialScandyTui.close();
        initialScandyTui = null;

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
        if (
          first.outcomes.length !== 2 ||
          first.outcomes.some((outcome) => outcome.state !== "enrolled")
        ) {
          throw new Error(`Loaded-before CLI roots were not eligible: ${JSON.stringify(first.outcomes)}`);
        }
        expect(
          first.outcomes.every(
            (outcome) =>
              outcome.state === "enrolled" &&
              outcome.session.enrollment_origin === "loaded_before" &&
              outcome.subscribed
          )
        ).toBe(true);
        expect(states.getByThreadId(sideCueThread)?.mapping.id).toBe(
          deriveAutomaticSessionIdentity(sideCueThread, "side_cue_app").internal_session_id
        );
        expect(states.getByThreadId(scandyThread)?.mapping.id).toBe(
          deriveAutomaticSessionIdentity(scandyThread, "ScandyControl").internal_session_id
        );

        resumedScandyTui = await resumePlainCodexThread(
          codexBin,
          codexHome,
          projects[2],
          scandyThread,
          join(root, "scandy-resume-tmux.sock"),
          nativeConnection,
          nativeRequests
        );
        await callback.drain();
        expect(states.list()).toHaveLength(2);
        expect(states.getByThreadId(scandyThread)?.mapping.codex_thread_id).toBe(
          scandyThread
        );

        marketPilotTui = await startPlainCodexThread(
          codexBin,
          codexHome,
          projects[1],
          join(root, "market-pilot-tmux.sock"),
          nativeConnection,
          nativeRequests
        );
        const marketPilotThread = marketPilotTui.thread_id;
        sensitiveValues.push(marketPilotThread);
        await materializeWithoutTurn(nativeConnection, nativeRequests, marketPilotThread);
        await callback.drain();
        if (states.getByThreadId(marketPilotThread) === null) {
          await expect(service.retryPending(marketPilotThread)).resolves.toMatchObject({
            state: "enrolled",
            session: { native_thread_id: marketPilotThread, enrollment_origin: "created_after" }
          });
        }
        await callback.drain();

        const memberships = states.listSharedMemberships();
        expect(memberships.every((entry) => entry.origin === "automatic")).toBe(true);
        expect(
          memberships
            .flatMap((entry) => (entry.origin === "automatic" ? [entry.native_thread_id] : []))
            .sort()
        ).toEqual([sideCueThread, marketPilotThread, scandyThread].sort());
        expect(states.list()).toHaveLength(3);
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
        const catalog = createSessionCatalogStateReader({
          max_sessions: 8,
          states
        }).read();
        expect(catalog).toHaveLength(3);
        expect(new Set(catalog.map((entry) => entry.tracked.native_thread_id)).size).toBe(3);
        expect(
          catalog.map((entry) => entry.tracked.project_cue).sort()
        ).toEqual(["MarketPilot", "ScandyControl", "side_cue_app"].sort());
        const catalogOrdered = catalog.every((entry, index) => {
          const previous = catalog[index - 1];
          return previous === undefined ||
            previous.tracked.created_at < entry.tracked.created_at ||
            (previous.tracked.created_at === entry.tracked.created_at &&
              previous.tracked.internal_session_id < entry.tracked.internal_session_id);
        });
        expect(catalogOrdered).toBe(true);
        const newDesktopProcesses = difference(
          currentDesktopProcessIdentities(),
          desktopBaseline
        );
        expect(newDesktopProcesses).toEqual([]);

        await nativeConnection.close("Automatic enrollment smoke released its observation client.");
        nativeConnection = null;

        service.close();
        service = null;
        await hostConnection.close("Automatic enrollment smoke reconnecting HostDeck.");
        hostConnection = null;
        expect(processIsAlive(brokerPid)).toBe(true);
        expect(lstatSync(location.socket_path, { bigint: true }).ino).toBe(socketInode);
        expect(sideCueTui.active()).toBe(true);
        expect(resumedScandyTui.active()).toBe(true);
        expect(marketPilotTui.active()).toBe(true);

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
        expect(restarted.outcomes).toHaveLength(3);
        expect(restarted.outcomes.every((outcome) => outcome.state === "enrolled")).toBe(true);
        expect(states.list()).toHaveLength(3);
        expect(states.listSharedMemberships()).toHaveLength(3);
        expect(restartCallback.failures).toEqual([]);
        expect(restartCallback.issues).toEqual([]);
        expect(restartObservedMethods).not.toContain("turn/started");
        expect(restartRequests.some((request) => request.method === "turn/start")).toBe(false);
        reportFacts = {
          schema_version: 1,
          task: "INT-V1-114-real",
          hostdeck_commit: reportContext?.commit ?? currentCommit(false),
          runtime: {
            runtime_version: "0.148.0",
            standard_socket: true,
            socket_mode: 0o600
          },
          execution: {
            project_count: 3,
            loaded_before_count: 2,
            created_after_count: 1,
            resumed_existing_count: 1,
            enrolled_count: 3,
            reconnect_enrolled_count: 3,
            hostdeck_connection_count: 2,
            tui_lifetime_count: 4,
            turn_start_count: 0,
            retry_count: 0
          },
          continuity: {
            broker_pid_stable_after_hostdeck_detach: true,
            socket_inode_stable_after_hostdeck_detach: true,
            loaded_tui_survived_hostdeck_detach: true,
            native_resume_identity_preserved: true
          },
          integrity: {
            unique_mapping_count: 3,
            unique_native_identity_count: 3,
            catalog_session_count: 3,
            catalog_ordered: true,
            protocol_issue_count: 0,
            enrollment_failure_count: 0,
            desktop_window_process_count: 0,
            superseded_command_count: 0
          }
        };
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
      if (marketPilotTui !== null) collectSyncCleanup(() => marketPilotTui?.close(), cleanupErrors);
      if (resumedScandyTui !== null) collectSyncCleanup(() => resumedScandyTui?.close(), cleanupErrors);
      if (initialScandyTui !== null) collectSyncCleanup(() => initialScandyTui?.close(), cleanupErrors);
      if (sideCueTui !== null) collectSyncCleanup(() => sideCueTui?.close(), cleanupErrors);
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
      expect(existsSync(root)).toBe(false);
      expect(existsSync(location.socket_path)).toBe(false);
      if (brokerPid === null) throw new TypeError("Shared broker pid was not observed.");
      expect(processIsAlive(brokerPid)).toBe(false);
      if (reportContext !== null) {
        if (reportFacts === null) throw new TypeError("Shared runtime report facts are missing.");
        const report = parseSharedRuntimeRealReport({
          ...reportFacts,
          privacy: {
            contains_native_or_internal_id: false,
            contains_path_or_socket: false,
            contains_pid_or_process_identity: false,
            contains_prompt_goal_or_transcript: false,
            contains_credential_or_raw_protocol: false
          },
          cleanup: {
            app_servers_remaining: 0,
            browser_processes_remaining: 0,
            temporary_roots_remaining: 0,
            tmux_servers_remaining: 0,
            tui_processes_remaining: 0,
            unix_sockets_remaining: 0
          }
        });
        publishReport(reportContext.path, report, sensitiveValues);
      }
    },
    90_000
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
    active: () => isTmuxActive(tmuxSocketPath, environment),
    close() {
      if (closed) return;
      stopTmux(tmuxSocketPath, environment);
      closed = true;
    }
  });
}

interface PlainCodexTui {
  readonly thread_id: string;
  readonly active: () => boolean;
  readonly close: () => void;
}

async function resumePlainCodexThread(
  codexBin: string,
  codexHome: string,
  cwd: string,
  expectedThreadId: string,
  tmuxSocketPath: string,
  connection: CodexAppServerConnection,
  requests: CodexRequestInput[]
): Promise<PlainCodexTui> {
  const before = (await loadedThreadIds(connection, requests)).sort();
  if (!before.includes(expectedThreadId)) {
    throw new Error("Plain Codex resume target was not loaded before resume.");
  }
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  const command = [
    codexBin,
    "--no-alt-screen",
    "-C",
    cwd,
    "resume",
    expectedThreadId
  ].map(shellQuote).join(" ");
  execFileSync(
    "tmux",
    ["-S", tmuxSocketPath, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "codex", command],
    { cwd, env: environment, timeout: 5_000, stdio: "ignore" }
  );

  let failure: unknown = null;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (isTmuxActive(tmuxSocketPath, environment)) {
        const after = (await loadedThreadIds(connection, requests)).sort();
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          throw new Error("Plain Codex resume changed the loaded native identity set.");
        }
        let closed = false;
        return Object.freeze({
          thread_id: expectedThreadId,
          active: () => isTmuxActive(tmuxSocketPath, environment),
          close() {
            if (closed) return;
            stopTmux(tmuxSocketPath, environment);
            closed = true;
          }
        });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error("Plain Codex resume did not remain active before timeout.");
  } catch (error) {
    failure = error;
  }
  try {
    stopTmux(tmuxSocketPath, environment);
  } catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], "Plain Codex resume and cleanup failed.");
  }
  throw failure;
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

function isTmuxActive(
  tmuxSocketPath: string,
  environment: NodeJS.ProcessEnv
): boolean {
  return spawnSync("tmux", ["-S", tmuxSocketPath, "has-session"], {
    env: environment,
    encoding: "utf8",
    timeout: 5_000
  }).status === 0;
}

interface SharedRuntimeReportContext {
  readonly commit: string;
  readonly path: string;
}

function resolveReportContext(): SharedRuntimeReportContext | null {
  const candidate = process.env.HOSTDECK_SHARED_RUNTIME_REPORT;
  if (candidate === undefined) return null;
  if (
    !isAbsolute(candidate) ||
    resolve(candidate) !== candidate ||
    basename(candidate) !== "multi-project-report.json" ||
    existsSync(candidate)
  ) {
    throw new TypeError("Shared runtime real report path is invalid.");
  }
  const reportDirectory = dirname(candidate);
  try {
    assertPrivateLifecycleDirectory(reportDirectory);
    const relationship = relative(realpathSync(tmpdir()), reportDirectory);
    if (
      relationship === "" ||
      relationship === ".." ||
      relationship.startsWith("../") ||
      isAbsolute(relationship)
    ) {
      throw new TypeError("Shared runtime report directory is invalid.");
    }
  } catch {
    throw new TypeError("Shared runtime real report path is invalid.");
  }
  const expectedCommit = process.env.HOSTDECK_EXPECTED_COMMIT;
  if (expectedCommit === undefined || !/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new TypeError("Shared runtime expected commit is invalid.");
  }
  const commit = currentCommit(true);
  if (commit !== expectedCommit) {
    throw new TypeError("Shared runtime real scenario commit differs.");
  }
  return Object.freeze({ commit, path: candidate });
}

function currentCommit(requireClean: boolean): string {
  if (requireClean) {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1_024
    });
    if (status !== "") {
      throw new TypeError("Shared runtime real scenario requires a clean commit.");
    }
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1_024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new TypeError("Shared runtime commit identity is invalid.");
  }
  return commit;
}

function publishReport(
  path: string,
  report: SharedRuntimeRealReport,
  privateValues: readonly string[]
): void {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  for (const value of privateValues) {
    if (value.length >= 8 && encoded.includes(value)) {
      throw new TypeError("Shared runtime real report retained private runtime data.");
    }
  }
  writeFileSync(path, encoded, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== 0o600) {
    throw new TypeError("Shared runtime real report file is insecure.");
  }
  expect(parseSharedRuntimeRealReport(JSON.parse(readFileSync(path, "utf8")))).toEqual(report);
}

function readBrokerPid(ownerPath: string): number {
  const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Number.isSafeInteger((parsed as { readonly pid?: unknown }).pid) ||
    Number((parsed as { readonly pid: number }).pid) < 1
  ) {
    throw new TypeError("Shared broker ownership pid is invalid.");
  }
  return (parsed as { readonly pid: number }).pid;
}

const desktopProcessNames = new Set([
  "alacritty",
  "chromium",
  "firefox",
  "gnome-terminal-",
  "google-chrome",
  "kitty",
  "konsole",
  "wezterm",
  "xfce4-terminal",
  "xterm"
]);

function currentDesktopProcessIdentities(): Set<string> {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) {
    throw new TypeError("Shared runtime desktop-process inspection requires Linux.");
  }
  const identities = new Set<string>();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const processRoot = `/proc/${entry.name}`;
    try {
      if (lstatSync(processRoot).uid !== uid) continue;
      const name = readFileSync(`${processRoot}/comm`, "utf8").trim();
      if (desktopProcessNames.has(name)) identities.add(`${entry.name}:${name}`);
    } catch (error) {
      if (isMissingProcess(error)) continue;
      throw error;
    }
  }
  return identities;
}

function difference(current: Set<string>, baseline: Set<string>): string[] {
  return [...current].filter((identity) => !baseline.has(identity)).sort();
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EACCES")
  );
}

function processIsAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
