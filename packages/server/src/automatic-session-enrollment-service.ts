import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  type CodexConnectionNotification,
  type CodexEventNormalizerReconciliation,
  type CodexLoadedThreadClient,
  type CodexLoadedThreadSnapshot,
  codexLoadedThreadNotificationTarget,
  HostDeckCodexAdapterError,
  HostDeckCodexLoadedThreadError
} from "@hostdeck/codex-adapter";
import {
  absoluteCwdSchema,
  clientOperationIdSchema,
  codexThreadIdSchema,
  defaultResourceBudget,
  type LoadedThreadCandidate,
  nativeCodexThreadIdSchema,
  outputCursorSchema,
  type PendingEnrollmentNotification,
  type PendingEnrollmentSnapshot,
  pendingEnrollmentSnapshotSchema,
  type ResourceBudget,
  resourceBudgetSchema,
  type SharedSessionEnrollment,
  type SharedSessionMembershipRecord,
  selectedProjectionEventSchema,
  selectedSessionEnrollmentAuditEventRecordSchema,
  sharedCodexRuntimeContractLimits,
  sharedSessionEnrollmentSchema,
  type TrackedSession,
  trackedSessionSchema
} from "@hostdeck/contracts";
import type {
  CodexThreadId,
  ErrorCode,
  IsoTimestamp,
  NativeCodexThreadId
} from "@hostdeck/core";
import {
  type AutomaticSelectedSessionEnrollmentResult,
  captureGitBranchMetadata,
  deriveAutomaticSessionIdentity,
  type SelectedAuditRepository,
  type SelectedSessionState,
  type SelectedStateRepository,
  selectedProjectedEventByteLength
} from "@hostdeck/storage";
import type {
  CodexEventPipeline,
  CodexEventPipelineResult
} from "./codex-event-pipeline.js";

export type AutomaticSessionEnrollmentFailureCode =
  | "metadata_failure"
  | "pending_overflow"
  | "pending_timeout"
  | "runtime_boundary"
  | "storage_failure"
  | "subscription_failure";

export interface AutomaticSessionEnrollmentReconciliation {
  readonly origin: "loaded_before" | "reconciliation";
  readonly endpoint_generation: number;
  readonly loaded_thread_count: number;
  readonly outcomes: readonly SharedSessionEnrollment[];
}

export type AutomaticSessionNotificationResult =
  | { readonly kind: "projected"; readonly result: CodexEventPipelineResult }
  | { readonly kind: "enrollment"; readonly enrollment: SharedSessionEnrollment };

export interface AutomaticSessionEnrollmentServiceOptions {
  readonly loaded: CodexLoadedThreadClient;
  readonly states: SelectedStateRepository;
  readonly audit: SelectedAuditRepository;
  readonly events: Pick<CodexEventPipeline, "consume" | "reconcile" | "transitionMembership">;
  readonly resource_budget?: ResourceBudget;
  readonly now?: () => Date;
  readonly create_operation_id?: () => string;
  readonly create_record_id?: () => string;
  readonly capture_branch?: (cwd: string) => string | null;
  readonly background_mapped_refresh?: boolean;
  readonly background_unmapped_enrollment?: boolean;
  readonly reconcile_mapped_sessions?: boolean;
  readonly on_background_outcome?: (outcome: SharedSessionEnrollment) => void;
}

export interface AutomaticSessionEnrollmentService {
  readonly reconcileLoaded: (
    origin: "loaded_before" | "reconciliation",
    endpointGeneration: number,
    signal?: AbortSignal
  ) => Promise<AutomaticSessionEnrollmentReconciliation>;
  readonly observeNotification: (
    notification: CodexConnectionNotification,
    endpointGeneration: number
  ) => Promise<AutomaticSessionNotificationResult>;
  readonly retryPending: (
    threadId: NativeCodexThreadId | string
  ) => Promise<SharedSessionEnrollment>;
  readonly suspendBackgroundEnrollment: () => void;
  readonly startPendingBackgroundEnrollment: () => number;
  readonly close: () => readonly SharedSessionEnrollment[];
  readonly pending: readonly PendingEnrollmentSnapshot[];
  readonly background_failure: Error | null;
}

interface ParsedOptions {
  readonly loaded: CodexLoadedThreadClient;
  readonly states: SelectedStateRepository;
  readonly audit: SelectedAuditRepository;
  readonly events: Pick<CodexEventPipeline, "consume" | "reconcile" | "transitionMembership">;
  readonly budget: ResourceBudget;
  readonly now: () => Date;
  readonly createOperationId: () => string;
  readonly createRecordId: () => string;
  readonly captureBranch: (cwd: string) => string | null;
  readonly backgroundMappedRefresh: boolean;
  readonly backgroundUnmappedEnrollment: boolean;
  readonly reconcileMappedSessions: boolean;
  readonly onBackgroundOutcome: ((outcome: SharedSessionEnrollment) => void) | undefined;
}

interface BufferedNotification {
  readonly notification: CodexConnectionNotification;
  readonly generation: number;
  readonly metadata: PendingEnrollmentNotification;
}

interface PendingEnrollment {
  snapshot: PendingEnrollmentSnapshot;
  readonly notifications: BufferedNotification[];
  readonly generation: number;
  audit: EnrollmentAuditContext | null;
  attempts: number;
  readonly background: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface EnrollmentAuditContext {
  readonly operation_id: string;
  readonly accepted_at: IsoTimestamp;
}

interface EnrollmentBuild {
  readonly input: {
    readonly membership: unknown;
    readonly state: SelectedSessionState;
    readonly events: readonly unknown[];
    readonly project_cue: string;
  };
  readonly imported_event_count: number;
}

class EnrollmentSupersededError extends Error {
  constructor() {
    super("Automatic enrollment was superseded by an explicit terminal outcome.");
    this.name = "EnrollmentSupersededError";
  }
}

class EnrollmentExpiredError extends Error {
  constructor() {
    super("Automatic enrollment exceeded its bounded deadline before commit.");
    this.name = "EnrollmentExpiredError";
  }
}

export function createAutomaticSessionEnrollmentService(
  options: AutomaticSessionEnrollmentServiceOptions
): AutomaticSessionEnrollmentService {
  const service = new DefaultAutomaticSessionEnrollmentService(parseOptions(options));
  return Object.freeze({
    reconcileLoaded: (
      origin: "loaded_before" | "reconciliation",
      endpointGeneration: number,
      signal?: AbortSignal
    ) =>
      service.reconcileLoaded(origin, endpointGeneration, signal),
    observeNotification: (notification: CodexConnectionNotification, endpointGeneration: number) =>
      service.observeNotification(notification, endpointGeneration),
    retryPending: (threadId: NativeCodexThreadId | string) => service.retryPending(threadId),
    suspendBackgroundEnrollment: () => service.suspendBackgroundEnrollment(),
    startPendingBackgroundEnrollment: () => service.startPendingBackgroundEnrollment(),
    close: () => service.close(),
    get pending() {
      return service.pending;
    },
    get background_failure() {
      return service.background_failure;
    }
  });
}

class DefaultAutomaticSessionEnrollmentService {
  private readonly pendingByThread = new Map<string, PendingEnrollment>();
  private readonly terminalByThread = new Map<string, SharedSessionEnrollment>();
  private readonly inFlight = new Map<string, Promise<SharedSessionEnrollment>>();
  private closed = false;
  private backgroundEnrollmentActive = false;
  private backgroundFailure: Error | null = null;

