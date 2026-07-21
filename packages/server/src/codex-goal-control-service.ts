import {
  type CodexGoalClient,
  type CodexThreadGoal,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  type GoalControlSnapshot,
  type GoalControlValue,
  goalControlSnapshotSchema,
  goalOperationIntentSchema,
  isoTimestampSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  type UncertainGoalMutation
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp, OperationDeadline } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";
import {
  requireOpenOperationDeadline,
  runSerializedWithDeadline
} from "./operation-deadline-serialization.js";
import type { PendingTurnSettingsReader } from "./pending-turn-settings.js";

type GoalOperationIntent = Extract<SelectedOperationIntent, { readonly kind: "goal" }>;
type GoalAction = GoalOperationIntent["action"];

export type CodexGoalControlErrorCode =
  | "capability_unsupported"
  | "goal_missing"
  | "invalid_request"
  | "operation_timeout"
  | "operation_conflict"
  | "pending_settings_conflict"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_writable"
  | "unknown_outcome";

export type CodexGoalControlOutcome = "not_sent" | "remote_rejected" | "unknown";

export class HostDeckCodexGoalControlError extends Error {
  constructor(
    readonly code: CodexGoalControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexGoalControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexGoalControlError";
  }
}

export interface CodexGoalMutationResult {
  readonly action: GoalAction;
  readonly state: "accepted" | "succeeded";
  readonly dispatched: boolean;
  readonly goal: GoalControlValue | null;
}

export interface CodexGoalControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexGoalControlServiceOptions {
  readonly goals: CodexGoalClient;
  readonly states: CodexGoalControlStatePort;
  readonly pending_settings: PendingTurnSettingsReader;
  readonly max_uncertain_mutations?: number;
  readonly now?: () => string;
}

export interface CodexGoalControlService {
  readonly snapshot: (target: unknown, deadline: OperationDeadline) => Promise<GoalControlSnapshot>;
  readonly mutate: (intent: unknown, deadline: OperationDeadline) => Promise<CodexGoalMutationResult>;
  readonly reconcile: (target: unknown, deadline?: OperationDeadline) => Promise<GoalControlSnapshot>;
  readonly observeGoal: (event: NormalizedCodexEvent) => Promise<void>;
  readonly uncertain_count: number;
}

interface InternalUncertainGoalMutation extends UncertainGoalMutation {
  readonly target: ManagedSessionTarget;
  readonly baseline_objective: string | null;
}

const activeTurnStates = new Set(["in_progress", "waiting_for_approval", "waiting_for_input", "unknown"]);

export function createCodexGoalControlService(options: CodexGoalControlServiceOptions): CodexGoalControlService {
  const implementation = new DefaultCodexGoalControlService(options);
  return Object.freeze({
    snapshot: (target: unknown, deadline: OperationDeadline) => implementation.snapshot(target, deadline),
    mutate: (intent: unknown, deadline: OperationDeadline) => implementation.mutate(intent, deadline),
    reconcile: (target: unknown, deadline?: OperationDeadline) => implementation.reconcile(target, deadline),
    observeGoal: (event: NormalizedCodexEvent) => implementation.observeGoal(event),
    get uncertain_count() {
      return implementation.uncertain_count;
    }
  });
}

class DefaultCodexGoalControlService implements CodexGoalControlService {
  private readonly uncertainBySession = new Map<string, InternalUncertainGoalMutation>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly maxUncertainMutations: number;
  private readonly now: () => string;
  private uncertainReservations = 0;

  constructor(private readonly options: CodexGoalControlServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.goals?.read !== "function" ||
      typeof options.goals?.setPaused !== "function" ||
      typeof options.goals?.setStatus !== "function" ||
      typeof options.goals?.clear !== "function" ||
      typeof options.states?.get !== "function" ||
      typeof options.states?.getByThreadId !== "function" ||
      typeof options.pending_settings?.readPendingSettings !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Codex goal control requires exact goal, selected-state, and pending-setting ports.");
    }
    this.maxUncertainMutations = parseCapacity(options.max_uncertain_mutations);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get uncertain_count(): number {
    return this.uncertainBySession.size;
  }

  async snapshot(target: unknown, deadline: OperationDeadline): Promise<GoalControlSnapshot> {
    const parsedTarget = parseTarget(target);
    return this.serialized(parsedTarget.session_id, async () => {
      const state = this.requireTarget(parsedTarget, false);
      const goal = await this.readGoal(state, deadline);
      this.requireTarget(parsedTarget, false);
      return this.buildSnapshot(parsedTarget.session_id, goal);
    }, deadline);
  }

