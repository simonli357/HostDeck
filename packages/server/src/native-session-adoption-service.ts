import { randomBytes } from "node:crypto";
import {
  type CodexNativeSessionClient,
  HostDeckCodexAdapterError,
  HostDeckCodexNativeSessionError
} from "@hostdeck/codex-adapter";
import {
  type NativeCodexAdoptionSnapshot,
  type NativeSessionAdoptRequest,
  type NativeSessionDiscoveryRequest,
  type NativeSessionDiscoveryResponse,
  type NativeSessionUnmanageRequest,
  type NativeSessionUnmanageResponse,
  nativeSessionAdoptRequestSchema,
  nativeSessionContractLimits,
  nativeSessionDiscoveryRequestSchema,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageRequestSchema,
  nativeSessionUnmanageResponseSchema,
  selectedProjectionEventSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { IsoTimestamp, OperationDeadline, SessionId } from "@hostdeck/core";
import { parseSessionId } from "@hostdeck/core";
import {
  captureGitBranchMetadata,
  HostDeckSelectedStateRepositoryError,
  type SelectedSessionState,
  type SelectedStateRepository,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "@hostdeck/storage";
import type {
  CodexEventPipeline,
  CodexEventPipelineMembershipNormalizer
} from "./codex-event-pipeline.js";
import { HostDeckCodexEventPipelineError } from "./codex-event-pipeline.js";
import {
  requireOpenOperationDeadline,
  runSerializedWithDeadline
} from "./operation-deadline-serialization.js";

export type NativeSessionAdministrationErrorCode =
  | "duplicate_session_name"
  | "identity_mismatch"
  | "invalid_request"
  | "operation_timeout"
  | "protocol_error"
  | "recovery_required"
  | "runtime_incompatible"
  | "runtime_unavailable"
  | "session_not_adopted"
  | "session_not_found"
  | "session_not_quiet"
  | "storage_error"
  | "thread_already_managed"
  | "thread_conflict"
  | "thread_ineligible";

export type NativeSessionAdministrationOutcome =
  | "committed"
  | "not_sent"
  | "unknown";

export class HostDeckNativeSessionAdministrationError extends Error {
  constructor(
    readonly code: NativeSessionAdministrationErrorCode,
    message: string,
    readonly outcome: NativeSessionAdministrationOutcome,
    readonly retry_safe: boolean,
    readonly session_id: string | null = null,
    readonly thread_id: string | null = null,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckNativeSessionAdministrationError";
  }
}

export interface NativeSessionAdministrationServiceOptions {
  readonly native: CodexNativeSessionClient;
  readonly states: SelectedStateRepository;
  readonly events: Pick<CodexEventPipeline, "transitionMembership">;
  readonly now?: () => Date;
  readonly create_session_id?: () => SessionId;
  readonly capture_branch?: (cwd: string) => string | null;
}

export interface NativeSessionAdministrationService {
  readonly discover: (
    input: unknown,
    deadline: OperationDeadline
  ) => Promise<NativeSessionDiscoveryResponse>;
  readonly adopt: (
    input: unknown,
    deadline: OperationDeadline
  ) => Promise<SelectedSessionState>;
  readonly unmanage: (
    sessionId: string,
    input: unknown,
    deadline: OperationDeadline
  ) => Promise<NativeSessionUnmanageResponse>;
}

const membershipMutationKey = "native-session-membership";
const recoveryLatchAttempts = 8;

export function createNativeSessionAdministrationService(
  options: NativeSessionAdministrationServiceOptions
): NativeSessionAdministrationService {
  return new DefaultNativeSessionAdministrationService(parseOptions(options));
}

interface ParsedOptions {
  readonly native: CodexNativeSessionClient;
  readonly states: SelectedStateRepository;
  readonly events: Pick<CodexEventPipeline, "transitionMembership">;
  readonly now: () => Date;
  readonly createSessionId: () => SessionId;
  readonly captureBranch: (cwd: string) => string | null;
}

class DefaultNativeSessionAdministrationService
  implements NativeSessionAdministrationService
{
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly options: ParsedOptions) {}

  async discover(
    input: unknown,
    deadlineInput: OperationDeadline
  ): Promise<NativeSessionDiscoveryResponse> {
    const deadline = requireNativeDeadline(deadlineInput);
    const request = parseDiscoveryRequest(input);
    requireNativeDeadline(deadline);

    let discovered: NativeSessionDiscoveryResponse;
    try {
      discovered = await this.options.native.discover(
        { limit: nativeSessionContractLimits.discoveryLimit },
        deadline
      );
    } catch (error) {
      throw mapAdapterError(error, "Native Codex sessions could not be discovered.");
    }
    requireNativeDeadline(deadline);

    let managedThreadIds: Set<string>;
    try {
      managedThreadIds = new Set(
        this.options.states.list().map((state) => state.mapping.codex_thread_id)
      );
    } catch (error) {
      throw mapStorageError(error, "Managed session membership could not be read.");
    }
    const limit = request.limit ?? nativeSessionContractLimits.discoveryDefaultLimit;
    const unmanaged = discovered.threads.filter(
      (thread) => !managedThreadIds.has(thread.thread_id)
    );
    return deepFreeze(
      nativeSessionDiscoveryResponseSchema.parse({
        limit,
        threads: unmanaged.slice(0, limit),
        truncated: discovered.truncated || unmanaged.length > limit
      })
    );
  }

  adopt(
    input: unknown,
    deadlineInput: OperationDeadline
  ): Promise<SelectedSessionState> {
    const deadline = requireNativeDeadline(deadlineInput);
    const request = parseAdoptRequest(input);
    return runSerializedWithDeadline(
      this.mutationTails,
      membershipMutationKey,
      deadline,
      nativeDeadlineFailure,
      () => this.adoptSerialized(request, deadline),
      invalidDeadlineFailure
    );
  }

  unmanage(
    sessionId: string,
    input: unknown,
    deadlineInput: OperationDeadline
  ): Promise<NativeSessionUnmanageResponse> {
    const deadline = requireNativeDeadline(deadlineInput);
    const parsedSessionId = parseSelectedSessionId(sessionId);
    const request = parseUnmanageRequest(input);
    return runSerializedWithDeadline(
      this.mutationTails,
      membershipMutationKey,
      deadline,
      nativeDeadlineFailure,
      () => this.unmanageSerialized(parsedSessionId, request, deadline),
      invalidDeadlineFailure
    );
  }

  private async adoptSerialized(
    request: NativeSessionAdoptRequest,
    deadline: OperationDeadline
  ): Promise<SelectedSessionState> {
    requireNativeDeadline(deadline);
    this.assertAvailableIdentity(request);
    requireNativeDeadline(deadline);

    let snapshot: NativeCodexAdoptionSnapshot;
    try {
      snapshot = await this.options.native.readAdoptionSnapshot(
        request.thread_id,
        deadline
      );
    } catch (error) {
      throw mapAdapterError(error, "Native Codex session could not be validated for adoption.");
    }
    requireNativeDeadline(deadline);
    this.assertAvailableIdentity(request);

    const state = this.buildAdoptionState(request, snapshot);
    try {
      await this.options.events.transitionMembership(
        () => this.options.states.adopt(state),
        deadline.signal
      );
    } catch (error) {
      throw mapMembershipTransitionError(
        error,
        "Native Codex session membership could not be committed.",
        null,
        request.thread_id
      );
    }

    try {
      requireNativeDeadline(deadline);
      const resumed = await this.options.native.resume(request.thread_id, deadline);
      requireNativeDeadline(deadline);
      assertResumedIdentity(snapshot, resumed.thread);
      return deepFreeze(this.options.states.require(state.state.mapping.id));
    } catch (error) {
      const latchError = this.markRecoveryRequired(
        state.state.mapping.id,
        "Native Codex session activation failed after HostDeck committed adoption."
      );
      throw administrationError(
        "recovery_required",
        latchError === null
          ? "Native Codex session was adopted, but activation failed and requires explicit reconciliation."
          : "Native Codex session was adopted, but activation failed and its recovery state could not be confirmed.",
        "committed",
        false,
        state.state.mapping.id,
        request.thread_id,
        latchError === null ? error : new AggregateError([error, latchError])
      );
    }
  }

  private async unmanageSerialized(
    sessionId: SessionId,
    request: NativeSessionUnmanageRequest,
    deadline: OperationDeadline
  ): Promise<NativeSessionUnmanageResponse> {
    requireNativeDeadline(deadline);
    let current: SelectedSessionState;
    try {
      current = this.options.states.require(sessionId);
    } catch (error) {
      throw mapStorageError(
        error,
        "Managed session could not be read before unmanage.",
        sessionId
      );
    }
    const unmanagedAt = this.timestampAfter(
      current.mapping.updated_at,
      current.projection.session.updated_at
    );
    requireNativeDeadline(deadline);

    try {
      const removed = await this.options.events.transitionMembership(
        (normalizer: CodexEventPipelineMembershipNormalizer) => {
          const result = this.options.states.unmanageAdopted(
            sessionId,
            selectedStateRevision(current)
          );
          normalizer.forgetThread(result.membership.codex_thread_id);
          return result;
        },
        deadline.signal
      );
      if (
        removed.state.mapping.id !== sessionId ||
        removed.membership.session_id !== sessionId ||
        removed.membership.codex_thread_id !== current.mapping.codex_thread_id
      ) {
        throw new TypeError("Native session unmanage returned contradictory identity.");
      }
    } catch (error) {
      throw mapMembershipTransitionError(
        error,
        "Native session membership could not be removed.",
        sessionId,
        current.mapping.codex_thread_id
      );
    }
    return deepFreeze(
      nativeSessionUnmanageResponseSchema.parse({
        operation_id: request.operation_id,
        session_id: sessionId,
        codex_thread_id: current.mapping.codex_thread_id,
        unmanaged_at: unmanagedAt
      })
    );
  }

  private assertAvailableIdentity(request: NativeSessionAdoptRequest): void {
    let states: readonly SelectedSessionState[];
    try {
      states = this.options.states.list();
    } catch (error) {
      throw mapStorageError(error, "Managed session identity could not be checked.");
    }
    if (states.some((state) => state.mapping.codex_thread_id === request.thread_id)) {
      throw administrationError(
        "thread_already_managed",
        "Native Codex thread is already managed by HostDeck.",
        "not_sent",
        false,
        null,
        request.thread_id
      );
    }
    if (states.some((state) => state.mapping.name === request.name)) {
      throw administrationError(
        "duplicate_session_name",
        `Managed session name ${request.name} already exists.`,
        "not_sent",
        false,
        null,
        request.thread_id
      );
    }
  }

  private buildAdoptionState(
    request: NativeSessionAdoptRequest,
    snapshot: NativeCodexAdoptionSnapshot
  ): {
    readonly membership: unknown;
    readonly state: SelectedSessionState;
    readonly events: readonly unknown[];
  } {
    if (snapshot.thread.thread_id !== request.thread_id) {
      throw administrationError(
        "identity_mismatch",
        "Native Codex adoption snapshot returned a different thread id.",
        "not_sent",
        false,
        null,
        request.thread_id
      );
    }
    const handoffConfirmedAt = this.timestamp();
    const adoptedAt = maxTimestamp(
      handoffConfirmedAt,
      snapshot.thread.updated_at,
      snapshot.thread.created_at
    );
    let branch: string | null;
    try {
      branch = this.options.captureBranch(snapshot.thread.cwd);
    } catch (error) {
      throw administrationError(
        "storage_error",
        "Git branch metadata capture failed during native session adoption.",
        "not_sent",
        false,
        null,
        request.thread_id,
        error
      );
    }
    const sessionId = this.createSessionId();
    const events = buildAdoptionEvents(
      sessionId,
      snapshot,
      adoptedAt
    );
    const retainedBytes = events.reduce(
      (total, event) => total + event.byte_length,
      0
    );
    const firstEvent = events[0];
    const lastEvent = events.at(-1);
    if (firstEvent === undefined || lastEvent === undefined) {
      throw administrationError(
        "storage_error",
        "Native session adoption projection is unexpectedly empty.",
        "not_sent",
        false,
        null,
        request.thread_id
      );
    }
    const summary =
      snapshot.turns.length === 0
        ? "Adopted native Codex session ready."
        : `Adopted native Codex session with ${snapshot.turns.length} retained turn${snapshot.turns.length === 1 ? "" : "s"}.`;
    const state: SelectedSessionState = {
      mapping: {
        id: sessionId,
        name: request.name,
        codex_thread_id: snapshot.thread.thread_id,
        cwd: snapshot.thread.cwd,
        runtime_source: "codex_app_server",
        runtime_version: snapshot.thread.runtime_version,
        disposition: "selected",
        created_at: snapshot.thread.created_at,
        updated_at: adoptedAt,
        archived_at: null
      },
      projection: {
        session: {
          id: sessionId,
          name: request.name,
          codex_thread_id: snapshot.thread.thread_id,
          cwd: snapshot.thread.cwd,
          runtime_source: "codex_app_server",
          runtime_version: snapshot.thread.runtime_version,
          created_at: snapshot.thread.created_at,
          archived_at: null,
          session_state: "active",
          turn_state: "idle",
          attention: "none",
          freshness: "current",
          freshness_reason: null,
          updated_at: adoptedAt,
          last_activity_at: snapshot.thread.updated_at,
          branch,
          model: null,
          settings: null,
          goal: null,
          recent_summary: summary,
          last_event_cursor: lastEvent.event.cursor
        },
        retained_event_count: events.length,
        retained_event_bytes: retainedBytes,
        earliest_retained_cursor: firstEvent.event.cursor,
        retention_boundary_cursor: null
      }
    };
    return {
      membership: {
        session_id: sessionId,
        codex_thread_id: snapshot.thread.thread_id,
        origin: "adopted",
        adopted_at: adoptedAt,
        handoff_confirmed_at: handoffConfirmedAt
      },
      state,
      events
    };
  }

  private markRecoveryRequired(sessionId: SessionId, reason: string): Error | null {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < recoveryLatchAttempts; attempt += 1) {
      let current: SelectedSessionState;
      try {
        current = this.options.states.require(sessionId);
      } catch (error) {
        return asError(error);
      }
      if (
        current.mapping.disposition === "recovery_required" &&
        current.projection.session.freshness === "stale"
      ) {
        return null;
      }
      const updatedAt = this.timestampAfter(
        current.mapping.updated_at,
        current.projection.session.updated_at
      );
      try {
        this.options.states.replace(
          {
            mapping: {
              ...current.mapping,
              disposition: "recovery_required",
              updated_at: updatedAt
            },
            projection: {
              ...current.projection,
              session: {
                ...current.projection.session,
                session_state: "stale",
                turn_state: "unknown",
                attention: "unknown",
                freshness: "stale",
                freshness_reason: reason,
                updated_at: updatedAt,
                recent_summary: "Adopted Codex session requires reconciliation."
              }
            }
          },
          selectedStateRevision(current)
        );
        return null;
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof HostDeckSelectedStateRepositoryError) ||
          error.code !== "projection_conflict"
        ) {
          return asError(error);
        }
      }
    }
    return asError(lastError);
  }

  private createSessionId(): SessionId {
    let candidate: unknown;
    try {
      candidate = this.options.createSessionId();
    } catch (error) {
      throw administrationError(
        "storage_error",
        "Native session id generation failed.",
        "not_sent",
        false,
        null,
        null,
        error
      );
    }
    const parsed = sessionIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw administrationError(
        "storage_error",
        "Native session id generation returned invalid identity.",
        "not_sent",
        false,
        null,
        null,
        parsed.error
      );
    }
    return parsed.data;
  }

  private timestamp(): IsoTimestamp {
    let candidate: unknown;
    try {
      candidate = this.options.now();
    } catch (error) {
      throw administrationError(
        "storage_error",
        "Native session administration clock failed.",
        "not_sent",
        false,
        null,
        null,
        error
      );
    }
    if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) {
      throw administrationError(
        "storage_error",
        "Native session administration clock returned an invalid date.",
        "not_sent",
        false
      );
    }
    return candidate.toISOString() as IsoTimestamp;
  }

  private timestampAfter(...values: readonly string[]): IsoTimestamp {
    const now = this.timestamp();
    const floor = values.reduce(
      (maximum, value) => Math.max(maximum, Date.parse(value)),
      -1
    );
    const milliseconds = Math.max(Date.parse(now), floor + 1);
    if (!Number.isSafeInteger(milliseconds)) {
      throw administrationError(
        "storage_error",
        "Native session timestamp space is exhausted.",
        "not_sent",
        false
      );
    }
    return new Date(milliseconds).toISOString() as IsoTimestamp;
  }
}

