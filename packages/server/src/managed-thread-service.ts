import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type CodexThreadClient,
  type CodexThreadRecord,
  type CodexThreadStartResult,
  HostDeckCodexAdapterError,
  isSupportedCodexThreadSource
} from "@hostdeck/codex-adapter";
import {
  clientOperationIdSchema,
  type SelectedSessionStartRecoveryRecord,
  type SelectedStartSessionRequest,
  selectedSessionStartRecoveryRecordSchema,
  selectedStartSessionRequestSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp, OperationDeadline, SessionId } from "@hostdeck/core";
import { parseSessionId } from "@hostdeck/core";
import {
  captureGitBranchMetadata,
  HostDeckSelectedStateRepositoryError,
  type SelectedSessionState,
  type SelectedStateRepository,
  selectedStateRevision
} from "@hostdeck/storage";
import { requireOpenOperationDeadline } from "./operation-deadline-serialization.js";

export type ManagedCodexThreadServiceErrorCode =
  | "duplicate_session_name"
  | "identity_mismatch"
  | "invalid_cwd"
  | "invalid_request"
  | "operation_timeout"
  | "recovery_required"
  | "runtime_incompatible"
  | "runtime_unavailable"
  | "storage_error"
  | "thread_already_archived"
  | "thread_conflict"
  | "thread_not_found"
  | "thread_not_writable"
  | "unknown_outcome";

export type ManagedCodexThreadServiceOutcome = "not_sent" | "remote_rejected" | "remote_succeeded" | "unknown";

export class HostDeckManagedCodexThreadServiceError extends Error {
  constructor(
    readonly code: ManagedCodexThreadServiceErrorCode,
    message: string,
    readonly outcome: ManagedCodexThreadServiceOutcome,
    readonly retry_safe: boolean,
    readonly thread_id: string | null = null,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckManagedCodexThreadServiceError";
  }
}

export interface ManagedThreadReconciliationIssue {
  readonly session_id: string | null;
  readonly operation_id: string | null;
  readonly code: ManagedCodexThreadServiceErrorCode;
  readonly message: string;
}

export interface ManagedThreadReconciliationResult {
  readonly recovered_starts: number;
  readonly reconciled_sessions: number;
  readonly stale_sessions: number;
  readonly ignored_unmanaged_threads: number;
  readonly issues: readonly ManagedThreadReconciliationIssue[];
}

export interface ManagedCodexThreadServiceOptions {
  readonly threads: CodexThreadClient;
  readonly states: SelectedStateRepository;
  readonly now?: () => Date;
  readonly create_session_id?: () => SessionId;
  readonly validate_cwd?: (cwd: string) => Promise<void>;
  readonly capture_branch?: (cwd: string) => string | null;
}

export interface ManagedCodexThreadService {
  readonly start: (input: unknown, deadline: OperationDeadline) => Promise<SelectedSessionState>;
  readonly list: () => readonly SelectedSessionState[];
  readonly read: (sessionId: string) => SelectedSessionState;
  readonly archive: (sessionId: string, deadline: OperationDeadline) => Promise<SelectedSessionState>;
  readonly reconcile: () => Promise<ManagedThreadReconciliationResult>;
  readonly clearFailedStartRecovery: (operationId: string) => boolean;
}

export function createManagedCodexThreadService(options: ManagedCodexThreadServiceOptions): ManagedCodexThreadService {
  return new DefaultManagedCodexThreadService(options);
}

class DefaultManagedCodexThreadService implements ManagedCodexThreadService {
  private readonly archiveInFlight = new Set<string>();
  private readonly uncertainArchives = new Set<string>();
  private readonly now: () => Date;
  private readonly createSessionId: () => SessionId;
  private readonly validateCwd: (cwd: string) => Promise<void>;
  private readonly captureBranch: (cwd: string) => string | null;

  constructor(private readonly options: ManagedCodexThreadServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createSessionId = options.create_session_id ?? defaultSessionId;
    this.validateCwd = options.validate_cwd ?? validateDirectory;
    this.captureBranch = options.capture_branch ?? captureGitBranchMetadata;
  }