  async mutate(input: unknown, deadline: OperationDeadline): Promise<CodexGoalMutationResult> {
    const intent = parseIntent(input);
    return this.serialized(intent.target.session_id, async () => {
      const state = this.requireTarget(intent.target, true);
      if (this.uncertainBySession.has(intent.target.session_id)) {
        throw goalError(
          "operation_conflict",
          "operation_conflict",
          "A prior goal mutation requires reconciliation before another mutation.",
          "not_sent",
          false
        );
      }
      const current = await this.readGoal(state, deadline);
      requireGoalDeadline(deadline);
      const currentState = this.requireTarget(intent.target, true);
      assertExpectedRevision(intent, current);
      assertTransition(intent, current, currentState, this.options.pending_settings);

      const noOp = noOpResult(intent, current);
      if (noOp !== null) return noOp;
      return this.withUncertainReservation(() => this.executeMutation(intent, current, deadline));
    }, deadline);
  }

  private async executeMutation(
    intent: GoalOperationIntent,
    current: CodexThreadGoal | null,
    deadline: OperationDeadline
  ): Promise<CodexGoalMutationResult> {
    const uncertain = this.createUncertain(intent, current);
    let response: CodexThreadGoal | null;
    try {
      response = await this.dispatch(intent, deadline);
    } catch (error) {
      const mapped = mapMutationError(error, "Codex goal mutation failed.");
      if (mapped.outcome === "unknown") this.latchUncertain(intent.target.session_id, uncertain, mapped);
      throw mapped;
    }

    if (intent.action === "resume") {
      try {
        if (response === null) throw protocolError("Codex resume returned no goal state.");
        assertResponseMatches(intent, current, response);
      } catch (error) {
        const mapped = verificationUnknown(error);
        this.latchUncertain(intent.target.session_id, uncertain, mapped);
        throw mapped;
      }
      if (response === null) throw protocolError("Codex resume returned no goal state.");
      return Object.freeze({ action: intent.action, state: "accepted", dispatched: true, goal: publicGoal(response) });
    }

    let readBack: CodexThreadGoal | null;
    try {
      const latestState = this.requireTarget(intent.target, false);
      readBack = await this.readGoal(latestState, deadline);
      this.requireTarget(intent.target, false);
    } catch (error) {
      const mapped = verificationUnknown(error);
      this.latchUncertain(intent.target.session_id, uncertain, mapped);
      throw mapped;
    }
    if (!matchesDesired(intent, current, readBack)) {
      const conflict = goalError(
        "operation_conflict",
        "operation_conflict",
        "Codex goal read-back did not match the requested mutation.",
        "unknown",
        false
      );
      this.latchConflict(intent.target.session_id, uncertain, conflict);
      throw conflict;
    }
    try {
      assertResponseMatches(intent, current, response);
    } catch (error) {
      const mapped = verificationUnknown(error);
      this.latchUncertain(intent.target.session_id, uncertain, mapped);
      throw mapped;
    }
    return Object.freeze({
      action: intent.action,
      state: "succeeded",
      dispatched: true,
      goal: readBack === null ? null : publicGoal(readBack)
    });
  }

  async reconcile(target: unknown, deadline?: OperationDeadline): Promise<GoalControlSnapshot> {
    const parsedTarget = parseTarget(target);
    return this.serialized(parsedTarget.session_id, async () => {
      const uncertain = this.uncertainBySession.get(parsedTarget.session_id);
      if (uncertain === undefined) {
        throw goalError(
          "operation_conflict",
          "operation_conflict",
          "The selected session has no uncertain goal mutation to reconcile.",
          "not_sent",
          true
        );
      }
      const state = this.requireTarget(parsedTarget, false);
      const current = await this.readGoal(state, deadline);
      this.requireTarget(parsedTarget, false);
      if (matchesUncertain(uncertain, current)) {
        this.uncertainBySession.delete(parsedTarget.session_id);
      } else if (!matchesBaseline(uncertain, current)) {
        const conflict = goalError(
          "operation_conflict",
          "operation_conflict",
          "Goal state changed to a value that does not match the uncertain mutation.",
          "unknown",
          false
        );
        this.latchConflict(parsedTarget.session_id, uncertain, conflict);
      }
      return this.buildSnapshot(parsedTarget.session_id, current);
    }, deadline);
  }