  constructor(private readonly options: ParsedOptions) {}

  get pending(): readonly PendingEnrollmentSnapshot[] {
    return Object.freeze(
      [...this.pendingByThread.values()]
        .map((entry) => entry.snapshot)
        .sort((left, right) => String(left.native_thread_id).localeCompare(String(right.native_thread_id)))
    );
  }

  get background_failure(): Error | null {
    return this.backgroundFailure;
  }

  async reconcileLoaded(
    origin: "loaded_before" | "reconciliation",
    endpointGeneration: number,
    signal?: AbortSignal
  ): Promise<AutomaticSessionEnrollmentReconciliation> {
    this.requireOpen();
    const generation = parseGeneration(endpointGeneration);
    assertAbortSignal(signal);
    const ids = await this.options.loaded.listLoadedThreadIds(signal);
    const outcomes: SharedSessionEnrollment[] = [];
    for (const threadId of ids) {
      if (signal?.aborted === true) throw aborted(signal);
      this.terminalByThread.delete(threadId);
      const existingState = this.options.states.getByThreadId(threadId);
      if (
        !this.options.reconcileMappedSessions &&
        existingState !== null &&
        !requiresAutomaticRefresh(existingState, this.options.loaded.runtime_version)
      ) {
        continue;
      }
      const pending = this.pendingByThread.get(threadId) ?? this.createPending(
        threadId,
        origin,
        generation,
        null,
        existingState === null
          ? this.options.backgroundUnmappedEnrollment
          : this.options.backgroundMappedRefresh
      );
      if (pending === null) {
        outcomes.push(this.requireTerminal(threadId));
        continue;
      }
      if (pending.generation !== generation) {
        outcomes.push(this.failPending(pending, "runtime_boundary", "Shared Codex generation changed during enrollment."));
        continue;
      }
      if (pending.background) {
        outcomes.push(this.backgroundEnrollmentOutcome(pending));
        continue;
      }
      outcomes.push(await settleWithAbort(this.ensureEnrollment(pending), signal));
    }
    return deepFreeze({
      origin,
      endpoint_generation: generation,
      loaded_thread_count: ids.length,
      outcomes
    });
  }

  async observeNotification(
    notification: CodexConnectionNotification,
    endpointGeneration: number
  ): Promise<AutomaticSessionNotificationResult> {
    this.requireOpen();
    const generation = parseGeneration(endpointGeneration);
    const threadId = codexLoadedThreadNotificationTarget(notification);
    if (threadId === null) {
      return { kind: "projected", result: await this.options.events.consume(notification, generation) };
    }

    const pending = this.pendingByThread.get(threadId);
    if (pending !== undefined) {
      if (pending.generation !== generation) {
        return {
          kind: "enrollment",
          enrollment: this.failPending(pending, "runtime_boundary", "Shared Codex generation changed during enrollment.")
        };
      }
      const overflow = this.bufferNotification(pending, notification, generation);
      if (overflow !== null) return { kind: "enrollment", enrollment: overflow };
      if (pending.background) {
        return { kind: "enrollment", enrollment: this.backgroundEnrollmentOutcome(pending) };
      }
      return { kind: "enrollment", enrollment: await this.ensureEnrollment(pending) };
    }

    const terminal = this.terminalByThread.get(threadId);
    if (terminal !== undefined) {
      if (!isRetryableTerminalTimeout(terminal)) {
        return { kind: "enrollment", enrollment: terminal };
      }
      this.terminalByThread.delete(threadId);
    }
    const existingState = this.options.states.getByThreadId(threadId);
    if (
      existingState !== null &&
      !requiresAutomaticRefresh(existingState, this.options.loaded.runtime_version)
    ) {
      return { kind: "projected", result: await this.options.events.consume(notification, generation) };
    }

    let candidate: LoadedThreadCandidate | null = null;
    if (notification.method === "thread/started") {
      candidate = this.options.loaded.candidateFromStartedNotification(notification);
      if (candidate.eligibility.state === "ineligible") {
        const outcome = ineligibleOutcome(candidate, this.timestampAtOrAfter(candidate.updated_at));
        this.rememberTerminal(threadId, outcome);
        return { kind: "enrollment", enrollment: outcome };
      }
    }
    const created = this.createPending(
      threadId,
      notification.method === "thread/started" ? "created_after" : "resumed_after",
      generation,
      candidate,
      this.options.backgroundUnmappedEnrollment && existingState === null
    );
    if (created === null) return { kind: "enrollment", enrollment: this.requireTerminal(threadId) };
    const overflow = this.bufferNotification(created, notification, generation);
    if (overflow !== null) return { kind: "enrollment", enrollment: overflow };
    if (created.background) {
      return { kind: "enrollment", enrollment: this.backgroundEnrollmentOutcome(created) };
    }
    return { kind: "enrollment", enrollment: await this.ensureEnrollment(created) };
  }

  retryPending(threadId: NativeCodexThreadId | string): Promise<SharedSessionEnrollment> {
    this.requireOpen();
    const parsed = parseNativeThreadId(threadId);
    const pending = this.pendingByThread.get(parsed);
    if (pending === undefined) {
      const terminal = this.terminalByThread.get(parsed);
      if (terminal !== undefined) return Promise.resolve(terminal);
      throw new TypeError("Automatic enrollment retry requires one pending native thread.");
    }
    this.clearTimer(pending);
    return this.ensureEnrollment(pending);
  }

  suspendBackgroundEnrollment(): void {
    this.backgroundEnrollmentActive = false;
  }