  async start(input: unknown, deadlineInput: OperationDeadline): Promise<SelectedSessionState> {
    const deadline = requireManagedThreadDeadline(deadlineInput);
    const request = parseStartRequest(input);
    requireManagedThreadDeadline(deadline);
    await this.validateStartCwd(request.cwd);
    requireManagedThreadDeadline(deadline);
    const existing = this.getRecovery(request.operation_id);
    if (existing !== null) {
      assertRecoveryRequest(existing, request);
      if (existing.state === "failed") {
        throw serviceError("recovery_required", existing.error_message ?? "Prior session start failed and awaits explicit cleanup.", "not_sent", true);
      }
      return this.resumeRecovery(existing, deadline);
    }
    requireManagedThreadDeadline(deadline);
    try {
      if (this.options.states.list().some((state) => state.mapping.name === request.name)) {
        throw serviceError("duplicate_session_name", `Managed session name ${request.name} already exists.`, "not_sent", false);
      }
    } catch (error) {
      if (error instanceof HostDeckManagedCodexThreadServiceError) throw error;
      throw mapStorageError(error, "Managed session names could not be checked before start.");
    }
    requireManagedThreadDeadline(deadline);

    const timestamp = this.timestamp();
    const reserved = selectedSessionStartRecoveryRecordSchema.parse({
      operation_id: request.operation_id,
      session_id: this.createSessionId(),
      name: request.name,
      cwd: request.cwd,
      codex_thread_id: null,
      state: "reserved",
      created_at: timestamp,
      updated_at: timestamp,
      error_code: null,
      error_message: null
    });
    try {
      this.options.states.putRecovery(reserved);
    } catch (error) {
      throw mapStorageError(error, "Session start identity could not be reserved.");
    }
    try {
      requireManagedThreadDeadline(deadline);
    } catch (error) {
      this.recordFailedStartTimeout(reserved, error);
      throw error;
    }

    let started: CodexThreadStartResult;
    try {
      started = await this.options.threads.start(
        { operation_id: request.operation_id, cwd: request.cwd },
        deadline
      );
    } catch (error) {
      if (isKnownNoThreadOutcome(error)) this.recordFailedStart(reserved, error);
      throw mapAdapterError(error, "Codex thread start failed.");
    }

    let threadCreated: SelectedSessionStartRecoveryRecord;
    try {
      threadCreated = this.options.states.putRecovery({
        ...reserved,
        codex_thread_id: started.thread.id,
        state: "thread_created",
        updated_at: this.advanceTimestamp(reserved.updated_at)
      });
    } catch (error) {
      throw serviceError(
        "storage_error",
        "Codex created a thread but HostDeck could not persist its recovery identity.",
        "remote_succeeded",
        false,
        started.thread.id,
        error
      );
    }
    return this.materializeRecovery(threadCreated, started.model, deadline);
  }

  list(): readonly SelectedSessionState[] {
    try {
      return this.options.states.list();
    } catch (error) {
      throw mapStorageError(error, "Managed sessions could not be listed.");
    }
  }

  read(sessionId: string): SelectedSessionState {
    const parsed = parseSelectedSessionId(sessionId);
    try {
      return this.options.states.require(parsed);
    } catch (error) {
      if (error instanceof HostDeckSelectedStateRepositoryError && error.code === "session_not_found") {
        throw serviceError("thread_not_found", `Managed session ${parsed} does not exist.`, "not_sent", false, null, error);
      }
      throw mapStorageError(error, "Managed session could not be read.");
    }
  }

  async archive(sessionId: string, deadlineInput: OperationDeadline): Promise<SelectedSessionState> {
    const deadline = requireManagedThreadDeadline(deadlineInput);
    const parsedSessionId = parseSelectedSessionId(sessionId);
    if (this.archiveInFlight.has(parsedSessionId)) {
      throw serviceError("thread_conflict", "Managed session archive is already in flight.", "not_sent", false);
    }
    if (this.uncertainArchives.has(parsedSessionId)) {
      throw serviceError("recovery_required", "Managed session archive outcome requires reconciliation before retry.", "unknown", false);
    }
    this.archiveInFlight.add(parsedSessionId);
    try {
      requireManagedThreadDeadline(deadline);
      const current = this.read(parsedSessionId);
      assertArchivableState(current);
      requireManagedThreadDeadline(deadline);
      let runtimeVersion: string;
      try {
        runtimeVersion = this.options.threads.runtime_version;
      } catch (error) {
        throw mapAdapterError(error, "Codex runtime version could not be verified before archive.");
      }
      if (
        current.mapping.runtime_version !== runtimeVersion ||
        current.projection.session.runtime_version !== runtimeVersion
      ) {
        throw serviceError(
          "runtime_incompatible",
          "Managed session runtime version changed and requires reconciliation before archive.",
          "not_sent",
          false,
          current.mapping.codex_thread_id
        );
      }

      let listedThreads: readonly CodexThreadRecord[];
      try {
        listedThreads = await this.options.threads.listAll(deadline);
      } catch (error) {
        throw mapAdapterError(error, "Codex thread disposition could not be verified before archive.");
      }
      requireManagedThreadDeadline(deadline);
      const listedMatches = listedThreads.filter(
        (thread) => thread.id === current.mapping.codex_thread_id
      );
      const listedThread = listedMatches[0];
      if (listedMatches.length !== 1 || listedThread === undefined) {
        throw serviceError(
          listedMatches.length === 0 ? "thread_not_found" : "identity_mismatch",
          "Managed Codex thread could not be resolved exactly before archive.",
          "not_sent",
          false,
          current.mapping.codex_thread_id
        );
      }
      if (listedThread.archived === true) {
        throw serviceError(
          "thread_already_archived",
          "Managed Codex thread is already archived.",
          "not_sent",
          false,
          current.mapping.codex_thread_id
        );
      }
      if (listedThread.archived !== false) {
        throw serviceError(
          "identity_mismatch",
          "Codex thread disposition is not authoritative for archive.",
          "not_sent",
          false,
          current.mapping.codex_thread_id
        );
      }
      assertRuntimeThreadArchivable(listedThread, current);

      let runtimeThread: CodexThreadRecord;
      try {
        runtimeThread = await this.options.threads.read(current.mapping.codex_thread_id, deadline);
      } catch (error) {
        throw mapAdapterError(error, "Codex thread could not be verified before archive.");
      }
      assertRuntimeThreadArchivable(runtimeThread, current);
      requireManagedThreadDeadline(deadline);

      const dispatchState = this.read(parsedSessionId);
      assertSameArchiveCandidate(current, dispatchState);
      requireManagedThreadDeadline(deadline);
      try {
        await this.options.threads.archive(current.mapping.codex_thread_id, deadline);
      } catch (error) {
        const mapped = mapAdapterError(error, "Codex thread archive failed.");
        if (mapped.outcome === "unknown") {
          this.uncertainArchives.add(parsedSessionId);
          try {
            this.markStale(
              dispatchState,
              "Codex archive outcome is uncertain and requires reconciliation."
            );
          } catch (latchError) {
            throw serviceError(
              "recovery_required",
              "Codex archive outcome is uncertain and its durable recovery latch could not be persisted.",
              "unknown",
              false,
              current.mapping.codex_thread_id,
              new AggregateError([error, latchError])
            );
          }
        }
        throw mapped;
      }

      const updatedAt = this.advanceTimestamp(
        dispatchState.mapping.updated_at,
        dispatchState.projection.session.updated_at
      );
      const archived = {
        mapping: {
          ...dispatchState.mapping,
          disposition: "selected" as const,
          updated_at: updatedAt,
          archived_at: updatedAt
        },
        projection: {
          ...dispatchState.projection,
          session: {
            ...dispatchState.projection.session,
            session_state: "archived" as const,
            turn_state: "idle" as const,
            attention: "none" as const,
            freshness: "current" as const,
            freshness_reason: null,
            archived_at: updatedAt,
            updated_at: updatedAt,
            last_activity_at: updatedAt,
            recent_summary: "Managed Codex session archived."
          }
        }
      };
      try {
        const persisted = this.options.states.replace(
          archived,
          selectedStateRevision(dispatchState)
        );
        this.uncertainArchives.delete(parsedSessionId);
        return persisted;
      } catch (error) {
        this.uncertainArchives.add(parsedSessionId);
        throw serviceError(
          "recovery_required",
          "Codex archived the thread but HostDeck could not persist the archived mapping; reconciliation is required.",
          "remote_succeeded",
          false,
          current.mapping.codex_thread_id,
          error
        );
      }
    } finally {
      this.archiveInFlight.delete(parsedSessionId);
    }
  }