  async observeGoal(event: NormalizedCodexEvent): Promise<void> {
    if (event.method !== "thread/goal/updated" && event.method !== "thread/goal/cleared") return;
    const state = this.options.states.getByThreadId(event.thread_id);
    if (state === null) return;
    await this.serialized(state.mapping.id, async () => {
      const uncertain = this.uncertainBySession.get(state.mapping.id);
      if (uncertain === undefined) return;
      const currentState = this.options.states.get(state.mapping.id);
      if (
        currentState === null ||
        currentState.mapping.archived_at !== null ||
        currentState.projection.session.session_state === "archived"
      ) {
        this.uncertainBySession.delete(state.mapping.id);
        return;
      }
      if (event.captured_at < uncertain.requested_at) return;
      if (eventMatchesUncertain(uncertain, event)) {
        this.uncertainBySession.delete(state.mapping.id);
        return;
      }
      const conflict = goalError(
        "operation_conflict",
        "operation_conflict",
        "A goal event contradicted the uncertain mutation.",
        "unknown",
        false
      );
      this.latchConflict(state.mapping.id, uncertain, conflict);
    });
  }

  private async dispatch(intent: GoalOperationIntent, deadline: OperationDeadline): Promise<CodexThreadGoal | null> {
    requireGoalDeadline(deadline);
    switch (intent.action) {
      case "set":
        return this.options.goals.setPaused(intent.target.codex_thread_id, intent.objective as string, deadline);
      case "pause":
        return this.options.goals.setStatus(intent.target.codex_thread_id, "paused", deadline);
      case "resume":
        return this.options.goals.setStatus(intent.target.codex_thread_id, "active", deadline);
      case "complete":
        return this.options.goals.setStatus(intent.target.codex_thread_id, "complete", deadline);
      case "clear": {
        const cleared = await this.options.goals.clear(intent.target.codex_thread_id, deadline);
        if (!cleared) throw protocolError("Codex did not acknowledge clearing the existing goal.");
        return null;
      }
    }
  }

  private async readGoal(
    state: SelectedSessionState,
    deadline?: OperationDeadline
  ): Promise<CodexThreadGoal | null> {
    try {
      const goal = await this.options.goals.read(state.mapping.codex_thread_id, deadline);
      if (goal !== null && goal.thread_id !== state.mapping.codex_thread_id) {
        throw protocolError("Codex goal read-back changed the selected thread identity.");
      }
      return goal;
    } catch (error) {
      if (error instanceof HostDeckCodexGoalControlError) throw error;
      throw mapAdapterError(error, "Codex goal state could not be read.");
    }
  }

