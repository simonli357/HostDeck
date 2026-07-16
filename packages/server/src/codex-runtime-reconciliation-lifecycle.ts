import {
  type CodexReconciliationLatestTurn,
  type CodexReconnectDisconnectedInput,
  type CodexReconnectLifecyclePort,
  type CodexReconnectReadyInput,
  type CodexReconnectReconcileInput,
  type CodexReconnectReconciliation,
  type CodexReconnectResubscribeInput,
  type CodexThreadGoal,
  type CodexThreadRecord,
  createCodexReconciliationReadClient,
  createCodexReconciliationResubscribeClient,
  HostDeckCodexAdapterError,
  isSupportedCodexThreadSource
} from "@hostdeck/codex-adapter";
import {
  assertResolvedResourceBudget,
  isoTimestampSchema,
  type ManagedSessionProjection,
  type ManagedSessionTarget,
  type ResourceBudget
} from "@hostdeck/contracts";
import type { IsoTimestamp, OperationDeadline } from "@hostdeck/core";
import {
  type ProductionProjectionAppendPort,
  type ProductionProjectionContinuityPort,
  type SelectedSessionState,
  type SelectedStateRepository,
  type StartupAuditOrphanReconciliationResult,
  selectedStateRevision
} from "@hostdeck/storage";

export type CodexRuntimeReconciliationPhase =
  | "idle"
  | "gap_prepared"
  | "reconciled"
  | "resubscribed"
  | "ready"
  | "failed";

export type CodexRuntimeReconciliationFailureCode =
  | "audit_incomplete"
  | "invalid_contract"
  | "lifecycle_conflict"
  | "mapping_contradiction"
  | "plan_rehydration_failed"
  | "projection_failed"
  | "runtime_read_failed"
  | "runtime_resume_failed"
  | "state_conflict";

export class HostDeckCodexRuntimeReconciliationError extends Error {
  constructor(
    readonly code: CodexRuntimeReconciliationFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexRuntimeReconciliationError";
  }
}

export interface CodexRuntimeAuditReconciliationInput {
  readonly eligible_before: string;
  readonly reconciled_at: string;
  readonly deadline: OperationDeadline;
}

export interface CodexRuntimeAuditReconciliationPort {
  readonly reconcile: (
    input: CodexRuntimeAuditReconciliationInput
  ) => StartupAuditOrphanReconciliationResult | Promise<StartupAuditOrphanReconciliationResult>;
}

export interface CodexRuntimeApprovalDisconnectPort {
  readonly disconnect: (generation: unknown) => Promise<number>;
}