  startPendingBackgroundEnrollment(): number {
    this.requireOpen();
    this.backgroundEnrollmentActive = true;
    let started = 0;
    for (const pending of this.pendingByThread.values()) {
      if (!pending.background || this.inFlight.has(String(pending.snapshot.native_thread_id))) continue;
      this.beginBackgroundEnrollment(pending);
      started += 1;
    }
    return started;
  }

  close(): readonly SharedSessionEnrollment[] {
    if (this.closed) return Object.freeze([]);
    this.closed = true;
    const failures = [...this.pendingByThread.values()].map((pending) =>
      this.failPending(pending, "runtime_boundary", "HostDeck closed during automatic enrollment.")
    );
    return Object.freeze(failures);
  }

  private ensureEnrollment(pending: PendingEnrollment): Promise<SharedSessionEnrollment> {
    const threadId = String(pending.snapshot.native_thread_id);
    const existing = this.inFlight.get(threadId);
    if (existing !== undefined) return existing;
    const operation = this.attemptEnrollment(pending).finally(() => {
      if (this.inFlight.get(threadId) === operation) this.inFlight.delete(threadId);
    });
    this.inFlight.set(threadId, operation);
    return operation;
  }

  private backgroundEnrollmentOutcome(pending: PendingEnrollment): SharedSessionEnrollment {
    if (this.backgroundEnrollmentActive) this.beginBackgroundEnrollment(pending);
    return deepFreeze(sharedSessionEnrollmentSchema.parse({ state: "pending", pending: pending.snapshot }));
  }

  private beginBackgroundEnrollment(pending: PendingEnrollment): void {
    const threadId = String(pending.snapshot.native_thread_id);
    if (!this.inFlight.has(threadId)) {
      void this.ensureEnrollment(pending)
        .then((outcome) => this.options.onBackgroundOutcome?.(outcome))
        .catch((error: unknown) => {
          if (this.backgroundFailure === null) this.backgroundFailure = asError(error);
        });
    }
  }

  private async attemptEnrollment(pending: PendingEnrollment): Promise<SharedSessionEnrollment> {
    if (this.closed) {
      return this.failPending(pending, "runtime_boundary", "HostDeck closed during automatic enrollment.");
    }
    this.clearTimer(pending);
    const now = this.timestamp();
    if (now >= pending.snapshot.deadline_at) {
      return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.");
    }
    pending.attempts += 1;
    this.updatePendingAttempt(pending, now);

    let candidate = pending.snapshot.candidate;
    if (candidate === null) {
      try {
        candidate = await this.options.loaded.readCandidate(pending.snapshot.native_thread_id);
      } catch (error) {
        return this.handleRetryableFailure(pending, "pending_metadata", error);
      }
      const supersededAfterRead = this.supersededOutcome(pending);
      if (supersededAfterRead !== null) return supersededAfterRead;
      if (this.deadlineExpired(pending)) {
        return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.");
      }
      if (candidate.eligibility.state === "ineligible") return this.completeIneligible(pending, candidate);
      this.updatePendingCandidate(pending, candidate, "pending_materialization");
    }

    try {
      this.ensureAuditAccepted(pending, candidate);
    } catch (error) {
      return this.failPending(pending, "storage_failure", "Automatic enrollment acceptance could not be audited.", error);
    }
    if (this.deadlineExpired(pending)) {
      return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.");
    }

    let snapshot: CodexLoadedThreadSnapshot;
    try {
      snapshot = await this.options.loaded.subscribeAndReadSnapshot(candidate);
    } catch (error) {
      if (error instanceof HostDeckCodexLoadedThreadError && error.code === "identity_changed") {
        this.updatePendingCandidate(pending, null, "pending_metadata");
        return this.handleRetryableFailure(pending, "pending_metadata", error);
      }
      return this.handleRetryableFailure(pending, "pending_materialization", error);
    }
    const supersededAfterSnapshot = this.supersededOutcome(pending);
    if (supersededAfterSnapshot !== null) return supersededAfterSnapshot;
    if (this.deadlineExpired(pending)) {
      return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.");
    }
    if (snapshot.candidate.eligibility.state === "ineligible") {
      return this.completeIneligible(pending, snapshot.candidate);
    }
    this.updatePendingCandidate(pending, snapshot.candidate, "pending_mapping");

    let build: EnrollmentBuild;
    try {
      build = this.buildEnrollment(pending, snapshot);
    } catch (error) {
      return this.failPending(pending, "storage_failure", "Automatic enrollment state could not be constructed.", error);
    }

    let committed: AutomaticSelectedSessionEnrollmentResult;
    try {
      committed = await this.options.events.transitionMembership(() => {
        if (this.pendingByThread.get(snapshot.candidate.native_thread_id) !== pending) {
          throw new EnrollmentSupersededError();
        }
        if (this.deadlineExpired(pending)) throw new EnrollmentExpiredError();
        return this.options.states.enrollAutomatic(build.input);
      });
    } catch (error) {
      if (error instanceof EnrollmentSupersededError) return this.requireTerminal(snapshot.candidate.native_thread_id);
      if (error instanceof EnrollmentExpiredError) {
        return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.");
      }
      return this.failPending(pending, "storage_failure", "Automatic session mapping could not be committed.", error);
    }
    try {
      assertCommittedEnrollment(committed, snapshot.candidate);
    } catch (error) {
      return this.failPending(pending, "storage_failure", "Committed automatic session identity is contradictory.", error);
    }

    const replay = replayableNotifications(pending.notifications, snapshot);
    const normalizerState: CodexEventNormalizerReconciliation = {
      thread_id: asCodexThreadId(snapshot.candidate.native_thread_id),
      active_turn_id: replay.seed_active_turn_id
    };
    try {
      await this.options.events.reconcile([normalizerState]);
      const supersededAfterReconcile = this.supersededOutcome(pending);
      if (supersededAfterReconcile !== null) return supersededAfterReconcile;
      let replayIndex = 0;
      while (true) {
        const buffered = pending.notifications[replayIndex];
        if (buffered === undefined) break;
        replayIndex += 1;
        if (!replay.should_replay(buffered.notification)) continue;
        await this.options.events.consume(buffered.notification, buffered.generation);
      }
    } catch (error) {
      return this.failPending(pending, "runtime_boundary", "Buffered Codex activity could not be reconciled after mapping.", error);
    }

    let outcome: SharedSessionEnrollment;
    try {
      outcome = enrolledOutcome(
        committed,
        snapshot.candidate,
        pending.snapshot.origin,
        build.imported_event_count,
        committed.created || committed.refreshed ? snapshot : null
      );
      this.recordAuditSucceeded(pending, committed.created, committed.refreshed);
    } catch (error) {
      return this.failAfterAuditTerminalError(
        pending,
        "Automatic enrollment completion could not be audited.",
        error
      );
    }
    this.pendingByThread.delete(snapshot.candidate.native_thread_id);
    this.terminalByThread.delete(snapshot.candidate.native_thread_id);
    return outcome;
  }