  async reconcile(): Promise<ManagedThreadReconciliationResult> {
    const issues: ManagedThreadReconciliationIssue[] = [];
    let recoveredStarts = 0;
    let recoveries: readonly SelectedSessionStartRecoveryRecord[];
    try {
      recoveries = this.options.states.listRecoveries();
    } catch (error) {
      throw mapStorageError(error, "Session-start recoveries could not be listed.");
    }
    for (const recovery of recoveries) {
      if (recovery.state === "failed") continue;
      try {
        await this.resumeRecovery(recovery);
        recoveredStarts += 1;
      } catch (error) {
        issues.push(issueFromError(error, null, recovery.operation_id));
      }
    }

    let runtimeThreads: readonly CodexThreadRecord[];
    try {
      runtimeThreads = await this.options.threads.listAll();
    } catch (error) {
      throw mapAdapterError(error, "Codex threads could not be listed for reconciliation.");
    }
    const runtimeById = new Map(runtimeThreads.map((thread) => [thread.id, thread]));
    let managed: readonly SelectedSessionState[];
    try {
      managed = this.options.states.list();
    } catch (error) {
      throw mapStorageError(error, "Managed sessions could not be listed for reconciliation.");
    }
    const managedIds = new Set(managed.map((state) => state.mapping.codex_thread_id));
    let reconciledSessions = 0;
    let staleSessions = 0;

    for (const current of managed) {
      const runtime = runtimeById.get(current.mapping.codex_thread_id);
      try {
        if (runtime === undefined) {
          this.markStale(current, "Managed Codex thread is missing from active and archived runtime lists.");
          staleSessions += 1;
        } else if (runtime.cwd !== current.mapping.cwd || !isSupportedCodexThreadSource(runtime.source)) {
          this.markStale(current, "Managed Codex thread identity no longer matches its durable mapping.");
          staleSessions += 1;
        } else {
          this.reconcileState(current, runtime);
          this.uncertainArchives.delete(current.mapping.id);
          reconciledSessions += 1;
        }
      } catch (error) {
        issues.push(issueFromError(error, current.mapping.id, null));
      }
    }

    return {
      recovered_starts: recoveredStarts,
      reconciled_sessions: reconciledSessions,
      stale_sessions: staleSessions,
      ignored_unmanaged_threads: runtimeThreads.filter((thread) => !managedIds.has(thread.id)).length,
      issues
    };
  }