export interface CodexRuntimeEventBarrierPort {
  readonly barrier: (input: {
    readonly generation: number;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
}

export interface CodexRuntimePlanRehydrationPort {
  readonly rehydrate: (target: unknown) => Promise<unknown>;
}

export interface CodexRuntimeReconciliationLifecycleOptions {
  readonly approvals: CodexRuntimeApprovalDisconnectPort;
  readonly audit: CodexRuntimeAuditReconciliationPort;
  readonly continuity: ProductionProjectionContinuityPort;
  readonly events: CodexRuntimeEventBarrierPort;
  readonly now: () => string;
  readonly plans: CodexRuntimePlanRehydrationPort;
  readonly projection: ProductionProjectionAppendPort;
  readonly repository: SelectedStateRepository;
  readonly resource_budget: ResourceBudget;
}

export interface CodexRuntimeReconciliationIssueCounts {
  readonly archived: number;
  readonly contradictions: number;
  readonly missing: number;
  readonly stale: number;
  readonly unavailable: number;
}

export interface CodexRuntimeReconciliationSnapshot {
  readonly phase: CodexRuntimeReconciliationPhase;
  readonly generation: number | null;
  readonly continuity: CodexReconnectReconciliation["continuity"] | null;
  readonly gap_reason: "disconnect" | "restart" | null;
  readonly cycle_count: number;
  readonly durable_session_count: number;
  readonly recoverable_session_count: number;
  readonly unmanaged_runtime_count: number;
  readonly boundary_count: number;
  readonly resumed_count: number;
  readonly ready_count: number;
  readonly approvals_superseded: number;
  readonly audits_reconciled: number;
  readonly issues: CodexRuntimeReconciliationIssueCounts;
  readonly last_failure: CodexRuntimeReconciliationFailureCode | null;
}

export interface CodexRuntimeReconciliationLifecycle extends CodexReconnectLifecyclePort {
  readonly snapshot: () => CodexRuntimeReconciliationSnapshot;
}

type GapReason = "disconnect" | "restart";
type SessionOutcomeKind = "archived" | "recoverable" | "stale";
type SessionIssue = "contradiction" | "missing" | "none" | "unavailable";

interface PreparedGap {
  readonly reason: GapReason;
  readonly lost_generation: number | null;
  readonly approvals_superseded: number;
  readonly audits_reconciled: number;
}

interface RuntimeObservation {
  readonly current: SelectedSessionState;
  readonly listed: CodexThreadRecord | null;
  readonly read: CodexThreadRecord | null;
  readonly read_unavailable: boolean;
  readonly goal: CodexThreadGoal | null;
  readonly latest_turn: CodexReconciliationLatestTurn | null;
  readonly detail_unavailable: boolean;
}

interface SessionOutcome {
  readonly target: ManagedSessionTarget;
  readonly identity: ReconciledSessionIdentity;
  readonly kind: SessionOutcomeKind;
  readonly issue: SessionIssue;
  readonly mapping_disposition: "recovery_required" | "selected";
  readonly patch: Partial<ManagedSessionProjection>;
}

interface ReconciledSessionIdentity {
  readonly cwd: string;
  readonly runtime_source: string;
  readonly runtime_version: string;
}

interface ActiveCycle {
  readonly generation: number;
  readonly gap: PreparedGap;
  readonly continuity: CodexReconnectReconciliation["continuity"];
  readonly outcomes: readonly SessionOutcome[];
  readonly recoverable_outcomes: readonly SessionOutcome[];
  readonly durable_session_count: number;
  readonly unmanaged_runtime_count: number;
  readonly boundary_count: number;
  readonly issues: CodexRuntimeReconciliationIssueCounts;
  resumed_outcomes: readonly SessionOutcome[];
  ready_count: number;
}

interface MutablePublicState {
  phase: CodexRuntimeReconciliationPhase;
  generation: number | null;
  continuity: CodexReconnectReconciliation["continuity"] | null;
  gapReason: GapReason | null;
  cycleCount: number;
  durableSessionCount: number;
  recoverableSessionCount: number;
  unmanagedRuntimeCount: number;
  boundaryCount: number;
  resumedCount: number;
  readyCount: number;
  approvalsSuperseded: number;
  auditsReconciled: number;
  issues: CodexRuntimeReconciliationIssueCounts;
  lastFailure: CodexRuntimeReconciliationFailureCode | null;
}

const optionKeys = [
  "approvals",
  "audit",
  "continuity",
  "events",
  "now",
  "plans",
  "projection",
  "repository",
  "resource_budget"
] as const;

const auditResultKeys = [
  "actionable_remaining",
  "batch_count",
  "duration_ms",
  "eligible_before",
  "eligible_pending_operation_count",
  "failure",
  "protected_recent_operation_count",
  "reasons",
  "reconciled_at",
  "reconciled_operation_count",
  "scan_complete",
  "status",
  "total_pending_operation_count"
] as const;

const emptyIssues: CodexRuntimeReconciliationIssueCounts = Object.freeze({
  archived: 0,
  contradictions: 0,
  missing: 0,
  stale: 0,
  unavailable: 0
});

export function createCodexRuntimeReconciliationLifecycle(
  options: CodexRuntimeReconciliationLifecycleOptions
): CodexRuntimeReconciliationLifecycle {
  const implementation = new DefaultCodexRuntimeReconciliationLifecycle(parseOptions(options));
  return Object.freeze({
    disconnected: (input: CodexReconnectDisconnectedInput) => implementation.disconnected(input),
    reconcile: (input: CodexReconnectReconcileInput) => implementation.reconcile(input),
    resubscribe: (input: CodexReconnectResubscribeInput) => implementation.resubscribe(input),
    ready: (input: CodexReconnectReadyInput) => implementation.ready(input),
    snapshot: () => implementation.snapshot()
  });
}

class DefaultCodexRuntimeReconciliationLifecycle {
  private pendingGap: PreparedGap | null = null;
  private cycle: ActiveCycle | null = null;
  private lastDisconnectedGeneration = 0;
  private readonly state: MutablePublicState = {
    phase: "idle",
    generation: null,
    continuity: null,
    gapReason: null,
    cycleCount: 0,
    durableSessionCount: 0,
    recoverableSessionCount: 0,
    unmanagedRuntimeCount: 0,
    boundaryCount: 0,
    resumedCount: 0,
    readyCount: 0,
    approvalsSuperseded: 0,
    auditsReconciled: 0,
    issues: emptyIssues,
    lastFailure: null
  };

  constructor(private readonly options: CodexRuntimeReconciliationLifecycleOptions) {}

  async disconnected(input: CodexReconnectDisconnectedInput): Promise<void> {
    parseDisconnectedInput(input);
    if (input.generation <= this.lastDisconnectedGeneration) {
      throw this.fail("lifecycle_conflict", "Codex runtime disconnect reconciliation repeated a completed generation.");
    }
    try {
      input.deadline.throwIfAborted();
      const gap = await this.prepareGap("disconnect", input.generation, input.deadline);
      input.deadline.throwIfAborted();
      this.lastDisconnectedGeneration = input.generation;
      this.pendingGap = gap;
      this.cycle = null;
      this.state.phase = "gap_prepared";
      this.state.generation = null;
      this.state.continuity = null;
      this.state.gapReason = gap.reason;
      this.state.approvalsSuperseded = gap.approvals_superseded;
      this.state.auditsReconciled = gap.audits_reconciled;
      this.state.lastFailure = null;
    } catch (error) {
      this.recordFailure(error, "projection_failed");
      throw error;
    }
  }

  async reconcile(input: CodexReconnectReconcileInput): Promise<CodexReconnectReconciliation> {
    parseReconcileInput(input);
    if (this.cycle !== null && this.cycle.generation === input.generation) {
      throw this.fail("lifecycle_conflict", "Codex runtime reconciliation repeated an active generation.");
    }
    try {
      input.deadline.throwIfAborted();
      const gap = this.pendingGap ?? (await this.prepareGap("restart", null, input.deadline));
      input.deadline.throwIfAborted();
      const reads = createCodexReconciliationReadClient(input.runtime, this.options.resource_budget);
      if (reads.generation !== input.generation || reads.runtime_version !== input.compatibility.observed_version) {
        throw this.fail("invalid_contract", "Codex reconciliation runtime identity changed before inspection.");
      }

      const states = this.options.repository.list();
      const runtimeThreads = await reads.listAllThreads(input.deadline.signal);
      input.deadline.throwIfAborted();
      const durableThreadIds = new Set(states.map((state) => state.mapping.codex_thread_id));
      const unmanagedRuntimeCount = runtimeThreads.filter((thread) => !durableThreadIds.has(thread.id)).length;
      const runtimeById = new Map(runtimeThreads.map((thread) => [thread.id, thread]));
      const observations: RuntimeObservation[] = [];
      for (const current of states) {
        input.deadline.throwIfAborted();
        observations.push(
          await this.observeSession(current, runtimeById.get(current.mapping.codex_thread_id) ?? null, reads, input.deadline)
        );
      }
      input.deadline.throwIfAborted();

      for (const observation of observations) this.assertArchivedMapping(observation);
      const outcomes = observations
        .filter((observation) => observation.current.mapping.archived_at === null)
        .map((observation) => deriveOutcome(observation, reads.runtime_version));

      let boundaryCount = 0;
      const committedOutcomes: SessionOutcome[] = [];
      for (const outcome of outcomes) {
        input.deadline.throwIfAborted();
        await this.commitOutcomeBoundary(outcome, gap.reason, input.deadline);
        committedOutcomes.push(outcome);
        boundaryCount += 1;
      }

      const recoverableOutcomes = Object.freeze(
        committedOutcomes.filter((outcome) => outcome.kind === "recoverable")
      );
      const issues = countIssues(committedOutcomes);
      const continuity = boundaryCount > 0 ? "boundary_required" : "continuous";
      const cycle: ActiveCycle = {
        generation: input.generation,
        gap,
        continuity,
        outcomes: Object.freeze(committedOutcomes),
        recoverable_outcomes: recoverableOutcomes,
        durable_session_count: states.length,
        unmanaged_runtime_count: unmanagedRuntimeCount,
        boundary_count: boundaryCount,
        issues,
        resumed_outcomes: Object.freeze([]),
        ready_count: 0
      };
      this.cycle = cycle;
      this.pendingGap = gap;
      this.state.phase = "reconciled";
      this.state.generation = input.generation;
      this.state.continuity = continuity;
      this.state.gapReason = gap.reason;
      this.state.cycleCount += 1;
      this.state.durableSessionCount = states.length;
      this.state.recoverableSessionCount = recoverableOutcomes.length;
      this.state.unmanagedRuntimeCount = unmanagedRuntimeCount;
      this.state.boundaryCount = boundaryCount;
      this.state.resumedCount = 0;
      this.state.readyCount = 0;
      this.state.approvalsSuperseded = gap.approvals_superseded;
      this.state.auditsReconciled = gap.audits_reconciled;
      this.state.issues = issues;
      this.state.lastFailure = null;
      return Object.freeze({ continuity });
    } catch (error) {
      this.recordFailure(error, "runtime_read_failed");
      throw error;
    }
  }

  async resubscribe(input: CodexReconnectResubscribeInput): Promise<void> {
    parseResubscribeInput(input);
    const cycle = this.requireCycle(input.generation, "reconciled");
    if (input.reconciliation.continuity !== cycle.continuity) {
      throw this.fail("invalid_contract", "Codex resubscription continuity contradicts reconciliation.");
    }
    try {
      const resumes = createCodexReconciliationResubscribeClient(input.runtime, this.options.resource_budget);
      if (resumes.generation !== input.generation || resumes.runtime_version !== input.compatibility.observed_version) {
        throw this.fail("invalid_contract", "Codex resubscription runtime identity changed before resume.");
      }
      const resumed: SessionOutcome[] = [];
      for (const outcome of cycle.recoverable_outcomes) {
        const target = outcome.target;
        input.deadline.throwIfAborted();
        const before = this.requireExactTarget(target, true, outcome.identity);
        const readback = await resumes.resumeThread(target.codex_thread_id, input.deadline.signal);
        input.deadline.throwIfAborted();
        if (readback.cwd !== before.mapping.cwd) {
          throw this.fail("mapping_contradiction", "Codex resume returned a different managed working directory.");
        }
        const current = this.requireExactTarget(target, true, outcome.identity);
        const settings = current.projection.session.settings;
        const settingsMatch =
          settings !== null &&
          settings.runtime_model === readback.runtime_model &&
          settings.reasoning_effort === readback.reasoning_effort;
        const updatedAt = this.timestampAfter(
          current.mapping.updated_at,
          current.projection.session.updated_at
        );
        this.options.repository.replace(
          {
            mapping: { ...current.mapping, updated_at: updatedAt },
            projection: {
              ...current.projection,
              session: {
                ...current.projection.session,
                model: readback.runtime_model,
                settings: settingsMatch ? settings : null,
                updated_at: updatedAt
              }
            }
          },
          selectedStateRevision(current)
        );
        resumed.push(outcome);
      }
      cycle.resumed_outcomes = Object.freeze(resumed);
      this.state.phase = "resubscribed";
      this.state.resumedCount = resumed.length;
      this.state.lastFailure = null;
    } catch (error) {
      this.recordFailure(error, "runtime_resume_failed");
      throw error;
    }
  }

  async ready(input: CodexReconnectReadyInput): Promise<void> {
    parseReadyInput(input);
    const cycle = this.requireCycle(input.generation, "resubscribed");
    if (input.reconciliation.continuity !== cycle.continuity) {
      throw this.fail("invalid_contract", "Codex ready continuity contradicts reconciliation.");
    }
    try {
      input.deadline.throwIfAborted();
      await this.options.events.barrier({ generation: input.generation, signal: input.deadline.signal });
      input.deadline.throwIfAborted();
      let readyCount = 0;
      for (const outcome of cycle.resumed_outcomes) {
        const target = outcome.target;
        input.deadline.throwIfAborted();
        const current = this.requireExactTarget(target, true, outcome.identity);
        const capturedAt = this.timestampAfter(
          current.mapping.updated_at,
          current.projection.session.updated_at
        );
        const nextSession = omitCursor({
          ...current.projection.session,
          session_state: "active",
          freshness: "current",
          freshness_reason: null,
          updated_at: capturedAt,
          recent_summary: readySummary(current.projection.session.turn_state)
        });
        await this.options.projection.append({
          session_id: target.session_id,
          expected_revision: selectedStateRevision(current),
          event: {
            captured_at: capturedAt,
            upstream_at: null,
            codex_event_id: null,
            codex_event_type: null,
            content_state: "complete",
            content_notice: null,
            type: "runtime",
            state: "ready",
            message: null
          },
          next_session: nextSession
        });
        try {
          await this.options.plans.rehydrate(target);
        } catch (error) {
          throw this.fail("plan_rehydration_failed", "Durable Plan settings could not be rehydrated.", error);
        }
        readyCount += 1;
      }
      input.deadline.throwIfAborted();
      await this.options.events.barrier({ generation: input.generation, signal: input.deadline.signal });
      input.deadline.throwIfAborted();
      cycle.ready_count = readyCount;
      this.pendingGap = null;
      this.state.phase = "ready";
      this.state.readyCount = readyCount;
      this.state.lastFailure = null;
    } catch (error) {
      this.recordFailure(error, "projection_failed");
      throw error;
    }
  }

  snapshot(): CodexRuntimeReconciliationSnapshot {
    return Object.freeze({
      phase: this.state.phase,
      generation: this.state.generation,
      continuity: this.state.continuity,
      gap_reason: this.state.gapReason,
      cycle_count: this.state.cycleCount,
      durable_session_count: this.state.durableSessionCount,
      recoverable_session_count: this.state.recoverableSessionCount,
      unmanaged_runtime_count: this.state.unmanagedRuntimeCount,
      boundary_count: this.state.boundaryCount,
      resumed_count: this.state.resumedCount,
      ready_count: this.state.readyCount,
      approvals_superseded: this.state.approvalsSuperseded,
      audits_reconciled: this.state.auditsReconciled,
      issues: Object.freeze({ ...this.state.issues }),
      last_failure: this.state.lastFailure
    });
  }

  private async prepareGap(
    reason: GapReason,
    lostGeneration: number | null,
    deadline: OperationDeadline
  ): Promise<PreparedGap> {
    deadline.throwIfAborted();
    const approvalsSuperseded = lostGeneration === null
      ? 0
      : requireNonnegativeCount(
          await this.options.approvals.disconnect(lostGeneration),
          "Approval cleanup returned an invalid superseded count."
        );
    deadline.throwIfAborted();
    const states = this.options.repository.list();
    const observed = this.timestamp();
    const cutoff = this.timestampAfter(
      observed,
      ...states.flatMap((state) => [state.mapping.updated_at, state.projection.session.updated_at])
    );
    const audit = await this.options.audit.reconcile({
      eligible_before: cutoff,
      reconciled_at: cutoff,
      deadline
    });
    deadline.throwIfAborted();
    assertCompleteAudit(audit, cutoff);

    for (const listed of states) {
      if (listed.mapping.archived_at !== null) continue;
      deadline.throwIfAborted();
      const current = this.options.repository.require(listed.mapping.id);
      if (current.mapping.archived_at !== null) continue;
      const capturedAt = this.timestampAfter(
        cutoff,
        current.mapping.updated_at,
        current.projection.session.updated_at
      );
      await this.options.projection.append({
        session_id: current.mapping.id,
        expected_revision: selectedStateRevision(current),
        event: {
          captured_at: capturedAt,
          upstream_at: null,
          codex_event_id: null,
          codex_event_type: null,
          content_state: "complete",
          content_notice: null,
          type: "runtime",
          state: "disconnected",
          message: reason === "disconnect"
            ? "Codex runtime disconnected; reconciliation is required."
            : "HostDeck restarted; runtime reconciliation is required."
        },
        next_session: omitCursor({
          ...current.projection.session,
          freshness: "disconnected",
          freshness_reason: reason === "disconnect"
            ? "Codex runtime disconnected; reconciliation is required."
            : "HostDeck restarted; runtime reconciliation is required.",
          updated_at: capturedAt,
          recent_summary: activeTurnState(current.projection.session.turn_state)
            ? "Runtime continuity was lost while work may still be active."
            : "Runtime continuity was lost; reconciliation is required."
        })
      });
    }
    return Object.freeze({
      reason,
      lost_generation: lostGeneration,
      approvals_superseded: approvalsSuperseded,
      audits_reconciled: audit.reconciled_operation_count
    });
  }

  private async observeSession(
    current: SelectedSessionState,
    listed: CodexThreadRecord | null,
    reads: ReturnType<typeof createCodexReconciliationReadClient>,
    deadline: OperationDeadline
  ): Promise<RuntimeObservation> {
    const readResult = await remoteReadOrUnavailable(
      () => reads.readThread(current.mapping.codex_thread_id, deadline.signal)
    );
    deadline.throwIfAborted();
    if (readResult.unavailable || readResult.value === null) {
      return {
        current,
        listed,
        read: null,
        read_unavailable: true,
        goal: null,
        latest_turn: null,
        detail_unavailable: true
      };
    }
    const read = readResult.value;
    if (!safeRuntimeIdentity(current, read)) {
      return {
        current,
        listed,
        read,
        read_unavailable: false,
        goal: null,
        latest_turn: null,
        detail_unavailable: false
      };
    }
    const goalResult = await remoteReadOrUnavailable(
      () => reads.readGoal(current.mapping.codex_thread_id, deadline.signal)
    );
    deadline.throwIfAborted();
    const turnResult = await remoteReadOrUnavailable(
      () => reads.readLatestTurn(current.mapping.codex_thread_id, deadline.signal)
    );
    deadline.throwIfAborted();
    return {
      current,
      listed,
      read,
      read_unavailable: false,
      goal: goalResult.value,
      latest_turn: turnResult.value,
      detail_unavailable: goalResult.unavailable || turnResult.unavailable
    };
  }

  private assertArchivedMapping(observation: RuntimeObservation): void {
    if (observation.current.mapping.archived_at === null) return;
    const listed = observation.listed;
    if (listed === null) {
      if (observation.read !== null) {
        throw this.fail("mapping_contradiction", "A durable archived mapping reappeared outside archived runtime history.");
      }
      return;
    }
    if (
      listed.archived !== true ||
      observation.read === null ||
      !safeRuntimeIdentity(observation.current, listed) ||
      !safeRuntimeIdentity(observation.current, observation.read)
    ) {
      throw this.fail("mapping_contradiction", "A durable archived mapping contradicts current runtime identity.");
    }
  }

  private async commitOutcomeBoundary(
    outcome: SessionOutcome,
    reason: GapReason,
    deadline: OperationDeadline
  ): Promise<void> {
    let current = this.requireExactTarget(outcome.target, false, outcome.identity);
    const needsArchive = outcome.kind === "archived" && current.mapping.archived_at === null;
    const needsDisposition = current.mapping.disposition !== outcome.mapping_disposition;
    if (needsArchive || needsDisposition) {
      const updatedAt = this.timestampAfter(
        current.mapping.updated_at,
        current.projection.session.updated_at
      );
      const archivedAt = needsArchive ? updatedAt : current.mapping.archived_at;
      const intermediateSession = {
        ...current.projection.session,
        ...outcome.patch,
        archived_at: archivedAt,
        updated_at: updatedAt
      };
      current = this.options.repository.replace(
        {
          mapping: {
            ...current.mapping,
            disposition: outcome.mapping_disposition,
            archived_at: archivedAt,
            updated_at: updatedAt
          },
          projection: { ...current.projection, session: intermediateSession }
        },
        selectedStateRevision(current)
      );
    }
    deadline.throwIfAborted();
    const capturedAt = this.timestampAfter(
      current.mapping.updated_at,
      current.projection.session.updated_at
    );
    await this.options.continuity.replaceWithBoundary({
      session_id: outcome.target.session_id,
      expected_revision: selectedStateRevision(current),
      captured_at: capturedAt,
      reason,
      next_session: omitCursor({
        ...current.projection.session,
        ...outcome.patch,
        archived_at: current.mapping.archived_at,
        updated_at: capturedAt
      })
    });
  }

  private requireCycle(
    generation: number,
    expectedPhase: "reconciled" | "resubscribed"
  ): ActiveCycle {
    const cycle = this.cycle;
    if (cycle === null || cycle.generation !== generation || this.state.phase !== expectedPhase) {
      throw this.fail("lifecycle_conflict", `Codex runtime lifecycle expected ${expectedPhase} state for this generation.`);
    }
    return cycle;
  }

  private requireExactTarget(
    target: ManagedSessionTarget,
    requireRecoverableState: boolean,
    expectedIdentity: ReconciledSessionIdentity
  ): SelectedSessionState {
    const current = this.options.repository.get(target.session_id);
    if (
      current === null ||
      current.mapping.id !== target.session_id ||
      current.mapping.codex_thread_id !== target.codex_thread_id ||
      current.projection.session.id !== target.session_id ||
      current.projection.session.codex_thread_id !== target.codex_thread_id ||
      current.mapping.cwd !== current.projection.session.cwd ||
      current.mapping.cwd !== expectedIdentity.cwd ||
      current.mapping.runtime_source !== expectedIdentity.runtime_source ||
      current.mapping.runtime_version !== expectedIdentity.runtime_version ||
      current.mapping.runtime_version !== current.projection.session.runtime_version ||
      current.mapping.archived_at !== current.projection.session.archived_at
    ) {
      throw this.fail("state_conflict", "Managed session identity changed during runtime reconciliation.");
    }
    if (
      requireRecoverableState &&
      (
        current.mapping.disposition !== "selected" ||
        current.mapping.archived_at !== null ||
        current.projection.session.session_state !== "active" ||
        current.projection.session.freshness !== "stale" ||
        current.projection.session.freshness_reason !== "Runtime resubscription is required."
      )
    ) {
      throw this.fail("state_conflict", "Managed session became ineligible before runtime readiness publication.");
    }
    return current;
  }

  private timestamp(): IsoTimestamp {
    let candidate: unknown;
    try {
      candidate = this.options.now();
    } catch (error) {
      throw this.fail("invalid_contract", "Codex runtime reconciliation clock failed.", error);
    }
    const parsed = isoTimestampSchema.safeParse(candidate);
    if (!parsed.success) throw this.fail("invalid_contract", "Codex runtime reconciliation clock returned an invalid timestamp.");
    return parsed.data;
  }

  private timestampAfter(...candidates: string[]): IsoTimestamp {
    const now = this.timestamp();
    const floor = candidates.reduce((maximum, candidate) => Math.max(maximum, Date.parse(candidate)), -1);
    const milliseconds = Math.max(Date.parse(now), floor + 1);
    if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_640_000_000_000_000) {
      throw this.fail("invalid_contract", "Codex runtime reconciliation timestamp space is exhausted.");
    }
    const parsed = isoTimestampSchema.safeParse(new Date(milliseconds).toISOString());
    if (!parsed.success) throw this.fail("invalid_contract", "Codex runtime reconciliation timestamp is invalid.");
    return parsed.data;
  }

  private fail(
    code: CodexRuntimeReconciliationFailureCode,
    message: string,
    cause?: unknown
  ): HostDeckCodexRuntimeReconciliationError {
    return new HostDeckCodexRuntimeReconciliationError(
      code,
      message,
      cause === undefined ? undefined : { cause }
    );
  }

  private recordFailure(error: unknown, fallback: CodexRuntimeReconciliationFailureCode): void {
    this.state.phase = "failed";
    this.state.lastFailure =
      error instanceof HostDeckCodexRuntimeReconciliationError ? error.code : fallback;
  }
}

function deriveOutcome(observation: RuntimeObservation, runtimeVersion: string): SessionOutcome {
  const current = observation.current;
  const target = targetFor(current);
  const identity = identityFor(current);
  const listed = observation.listed;
  const read = observation.read;
  const stale = (
    issue: SessionIssue,
    reason: string,
    disposition: "recovery_required" | "selected" = current.mapping.disposition
  ): SessionOutcome => ({
    target,
    identity,
    kind: "stale",
    issue,
    mapping_disposition: disposition,
    patch: stalePatch(reason)
  });

  if (listed === null) {
    return read === null
      ? stale(
          observation.read_unavailable ? "missing" : "unavailable",
          "Managed Codex thread is unavailable.",
          "recovery_required"
        )
      : stale("contradiction", "Managed Codex thread is absent from durable runtime history.", "recovery_required");
  }
  if (read === null) {
    return stale("unavailable", "Managed Codex thread details are unavailable.");
  }
  if (!safeRuntimeIdentity(current, listed) || !safeRuntimeIdentity(current, read)) {
    return stale("contradiction", "Managed Codex thread identity changed.", "recovery_required");
  }
  if (current.mapping.runtime_version !== runtimeVersion) {
    return stale("contradiction", "Managed Codex runtime version changed.", "recovery_required");
  }
  if (current.mapping.disposition !== "selected") {
    return stale("contradiction", "Managed session still requires explicit recovery.", "recovery_required");
  }
  if (listed.archived === true) {
    const terminal = terminalPatch(observation.latest_turn, current.projection.session.turn_state);
    const archivedGoal = observation.detail_unavailable
      ? current.projection.session.goal
      : goalPatch(observation.goal);
    return {
      target,
      identity,
      kind: "archived",
      issue: "none",
      mapping_disposition: "selected",
      patch: {
        session_state: "archived",
        turn_state: terminal.turn_state,
        attention: terminal.attention,
        freshness: "current",
        freshness_reason: null,
        model: null,
        settings: null,
        goal: archivedGoal === undefined ? current.projection.session.goal : archivedGoal,
        last_activity_at: terminal.last_activity_at ?? current.projection.session.last_activity_at,
        recent_summary: "Codex thread is archived."
      }
    };
  }
  if (observation.detail_unavailable) {
    return stale("unavailable", "Managed Codex thread details are unavailable.");
  }
  const goal = goalPatch(observation.goal);
  if (goal === undefined) {
    return stale("contradiction", "Managed Codex goal exceeds the selected projection contract.");
  }
  if (read.status === "not_loaded" || read.status === "system_error") {
    return stale(
      read.status === "system_error" ? "contradiction" : "unavailable",
      read.status === "system_error" ? "Codex reported a thread system error." : "Codex thread is not loaded."
    );
  }
  if (read.status === "active") {
    if (observation.latest_turn?.status !== "in_progress") {
      return stale("contradiction", "Active Codex thread has no matching in-progress latest turn.");
    }
    const waitingApproval = read.active_flags.includes("waiting_on_approval");
    const waitingInput = read.active_flags.includes("waiting_on_user_input");
    if (waitingApproval && waitingInput) {
      return stale("contradiction", "Active Codex thread reports conflicting waiting states.");
    }
    return {
      target,
      identity,
      kind: "recoverable",
      issue: "none",
      mapping_disposition: "selected",
      patch: {
        session_state: "active",
        turn_state: waitingApproval ? "waiting_for_approval" : waitingInput ? "waiting_for_input" : "in_progress",
        attention: waitingApproval ? "needs_approval" : waitingInput ? "needs_input" : "watch",
        freshness: "stale",
        freshness_reason: "Runtime resubscription is required.",
        goal,
        last_activity_at: observation.latest_turn.started_at,
        recent_summary: waitingApproval
          ? "Codex turn is waiting for approval after reconnect."
          : waitingInput
            ? "Codex turn is waiting for input after reconnect."
            : "Codex turn remains active after reconnect."
      }
    };
  }
  if (observation.latest_turn?.status === "in_progress") {
    return stale("contradiction", "Idle Codex thread has a stale in-progress latest turn.");
  }
  const terminal = terminalPatch(observation.latest_turn, current.projection.session.turn_state);
  return {
    target,
    identity,
    kind: "recoverable",
    issue: "none",
    mapping_disposition: "selected",
    patch: {
      session_state: "active",
      turn_state: terminal.turn_state,
      attention: terminal.attention,
      freshness: "stale",
      freshness_reason: "Runtime resubscription is required.",
      goal,
      last_activity_at: terminal.last_activity_at ?? current.projection.session.last_activity_at,
      recent_summary: terminal.summary
    }
  };
}

function terminalPatch(
  latest: CodexReconciliationLatestTurn | null,
  previous: ManagedSessionProjection["turn_state"]
): {
  readonly turn_state: ManagedSessionProjection["turn_state"];
  readonly attention: ManagedSessionProjection["attention"];
  readonly last_activity_at: IsoTimestamp | null;
  readonly summary: string;
} {
  if (latest === null) {
    if (activeTurnState(previous)) {
      return {
        turn_state: "interrupted",
        attention: "stuck",
        last_activity_at: null,
        summary: "Active turn continuity was lost and is now interrupted."
      };
    }
    return { turn_state: "idle", attention: "none", last_activity_at: null, summary: "Codex thread is idle." };
  }
  if (latest.status === "completed") {
    return {
      turn_state: "completed",
      attention: "none",
      last_activity_at: latest.completed_at,
      summary: "Latest Codex turn completed."
    };
  }
  if (latest.status === "interrupted") {
    return {
      turn_state: "interrupted",
      attention: "stuck",
      last_activity_at: latest.completed_at,
      summary: "Latest Codex turn was interrupted."
    };
  }
  if (latest.status === "failed") {
    return {
      turn_state: "failed",
      attention: "failed",
      last_activity_at: latest.completed_at,
      summary: "Latest Codex turn failed."
    };
  }
  return {
    turn_state: "unknown",
    attention: "unknown",
    last_activity_at: latest.started_at,
    summary: "Codex turn state is contradictory."
  };
}

function stalePatch(reason: string): Partial<ManagedSessionProjection> {
  return {
    session_state: "unknown",
    turn_state: "unknown",
    attention: "unknown",
    freshness: "stale",
    freshness_reason: reason,
    model: null,
    settings: null,
    recent_summary: reason
  };
}

function goalPatch(goal: CodexThreadGoal | null): ManagedSessionProjection["goal"] | undefined {
  if (goal === null) return null;
  if (goal.objective.length > 512) return undefined;
  return { objective: goal.objective, state: goal.status };
}

function safeRuntimeIdentity(state: SelectedSessionState, thread: CodexThreadRecord): boolean {
  return (
    thread.id === state.mapping.codex_thread_id &&
    thread.cwd === state.mapping.cwd &&
    isSupportedCodexThreadSource(thread.source)
  );
}

async function remoteReadOrUnavailable<T>(operation: () => Promise<T>): Promise<{
  readonly value: T | null;
  readonly unavailable: boolean;
}> {
  try {
    return { value: await operation(), unavailable: false };
  } catch (error) {
    if (error instanceof HostDeckCodexAdapterError && error.code === "remote_error") {
      return { value: null, unavailable: true };
    }
    throw error;
  }
}

function countIssues(outcomes: readonly SessionOutcome[]): CodexRuntimeReconciliationIssueCounts {
  return Object.freeze({
    archived: outcomes.filter((outcome) => outcome.kind === "archived").length,
    contradictions: outcomes.filter((outcome) => outcome.issue === "contradiction").length,
    missing: outcomes.filter((outcome) => outcome.issue === "missing").length,
    stale: outcomes.filter((outcome) => outcome.kind === "stale").length,
    unavailable: outcomes.filter((outcome) => outcome.issue === "unavailable").length
  });
}

function targetFor(state: SelectedSessionState): ManagedSessionTarget {
  return Object.freeze({
    type: "managed_session",
    session_id: state.mapping.id,
    codex_thread_id: state.mapping.codex_thread_id
  });
}

function identityFor(state: SelectedSessionState): ReconciledSessionIdentity {
  return Object.freeze({
    cwd: state.mapping.cwd,
    runtime_source: state.mapping.runtime_source,
    runtime_version: state.mapping.runtime_version
  });
}

function omitCursor(session: ManagedSessionProjection): Omit<ManagedSessionProjection, "last_event_cursor"> {
  const { last_event_cursor: _lastEventCursor, ...uncommitted } = session;
  return uncommitted;
}

function activeTurnState(state: ManagedSessionProjection["turn_state"]): boolean {
  return ["in_progress", "waiting_for_approval", "waiting_for_input"].includes(state);
}

function readySummary(state: ManagedSessionProjection["turn_state"]): string {
  if (state === "waiting_for_approval") return "Codex runtime is ready; the active turn requires approval.";
  if (state === "waiting_for_input") return "Codex runtime is ready; the active turn requires input.";
  if (state === "in_progress") return "Codex runtime is ready; the turn remains active.";
  return "Codex runtime is ready.";
}

function assertCompleteAudit(
  result: StartupAuditOrphanReconciliationResult,
  expectedCutoff: string
): void {
  const descriptors = result === null || typeof result !== "object"
    ? null
    : Object.getOwnPropertyDescriptors(result);
  const keys = descriptors === null ? [] : Object.keys(descriptors).sort();
  const expectedKeys = [...auditResultKeys].sort();
  if (
    descriptors === null ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined) ||
    result.status !== "complete" ||
    !result.scan_complete ||
    result.actionable_remaining !== false ||
    result.failure !== null ||
    !Array.isArray(result.reasons) ||
    result.reasons.length !== 0 ||
    result.eligible_before !== expectedCutoff ||
    result.reconciled_at !== expectedCutoff ||
    result.eligible_pending_operation_count !== 0 ||
    !validNonnegativeCount(result.batch_count) ||
    !validNonnegativeNumber(result.duration_ms) ||
    !validNonnegativeCount(result.protected_recent_operation_count) ||
    !validNonnegativeCount(result.reconciled_operation_count) ||
    !validNonnegativeCount(result.total_pending_operation_count)
  ) {
    throw new HostDeckCodexRuntimeReconciliationError(
      "audit_incomplete",
      "Accepted-operation audit reconciliation did not complete before runtime admission."
    );
  }
}