function buildAdoptionEvents(
  sessionId: SessionId,
  snapshot: NativeCodexAdoptionSnapshot,
  capturedAt: IsoTimestamp
) {
  let cursor = 1;
  const projected = [
    selectedProjectionEventSchema.parse({
      session_id: sessionId,
      cursor,
      captured_at: capturedAt,
      upstream_at: null,
      codex_event_id: null,
      codex_event_type: null,
      content_state: "complete",
      content_notice: null,
      type: "replay_boundary",
      after: null,
      next_cursor: cursor,
      reason: "adoption"
    })
  ];
  for (const turn of snapshot.turns) {
    for (const message of turn.messages) {
      cursor += 1;
      projected.push(
        selectedProjectionEventSchema.parse({
          session_id: sessionId,
          cursor,
          captured_at: capturedAt,
          upstream_at: turn.started_at,
          codex_event_id: `native:item:${message.item_id}`,
          codex_event_type: `native_history/${message.role}_message`,
          content_state: "complete",
          content_notice: null,
          type: "message",
          role: message.role,
          phase: "completed",
          item_id: message.item_id,
          text: message.text
        })
      );
    }
    cursor += 1;
    projected.push(
      selectedProjectionEventSchema.parse({
        session_id: sessionId,
        cursor,
        captured_at: capturedAt,
        upstream_at: turn.completed_at,
        codex_event_id: `native:turn:${turn.turn_id}`,
        codex_event_type: "native_history/turn",
        content_state: "complete",
        content_notice: null,
        type: "turn",
        turn_id: turn.turn_id,
        state: turn.status,
        error:
          turn.status === "failed"
            ? {
                code: "unknown_error",
                message: "Imported native Codex turn failed."
              }
            : null
      })
    );
  }
  return Object.freeze(
    projected.map((event) =>
      Object.freeze({
        event,
        byte_length: selectedProjectedEventByteLength(event)
      })
    )
  );
}