  clearFailedStartRecovery(operationId: string): boolean {
    const parsed = clientOperationIdSchema.safeParse(operationId);
    if (!parsed.success) throw serviceError("invalid_request", "Session start operation id is invalid.", "not_sent", false, null, parsed.error);
    const recovery = this.getRecovery(parsed.data);
    if (recovery === null) return false;
    if (recovery.state !== "failed") {
      throw serviceError("recovery_required", "Only a terminal failed start recovery can be cleared.", "not_sent", false);
    }
    try {
      return this.options.states.deleteRecovery(parsed.data);
    } catch (error) {
      throw mapStorageError(error, "Failed session-start recovery could not be cleared.");
    }
  }

  private async resumeRecovery(
    recovery: SelectedSessionStartRecoveryRecord,
    deadline?: OperationDeadline
  ): Promise<SelectedSessionState> {
    if (deadline !== undefined) requireManagedThreadDeadline(deadline);
    if (recovery.state === "persisted") return this.finishPersistedRecovery(recovery);
    if (recovery.state === "thread_created") return this.materializeRecovery(recovery, null, deadline);
    if (recovery.state !== "reserved") {
      throw serviceError("recovery_required", "Session start recovery is terminal and cannot resume.", "not_sent", false);
    }

    let matches: readonly CodexThreadRecord[];
    try {
      matches = await this.options.threads.findByOperationId(recovery.operation_id, deadline);
    } catch (error) {
      throw mapAdapterError(error, "Reserved session start could not be reconciled against Codex.");
    }
    if (matches.length === 0) {
      throw serviceError(
        "recovery_required",
        "Reserved session start has no provable Codex outcome; HostDeck will not dispatch it again.",
        "unknown",
        false
      );
    }
    if (matches.length !== 1) {
      throw serviceError(
        "thread_conflict",
        "Multiple Codex threads claim one HostDeck start operation.",
        "remote_succeeded",
        false
      );
    }
    const thread = matches[0];
    if (thread === undefined) {
      throw serviceError("identity_mismatch", "Recovered Codex thread cwd does not match the reserved session.", "unknown", false);
    }
    if (thread.cwd !== recovery.cwd) {
      throw serviceError(
        "identity_mismatch",
        "Recovered Codex thread cwd does not match the reserved session.",
        "remote_succeeded",
        false,
        thread.id
      );
    }
    let threadCreated: SelectedSessionStartRecoveryRecord;
    try {
      threadCreated = this.options.states.putRecovery({
        ...recovery,
        codex_thread_id: thread.id,
        state: "thread_created",
        updated_at: this.advanceTimestamp(recovery.updated_at)
      });
    } catch (error) {
      throw mapStorageError(error, "Recovered Codex thread identity could not be persisted.", thread.id, "remote_succeeded");
    }
    return this.materializeRecovery(threadCreated, null, deadline);
  }

  private async materializeRecovery(
    recovery: SelectedSessionStartRecoveryRecord,
    model: string | null,
    deadline?: OperationDeadline
  ): Promise<SelectedSessionState> {
    if (recovery.codex_thread_id === null) {
      throw serviceError(
        "identity_mismatch",
        "Thread-created recovery is missing its Codex thread id.",
        "remote_succeeded",
        false
      );
    }
    let thread: CodexThreadRecord;
    try {
      thread = await this.options.threads.ensureMaterialized({
        thread_id: recovery.codex_thread_id,
        operation_id: recovery.operation_id,
        cwd: recovery.cwd,
        name: recovery.name
      }, deadline);
    } catch (error) {
      throw mapMaterializationError(error, recovery.codex_thread_id);
    }
    return this.persistThreadCreated(recovery, thread, model);
  }

  private persistThreadCreated(
    recovery: SelectedSessionStartRecoveryRecord,
    thread: CodexThreadRecord,
    model: string | null
  ): SelectedSessionState {
    if (recovery.codex_thread_id !== thread.id || recovery.cwd !== thread.cwd) {
      throw serviceError(
        "identity_mismatch",
        "Codex thread does not match its recovery record.",
        "remote_succeeded",
        false,
        thread.id
      );
    }
    let existing: SelectedSessionState | null;
    try {
      existing = this.options.states.get(recovery.session_id);
    } catch (error) {
      throw mapStorageError(error, "Existing Codex thread mapping could not be read.", thread.id, "remote_succeeded");
    }
    let state: SelectedSessionState;
    if (existing === null) {
      state = this.createSelectedState(recovery, thread, model);
      try {
        this.options.states.create(state);
      } catch (error) {
        throw mapStorageError(error, "Codex thread mapping could not be persisted.", thread.id, "remote_succeeded");
      }
    } else {
      assertPersistedIdentity(existing, recovery, thread);
      state = existing;
    }

    let persisted: SelectedSessionStartRecoveryRecord;
    try {
      persisted = this.options.states.putRecovery({
        ...recovery,
        state: "persisted",
        updated_at: this.advanceTimestamp(recovery.updated_at)
      });
      if (!this.options.states.deleteRecovery(persisted.operation_id)) {
        throw new Error("Recovery row disappeared before finalization.");
      }
    } catch (error) {
      throw serviceError(
        "storage_error",
        "Persisted session-start recovery could not be finalized.",
        "remote_succeeded",
        false,
        thread.id,
        error
      );
    }
    return state;
  }