function requireNonnegativeCount(candidate: unknown, message: string): number {
  if (!validNonnegativeCount(candidate)) throw invalidContract(message);
  return candidate;
}

function validNonnegativeCount(candidate: unknown): candidate is number {
  return Number.isSafeInteger(candidate) && (candidate as number) >= 0;
}

function validNonnegativeNumber(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
}

function parseOptions(
  options: CodexRuntimeReconciliationLifecycleOptions
): CodexRuntimeReconciliationLifecycleOptions {
  assertPlainExactObject(options, optionKeys, "Codex runtime reconciliation options");
  if (typeof options.approvals?.disconnect !== "function") throw new TypeError("Codex runtime reconciliation requires approval cleanup.");
  if (typeof options.audit?.reconcile !== "function") throw new TypeError("Codex runtime reconciliation requires audit cleanup.");
  if (typeof options.continuity?.replaceWithBoundary !== "function") throw new TypeError("Codex runtime reconciliation requires continuity storage.");
  if (typeof options.events?.barrier !== "function") throw new TypeError("Codex runtime reconciliation requires an event barrier.");
  if (typeof options.now !== "function") throw new TypeError("Codex runtime reconciliation requires a strict clock.");
  if (typeof options.plans?.rehydrate !== "function") throw new TypeError("Codex runtime reconciliation requires Plan rehydration.");
  if (typeof options.projection?.append !== "function") throw new TypeError("Codex runtime reconciliation requires projection append.");
  if (
    typeof options.repository?.get !== "function" ||
    typeof options.repository.list !== "function" ||
    typeof options.repository.replace !== "function" ||
    typeof options.repository.require !== "function"
  ) {
    throw new TypeError("Codex runtime reconciliation requires selected-state storage.");
  }
  assertResolvedResourceBudget(options.resource_budget);
  return Object.freeze({ ...options });
}