  private handleRetryableFailure(
    pending: PendingEnrollment,
    phase: PendingEnrollmentSnapshot["phase"],
    error: unknown
  ): SharedSessionEnrollment {
    const retryable =
      (error instanceof HostDeckCodexLoadedThreadError && error.retry_safe) ||
      (error instanceof HostDeckCodexAdapterError && error.retry_safe);
    if (!retryable) {
      const failure = phase === "pending_metadata" ? "metadata_failure" : "subscription_failure";
      return this.failPending(pending, failure, failureDetail(failure), error);
    }
    const now = this.timestamp();
    if (now >= pending.snapshot.deadline_at) {
      return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.", error);
    }
    this.updatePendingPhase(pending, phase, now);
    this.scheduleRetry(pending);
    return deepFreeze(sharedSessionEnrollmentSchema.parse({ state: "pending", pending: pending.snapshot }));
  }

  private buildEnrollment(
    pending: PendingEnrollment,
    snapshot: CodexLoadedThreadSnapshot
  ): EnrollmentBuild {
    const candidate = snapshot.candidate;
    const identity = deriveAutomaticSessionIdentity(candidate.native_thread_id, candidate.project_cue);
    const enrolledAt = this.timestampAtOrAfter(candidate.created_at, candidate.updated_at);
    const branch = this.options.captureBranch(candidate.cwd);
    const events = buildEnrollmentEvents(identity.internal_session_id, snapshot, enrolledAt);
    const retainedBytes = events.reduce((total, event) => total + event.byte_length, 0);
    const lastEvent = events.at(-1);
    if (lastEvent === undefined) throw new TypeError("Automatic enrollment history cannot be empty.");
    const activity = latestActivity(snapshot);
    const state = enrollmentState(candidate, snapshot, {
      branch,
      enrolledAt,
      identity,
      lastActivityAt: activity,
      lastCursor: lastEvent.event.cursor,
      retainedBytes,
      retainedEventCount: events.length
    });
    return {
      input: {
        membership: {
          session_id: identity.internal_session_id,
          native_thread_id: candidate.native_thread_id,
          origin: "automatic",
          enrollment_origin: pending.snapshot.origin,
          enrolled_at: enrolledAt
        },
        state,
        events,
        project_cue: candidate.project_cue
      },
      imported_event_count: events.length - 1
    };
  }

  private createPending(
    threadId: NativeCodexThreadId,
    origin: PendingEnrollmentSnapshot["origin"],
    generation: number,
    candidate: LoadedThreadCandidate | null,
    background = false
  ): PendingEnrollment | null {
    if (this.pendingByThread.size >= this.options.budget.protocol_enrollment_max_pending_threads) {
      const failure = failedOutcome(
        threadId,
        candidate === null ? "pending_metadata" : "pending_materialization",
        "pending_overflow",
        this.timestamp(),
        "Automatic enrollment thread capacity is exhausted."
      );
      this.rememberTerminal(threadId, failure);
      return null;
    }
    const firstSeen = this.timestamp();
    const deadline = addMilliseconds(firstSeen, this.options.budget.protocol_enrollment_pending_timeout_ms);
    const nextRetry = addMilliseconds(firstSeen, this.options.budget.protocol_enrollment_retry_interval_ms);
    const snapshot = pendingEnrollmentSnapshotSchema.parse({
      native_thread_id: threadId,
      origin,
      phase: candidate === null ? "pending_metadata" : "pending_materialization",
      candidate,
      first_seen_at: firstSeen,
      last_attempt_at: firstSeen,
      next_retry_at: nextRetry,
      deadline_at: deadline,
      attempt_count: 1,
      buffered_notifications: [],
      buffered_bytes: 0,
      boundary_required: false
    });
    const pending: PendingEnrollment = {
      snapshot: deepFreeze(snapshot),
      notifications: [],
      generation,
      audit: null,
      attempts: 0,
      background,
      timer: null
    };
    this.pendingByThread.set(threadId, pending);
    return pending;
  }

  private bufferNotification(
    pending: PendingEnrollment,
    notification: CodexConnectionNotification,
    generation: number
  ): SharedSessionEnrollment | null {
    if (this.timestamp() >= pending.snapshot.deadline_at) {
      return this.failPending(pending, "pending_timeout", "Loaded Codex thread did not enroll before its deadline.");
    }
    let wireBytes: number;
    try {
      wireBytes = Buffer.byteLength(JSON.stringify({ method: notification.method, params: notification.params }), "utf8");
    } catch (error) {
      return this.failPending(pending, "runtime_boundary", "Codex notification could not be measured for enrollment.", error);
    }
    const budget = this.options.budget;
    if (
      wireBytes < 1 ||
      wireBytes > budget.protocol_max_frame_bytes ||
      pending.notifications.length >= budget.protocol_enrollment_pending_events_per_thread ||
      pending.snapshot.buffered_bytes + wireBytes > budget.protocol_enrollment_pending_bytes_per_thread
    ) {
      return this.failPending(pending, "pending_overflow", "Automatic enrollment notification capacity is exhausted.");
    }
    const prior = pending.notifications.at(-1)?.metadata.received_at ?? pending.snapshot.first_seen_at;
    const receivedAt = this.timestampAtOrAfter(prior);
    const metadata = pendingEnrollmentSnapshotSchema.shape.buffered_notifications.element.parse({
      native_thread_id: pending.snapshot.native_thread_id,
      ordinal: pending.notifications.length + 1,
      method: notification.method,
      received_at: receivedAt,
      wire_bytes: wireBytes
    });
    pending.notifications.push({ notification, generation, metadata });
    pending.snapshot = deepFreeze(pendingEnrollmentSnapshotSchema.parse({
      ...pending.snapshot,
      buffered_notifications: pending.notifications.map((entry) => entry.metadata),
      buffered_bytes: pending.snapshot.buffered_bytes + wireBytes
    }));
    return null;
  }