  private finishPersistedRecovery(recovery: SelectedSessionStartRecoveryRecord): SelectedSessionState {
    if (recovery.codex_thread_id === null) {
      throw serviceError(
        "identity_mismatch",
        "Persisted start recovery is missing its thread id.",
        "remote_succeeded",
        false
      );
    }
    let state: SelectedSessionState | null;
    try {
      state = this.options.states.get(recovery.session_id);
    } catch (error) {
      throw mapStorageError(
        error,
        "Persisted session-start mapping could not be read.",
        recovery.codex_thread_id,
        "remote_succeeded"
      );
    }
    if (state === null) {
      throw serviceError(
        "storage_error",
        "Persisted start recovery has no selected mapping.",
        "remote_succeeded",
        false,
        recovery.codex_thread_id
      );
    }
    assertPersistedIdentity(state, recovery, { id: recovery.codex_thread_id, cwd: recovery.cwd });
    try {
      if (!this.options.states.deleteRecovery(recovery.operation_id)) {
        throw new Error("Recovery row disappeared before finalization.");
      }
    } catch (error) {
      throw serviceError(
        "storage_error",
        "Persisted session-start recovery could not be finalized.",
        "remote_succeeded",
        false,
        recovery.codex_thread_id,
        error
      );
    }
    return state;
  }

  private createSelectedState(
    recovery: SelectedSessionStartRecoveryRecord,
    thread: CodexThreadRecord,
    model: string | null
  ): SelectedSessionState {
    const projectionState = projectionFromThread(thread);
    const updatedAt = maxTimestamp(thread.updated_at, recovery.updated_at, this.timestamp());
    const archivedAt = thread.archived === true ? updatedAt : null;
    let branch: string | null;
    try {
      branch = this.captureBranch(recovery.cwd);
    } catch (error) {
      throw serviceError(
        "storage_error",
        "Git branch metadata capture failed during thread mapping.",
        "remote_succeeded",
        false,
        thread.id,
        error
      );
    }
    return {
      mapping: {
        id: recovery.session_id,
        name: recovery.name,
        codex_thread_id: thread.id,
        cwd: recovery.cwd,
        runtime_source: "codex_app_server",
        runtime_version: this.options.threads.runtime_version,
        disposition: "selected",
        created_at: thread.created_at,
        updated_at: updatedAt,
        archived_at: archivedAt
      },
      projection: {
        session: {
          id: recovery.session_id,
          name: recovery.name,
          codex_thread_id: thread.id,
          cwd: recovery.cwd,
          runtime_source: "codex_app_server",
          runtime_version: this.options.threads.runtime_version,
          created_at: thread.created_at,
          archived_at: archivedAt,
          session_state: thread.archived === true ? "archived" : projectionState.session_state,
          turn_state: thread.archived === true ? "idle" : projectionState.turn_state,
          attention: thread.archived === true ? "none" : projectionState.attention,
          freshness: projectionState.freshness,
          freshness_reason: projectionState.freshness_reason,
          updated_at: updatedAt,
          last_activity_at: thread.updated_at,
          branch,
          model,
          settings: null,
          goal: null,
          recent_summary: thread.archived === true ? "Managed Codex session archived." : projectionState.summary,
          last_event_cursor: null
        },
        retained_event_count: 0,
        retained_event_bytes: 0,
        earliest_retained_cursor: null,
        retention_boundary_cursor: null
      }
    };
  }

  private reconcileState(current: SelectedSessionState, thread: CodexThreadRecord): SelectedSessionState {
    if (current.mapping.archived_at !== null && thread.archived !== true) {
      throw serviceError("identity_mismatch", "Codex reports a durable archived mapping as active.", "unknown", false, thread.id);
    }
    const projectionState = projectionFromThread(thread);
    const updatedAt = this.advanceTimestamp(current.mapping.updated_at, current.projection.session.updated_at);
    const archivedAt = thread.archived === true ? (current.mapping.archived_at ?? updatedAt) : null;
    const next = {
      mapping: {
        ...current.mapping,
        disposition: "selected" as const,
        updated_at: updatedAt,
        archived_at: archivedAt
      },
      projection: {
        ...current.projection,
        session: {
          ...current.projection.session,
          session_state: thread.archived === true ? ("archived" as const) : projectionState.session_state,
          turn_state: thread.archived === true ? ("idle" as const) : projectionState.turn_state,
          attention: thread.archived === true ? ("none" as const) : projectionState.attention,
          freshness: projectionState.freshness,
          freshness_reason: projectionState.freshness_reason,
          archived_at: archivedAt,
          updated_at: updatedAt,
          last_activity_at: maxNullableTimestamp(current.projection.session.last_activity_at, thread.updated_at),
          recent_summary: thread.archived === true ? "Managed Codex session archived." : projectionState.summary
        }
      }
    };
    try {
      return this.options.states.replace(next, selectedStateRevision(current));
    } catch (error) {
      throw mapStorageError(error, "Managed session reconciliation could not be persisted.", thread.id);
    }
  }