function assertResumedIdentity(
  snapshot: NativeCodexAdoptionSnapshot,
  resumed: NativeCodexAdoptionSnapshot["thread"]
): void {
  const expected = snapshot.thread;
  if (
    resumed.thread_id !== expected.thread_id ||
    resumed.cwd !== expected.cwd ||
    resumed.source !== "cli" ||
    resumed.runtime_version !== expected.runtime_version ||
    resumed.created_at !== expected.created_at ||
    resumed.archived !== false ||
    resumed.ephemeral !== false ||
    resumed.parent_thread_id !== null ||
    resumed.forked_from_id !== null ||
    resumed.history_mode !== expected.history_mode
  ) {
    throw administrationError(
      "identity_mismatch",
      "Native Codex thread identity changed during HostDeck activation.",
      "committed",
      false,
      null,
      expected.thread_id
    );
  }
}

function parseOptions(options: NativeSessionAdministrationServiceOptions): ParsedOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.native?.discover !== "function" ||
    typeof options.native.readAdoptionSnapshot !== "function" ||
    typeof options.native.resume !== "function" ||
    typeof options.states?.list !== "function" ||
    typeof options.states.adopt !== "function" ||
    typeof options.states.unmanageAdopted !== "function" ||
    typeof options.events?.transitionMembership !== "function" ||
    (options.now !== undefined && typeof options.now !== "function") ||
    (options.create_session_id !== undefined &&
      typeof options.create_session_id !== "function") ||
    (options.capture_branch !== undefined &&
      typeof options.capture_branch !== "function")
  ) {
    throw new TypeError(
      "Native session administration requires adapter, state, clock, identity, and branch ports."
    );
  }
  return Object.freeze({
    native: options.native,
    states: options.states,
    events: options.events,
    now: options.now ?? (() => new Date()),
    createSessionId: options.create_session_id ?? defaultSessionId,
    captureBranch: options.capture_branch ?? captureGitBranchMetadata
  });
}