  private requireTarget(target: ManagedSessionTarget, writable: boolean): SelectedSessionState {
    const candidate = this.options.states.get(target.session_id);
    if (candidate === null) {
      this.uncertainBySession.delete(target.session_id);
      throw goalError("target_not_found", "session_not_found", "The selected managed session does not exist.", "not_sent", false);
    }
    const state = parseSelectedGoalState(candidate);
    if (state === null) {
      throw goalError(
        "target_mismatch",
        "stale_session",
        "The selected managed session identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    if (state.mapping.id !== target.session_id || state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw goalError("target_mismatch", "invalid_session_id", "The selected session and Codex thread identity do not match.", "not_sent", false);
    }
    const session = state.projection.session;
    if (
      state.mapping.id !== session.id ||
      state.mapping.name !== session.name ||
      state.mapping.codex_thread_id !== session.codex_thread_id ||
      state.mapping.cwd !== session.cwd ||
      state.mapping.runtime_source !== session.runtime_source ||
      state.mapping.runtime_version !== session.runtime_version ||
      state.mapping.created_at !== session.created_at ||
      state.mapping.archived_at !== session.archived_at
    ) {
      throw goalError(
        "target_mismatch",
        "stale_session",
        "The selected managed session identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    if (state.mapping.disposition !== "selected") {
      throw goalError(
        "target_not_writable",
        "stale_session",
        "The selected managed session requires recovery before goal control.",
        "not_sent",
        false
      );
    }
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      this.uncertainBySession.delete(target.session_id);
      throw goalError("target_not_writable", "session_not_writable", "The selected managed session is archived.", "not_sent", false);
    }
    if (
      writable &&
      (state.projection.session.session_state !== "active" || state.projection.session.freshness !== "current")
    ) {
      throw goalError(
        "target_not_writable",
        state.projection.session.freshness === "current" ? "session_not_writable" : "stale_session",
        "The selected managed session is not currently writable.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private createUncertain(intent: GoalOperationIntent, current: CodexThreadGoal | null): InternalUncertainGoalMutation {
    return {
      target: intent.target,
      action: intent.action,
      phase: "unknown",
      requested_at: this.timestamp(),
      baseline_revision: current?.revision ?? null,
      baseline_objective: current?.objective ?? null,
      requested_objective: intent.action === "set" ? intent.objective : null,
      requested_status: desiredStatus(intent.action),
      error: {
        code: "unknown_error",
        message: "Goal mutation outcome is not yet known.",
        retryable: false
      }
    };
  }

  private latchUncertain(
    sessionId: string,
    uncertain: InternalUncertainGoalMutation,
    error: HostDeckCodexGoalControlError
  ): void {
    this.uncertainBySession.set(sessionId, {
      ...uncertain,
      phase: "unknown",
      error: errorEnvelope(error)
    });
  }

  private latchConflict(
    sessionId: string,
    uncertain: InternalUncertainGoalMutation,
    error: HostDeckCodexGoalControlError
  ): void {
    this.uncertainBySession.set(sessionId, {
      ...uncertain,
      phase: "conflict",
      error: errorEnvelope(error)
    });
  }

  private buildSnapshot(sessionId: string, goal: CodexThreadGoal | null): GoalControlSnapshot {
    const uncertain = this.uncertainBySession.get(sessionId) ?? null;
    return goalControlSnapshotSchema.parse({
      goal: goal === null ? null : publicGoal(goal),
      uncertain_mutation: uncertain === null ? null : publicUncertain(uncertain)
    });
  }

  private timestamp(): IsoTimestamp {
    const parsed = isoTimestampSchema.safeParse(this.now());
    if (!parsed.success) {
      throw goalError(
        "runtime_protocol_error",
        "internal_error",
        "The goal-control clock returned an invalid timestamp.",
        "not_sent",
        false,
        parsed.error
      );
    }
    return parsed.data;
  }

  private async withUncertainReservation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.uncertainBySession.size + this.uncertainReservations >= this.maxUncertainMutations) {
      throw goalError(
        "service_overloaded",
        "service_overloaded",
        "The uncertain goal-mutation capacity is exhausted.",
        "not_sent",
        true
      );
    }
    this.uncertainReservations += 1;
    try {
      return await operation();
    } finally {
      this.uncertainReservations -= 1;
    }
  }

  private serialized<T>(
    sessionId: string,
    operation: () => Promise<T>,
    deadline?: OperationDeadline
  ): Promise<T> {
    if (deadline !== undefined) {
      return runSerializedWithDeadline(
        this.tails,
        sessionId,
        deadline,
        goalDeadlineError,
        operation,
        goalInvalidDeadlineError
      );
    }
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate, () => gate);
    this.tails.set(sessionId, tail);
    return prior
      .then(operation, operation)
      .finally(() => {
        release();
        if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
      });
  }
}

function parseSelectedGoalState(candidate: SelectedSessionState): SelectedSessionState | null {
  try {
    const mapping = selectedSessionMappingRecordSchema.safeParse(candidate.mapping);
    const projection = selectedSessionProjectionRecordSchema.safeParse(candidate.projection);
    if (!mapping.success || !projection.success) return null;
    return { mapping: mapping.data, projection: projection.data };
  } catch {
    return null;
  }
}

function assertExpectedRevision(intent: GoalOperationIntent, current: CodexThreadGoal | null): void {
  if (intent.action !== "set" && current === null) {
    throw goalError("goal_missing", "validation_error", "The selected thread has no goal for this action.", "not_sent", true);
  }
  const currentRevision = current?.revision ?? null;
  if (intent.expected_goal_revision !== currentRevision) {
    throw goalError(
      "operation_conflict",
      "operation_conflict",
      "Goal state changed before this mutation.",
      "not_sent",
      true
    );
  }
}

