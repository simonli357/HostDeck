import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  type ApiErrorEnvelope,
  type HostStatusResponse,
  hostStatusResponseSchema
} from "@hostdeck/contracts";
import { createErrorEnvelope, type ErrorCode, parseIsoTimestamp } from "@hostdeck/core";
import {
  createSessionRepository,
  createSettingsRepository,
  HostDeckMigrationError,
  HostDeckSettingsError,
  type OpenMigratedDatabaseOptions,
  openMigratedDatabase,
  type SessionRepository,
  type SettingsRepository
} from "@hostdeck/storage";
import {
  createRealTmuxTargetDiscovery,
  HostDeckTmuxAdapterError,
  type RealTmuxTargetDiscovery,
  type TmuxTarget
} from "@hostdeck/tmux-adapter";
import {
  createRestartReconciler,
  HostDeckRestartReconcilerError,
  type RestartReconcileResult
} from "./restart-reconciler.js";

export type HostStartupErrorCode =
  | "invalid_state_dir"
  | "migration_failed"
  | "invalid_settings"
  | "network_bind_failed"
  | "tmux_unavailable"
  | "tmux_check_failed"
  | "registry_reconciliation_failed"
  | "output_reader_start_failed";

export class HostDeckStartupError extends Error {
  constructor(
    readonly code: HostStartupErrorCode,
    readonly status: HostStatusResponse,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckStartupError";
  }
}

type OpenMigratedDatabaseResult = ReturnType<typeof openMigratedDatabase>;
type OpenDatabase = (path: string, options: OpenMigratedDatabaseOptions) => OpenMigratedDatabaseResult;
type NetworkBindCheck = (bind: HostStatusResponse["bind"]) => Promise<void> | void;
type HealthCheck = HostStatusResponse["storage"];
type StartupCheck = HostStatusResponse["startup_checks"][number];
type StartupCheckName = "state_dir" | "storage_migrations" | "settings" | "network_bind" | "tmux" | "registry_reconciliation";
type StartupHealthState = HealthCheck["state"];

export interface StartHostAgentInput {
  readonly version: string;
  readonly stateDir: string;
  readonly databasePath?: string;
  readonly bindPort?: number;
  readonly tmuxBinary?: string;
  readonly tmuxSocketName?: string;
  readonly now?: () => Date;
  readonly ensureStateDirectory?: (stateDir: string) => Promise<void> | void;
  readonly openDatabase?: OpenDatabase;
  readonly checkNetworkBind?: NetworkBindCheck;
  readonly discovery?: RealTmuxTargetDiscovery;
  readonly startOutputReader?: (target: TmuxTarget) => Promise<void> | void;
}

export interface HostStartupResult {
  readonly status: HostStatusResponse;
  readonly db: OpenMigratedDatabaseResult["db"];
  readonly settings: SettingsRepository;
  readonly sessions: SessionRepository;
  readonly migrations: OpenMigratedDatabaseResult["result"];
  readonly reconciliation: RestartReconcileResult;
  readonly close: () => void;
}

const defaultBindPort = 3777;
const databaseFileName = "hostdeck.sqlite";
const maxDetailsValueLength = 256;