function parseDiscoveryRequest(input: unknown): NativeSessionDiscoveryRequest {
  const parsed = nativeSessionDiscoveryRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw administrationError(
      "invalid_request",
      "Native session discovery request is invalid.",
      "not_sent",
      false,
      null,
      null,
      parsed.error
    );
  }
  return parsed.data;
}

function parseAdoptRequest(input: unknown): NativeSessionAdoptRequest {
  const parsed = nativeSessionAdoptRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw administrationError(
      "invalid_request",
      "Native session adoption request is invalid.",
      "not_sent",
      false,
      null,
      null,
      parsed.error
    );
  }
  return parsed.data;
}

function parseUnmanageRequest(input: unknown): NativeSessionUnmanageRequest {
  const parsed = nativeSessionUnmanageRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw administrationError(
      "invalid_request",
      "Native session unmanage request is invalid.",
      "not_sent",
      false,
      null,
      null,
      parsed.error
    );
  }
  return parsed.data;
}

function parseSelectedSessionId(input: string): SessionId {
  const parsed = sessionIdSchema.safeParse(input);
  if (!parsed.success) {
    throw administrationError(
      "invalid_request",
      "Native session unmanage target is invalid.",
      "not_sent",
      false,
      null,
      null,
      parsed.error
    );
  }
  return parsed.data;
}