function assertTransition(
  intent: GoalOperationIntent,
  current: CodexThreadGoal | null,
  state: SelectedSessionState,
  pendingSettings: PendingTurnSettingsReader
): void {
  if (["set", "resume", "complete", "clear"].includes(intent.action) && activeTurnStates.has(state.projection.session.turn_state)) {
    throw goalError(
      "operation_conflict",
      "operation_conflict",
      "This goal action requires a proven idle thread; pause remains available and does not imply interrupt.",
      "not_sent",
      true
    );
  }
  if (intent.action === "resume") {
    if (current === null || !["paused", "blocked"].includes(current.status)) {
      throw goalError(
        "operation_conflict",
        "operation_conflict",
        "Only a paused or blocked goal can resume agentic work.",
        "not_sent",
        true
      );
    }
    const pending = pendingSettings.readPendingSettings(intent.target);
    if (pending.length > 0) {
      throw goalError(
        "pending_settings_conflict",
        "operation_conflict",
        `Agentic goal resume cannot apply pending ${pending.map((setting) => setting.control).join("/")} next-turn settings.`,
        "not_sent",
        true
      );
    }
  }
  if (current?.status === "active" && ["set", "complete", "clear"].includes(intent.action)) {
    throw goalError(
      "operation_conflict",
      "operation_conflict",
      "Pause the active goal before replacing, completing, or clearing it; pause does not interrupt its current turn.",
      "not_sent",
      true
    );
  }
  if (intent.action === "pause" && current?.status === "complete") {
    throw goalError("operation_conflict", "operation_conflict", "A completed goal cannot be paused.", "not_sent", false);
  }
}

function noOpResult(intent: GoalOperationIntent, current: CodexThreadGoal | null): CodexGoalMutationResult | null {
  if (
    intent.action === "set" &&
    current?.status === "paused" &&
    current.objective === intent.objective
  ) {
    return Object.freeze({ action: intent.action, state: "succeeded", dispatched: false, goal: publicGoal(current) });
  }
  if (intent.action === "pause" && current?.status === "paused") {
    return Object.freeze({ action: intent.action, state: "succeeded", dispatched: false, goal: publicGoal(current) });
  }
  if (intent.action === "complete" && current?.status === "complete") {
    return Object.freeze({ action: intent.action, state: "succeeded", dispatched: false, goal: publicGoal(current) });
  }
  return null;
}

function assertResponseMatches(
  intent: GoalOperationIntent,
  baseline: CodexThreadGoal | null,
  response: CodexThreadGoal | null
): void {
  if (!matchesDesired(intent, baseline, response)) {
    throw protocolError("Codex goal mutation response did not match the requested state.");
  }
}

function matchesDesired(
  intent: Pick<GoalOperationIntent, "action" | "objective">,
  baseline: CodexThreadGoal | null,
  goal: CodexThreadGoal | null
): boolean {
  if (intent.action === "clear") return goal === null;
  if (goal === null) return false;
  const status = desiredStatus(intent.action);
  if (status !== null && goal.status !== status) return false;
  if (intent.action === "set") return goal.objective === intent.objective;
  return baseline !== null && goal.objective === baseline.objective;
}

function desiredStatus(action: GoalAction): "active" | "complete" | "paused" | null {
  switch (action) {
    case "set":
    case "pause":
      return "paused";
    case "resume":
      return "active";
    case "complete":
      return "complete";
    case "clear":
      return null;
  }
}

function matchesUncertain(uncertain: InternalUncertainGoalMutation, goal: CodexThreadGoal | null): boolean {
  if (uncertain.action === "clear") return goal === null;
  if (goal === null || goal.status !== uncertain.requested_status) return false;
  return uncertain.action === "set"
    ? goal.objective === uncertain.requested_objective
    : goal.objective === uncertain.baseline_objective;
}

function matchesBaseline(uncertain: InternalUncertainGoalMutation, goal: CodexThreadGoal | null): boolean {
  return (goal?.revision ?? null) === uncertain.baseline_revision;
}

function eventMatchesUncertain(uncertain: InternalUncertainGoalMutation, event: NormalizedCodexEvent): boolean {
  if (uncertain.action === "clear") return event.method === "thread/goal/cleared";
  if (event.method !== "thread/goal/updated") return false;
  if (uncertain.requested_status !== null && event.status !== uncertain.requested_status) return false;
  if (uncertain.action === "set") return event.objective === uncertain.requested_objective;
  return event.objective === uncertain.baseline_objective;
}

function publicGoal(goal: CodexThreadGoal): GoalControlValue {
  const { thread_id: _threadId, ...value } = goal;
  return value;
}

function publicUncertain(uncertain: InternalUncertainGoalMutation): UncertainGoalMutation {
  const { baseline_objective: _baselineObjective, target: _target, ...value } = uncertain;
  return value;
}