  private markStale(current: SelectedSessionState, reason: string): SelectedSessionState {
    const updatedAt = this.advanceTimestamp(current.mapping.updated_at, current.projection.session.updated_at);
    try {
      return this.options.states.replace(
        {
          mapping: { ...current.mapping, disposition: "recovery_required", updated_at: updatedAt },
          projection: {
            ...current.projection,
            session: {
              ...current.projection.session,
              session_state: current.mapping.archived_at === null ? "stale" : "archived",
              turn_state: current.mapping.archived_at === null ? "unknown" : "idle",
              attention: "unknown",
              freshness: "stale",
              freshness_reason: bounded(reason),
              updated_at: updatedAt,
              recent_summary: "Managed Codex session requires reconciliation."
            }
          }
        },
        selectedStateRevision(current)
      );
    } catch (error) {
      throw mapStorageError(error, "Stale managed-session state could not be persisted.", current.mapping.codex_thread_id);
    }
  }

  private recordFailedStart(recovery: SelectedSessionStartRecoveryRecord, error: HostDeckCodexAdapterError): void {
    const errorCode = recoveryErrorCode(error);
    try {
      this.options.states.putRecovery({
        ...recovery,
        state: "failed",
        updated_at: this.advanceTimestamp(recovery.updated_at),
        error_code: errorCode,
        error_message: bounded(error.message)
      });
    } catch (storageError) {
      throw serviceError(
        "storage_error",
        "Known Codex start failure could not be recorded.",
        error.outcome === "remote_rejected" ? "remote_rejected" : "not_sent",
        false,
        null,
        storageError
      );
    }
  }

  private recordFailedStartTimeout(
    recovery: SelectedSessionStartRecoveryRecord,
    error: unknown
  ): void {
    try {
      this.options.states.putRecovery({
        ...recovery,
        state: "failed",
        updated_at: this.advanceTimestamp(recovery.updated_at),
        error_code: "operation_timeout",
        error_message: bounded(
          error instanceof Error ? error.message : "Session start deadline expired before dispatch."
        )
      });
    } catch (storageError) {
      throw serviceError(
        "storage_error",
        "Session start timed out before dispatch and its terminal recovery state could not be persisted.",
        "not_sent",
        false,
        null,
        new AggregateError([error, storageError])
      );
    }
  }

  private getRecovery(operationId: string): SelectedSessionStartRecoveryRecord | null {
    try {
      return this.options.states.getRecovery(operationId);
    } catch (error) {
      throw mapStorageError(error, "Session-start recovery could not be read.");
    }
  }

  private async validateStartCwd(cwd: string): Promise<void> {
    try {
      await this.validateCwd(cwd);
    } catch (error) {
      throw serviceError("invalid_cwd", `Session working directory ${cwd} is unavailable.`, "not_sent", true, null, error);
    }
  }

  private timestamp(): IsoTimestamp {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw serviceError("invalid_request", "Managed thread service clock returned an invalid date.", "not_sent", false);
    }
    return date.toISOString() as IsoTimestamp;
  }

  private advanceTimestamp(...current: readonly IsoTimestamp[]): IsoTimestamp {
    const candidate = this.timestamp();
    const latest = current.reduce((maximum, value) => (value > maximum ? value : maximum));
    if (candidate > latest) return candidate;
    const advanced = new Date(Date.parse(latest) + 1);
    if (!Number.isFinite(advanced.getTime())) {
      throw serviceError("storage_error", "Managed session timestamp cannot advance.", "not_sent", false);
    }
    return advanced.toISOString() as IsoTimestamp;
  }
}

function projectionFromThread(thread: CodexThreadRecord): {
  readonly session_state: "active" | "stale";
  readonly turn_state: "idle" | "in_progress" | "waiting_for_approval" | "waiting_for_input" | "unknown";
  readonly attention: "needs_approval" | "needs_input" | "none" | "unknown" | "watch";
  readonly freshness: "current" | "stale";
  readonly freshness_reason: string | null;
  readonly summary: string;
} {
  if (thread.status === "system_error") {
    return {
      session_state: "stale",
      turn_state: "unknown",
      attention: "unknown",
      freshness: "stale",
      freshness_reason: "Codex reported a system error for the thread.",
      summary: "Codex thread requires reconciliation."
    };
  }
  if (thread.status !== "active") {
    return {
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      summary: "Managed Codex session ready."
    };
  }
  if (thread.active_flags.includes("waiting_on_approval")) {
    return {
      session_state: "active",
      turn_state: "waiting_for_approval",
      attention: "needs_approval",
      freshness: "current",
      freshness_reason: null,
      summary: "Codex is waiting for approval."
    };
  }
  if (thread.active_flags.includes("waiting_on_user_input")) {
    return {
      session_state: "active",
      turn_state: "waiting_for_input",
      attention: "needs_input",
      freshness: "current",
      freshness_reason: null,
      summary: "Codex is waiting for input."
    };
  }
  return {
    session_state: "active",
    turn_state: "in_progress",
    attention: "watch",
    freshness: "current",
    freshness_reason: null,
    summary: "Codex thread is active."
  };
}

function parseStartRequest(input: unknown): SelectedStartSessionRequest {
  const parsed = selectedStartSessionRequestSchema.safeParse(input);
  if (!parsed.success) throw serviceError("invalid_request", "Managed session start request is invalid.", "not_sent", false, null, parsed.error);
  return parsed.data;
}