function mapAdapterError(
  error: unknown,
  fallback: string
): HostDeckNativeSessionAdministrationError {
  if (error instanceof HostDeckCodexNativeSessionError) {
    return administrationError(
      error.code === "identity_changed" ? "identity_mismatch" : "thread_ineligible",
      error.message,
      "not_sent",
      error.retry_safe,
      null,
      null,
      error
    );
  }
  if (error instanceof HostDeckCodexAdapterError) {
    if (["request_aborted", "request_timeout"].includes(error.code)) {
      return administrationError(
        "operation_timeout",
        error.message,
        error.outcome === "unknown" ? "unknown" : "not_sent",
        error.outcome === "unknown" ? false : error.retry_safe,
        null,
        null,
        error
      );
    }
    if (
      ["invalid_protocol_message", "protocol_violation", "unsupported_method"].includes(
        error.code
      )
    ) {
      return administrationError(
        "protocol_error",
        error.message,
        error.outcome === "unknown" ? "unknown" : "not_sent",
        false,
        null,
        null,
        error
      );
    }
    return administrationError(
      error.code === "handshake_failed"
        ? "runtime_incompatible"
        : "runtime_unavailable",
      error.message,
      error.outcome === "unknown" ? "unknown" : "not_sent",
      error.outcome === "unknown" ? false : error.retry_safe,
      null,
      null,
      error
    );
  }
  if (error instanceof HostDeckNativeSessionAdministrationError) return error;
  return administrationError(
    "runtime_unavailable",
    fallback,
    "unknown",
    false,
    null,
    null,
    error
  );
}