export async function startHostAgent(input: StartHostAgentInput): Promise<HostStartupResult> {
  const now = input.now ?? (() => new Date());
  const stateDir = normalizedStateDir(input.stateDir);
  const databasePath = resolve(input.databasePath ?? join(stateDir, databaseFileName));
  const openDatabase = input.openDatabase ?? openMigratedDatabase;
  const checkedAt = () => now().toISOString();
  const startupChecks: StartupCheck[] = [];
  let bind: HostStatusResponse["bind"] = {
    mode: "localhost",
    host: "127.0.0.1",
    port: fallbackBindPort(input.bindPort)
  };
  let locked = false;
  let lanEnabled = false;
  let staleSessionCount = 0;
  let storage = health("unknown", "Storage has not been checked.", checkedAt());
  let tmux = health("unknown", "tmux has not been checked.", checkedAt());
  let stream = health("unknown", "Output stream readers have not been checked.", checkedAt());
  let opened: OpenMigratedDatabaseResult | null = null;

  function status(lastError: ApiErrorEnvelope | null, checks: readonly StartupCheck[] = startupChecks): HostStatusResponse {
    return hostStatusResponseSchema.parse({
      version: input.version,
      bind,
      locked,
      lan_enabled: lanEnabled,
      storage,
      tmux,
      stream,
      startup_checks: checks,
      stale_session_count: staleSessionCount,
      last_error: lastError
    });
  }

  function fail(failure: {
    readonly startupCode: HostStartupErrorCode;
    readonly errorCode: ErrorCode;
    readonly checkName: StartupCheckName;
    readonly message: string;
    readonly cause: unknown;
    readonly field?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): never {
    closeOpenedDatabase(opened);
    opened = null;

    const apiError = apiErrorEnvelope({
      code: failure.errorCode,
      message: failure.message,
      ...(failure.field !== undefined ? { field: failure.field } : {}),
      ...(failure.details !== undefined ? { details: failure.details } : {})
    });
    const failedChecks = [...startupChecks, startupCheck(failure.checkName, "error", apiError.message)];

    throw new HostDeckStartupError(failure.startupCode, status(apiError, failedChecks), apiError.message, {
      cause: failure.cause
    });
  }

  try {
    if (stateDir.length === 0) {
      throw new Error("State directory is required.");
    }

    await (input.ensureStateDirectory ?? ensureUsableStateDirectory)(stateDir);
    startupChecks.push(startupCheck("state_dir", "ok", "State directory is usable."));
  } catch (error) {
    fail({
      startupCode: "invalid_state_dir",
      errorCode: "invalid_config",
      checkName: "state_dir",
      message: `HostDeck state directory is not usable: ${stateDir}.`,
      cause: error,
      field: "state_dir",
      details: { state_dir: stateDir }
    });
  }

  try {
    opened = openDatabase(databasePath, { now });
    storage = health("ok", `SQLite migrations current at ${opened.result.currentVersion}.`, checkedAt());
    startupChecks.push(startupCheck("storage_migrations", "ok", migrationMessage(opened.result)));
  } catch (error) {
    storage = health("error", migrationFailureMessage(error), checkedAt());
    fail({
      startupCode: "migration_failed",
      errorCode: "storage_error",
      checkName: "storage_migrations",
      message: migrationFailureMessage(error),
      cause: error,
      details: migrationFailureDetails(databasePath, error)
    });
  }

  const settings = createSettingsRepository(opened.db);
  const sessions = createSessionRepository(opened.db);

  try {
    const loadedSettings = settings.getOrCreateDefault({
      stateDir,
      ...(input.bindPort !== undefined ? { bindPort: input.bindPort } : {}),
      now
    });
    bind = {
      mode: loadedSettings.bind_mode,
      host: loadedSettings.bind_host,
      port: loadedSettings.bind_port
    };
    locked = loadedSettings.locked;
    lanEnabled = loadedSettings.lan_enabled;
    startupChecks.push(startupCheck("settings", "ok", "Settings and bind policy are valid."));
  } catch (error) {
    storage = health("error", settingsFailureMessage(error), checkedAt());
    fail({
      startupCode: "invalid_settings",
      errorCode: "invalid_config",
      checkName: "settings",
      message: settingsFailureMessage(error),
      cause: error,
      field: "settings"
    });
  }

  try {
    await (input.checkNetworkBind ?? checkNetworkBindAvailability)(bind);
    startupChecks.push(startupCheck("network_bind", "ok", `Network bind is available at ${bind.host}:${bind.port}.`));
  } catch (error) {
    fail({
      startupCode: "network_bind_failed",
      errorCode: "invalid_config",
      checkName: "network_bind",
      message: `HostDeck cannot bind ${bind.mode} listener at ${bind.host}:${bind.port}.`,
      cause: error,
      field: "bind",
      details: {
        bind_mode: bind.mode,
        bind_host: bind.host,
        bind_port: bind.port
      }
    });
  }

  const discovery =
    input.discovery ??
    createRealTmuxTargetDiscovery({
      ...(input.tmuxBinary !== undefined ? { tmuxBinary: input.tmuxBinary } : {}),
      ...(input.tmuxSocketName !== undefined ? { socketName: input.tmuxSocketName } : {})
    });

  try {
    await discovery.listTargets();
    tmux = health("ok", "tmux target discovery is available.", checkedAt());
    startupChecks.push(startupCheck("tmux", "ok", "tmux target discovery is available."));
  } catch (error) {
    tmux = health("error", tmuxFailureMessage(error), checkedAt());
    fail({
      startupCode: tmuxStartupCode(error),
      errorCode: tmuxErrorCode(error),
      checkName: "tmux",
      message: tmuxFailureMessage(error),
      cause: error,
      field: "tmux",
      details: { tmux_binary: input.tmuxBinary ?? "tmux" }
    });
  }

  try {
    const reconciliation = await createRestartReconciler({
      sessions,
      discovery,
      now,
      startOutputReader: input.startOutputReader ?? missingOutputReader
    }).reconcile();
    stream = health("ok", streamReadyMessage(reconciliation.liveTargets.length), checkedAt());
    staleSessionCount = sessions.list().filter((session) => session.lifecycle_state === "stale").length;
    const readyStatus = hostStatusResponseSchema.parse({
      ...status(null),
      stream,
      startup_checks: [
        ...startupChecks,
        startupCheck("registry_reconciliation", "ok", reconciliationMessage(reconciliation))
      ],
      stale_session_count: staleSessionCount
    });

    return {
      status: readyStatus,
      db: opened.db,
      settings,
      sessions,
      migrations: opened.result,
      reconciliation,
      close() {
        opened?.db.close();
      }
    };
  } catch (error) {
    const mapped = mapReconciliationFailure(error);
    staleSessionCount = sessions.list().filter((session) => session.lifecycle_state === "stale").length;

    if (mapped.streamState === "error") {
      stream = health("error", mapped.message, checkedAt());
    } else {
      tmux = health("error", mapped.message, checkedAt());
    }

    fail({
      startupCode: mapped.startupCode,
      errorCode: mapped.errorCode,
      checkName: "registry_reconciliation",
      message: mapped.message,
      cause: error,
      ...(mapped.details !== undefined ? { details: mapped.details } : {})
    });
  }
}

export function isHostReady(status: HostStatusResponse): boolean {
  return (
    status.last_error === null &&
    status.storage.state === "ok" &&
    status.tmux.state === "ok" &&
    status.stream.state === "ok" &&
    status.startup_checks.length > 0 &&
    status.startup_checks.every((check) => check.state === "ok")
  );
}

async function ensureUsableStateDirectory(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const stats = await stat(stateDir);

  if (!stats.isDirectory()) {
    throw new Error(`${stateDir} is not a directory.`);
  }

  await access(stateDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
}

function missingOutputReader(target: TmuxTarget): never {
  throw new Error(`Output reader startup is not configured for live session ${target.sessionId}.`);
}

function checkNetworkBindAvailability(bind: HostStatusResponse["bind"]): Promise<void> {
  return new Promise((resolveBind, rejectBind) => {
    const server = createServer();
    let settled = false;

    function settle(error?: unknown): void {
      if (settled) {
        return;
      }

      settled = true;

      if (error !== undefined) {
        rejectBind(error);
        return;
      }

      resolveBind();
    }

    server.once("error", settle);
    server.listen(
      {
        host: bind.host,
        port: bind.port,
        exclusive: true
      },
      () => {
        server.close((error) => settle(error ?? undefined));
      }
    );
  });
}

function normalizedStateDir(stateDir: string): string {
  const trimmed = stateDir.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return resolve(trimmed);
}

function health(state: StartupHealthState, message: string, checkedAt: string): HealthCheck {
  return {
    state,
    message: boundedMessage(message),
    checked_at: parseRequiredIsoTimestamp(checkedAt)
  };
}

function startupCheck(name: StartupCheckName, state: StartupHealthState, message: string): StartupCheck {
  return {
    name,
    state,
    message: boundedMessage(message)
  };
}

function apiErrorEnvelope(input: {
  readonly code: ErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): ApiErrorEnvelope {
  const error = createErrorEnvelope({
    code: input.code,
    message: boundedMessage(input.message),
    ...(input.field !== undefined ? { field: input.field } : {}),
    ...(input.details !== undefined ? { details: boundedDetails(input.details) } : {})
  });

  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.field !== undefined ? { field: error.field } : {}),
    ...(error.sessionId !== undefined ? { session_id: error.sessionId } : {}),
    ...(error.details !== undefined ? { details: error.details } : {})
  };
}

function migrationMessage(result: OpenMigratedDatabaseResult["result"]): string {
  if (result.applied.length === 0) {
    return `SQLite migrations current at ${result.currentVersion}.`;
  }

  return `SQLite migrations applied through ${result.currentVersion}.`;
}

function migrationFailureMessage(error: unknown): string {
  if (error instanceof HostDeckMigrationError) {
    return `SQLite migration failed: ${error.message}`;
  }

  return "SQLite migration failed.";
}

function migrationFailureDetails(databasePath: string, error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof HostDeckMigrationError
    ? { database_path: databasePath, migration_code: error.code }
    : { database_path: databasePath };
}

function settingsFailureMessage(error: unknown): string {
  if (error instanceof HostDeckSettingsError) {
    return `HostDeck settings are invalid: ${error.message}`;
  }

  return "HostDeck settings are invalid.";
}

function tmuxStartupCode(error: unknown): HostStartupErrorCode {
  return error instanceof HostDeckTmuxAdapterError && error.code === "tmux_unavailable" ? "tmux_unavailable" : "tmux_check_failed";
}

function tmuxErrorCode(error: unknown): ErrorCode {
  return error instanceof HostDeckTmuxAdapterError && error.code === "tmux_unavailable" ? "missing_binary" : "tmux_error";
}

function tmuxFailureMessage(error: unknown): string {
  if (error instanceof HostDeckTmuxAdapterError) {
    return error.message;
  }

  return "tmux target discovery failed.";
}

function streamReadyMessage(liveTargetCount: number): string {
  return liveTargetCount === 0
    ? "No live sessions need output readers."
    : `Output readers started for ${liveTargetCount} live session(s).`;
}

function reconciliationMessage(reconciliation: RestartReconcileResult): string {
  const details = [
    `${reconciliation.liveTargets.length} live session(s)`,
    `${reconciliation.staleSessionIds.length} stale session(s)`,
    `${reconciliation.unmanagedTargets.length} unmanaged target(s) ignored`
  ];

  return `Registry reconciled: ${details.join(", ")}.`;
}

function mapReconciliationFailure(error: unknown): {
  readonly startupCode: HostStartupErrorCode;
  readonly errorCode: ErrorCode;
  readonly message: string;
  readonly streamState?: "error";
  readonly details?: Readonly<Record<string, unknown>>;
} {
  if (error instanceof HostDeckRestartReconcilerError) {
    return {
      startupCode: "output_reader_start_failed",
      errorCode: "internal_error",
      message: error.message,
      streamState: "error",
      details: {
        session_count: error.sessionIds.length,
        session_ids: error.sessionIds.join(",")
      }
    };
  }

  if (error instanceof HostDeckTmuxAdapterError) {
    return {
      startupCode: tmuxStartupCode(error),
      errorCode: tmuxErrorCode(error),
      message: error.message,
      details: { tmux_code: error.code }
    };
  }

  return {
    startupCode: "registry_reconciliation_failed",
    errorCode: "internal_error",
    message: "Startup registry reconciliation failed."
  };
}

function fallbackBindPort(port: number | undefined): number {
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : defaultBindPort;
}

function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim();

  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237)}...`;
}

function boundedDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean | null>> {
  const bounded: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      bounded[key] = value.length > maxDetailsValueLength ? `${value.slice(0, maxDetailsValueLength - 3)}...` : value;
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      bounded[key] = value;
      continue;
    }

    if (typeof value === "boolean" || value === null) {
      bounded[key] = value;
      continue;
    }

    bounded[key] = String(value).slice(0, maxDetailsValueLength);
  }

  return bounded;
}

function closeOpenedDatabase(opened: OpenMigratedDatabaseResult | null): void {
  try {
    opened?.db.close();
  } catch {
    // Startup is already failing; close errors are not actionable at this layer.
  }
}

function parseRequiredIsoTimestamp(value: string) {
  const result = parseIsoTimestamp(value);

  if (!result.ok) {
    throw new TypeError(result.message);
  }

  return result.value;
}