  private updatePendingAttempt(pending: PendingEnrollment, attemptedAt: IsoTimestamp): void {
    const nextRetry = nextRetryAt(
      attemptedAt,
      pending.snapshot.deadline_at,
      this.options.budget.protocol_enrollment_retry_interval_ms
    );
    pending.snapshot = deepFreeze(pendingEnrollmentSnapshotSchema.parse({
      ...pending.snapshot,
      last_attempt_at: attemptedAt,
      next_retry_at: nextRetry,
      attempt_count: Math.max(1, pending.attempts)
    }));
  }

  private updatePendingCandidate(
    pending: PendingEnrollment,
    candidate: LoadedThreadCandidate | null,
    phase: PendingEnrollmentSnapshot["phase"]
  ): void {
    const materialized = pending.snapshot.candidate === null && candidate !== null;
    const phaseStarted = materialized ? this.timestamp() : null;
    const deadline = phaseStarted === null
      ? pending.snapshot.deadline_at
      : earlierTimestamp(
          addMilliseconds(
            pending.snapshot.first_seen_at,
            this.options.budget.protocol_enrollment_pending_timeout_ms * 2
          ),
          addMilliseconds(
            phaseStarted,
            this.options.budget.protocol_enrollment_pending_timeout_ms
          )
        );
    pending.snapshot = deepFreeze(pendingEnrollmentSnapshotSchema.parse({
      ...pending.snapshot,
      candidate,
      phase,
      deadline_at: deadline
    }));
  }

  private updatePendingPhase(
    pending: PendingEnrollment,
    phase: PendingEnrollmentSnapshot["phase"],
    attemptedAt: IsoTimestamp
  ): void {
    const candidate = phase === "pending_metadata" ? null : pending.snapshot.candidate;
    const nextRetry = nextRetryAt(
      attemptedAt,
      pending.snapshot.deadline_at,
      this.options.budget.protocol_enrollment_retry_interval_ms
    );
    pending.snapshot = deepFreeze(pendingEnrollmentSnapshotSchema.parse({
      ...pending.snapshot,
      phase,
      candidate,
      last_attempt_at: attemptedAt,
      next_retry_at: nextRetry,
      attempt_count: Math.max(1, pending.attempts)
    }));
  }

  private completeIneligible(
    pending: PendingEnrollment,
    candidate: LoadedThreadCandidate
  ): SharedSessionEnrollment {
    if (pending.audit !== null) {
      try {
        this.recordAuditFailed(pending, ineligibleAuditErrorCode(candidate));
      } catch (error) {
        return this.failAfterAuditTerminalError(
          pending,
          "Automatic enrollment ineligibility could not be audited.",
          error
        );
      }
    }
    this.clearTimer(pending);
    this.pendingByThread.delete(candidate.native_thread_id);
    const outcome = ineligibleOutcome(candidate, this.timestampAtOrAfter(candidate.updated_at));
    this.rememberTerminal(candidate.native_thread_id, outcome);
    return outcome;
  }

  private failPending(
    pending: PendingEnrollment,
    failure: AutomaticSessionEnrollmentFailureCode,
    detail: string,
    cause?: unknown
  ): SharedSessionEnrollment {
    if (pending.audit !== null) {
      try {
        this.recordAuditFailed(pending, failureAuditErrorCode(failure));
      } catch (error) {
        return this.failAfterAuditTerminalError(
          pending,
          "Automatic enrollment failure could not be audited.",
          error
        );
      }
    }
    this.clearTimer(pending);
    this.pendingByThread.delete(pending.snapshot.native_thread_id);
    const outcome = failedOutcome(
      pending.snapshot.native_thread_id,
      pending.snapshot.phase,
      failure,
      this.timestamp(),
      detail
    );
    void cause;
    this.rememberTerminal(pending.snapshot.native_thread_id, outcome);
    return outcome;
  }

  private failAfterAuditTerminalError(
    pending: PendingEnrollment,
    detail: string,
    error: unknown
  ): SharedSessionEnrollment {
    this.clearTimer(pending);
    this.pendingByThread.delete(pending.snapshot.native_thread_id);
    const failure = failedOutcome(
      pending.snapshot.native_thread_id,
      pending.snapshot.phase,
      "storage_failure",
      this.timestamp(),
      detail
    );
    if (this.backgroundFailure === null) this.backgroundFailure = asError(error);
    this.rememberTerminal(pending.snapshot.native_thread_id, failure);
    return failure;
  }

  private ensureAuditAccepted(
    pending: PendingEnrollment,
    candidate: LoadedThreadCandidate
  ): void {
    if (pending.audit !== null) return;
    const operationId = clientOperationIdSchema.parse(this.options.createOperationId());
    const acceptedAt = this.timestampAtOrAfter(pending.snapshot.first_seen_at);
    const record = selectedSessionEnrollmentAuditEventRecordSchema.parse({
      id: this.options.createRecordId(),
      operation_id: operationId,
      at: acceptedAt,
      actor: { type: "system", device_id: null, permission: null, origin: null },
      action: "session_enroll",
      target: { type: "native_codex_thread", codex_thread_id: candidate.native_thread_id },
      phase: "accepted",
      outcome: "accepted",
      payload_summary: { schema_version: 1, enrollment_origin: pending.snapshot.origin },
      error_code: null
    });
    this.options.audit.recordAccepted(record);
    pending.audit = Object.freeze({ operation_id: operationId, accepted_at: acceptedAt });
  }

  private recordAuditSucceeded(
    pending: PendingEnrollment,
    created: boolean,
    refreshed: boolean
  ): void {
    const audit = requireAuditContext(pending);
    this.options.audit.recordTerminal(selectedSessionEnrollmentAuditEventRecordSchema.parse({
      id: this.options.createRecordId(),
      operation_id: audit.operation_id,
      at: this.timestampAtOrAfter(audit.accepted_at),
      actor: { type: "system", device_id: null, permission: null, origin: null },
      action: "session_enroll",
      target: { type: "native_codex_thread", codex_thread_id: pending.snapshot.native_thread_id },
      phase: "terminal",
      outcome: "succeeded",
      payload_summary: { schema_version: 1, enrolled: true, created, refreshed },
      error_code: null
    }));
  }

  private recordAuditFailed(pending: PendingEnrollment, errorCode: ErrorCode): void {
    const audit = requireAuditContext(pending);
    this.options.audit.recordTerminal(selectedSessionEnrollmentAuditEventRecordSchema.parse({
      id: this.options.createRecordId(),
      operation_id: audit.operation_id,
      at: this.timestampAtOrAfter(audit.accepted_at),
      actor: { type: "system", device_id: null, permission: null, origin: null },
      action: "session_enroll",
      target: { type: "native_codex_thread", codex_thread_id: pending.snapshot.native_thread_id },
      phase: "terminal",
      outcome: "failed",
      payload_summary: { schema_version: 1 },
      error_code: errorCode
    }));
  }