function parseSelectedSessionId(input: string): SessionId {
  const parsed = sessionIdSchema.safeParse(input);
  if (!parsed.success) throw serviceError("invalid_request", "Managed session id is invalid.", "not_sent", false, null, parsed.error);
  return parsed.data;
}

function assertRecoveryRequest(recovery: SelectedSessionStartRecoveryRecord, request: SelectedStartSessionRequest): void {
  if (recovery.name !== request.name || recovery.cwd !== request.cwd) {
    throw serviceError("thread_conflict", "Session start operation id is already reserved for different input.", "not_sent", false);
  }
}

function assertPersistedIdentity(
  state: SelectedSessionState,
  recovery: SelectedSessionStartRecoveryRecord,
  thread: Pick<CodexThreadRecord, "cwd" | "id">
): void {
  if (
    state.mapping.id !== recovery.session_id ||
    state.mapping.name !== recovery.name ||
    state.mapping.cwd !== recovery.cwd ||
    state.mapping.codex_thread_id !== thread.id ||
    thread.cwd !== recovery.cwd
  ) {
    throw serviceError(
      "identity_mismatch",
      "Persisted managed session does not match start recovery identity.",
      "remote_succeeded",
      false,
      thread.id
    );
  }
}

function assertArchivableState(state: SelectedSessionState): void {
  const mapping = state.mapping;
  const session = state.projection.session;
  if (
    mapping.archived_at !== null ||
    session.archived_at !== null ||
    session.session_state === "archived"
  ) {
    throw serviceError(
      "thread_already_archived",
      "Managed session is already archived.",
      "not_sent",
      false,
      mapping.codex_thread_id
    );
  }
  if (
    mapping.id !== session.id ||
    mapping.name !== session.name ||
    mapping.codex_thread_id !== session.codex_thread_id ||
    mapping.cwd !== session.cwd ||
    mapping.runtime_source !== session.runtime_source ||
    mapping.runtime_version !== session.runtime_version ||
    mapping.created_at !== session.created_at
  ) {
    throw serviceError(
      "identity_mismatch",
      "Managed session mapping and projection identities do not match.",
      "not_sent",
      false,
      mapping.codex_thread_id
    );
  }
  if (
    mapping.disposition !== "selected" ||
    session.session_state !== "active" ||
    session.turn_state !== "idle" ||
    session.freshness !== "current"
  ) {
    throw serviceError(
      "thread_not_writable",
      "Managed session is not current and idle for archive.",
      "not_sent",
      false,
      mapping.codex_thread_id
    );
  }
}

function assertRuntimeThreadArchivable(
  thread: CodexThreadRecord,
  state: SelectedSessionState
): void {
  if (
    thread.id !== state.mapping.codex_thread_id ||
    thread.cwd !== state.mapping.cwd ||
    !isSupportedCodexThreadSource(thread.source)
  ) {
    throw serviceError(
      "identity_mismatch",
      "Codex thread identity could not be verified before archive.",
      "not_sent",
      false,
      state.mapping.codex_thread_id
    );
  }
  if (thread.archived === true) {
    throw serviceError(
      "thread_already_archived",
      "Managed Codex thread is already archived.",
      "not_sent",
      false,
      state.mapping.codex_thread_id
    );
  }
  if (thread.status !== "idle" || thread.active_flags.length !== 0) {
    throw serviceError(
      "thread_not_writable",
      "Managed Codex thread is not idle for archive.",
      "not_sent",
      false,
      state.mapping.codex_thread_id
    );
  }
}

function assertSameArchiveCandidate(
  before: SelectedSessionState,
  candidate: SelectedSessionState
): void {
  assertArchivableState(candidate);
  const expected = selectedStateRevision(before);
  const actual = selectedStateRevision(candidate);
  if (
    before.mapping.id !== candidate.mapping.id ||
    before.mapping.name !== candidate.mapping.name ||
    before.mapping.codex_thread_id !== candidate.mapping.codex_thread_id ||
    before.mapping.cwd !== candidate.mapping.cwd ||
    before.mapping.runtime_source !== candidate.mapping.runtime_source ||
    before.mapping.runtime_version !== candidate.mapping.runtime_version ||
    before.mapping.created_at !== candidate.mapping.created_at ||
    expected.mapping_updated_at !== actual.mapping_updated_at ||
    expected.projection_updated_at !== actual.projection_updated_at ||
    expected.last_event_cursor !== actual.last_event_cursor
  ) {
    throw serviceError(
      "thread_conflict",
      "Managed session changed while archive target was being verified.",
      "not_sent",
      false,
      before.mapping.codex_thread_id
    );
  }
}

function isKnownNoThreadOutcome(error: unknown): error is HostDeckCodexAdapterError {
  return error instanceof HostDeckCodexAdapterError && ["not_sent", "remote_rejected"].includes(error.outcome);
}

function recoveryErrorCode(error: HostDeckCodexAdapterError): ErrorCode {
  if (["request_aborted", "request_timeout"].includes(error.code)) return "operation_timeout";
  if (error.code === "remote_error") return "runtime_unavailable";
  if (error.code === "invalid_protocol_message" || error.code === "protocol_violation") return "protocol_error";
  return "runtime_unavailable";
}