function parseTarget(candidate: unknown): ManagedSessionTarget {
  const parsed = managedSessionTargetSchema.safeParse(candidate);
  if (!parsed.success) throw goalError("invalid_request", "validation_error", "The goal-control target is invalid.", "not_sent", true, parsed.error);
  return parsed.data;
}

function parseIntent(candidate: unknown): GoalOperationIntent {
  const parsed = goalOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) throw goalError("invalid_request", "validation_error", "The goal mutation request is invalid.", "not_sent", true, parsed.error);
  return parsed.data;
}

function parseCapacity(candidate: number | undefined): number {
  const definition = resourceBudgetDefinitionByKey.control_goal_max_uncertain_mutations;
  const value = candidate ?? defaultResourceBudget.control_goal_max_uncertain_mutations;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError(`Goal uncertain-mutation capacity must be between ${definition.minimum} and ${definition.maximum}.`);
  }
  return value;
}

function mapAdapterError(error: unknown, fallback: string): HostDeckCodexGoalControlError {
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return goalError("runtime_unavailable", "runtime_unavailable", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return goalError("capability_unsupported", "capability_unavailable", error.message, "not_sent", false, error);
  }
  if (["request_aborted", "request_timeout"].includes(error.code)) {
    return goalError(
      "operation_timeout",
      "operation_timeout",
      error.message,
      error.outcome === "unknown" ? "unknown" : "not_sent",
      error.outcome === "unknown" ? false : error.retry_safe,
      error
    );
  }
  if (error.outcome === "unknown") {
    return goalError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.outcome === "remote_rejected") {
    return goalError("operation_conflict", "operation_conflict", error.message, "remote_rejected", error.retry_safe, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    return goalError("runtime_protocol_error", "protocol_error", error.message, "not_sent", false, error);
  }
  if (error.code === "broker_overloaded") {
    return goalError("service_overloaded", "service_overloaded", error.message, "not_sent", error.retry_safe, error);
  }
  return goalError("runtime_unavailable", "runtime_unavailable", error.message || fallback, "not_sent", error.retry_safe, error);
}

function mapMutationError(error: unknown, fallback: string): HostDeckCodexGoalControlError {
  if (error instanceof HostDeckCodexGoalControlError) return error;
  if (
    error instanceof HostDeckCodexAdapterError &&
    ["invalid_protocol_message", "protocol_violation"].includes(error.code) &&
    error.outcome !== "not_sent"
  ) {
    return goalError("runtime_protocol_error", "protocol_error", error.message, "unknown", false, error);
  }
  return mapAdapterError(error, fallback);
}

function verificationUnknown(error: unknown): HostDeckCodexGoalControlError {
  if (
    error instanceof HostDeckCodexGoalControlError &&
    error.api_code === "operation_timeout"
  ) {
    return goalError(
      "operation_timeout",
      "operation_timeout",
      error.message,
      "unknown",
      false,
      error
    );
  }
  return goalError(
    "unknown_outcome",
    "unknown_error",
    "Codex accepted the goal mutation but its read-back could not be verified.",
    "unknown",
    false,
    error
  );
}

function requireGoalDeadline(candidate: unknown): OperationDeadline {
  return requireOpenOperationDeadline(
    candidate,
    goalDeadlineError,
    goalInvalidDeadlineError
  );
}

function goalInvalidDeadlineError(cause: unknown): HostDeckCodexGoalControlError {
  return goalError(
    "invalid_request",
    "validation_error",
    "The goal request deadline is invalid.",
    "not_sent",
    false,
    cause
  );
}

function goalDeadlineError(cause: unknown): HostDeckCodexGoalControlError {
  return goalError(
    "operation_timeout",
    "operation_timeout",
    "Codex goal operation exceeded its request deadline.",
    "not_sent",
    true,
    cause
  );
}

function errorEnvelope(error: HostDeckCodexGoalControlError): UncertainGoalMutation["error"] {
  return { code: error.api_code, message: error.message, retryable: error.retry_safe };
}

function protocolError(message: string, cause?: unknown): HostDeckCodexGoalControlError {
  return goalError("runtime_protocol_error", "protocol_error", message, "unknown", false, cause);
}

function goalError(
  code: CodexGoalControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexGoalControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexGoalControlError {
  return new HostDeckCodexGoalControlError(code, apiCode, message, outcome, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex goal control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