function parseDisconnectedInput(input: CodexReconnectDisconnectedInput): void {
  assertPlainExactObject(
    input,
    ["deadline", "generation", "previous_admitted_generation"],
    "Codex disconnected lifecycle input"
  );
  assertGeneration(input.generation);
  assertNullableGeneration(input.previous_admitted_generation);
  assertDeadline(input.deadline);
}

function parseReconcileInput(input: CodexReconnectReconcileInput): void {
  assertPlainExactObject(
    input,
    ["compatibility", "deadline", "generation", "previous_admitted_generation", "runtime"],
    "Codex reconcile lifecycle input"
  );
  assertGeneration(input.generation);
  assertNullableGeneration(input.previous_admitted_generation);
  assertDeadline(input.deadline);
  if (input.runtime?.generation !== input.generation) throw invalidContract("Codex reconcile runtime generation is invalid.");
}

function parseResubscribeInput(input: CodexReconnectResubscribeInput): void {
  assertPlainExactObject(
    input,
    ["compatibility", "deadline", "generation", "previous_admitted_generation", "reconciliation", "runtime"],
    "Codex resubscribe lifecycle input"
  );
  assertGeneration(input.generation);
  assertNullableGeneration(input.previous_admitted_generation);
  assertDeadline(input.deadline);
  assertReconciliation(input.reconciliation);
  if (input.runtime?.generation !== input.generation) throw invalidContract("Codex resubscribe runtime generation is invalid.");
}