function mapAdapterError(error: unknown, fallback: string): HostDeckManagedCodexThreadServiceError {
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return serviceError("runtime_unavailable", fallback, "unknown", false, null, error);
  }
  if (["request_aborted", "request_timeout"].includes(error.code)) {
    return serviceError(
      "operation_timeout",
      error.message,
      error.outcome === "unknown"
        ? "unknown"
        : error.outcome === "remote_rejected"
          ? "remote_rejected"
          : "not_sent",
      error.outcome === "unknown" ? false : error.retry_safe,
      null,
      error
    );
  }
  if (error.outcome === "unknown" || error.code === "unknown_outcome") {
    return serviceError("unknown_outcome", error.message, "unknown", false, null, error);
  }
  if (error.outcome === "remote_rejected") {
    return serviceError("runtime_unavailable", error.message, "remote_rejected", error.retry_safe, null, error);
  }
  return serviceError("runtime_unavailable", error.message, "not_sent", error.retry_safe, null, error);
}

function requireManagedThreadDeadline(candidate: unknown): OperationDeadline {
  return requireOpenOperationDeadline(
    candidate,
    (cause) =>
      serviceError(
        "operation_timeout",
        "Managed Codex thread operation exceeded its request deadline.",
        "not_sent",
        true,
        null,
        cause
      ),
    (cause) =>
      serviceError(
        "invalid_request",
        "Managed Codex thread request deadline is invalid.",
        "not_sent",
        false,
        null,
        cause
      )
  );
}

function mapMaterializationError(error: unknown, threadId: string): HostDeckManagedCodexThreadServiceError {
  if (error instanceof HostDeckCodexAdapterError) {
    if (error.outcome === "unknown" || error.code === "unknown_outcome") {
      return serviceError("unknown_outcome", error.message, "remote_succeeded", false, threadId, error);
    }
    if (error.outcome === "remote_rejected" || error.outcome === "not_applicable") {
      return serviceError(
        "recovery_required",
        `Codex thread materialization requires recovery: ${error.message}`,
        "remote_succeeded",
        false,
        threadId,
        error
      );
    }
  }
  const mapped = mapAdapterError(error, "Recovery Codex thread could not be materialized and verified.");
  return serviceError(mapped.code, mapped.message, "remote_succeeded", false, threadId, error);
}

function mapStorageError(
  error: unknown,
  fallback: string,
  threadId: string | null = null,
  outcome: ManagedCodexThreadServiceOutcome = "not_sent"
): HostDeckManagedCodexThreadServiceError {
  if (error instanceof HostDeckSelectedStateRepositoryError) {
    if (error.code === "duplicate_session_name") {
      return serviceError("duplicate_session_name", error.message, outcome, false, threadId, error);
    }
    if (["duplicate_thread_id", "identity_mismatch", "recovery_conflict", "session_exists"].includes(error.code)) {
      return serviceError("thread_conflict", error.message, outcome, false, threadId, error);
    }
    if (error.code === "session_not_found") {
      return serviceError("thread_not_found", error.message, outcome, false, threadId, error);
    }
  }
  return serviceError("storage_error", fallback, outcome, false, threadId, error);
}

function issueFromError(error: unknown, sessionId: string | null, operationId: string | null): ManagedThreadReconciliationIssue {
  const mapped =
    error instanceof HostDeckManagedCodexThreadServiceError
      ? error
      : serviceError("storage_error", "Managed thread reconciliation failed unexpectedly.", "unknown", false, null, error);
  return { session_id: sessionId, operation_id: operationId, code: mapped.code, message: mapped.message };
}

function serviceError(
  code: ManagedCodexThreadServiceErrorCode,
  message: string,
  outcome: ManagedCodexThreadServiceOutcome,
  retrySafe: boolean,
  threadId: string | null = null,
  cause?: unknown
): HostDeckManagedCodexThreadServiceError {
  return new HostDeckManagedCodexThreadServiceError(code, message, outcome, retrySafe, threadId, { cause });
}

async function validateDirectory(cwd: string): Promise<void> {
  if (!(await stat(cwd)).isDirectory()) throw new Error("Path is not a directory.");
}

function defaultSessionId(): SessionId {
  const candidate = `sess_${randomBytes(10).toString("hex")}`;
  const parsed = parseSessionId(candidate);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function maxTimestamp(...values: readonly IsoTimestamp[]): IsoTimestamp {
  const first = values[0];
  if (first === undefined) throw new Error("At least one timestamp is required.");
  return values.slice(1).reduce((latest, value) => (value > latest ? value : latest), first);
}

function maxNullableTimestamp(left: IsoTimestamp | null, right: IsoTimestamp): IsoTimestamp {
  return left === null || right > left ? right : left;
}

function bounded(value: string): string {
  let printable = "";
  for (let index = 0; index < Math.min(value.length, 4_096); index += 1) {
    const code = value.charCodeAt(index);
    printable += code <= 31 || code === 127 ? " " : value[index];
  }
  const normalized = printable.replace(/\s+/gu, " ").trim() || "Managed Codex thread operation failed.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