  private scheduleRetry(pending: PendingEnrollment): void {
    if (this.closed || pending.timer !== null) return;
    const delay = Math.max(1, Date.parse(pending.snapshot.next_retry_at) - Date.parse(this.timestamp()));
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.ensureEnrollment(pending)
        .then((outcome) => this.options.onBackgroundOutcome?.(outcome))
        .catch((error: unknown) => {
          if (this.backgroundFailure === null) this.backgroundFailure = asError(error);
        });
    }, delay);
    pending.timer.unref();
  }

  private clearTimer(pending: PendingEnrollment): void {
    if (pending.timer === null) return;
    clearTimeout(pending.timer);
    pending.timer = null;
  }

  private rememberTerminal(threadId: NativeCodexThreadId | string, outcome: SharedSessionEnrollment): void {
    const key = String(threadId);
    if (
      !this.terminalByThread.has(key) &&
      this.terminalByThread.size >= this.options.budget.protocol_thread_max_loaded_reads
    ) {
      const error = new Error("Automatic enrollment terminal outcome capacity is exhausted.");
      if (this.backgroundFailure === null) this.backgroundFailure = error;
      throw error;
    }
    this.terminalByThread.set(key, outcome);
  }

  private requireTerminal(threadId: NativeCodexThreadId | string): SharedSessionEnrollment {
    const terminal = this.terminalByThread.get(String(threadId));
    if (terminal === undefined) throw new TypeError("Automatic enrollment terminal outcome is missing.");
    return terminal;
  }

  private supersededOutcome(pending: PendingEnrollment): SharedSessionEnrollment | null {
    return this.pendingByThread.get(pending.snapshot.native_thread_id) === pending
      ? null
      : this.requireTerminal(pending.snapshot.native_thread_id);
  }

  private timestamp(): IsoTimestamp {
    const candidate = this.options.now();
    if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) {
      throw new TypeError("Automatic enrollment clock returned an invalid date.");
    }
    return candidate.toISOString() as IsoTimestamp;
  }

  private timestampAtOrAfter(...values: readonly string[]): IsoTimestamp {
    const now = Date.parse(this.timestamp());
    const floor = values.reduce((maximum, value) => Math.max(maximum, Date.parse(value)), -1);
    const milliseconds = Math.max(now, floor);
    if (!Number.isSafeInteger(milliseconds)) throw new TypeError("Automatic enrollment timestamp is invalid.");
    return new Date(milliseconds).toISOString() as IsoTimestamp;
  }

  private deadlineExpired(pending: PendingEnrollment): boolean {
    return this.timestamp() >= pending.snapshot.deadline_at;
  }

  private requireOpen(): void {
    if (this.closed) throw new TypeError("Automatic enrollment service is closed.");
    if (this.backgroundFailure !== null) {
      throw new Error("Automatic enrollment service has an unresolved background failure.", {
        cause: this.backgroundFailure
      });
    }
  }
}

function buildEnrollmentEvents(
  sessionId: string,
  snapshot: CodexLoadedThreadSnapshot,
  capturedAt: IsoTimestamp
) {
  let cursor = 1;
  const events = [selectedProjectionEventSchema.parse({
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
    reason: "enrollment"
  })];
  for (const turn of snapshot.turns) {
    for (const message of turn.messages) {
      cursor += 1;
      events.push(selectedProjectionEventSchema.parse({
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
      }));
    }
    cursor += 1;
    events.push(selectedProjectionEventSchema.parse({
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
      error: turn.status === "failed"
        ? { code: "unknown_error", message: "Imported native Codex turn failed." }
        : null
    }));
  }
  if (events.length - 1 > sharedCodexRuntimeContractLimits.recentEvents) {
    throw new TypeError("Automatic enrollment history exceeded its projected-event bound.");
  }
  return Object.freeze(events.map((event) => Object.freeze({
    event,
    byte_length: selectedProjectedEventByteLength(event)
  })));
}

function enrollmentState(
  candidate: LoadedThreadCandidate,
  snapshot: CodexLoadedThreadSnapshot,
  input: {
    readonly branch: string | null;
    readonly enrolledAt: IsoTimestamp;
    readonly identity: ReturnType<typeof deriveAutomaticSessionIdentity>;
    readonly lastActivityAt: IsoTimestamp | null;
    readonly lastCursor: number;
    readonly retainedBytes: number;
    readonly retainedEventCount: number;
  }
): SelectedSessionState {
  const lifecycle = projectedLifecycle(candidate, snapshot);
  const cwd = absoluteCwdSchema.parse(candidate.cwd);
  const lastCursor = outputCursorSchema.parse(input.lastCursor);
  const mapping = {
    id: input.identity.internal_session_id,
    name: input.identity.alias,
    codex_thread_id: asCodexThreadId(candidate.native_thread_id),
    cwd,
    runtime_source: "codex_app_server" as const,
    runtime_version: candidate.runtime_version,
    disposition: "selected" as const,
    created_at: candidate.created_at,
    updated_at: input.enrolledAt,
    archived_at: null
  };
  return {
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
        archived_at: null,
        session_state: "active",
        turn_state: lifecycle.turn_state,
        attention: lifecycle.attention,
        freshness: "current",
        freshness_reason: null,
        updated_at: input.enrolledAt,
        last_activity_at: input.lastActivityAt,
        branch: input.branch,
        model: snapshot.runtime_model,
        settings: null,
        goal: null,
        recent_summary: lifecycle.summary,
        last_event_cursor: lastCursor
      },
      retained_event_count: input.retainedEventCount,
      retained_event_bytes: input.retainedBytes,
      earliest_retained_cursor: outputCursorSchema.parse(1),
      retention_boundary_cursor: null
    }
  };
}

function projectedLifecycle(
  candidate: LoadedThreadCandidate,
  snapshot: CodexLoadedThreadSnapshot
): {
  readonly turn_state: SelectedSessionState["projection"]["session"]["turn_state"];
  readonly attention: SelectedSessionState["projection"]["session"]["attention"];
  readonly summary: string;
} {
  if (candidate.status === "active") {
    if (candidate.active_flags.includes("waiting_on_approval")) {
      return { turn_state: "waiting_for_approval", attention: "needs_approval", summary: "Codex turn is waiting for approval." };
    }
    if (candidate.active_flags.includes("waiting_on_user_input")) {
      return { turn_state: "waiting_for_input", attention: "needs_input", summary: "Codex turn is waiting for input." };
    }
    return { turn_state: "in_progress", attention: "watch", summary: "Codex turn is in progress." };
  }
  const latest = snapshot.turns.at(-1);
  if (latest?.status === "failed") return { turn_state: "failed", attention: "watch", summary: "Latest Codex turn failed." };
  if (latest?.status === "interrupted") return { turn_state: "interrupted", attention: "none", summary: "Latest Codex turn was interrupted." };
  if (latest?.status === "completed") return { turn_state: "completed", attention: "none", summary: "Latest Codex turn completed." };
  return { turn_state: "idle", attention: "none", summary: "Native Codex session enrolled." };
}