function mapStorageError(
  error: unknown,
  fallback: string,
  sessionId: string | null = null,
  threadId: string | null = null
): HostDeckNativeSessionAdministrationError {
  if (error instanceof HostDeckNativeSessionAdministrationError) return error;
  if (error instanceof HostDeckSelectedStateRepositoryError) {
    const mapping: Partial<
      Record<
        typeof error.code,
        NativeSessionAdministrationErrorCode
      >
    > = {
      duplicate_session_name: "duplicate_session_name",
      duplicate_thread_id: "thread_already_managed",
      identity_mismatch: "identity_mismatch",
      projection_conflict: "thread_conflict",
      session_exists: "thread_conflict",
      session_not_adopted: "session_not_adopted",
      session_not_found: "session_not_found",
      session_not_quiet: "session_not_quiet"
    };
    const code = mapping[error.code];
    if (code !== undefined) {
      return administrationError(
        code,
        error.message,
        "not_sent",
        false,
        sessionId,
        threadId,
        error
      );
    }
  }
  return administrationError(
    "storage_error",
    fallback,
    "not_sent",
    false,
    sessionId,
    threadId,
    error
  );
}

function mapMembershipTransitionError(
  error: unknown,
  fallback: string,
  sessionId: string | null = null,
  threadId: string | null = null
): HostDeckNativeSessionAdministrationError {
  if (
    error instanceof HostDeckCodexEventPipelineError &&
    error.code === "pipeline_barrier_aborted"
  ) {
    return administrationError(
      "operation_timeout",
      "Native session administration ended before its queued membership transition began.",
      "not_sent",
      true,
      sessionId,
      threadId,
      error
    );
  }
  return mapStorageError(error, fallback, sessionId, threadId);
}