function parseReadyInput(input: CodexReconnectReadyInput): void {
  assertPlainExactObject(
    input,
    ["compatibility", "deadline", "generation", "previous_admitted_generation", "reconciliation", "runtime"],
    "Codex ready lifecycle input"
  );
  assertGeneration(input.generation);
  assertNullableGeneration(input.previous_admitted_generation);
  assertDeadline(input.deadline);
  assertReconciliation(input.reconciliation);
  if (input.runtime?.generation !== input.generation) throw invalidContract("Codex ready runtime generation is invalid.");
}

function assertReconciliation(candidate: unknown): asserts candidate is CodexReconnectReconciliation {
  assertPlainExactObject(candidate, ["continuity"], "Codex reconciliation result");
  if (candidate.continuity !== "boundary_required" && candidate.continuity !== "continuous") {
    throw invalidContract("Codex reconciliation continuity is invalid.");
  }
}

function assertGeneration(candidate: unknown): asserts candidate is number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw invalidContract("Codex lifecycle generation must be a positive safe integer.");
  }
}

function assertNullableGeneration(candidate: unknown): void {
  if (candidate !== null) assertGeneration(candidate);
}

function assertDeadline(candidate: unknown): asserts candidate is OperationDeadline {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as OperationDeadline).throwIfAborted !== "function" ||
    !isAbortSignal((candidate as OperationDeadline).signal)
  ) {
    throw invalidContract("Codex lifecycle deadline is invalid.");
  }
}

function assertPlainExactObject(
  candidate: unknown,
  expectedKeys: readonly string[],
  label: string
): asserts candidate is Record<string, unknown> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)
  ) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as AbortSignal).aborted === "boolean" &&
    typeof (candidate as AbortSignal).addEventListener === "function"
  );
}

function invalidContract(message: string): HostDeckCodexRuntimeReconciliationError {
  return new HostDeckCodexRuntimeReconciliationError("invalid_contract", message);
}