function latestActivity(snapshot: CodexLoadedThreadSnapshot): IsoTimestamp | null {
  if (snapshot.active_turn_started_at !== null) return snapshot.active_turn_started_at;
  const latest = snapshot.turns.at(-1);
  return latest?.completed_at ?? latest?.started_at ?? null;
}

function enrolledOutcome(
  committed: AutomaticSelectedSessionEnrollmentResult,
  candidate: LoadedThreadCandidate,
  requestedOrigin: PendingEnrollmentSnapshot["origin"],
  importedEventCount: number,
  snapshot: CodexLoadedThreadSnapshot | null
): SharedSessionEnrollment {
  const membership = committed.membership;
  const enrolledAt = membershipTimestamp(membership);
  const origin = membership.origin === "automatic" ? membership.enrollment_origin : requestedOrigin;
  const tracked = trackedFromState(committed.state, candidate, origin);
  return deepFreeze(sharedSessionEnrollmentSchema.parse({
    state: "enrolled",
    session: tracked,
    subscribed: true,
    enrolled_at: enrolledAt,
    history: {
      turns_loaded: snapshot?.turns.length ?? 0,
      events_loaded: snapshot === null ? 0 : importedEventCount,
      truncated_before: snapshot?.truncated_before ?? false,
      boundary_cursor: snapshot?.truncated_before === true ? 1 : null
    },
    boundary_required: false
  }));
}

function trackedFromState(
  state: SelectedSessionState,
  candidate: LoadedThreadCandidate,
  origin: PendingEnrollmentSnapshot["origin"]
): TrackedSession {
  return trackedSessionSchema.parse({
    native_thread_id: candidate.native_thread_id,
    internal_session_id: state.mapping.id,
    alias: state.mapping.name,
    cwd: state.mapping.cwd,
    project_cue: candidate.project_cue,
    branch: state.projection.session.branch,
    runtime_version: state.mapping.runtime_version,
    runtime_source: state.mapping.runtime_source,
    enrollment_origin: origin,
    archived: state.mapping.archived_at !== null,
    created_at: state.mapping.created_at,
    updated_at: state.mapping.updated_at,
    archived_at: state.mapping.archived_at
  });
}

function membershipTimestamp(membership: SharedSessionMembershipRecord): string {
  return membership.origin === "automatic" ? membership.enrolled_at : membership.adopted_at;
}

function assertCommittedEnrollment(
  committed: AutomaticSelectedSessionEnrollmentResult,
  candidate: LoadedThreadCandidate
): void {
  const state = committed.state;
  if (
    String(state.mapping.codex_thread_id) !== String(candidate.native_thread_id) ||
    state.mapping.cwd !== candidate.cwd ||
    state.mapping.runtime_source !== "codex_app_server" ||
    state.mapping.runtime_version !== candidate.runtime_version ||
    state.mapping.disposition !== "selected" ||
    state.mapping.archived_at !== null ||
    state.projection.session.session_state === "archived"
  ) {
    throw new TypeError("Committed automatic enrollment does not match the exact loaded Codex identity.");
  }
}

function requiresAutomaticRefresh(
  state: SelectedSessionState,
  runtimeVersion: string
): boolean {
  if (
    state.mapping.archived_at !== null ||
    state.projection.session.session_state === "archived"
  ) {
    return false;
  }
  return (
    state.mapping.disposition !== "selected" ||
    state.mapping.runtime_version !== runtimeVersion
  );
}

function isRetryableTerminalTimeout(
  outcome: SharedSessionEnrollment
): outcome is Extract<SharedSessionEnrollment, { readonly state: "failed" }> {
  return outcome.state === "failed" && outcome.failure === "pending_timeout";
}

function replayableNotifications(
  buffered: readonly BufferedNotification[],
  snapshot: CodexLoadedThreadSnapshot
): {
  readonly seed_active_turn_id: CodexEventNormalizerReconciliation["active_turn_id"];
  readonly should_replay: (notification: CodexConnectionNotification) => boolean;
} {
  const terminalTurns = new Set(snapshot.turns.map((turn) => String(turn.turn_id)));
  const terminalItems = new Set(snapshot.turns.flatMap((turn) => turn.messages.map((message) => String(message.item_id))));
  const shouldReplay = (notification: CodexConnectionNotification): boolean => {
    if (notification.method === "thread/started") return false;
    const identity = notificationIdentity(notification);
    if (identity.turn_id !== null && terminalTurns.has(identity.turn_id)) return false;
    if (identity.item_id !== null && terminalItems.has(identity.item_id)) return false;
    return true;
  };
  const firstTurnEvent = buffered.map((entry) => entry.notification).find((notification) => {
    if (!shouldReplay(notification)) return false;
    return notificationIdentity(notification).turn_id !== null;
  });
  const seed = firstTurnEvent?.method === "turn/started" ? null : snapshot.active_turn_id;
  return { seed_active_turn_id: seed, should_replay: shouldReplay };
}

function notificationIdentity(notification: CodexConnectionNotification): {
  readonly turn_id: string | null;
  readonly item_id: string | null;
} {
  if (!isRecord(notification.params)) return { turn_id: null, item_id: null };
  const params = notification.params;
  const turn = isRecord(params.turn) ? params.turn : null;
  const item = isRecord(params.item) ? params.item : null;
  return {
    turn_id: typeof params.turnId === "string"
      ? params.turnId
      : typeof turn?.id === "string"
        ? turn.id
        : null,
    item_id: typeof params.itemId === "string"
      ? params.itemId
      : typeof item?.id === "string"
        ? item.id
        : null
  };
}

function ineligibleOutcome(
  candidate: LoadedThreadCandidate,
  rejectedAt: IsoTimestamp
): SharedSessionEnrollment {
  return deepFreeze(sharedSessionEnrollmentSchema.parse({
    state: "ineligible",
    candidate,
    rejected_at: rejectedAt,
    boundary_required: false
  }));
}