function requireNativeDeadline(candidate: unknown): OperationDeadline {
  return requireOpenOperationDeadline(
    candidate,
    nativeDeadlineFailure,
    invalidDeadlineFailure
  );
}

function nativeDeadlineFailure(cause: unknown) {
  return administrationError(
    "operation_timeout",
    "Native session administration exceeded its request deadline.",
    "not_sent",
    true,
    null,
    null,
    cause
  );
}

function invalidDeadlineFailure(cause: unknown) {
  return administrationError(
    "invalid_request",
    "Native session administration deadline is invalid.",
    "not_sent",
    false,
    null,
    null,
    cause
  );
}

function administrationError(
  code: NativeSessionAdministrationErrorCode,
  message: string,
  outcome: NativeSessionAdministrationOutcome,
  retrySafe: boolean,
  sessionId: string | null = null,
  threadId: string | null = null,
  cause?: unknown
) {
  return new HostDeckNativeSessionAdministrationError(
    code,
    message,
    outcome,
    retrySafe,
    sessionId,
    threadId,
    cause === undefined ? undefined : { cause }
  );
}

function defaultSessionId(): SessionId {
  const candidate = `sess_${randomBytes(10).toString("hex")}`;
  const parsed = parseSessionId(candidate);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function maxTimestamp(...values: readonly IsoTimestamp[]): IsoTimestamp {
  const first = values[0];
  if (first === undefined) throw new TypeError("At least one timestamp is required.");
  return values
    .slice(1)
    .reduce((latest, value) => (value > latest ? value : latest), first);
}

function bounded(value: string): string {
  let printable = "";
  for (let index = 0; index < Math.min(value.length, 4_096); index += 1) {
    const code = value.charCodeAt(index);
    printable += code <= 31 || code === 127 ? " " : value[index];
  }
  const normalized =
    printable.replace(/\s+/gu, " ").trim() ||
    "Native session administration failed.";
  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 237)}...`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