function failedOutcome(
  threadId: NativeCodexThreadId,
  phase: PendingEnrollmentSnapshot["phase"],
  failure: AutomaticSessionEnrollmentFailureCode,
  failedAt: IsoTimestamp,
  detail: string
): SharedSessionEnrollment {
  return deepFreeze(sharedSessionEnrollmentSchema.parse({
    state: "failed",
    native_thread_id: threadId,
    phase,
    failure,
    failed_at: failedAt,
    detail,
    boundary_required: true
  }));
}

function failureDetail(failure: AutomaticSessionEnrollmentFailureCode): string {
  if (failure === "metadata_failure") return "Loaded Codex thread metadata could not be read safely.";
  if (failure === "subscription_failure") return "Loaded Codex thread subscription could not be established safely.";
  if (failure === "pending_overflow") return "Automatic enrollment capacity is exhausted.";
  if (failure === "pending_timeout") return "Automatic enrollment exceeded its bounded deadline.";
  if (failure === "storage_failure") return "Automatic enrollment could not commit durable state.";
  return "Automatic enrollment crossed a shared Codex runtime boundary.";
}

function failureAuditErrorCode(failure: AutomaticSessionEnrollmentFailureCode): ErrorCode {
  if (failure === "pending_overflow") return "service_overloaded";
  if (failure === "pending_timeout") return "operation_timeout";
  if (failure === "storage_failure") return "storage_error";
  if (failure === "metadata_failure") return "protocol_error";
  return "runtime_unavailable";
}

function ineligibleAuditErrorCode(candidate: LoadedThreadCandidate): ErrorCode {
  if (candidate.eligibility.state !== "ineligible") return "capability_unavailable";
  if (candidate.eligibility.reason === "incompatible_runtime") return "incompatible_runtime";
  if (candidate.eligibility.reason === "invalid_cwd") return "invalid_cwd";
  if (["missing", "runtime_error"].includes(candidate.eligibility.reason)) return "runtime_unavailable";
  if (candidate.eligibility.reason === "contradictory_metadata") return "protocol_error";
  return "capability_unavailable";
}

function requireAuditContext(pending: PendingEnrollment): EnrollmentAuditContext {
  if (pending.audit === null) throw new TypeError("Automatic enrollment audit context is missing.");
  return pending.audit;
}

function parseOptions(options: AutomaticSessionEnrollmentServiceOptions): ParsedOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.loaded?.listLoadedThreadIds !== "function" ||
    typeof options.loaded?.readCandidate !== "function" ||
    typeof options.loaded?.subscribeAndReadSnapshot !== "function" ||
    typeof options.states?.enrollAutomatic !== "function" ||
    typeof options.audit?.recordAccepted !== "function" ||
    typeof options.audit?.recordTerminal !== "function" ||
    typeof options.events?.consume !== "function" ||
    typeof options.events?.reconcile !== "function" ||
    typeof options.events?.transitionMembership !== "function" ||
    (options.now !== undefined && typeof options.now !== "function") ||
    (options.create_operation_id !== undefined && typeof options.create_operation_id !== "function") ||
    (options.create_record_id !== undefined && typeof options.create_record_id !== "function") ||
    (options.capture_branch !== undefined && typeof options.capture_branch !== "function") ||
    (options.background_mapped_refresh !== undefined && typeof options.background_mapped_refresh !== "boolean") ||
    (options.background_unmapped_enrollment !== undefined && typeof options.background_unmapped_enrollment !== "boolean") ||
    (options.reconcile_mapped_sessions !== undefined && typeof options.reconcile_mapped_sessions !== "boolean") ||
    (options.on_background_outcome !== undefined && typeof options.on_background_outcome !== "function")
  ) {
    throw new TypeError("Automatic enrollment requires loaded-thread, storage, and event-pipeline ports.");
  }
  return Object.freeze({
    loaded: options.loaded,
    states: options.states,
    audit: options.audit,
    events: options.events,
    budget: resourceBudgetSchema.parse(options.resource_budget ?? defaultResourceBudget),
    now: options.now ?? (() => new Date()),
    createOperationId: options.create_operation_id ?? createEnrollmentOperationId,
    createRecordId: options.create_record_id ?? createEnrollmentAuditRecordId,
    captureBranch: options.capture_branch ?? captureGitBranchMetadata,
    backgroundMappedRefresh: options.background_mapped_refresh ?? false,
    backgroundUnmappedEnrollment: options.background_unmapped_enrollment ?? false,
    reconcileMappedSessions: options.reconcile_mapped_sessions ?? true,
    onBackgroundOutcome: options.on_background_outcome
  });
}

function createEnrollmentOperationId(): string {
  return `op_session_enroll_${randomBytes(16).toString("hex")}`;
}

function createEnrollmentAuditRecordId(): string {
  return `audit_session_enroll_${randomBytes(16).toString("hex")}`;
}

function parseGeneration(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new TypeError("Automatic enrollment requires one positive endpoint generation.");
  }
  return candidate as number;
}

function parseNativeThreadId(candidate: unknown): NativeCodexThreadId {
  const parsed = nativeCodexThreadIdSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Automatic enrollment native thread id is invalid.");
  return parsed.data;
}

function asCodexThreadId(candidate: NativeCodexThreadId): CodexThreadId {
  return codexThreadIdSchema.parse(candidate);
}

function addMilliseconds(timestamp: string, milliseconds: number): IsoTimestamp {
  const result = Date.parse(timestamp) + milliseconds;
  if (!Number.isSafeInteger(result)) throw new TypeError("Automatic enrollment timestamp range is exhausted.");
  return new Date(result).toISOString() as IsoTimestamp;
}

function earlierTimestamp(left: IsoTimestamp, right: IsoTimestamp): IsoTimestamp {
  return left <= right ? left : right;
}

function nextRetryAt(attemptedAt: string, deadlineAt: string, retryMs: number): IsoTimestamp {
  const attempted = Date.parse(attemptedAt);
  const deadline = Date.parse(deadlineAt);
  const next = Math.min(attempted + retryMs, deadline);
  if (!Number.isSafeInteger(next) || next <= attempted) {
    throw new TypeError("Automatic enrollment has no remaining retry interval.");
  }
  return new Date(next).toISOString() as IsoTimestamp;
}

function assertAbortSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function")
  ) throw new TypeError("Automatic enrollment abort signal is invalid.");
}

function aborted(signal: AbortSignal): Error {
  return new Error("Automatic enrollment reconciliation was aborted.", { cause: signal.reason });
}

function settleWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
