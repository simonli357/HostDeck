import {
  type CodexTurnClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  codexVersionSchema,
  defaultResourceBudget,
  interruptOperationIntentSchema,
  isoTimestampSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  type SelectedOperationProgress,
  selectedOperationProgressSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  type TurnOperationTarget,
  turnOperationTargetSchema
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp, OperationDeadline } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";
import {
  type OperationDeadlineFailureFactory,
  requireOpenOperationDeadline,
  runSerializedWithDeadline
} from "./operation-deadline-serialization.js";

type InterruptIntent = Extract<SelectedOperationIntent, { readonly kind: "interrupt" }>;
type TurnCompletedEvent = Extract<NormalizedCodexEvent, { readonly method: "turn/completed" }>;

export type CodexInterruptControlErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "operation_conflict"
  | "operation_timeout"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "state_unavailable"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_writable"
  | "target_stale"
  | "unknown_outcome";

export type CodexInterruptControlOutcome = "not_sent" | "remote_rejected" | "unknown";

export class HostDeckCodexInterruptControlError extends Error {
  constructor(
    readonly code: CodexInterruptControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexInterruptControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexInterruptControlError";
  }
}

export interface CodexInterruptControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexInterruptControlServiceOptions {
  readonly turns: Pick<CodexTurnClient, "interruptTurn" | "runtime_version">;
  readonly states: CodexInterruptControlStatePort;
  readonly max_tracked_turns?: number;
  readonly now?: () => string;
}

export interface CodexInterruptControlService {
  readonly requireInterruptible: (target: unknown) => Promise<void>;
  readonly snapshot: (target: unknown) => Promise<SelectedOperationProgress | null>;
  readonly interrupt: (intent: unknown, deadline: OperationDeadline) => Promise<SelectedOperationProgress>;
  readonly waitForTerminal: (target: unknown, deadline: OperationDeadline) => Promise<SelectedOperationProgress>;
  readonly observeEvent: (event: NormalizedCodexEvent) => Promise<void>;
  readonly active_count: number;
  readonly pending_count: number;
  readonly tracked_count: number;
}

interface ActiveTurnEvidence {
  readonly target: TurnOperationTarget;
  readonly started_at: IsoTimestamp;
}

interface TrackedInterrupt {
  readonly intent: InterruptIntent;
  readonly requested_at: IsoTimestamp;
  phase: "accepted" | "sending" | "terminal" | "unknown";
  progress: SelectedOperationProgress | null;
  terminal_status: TurnCompletedEvent["status"] | null;
}

interface TerminalWaiter {
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (progress: SelectedOperationProgress) => void;
}

interface ParsedOptions {
  readonly turns: Pick<CodexTurnClient, "interruptTurn" | "runtime_version">;
  readonly states: CodexInterruptControlStatePort;
  readonly max_tracked_turns: number;
  readonly now: () => string;
}

const activeProjectionStates = new Set(["in_progress", "waiting_for_approval", "waiting_for_input"]);
const selectedStateKeys = ["mapping", "projection"] as const;

export function createCodexInterruptControlService(
  options: CodexInterruptControlServiceOptions
): CodexInterruptControlService {
  const implementation = new DefaultCodexInterruptControlService(parseOptions(options));
  return Object.freeze({
    requireInterruptible: (target: unknown) => implementation.requireInterruptible(target),
    snapshot: (target: unknown) => implementation.snapshot(target),
    interrupt: (intent: unknown, deadline: OperationDeadline) => implementation.interrupt(intent, deadline),
    waitForTerminal: (target: unknown, deadline: OperationDeadline) => implementation.waitForTerminal(target, deadline),
    observeEvent: (event: NormalizedCodexEvent) => implementation.observeEvent(event),
    get active_count() {
      return implementation.active_count;
    },
    get pending_count() {
      return implementation.pending_count;
    },
    get tracked_count() {
      return implementation.tracked_count;
    }
  });
}

class DefaultCodexInterruptControlService implements CodexInterruptControlService {
  private readonly activeBySession = new Map<string, ActiveTurnEvidence>();
  private readonly interruptsBySession = new Map<string, TrackedInterrupt>();
  private readonly archivedSessions = new Set<string>();
  private readonly terminalByTarget = new Map<string, TurnCompletedEvent>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<TerminalWaiter>>();

  constructor(private readonly options: ParsedOptions) {}

  get active_count(): number {
    return this.activeBySession.size;
  }

  get pending_count(): number {
    return [...this.interruptsBySession.values()].filter((record) =>
      ["accepted", "sending", "unknown"].includes(record.phase)
    ).length;
  }

  get tracked_count(): number {
    return this.interruptsBySession.size;
  }

  async requireInterruptible(targetInput: unknown): Promise<void> {
    const target = parseTarget(targetInput);
    await this.serialized(target.session_id, async () => {
      this.requireInterruptibleTarget(target);
    });
  }

  async snapshot(targetInput: unknown): Promise<SelectedOperationProgress | null> {
    const target = parseTarget(targetInput);
    return this.serialized(target.session_id, async () => {
      this.requireIdentity(target);
      const record = this.interruptsBySession.get(target.session_id);
      if (record === undefined || !sameTarget(record.intent.target, target)) return null;
      return record.progress;
    });
  }

  async interrupt(input: unknown, deadline: OperationDeadline): Promise<SelectedOperationProgress> {
    const intent = parseIntent(input);
    return this.serialized(intent.target.session_id, async () => {
      this.requireInterruptibleTarget(intent.target);

      const requestedAt = this.timestamp();
      const record: TrackedInterrupt = {
        intent,
        requested_at: requestedAt,
        phase: "sending",
        progress: null,
        terminal_status: null
      };
      this.interruptsBySession.set(intent.target.session_id, record);
      try {
        requireInterruptDeadline(deadline);
        const accepted = await this.options.turns.interruptTurn({
          operation_id: intent.operation_id,
          thread_id: intent.target.codex_thread_id,
          turn_id: intent.target.turn_id,
          deadline
        });
        if (accepted.thread_id !== intent.target.codex_thread_id || accepted.turn_id !== intent.target.turn_id) {
          throw interruptError(
            "runtime_protocol_error",
            "protocol_error",
            "Codex interrupt acceptance changed the exact thread or turn target.",
            "unknown",
            false
          );
        }
        record.phase = "accepted";
        record.progress = progress(record, "accepted", record.requested_at, null);
        const terminal = this.takeTerminal(intent.target);
        if (terminal !== null) return this.applyTerminal(intent.target.session_id, terminal) ?? record.progress;
        if (this.archivedSessions.delete(intent.target.session_id)) {
          return this.markArchived(record, record.requested_at);
        }
        return record.progress;
      } catch (error) {
        const mapped = mapAdapterError(error, "Codex turn interrupt failed.");
        const terminal = this.takeTerminal(intent.target);
        if (mapped.outcome === "unknown") {
          record.phase = "unknown";
          record.progress = progress(record, "incomplete", record.requested_at, errorEnvelope(mapped));
          if (terminal !== null) {
            const reconciled = this.applyTerminal(intent.target.session_id, terminal);
            if (reconciled?.state === "interrupted") return reconciled;
            if (reconciled !== null) {
              throw interruptError(
                "operation_conflict",
                "operation_conflict",
                reconciled.error?.message ?? "The turn reached a non-interrupted terminal state.",
                "remote_rejected",
                false,
                mapped
              );
            }
          }
          if (this.archivedSessions.delete(intent.target.session_id)) this.markArchived(record, record.requested_at);
        } else {
          this.interruptsBySession.delete(intent.target.session_id);
          this.archivedSessions.delete(intent.target.session_id);
          if (terminal !== null) this.clearActiveForTerminal(intent.target.session_id, terminal);
        }
        throw mapped;
      }
    }, deadline);
  }

  async waitForTerminal(
    targetInput: unknown,
    deadline: OperationDeadline
  ): Promise<SelectedOperationProgress> {
    const target = parseTarget(targetInput);
    requireOpenOperationDeadline(
      deadline,
      terminalWaitAborted,
      interruptInvalidDeadlineError
    );

    const outcome = await this.serialized(target.session_id, async () => {
      this.requireIdentity(target);
      const record = this.interruptsBySession.get(target.session_id);
      if (record === undefined || !sameTarget(record.intent.target, target)) {
        throw interruptError(
          "operation_conflict",
          "operation_conflict",
          "The exact interrupt attempt is not registered.",
          "not_sent",
          false
        );
      }
      if (record.phase === "terminal") {
        if (record.progress === null) {
          throw interruptError(
            "runtime_protocol_error",
            "protocol_error",
            "Terminal interrupt state has no operation progress.",
            "not_sent",
            false
          );
        }
        return Object.freeze({ terminal: record.progress });
      }
      if (!["accepted", "sending", "unknown"].includes(record.phase)) {
        throw interruptError(
          "runtime_protocol_error",
          "protocol_error",
          "Interrupt state cannot enter terminal waiting.",
          "not_sent",
          false
        );
      }
      return Object.freeze({ waiting: this.createTerminalWaiter(target, deadline.signal) });
    }, deadline, terminalWaitAborted);
    if ("terminal" in outcome) return outcome.terminal;
    return await outcome.waiting;
  }

  async observeEvent(event: NormalizedCodexEvent): Promise<void> {
    if (!("thread_id" in event)) return;
    const state = this.readStateByThreadId(event.thread_id);
    if (state === null) return;
    this.requireRuntimeState(state);
    const sessionId = state.mapping.id;

    if (event.method === "thread/archived") this.archivedSessions.add(sessionId);

    if (event.method === "turn/completed") {
      const active = this.activeBySession.get(sessionId);
      const interrupt = this.interruptsBySession.get(sessionId);
      if (active?.target.turn_id === event.turn_id || interrupt?.intent.target.turn_id === event.turn_id) {
        this.terminalByTarget.set(targetKey(sessionId, event.turn_id), event);
      }
      await this.serialized(sessionId, async () => {
        const terminal = this.takeTerminalById(sessionId, event.turn_id) ?? event;
        this.applyTerminal(sessionId, terminal);
      });
      return;
    }

    await this.serialized(sessionId, async () => {
      if (event.method === "thread/archived" || state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
        this.archivedSessions.delete(sessionId);
        this.activeBySession.delete(sessionId);
        this.clearTerminalObservations(sessionId);
        const record = this.interruptsBySession.get(sessionId);
        if (record !== undefined && ["accepted", "sending", "unknown"].includes(record.phase)) {
          this.markArchived(record, event.captured_at);
        }
        return;
      }
      if (event.method !== "turn/started") return;
      const current = this.activeBySession.get(sessionId);
      if (current !== undefined) {
        if (current.target.turn_id === event.turn_id) return;
        throw interruptError(
          "runtime_protocol_error",
          "protocol_error",
          "A second turn started before the prior active turn reached terminal state.",
          "not_sent",
          false
        );
      }
      this.ensureCapacity(sessionId);
      const record = this.interruptsBySession.get(sessionId);
      if (record !== undefined && ["accepted", "unknown"].includes(record.phase) && record.intent.target.turn_id !== event.turn_id) {
        record.phase = "terminal";
        record.progress = progress(record, "incomplete", event.captured_at, {
          code: "protocol_error",
          message: "A later turn started without terminal evidence for the interrupted turn.",
          retryable: false
        });
        this.notifyWaiters(record.intent.target, record.progress);
      }
      this.activeBySession.set(sessionId, {
        target: parseInternalTarget({
          type: "turn",
          session_id: sessionId,
          codex_thread_id: event.thread_id,
          turn_id: event.turn_id
        }),
        started_at: event.captured_at
      });
    });
  }

  private applyTerminal(sessionId: string, event: TurnCompletedEvent): SelectedOperationProgress | null {
    this.clearActiveForTerminal(sessionId, event);
    const record = this.interruptsBySession.get(sessionId);
    if (record === undefined || record.intent.target.turn_id !== event.turn_id) return null;
    if (record.terminal_status !== null) {
      if (record.terminal_status === event.status) return record.progress;
      throw interruptError(
        "runtime_protocol_error",
        "protocol_error",
        "The same interrupt turn emitted contradictory terminal statuses.",
        "not_sent",
        false
      );
    }
    record.phase = "terminal";
    record.terminal_status = event.status;
    if (event.status === "interrupted") {
      record.progress = progress(record, "interrupted", event.captured_at, null);
    } else {
      record.progress = progress(record, "failed", event.captured_at, {
        code: "operation_conflict",
        message: `The turn reached ${event.status} instead of interrupted.`,
        retryable: false
      });
    }
    this.notifyWaiters(record.intent.target, record.progress);
    return record.progress;
  }

  private markArchived(record: TrackedInterrupt, at: IsoTimestamp): SelectedOperationProgress {
    record.phase = "terminal";
    record.progress = progress(record, "incomplete", at, {
      code: "session_not_writable",
      message: "The session archived before interrupt terminal proof.",
      retryable: false
    });
    this.notifyWaiters(record.intent.target, record.progress);
    return record.progress;
  }

  private clearActiveForTerminal(sessionId: string, event: TurnCompletedEvent): void {
    if (this.activeBySession.get(sessionId)?.target.turn_id === event.turn_id) this.activeBySession.delete(sessionId);
  }

  private takeTerminal(target: TurnOperationTarget): TurnCompletedEvent | null {
    return this.takeTerminalById(target.session_id, target.turn_id);
  }

  private takeTerminalById(sessionId: string, turnId: string): TurnCompletedEvent | null {
    const key = targetKey(sessionId, turnId);
    const event = this.terminalByTarget.get(key) ?? null;
    this.terminalByTarget.delete(key);
    return event;
  }

  private clearTerminalObservations(sessionId: string): void {
    for (const key of this.terminalByTarget.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.terminalByTarget.delete(key);
    }
  }

  private requireIdentity(target: TurnOperationTarget): SelectedSessionState {
    const state = this.readState(target.session_id);
    if (state === null) {
      this.activeBySession.delete(target.session_id);
      this.interruptsBySession.delete(target.session_id);
      this.archivedSessions.delete(target.session_id);
      this.clearTerminalObservations(target.session_id);
      throw interruptError("target_not_found", "session_not_found", "The selected interrupt session does not exist.", "not_sent", false);
    }
    if (state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw interruptError("target_mismatch", "invalid_session_id", "The selected session and interrupt thread do not match.", "not_sent", false);
    }
    this.requireRuntimeState(state);
    return state;
  }

  private requireWritableTarget(target: TurnOperationTarget): SelectedSessionState {
    const state = this.requireIdentity(target);
    if (state.mapping.disposition !== "selected") {
      throw interruptError(
        "target_stale",
        "stale_session",
        "The selected interrupt session requires recovery.",
        "not_sent",
        false
      );
    }
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      this.activeBySession.delete(target.session_id);
      const record = this.interruptsBySession.get(target.session_id);
      if (record !== undefined && ["accepted", "sending", "unknown"].includes(record.phase)) {
        this.markArchived(record, record.requested_at);
      }
      throw interruptError("target_not_writable", "session_not_writable", "The selected interrupt session is archived.", "not_sent", false);
    }
    if (state.projection.session.session_state !== "active" || state.projection.session.freshness !== "current") {
      throw interruptError(
        "target_not_writable",
        state.projection.session.freshness === "current" ? "session_not_writable" : "stale_session",
        "The selected interrupt session is not currently writable.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private requireInterruptibleTarget(target: TurnOperationTarget): void {
    const state = this.requireWritableTarget(target);
    if (!activeProjectionStates.has(state.projection.session.turn_state)) {
      throw interruptError(
        "operation_conflict",
        "operation_conflict",
        `The selected turn projection is ${state.projection.session.turn_state}, not actively interruptible.`,
        "not_sent",
        true
      );
    }
    const active = this.activeBySession.get(target.session_id);
    if (active === undefined) {
      throw interruptError(
        "operation_conflict",
        "operation_conflict",
        "The selected turn has no matching normalized turn-start evidence.",
        "not_sent",
        true
      );
    }
    if (!sameTarget(active.target, target)) {
      throw interruptError(
        "operation_conflict",
        "operation_conflict",
        "The requested interrupt does not match the event-proven active turn.",
        "not_sent",
        true
      );
    }

    const existing = this.interruptsBySession.get(target.session_id);
    if (existing !== undefined && ["accepted", "sending", "unknown"].includes(existing.phase)) {
      throw interruptError(
        "operation_conflict",
        existing.phase === "unknown" ? "unknown_error" : "operation_conflict",
        "A prior interrupt for this session is still awaiting authoritative reconciliation.",
        "not_sent",
        false
      );
    }
    if (existing !== undefined && sameTarget(existing.intent.target, target)) {
      throw interruptError(
        "operation_conflict",
        "operation_conflict",
        "The exact turn already has a terminal interrupt attempt.",
        "not_sent",
        false
      );
    }
  }

  private readState(sessionId: string): SelectedSessionState | null {
    let candidate: unknown;
    try {
      candidate = Reflect.apply(this.options.states.get, undefined, [sessionId]);
    } catch (error) {
      throw interruptError(
        "state_unavailable",
        "storage_error",
        "Selected state could not read the interrupt target.",
        "not_sent",
        true,
        error
      );
    }
    if (candidate === null) return null;
    const state = parseSelectedInterruptState(candidate);
    if (state === null || !selectedIdentityMatches(state)) {
      throw interruptError(
        "target_mismatch",
        "stale_session",
        "The selected interrupt target identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    return state;
  }

  private readStateByThreadId(threadId: string): SelectedSessionState | null {
    let candidate: unknown;
    try {
      candidate = Reflect.apply(this.options.states.getByThreadId, undefined, [threadId]);
    } catch (error) {
      throw interruptError(
        "state_unavailable",
        "storage_error",
        "Selected state could not resolve the interrupt thread.",
        "not_sent",
        true,
        error
      );
    }
    if (candidate === null) return null;
    const state = parseSelectedInterruptState(candidate);
    if (state === null || state.mapping.codex_thread_id !== threadId || !selectedIdentityMatches(state)) {
      throw interruptError(
        "target_mismatch",
        "stale_session",
        "The selected interrupt thread identity requires reconciliation.",
        "not_sent",
        false
      );
    }
    return state;
  }

  private requireRuntimeState(state: SelectedSessionState): void {
    const runtimeVersion = this.activeRuntimeVersion();
    if (
      state.mapping.runtime_version !== runtimeVersion ||
      state.projection.session.runtime_version !== runtimeVersion
    ) {
      throw interruptError(
        "target_stale",
        "stale_session",
        "The selected interrupt session belongs to another Codex runtime version.",
        "not_sent",
        true
      );
    }
  }

  private activeRuntimeVersion(): string {
    let candidate: unknown;
    try {
      candidate = this.options.turns.runtime_version;
    } catch (error) {
      throw mapAdapterError(error, "Codex interrupt runtime identity is unavailable.");
    }
    const parsed = codexVersionSchema.safeParse(candidate);
    if (!parsed.success) {
      throw interruptError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex interrupt runtime version is invalid.",
        "not_sent",
        false,
        parsed.error
      );
    }
    return parsed.data;
  }

  private createTerminalWaiter(target: TurnOperationTarget, signal: AbortSignal): Promise<SelectedOperationProgress> {
    const key = targetKey(target.session_id, target.turn_id);
    return new Promise<SelectedOperationProgress>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        const waiters = this.waiters.get(key);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.waiters.delete(key);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(terminalWaitAborted(signal.reason));
      };
      const waiter: TerminalWaiter = {
        signal,
        onAbort,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }
      };
      const waiters = this.waiters.get(key) ?? new Set<TerminalWaiter>();
      waiters.add(waiter);
      this.waiters.set(key, waiters);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private notifyWaiters(target: TurnOperationTarget, value: SelectedOperationProgress): void {
    const key = targetKey(target.session_id, target.turn_id);
    const waiters = this.waiters.get(key);
    if (waiters === undefined) return;
    this.waiters.delete(key);
    for (const waiter of waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(value);
    }
  }

  private ensureCapacity(sessionId: string): void {
    const trackedSessions = new Set([...this.activeBySession.keys(), ...this.interruptsBySession.keys()]);
    if (trackedSessions.has(sessionId) || trackedSessions.size < this.options.max_tracked_turns) return;
    const evictable = [...this.interruptsBySession.entries()]
      .filter(([candidate, record]) => record.phase === "terminal" && !this.activeBySession.has(candidate))
      .sort((left, right) => (left[1].progress?.updated_at ?? "").localeCompare(right[1].progress?.updated_at ?? ""));
    for (const [candidate] of evictable) {
      this.interruptsBySession.delete(candidate);
      trackedSessions.delete(candidate);
      if (trackedSessions.size < this.options.max_tracked_turns) return;
    }
    throw interruptError(
      "service_overloaded",
      "service_overloaded",
      "Interrupt active-turn capacity is exhausted.",
      "not_sent",
      true
    );
  }

  private timestamp(): IsoTimestamp {
    const parsed = isoTimestampSchema.safeParse(Reflect.apply(this.options.now, undefined, []));
    if (!parsed.success) {
      throw interruptError("invalid_request", "internal_error", "The interrupt-control clock returned an invalid timestamp.", "not_sent", false, parsed.error);
    }
    return parsed.data;
  }

  private serialized<T>(
    sessionId: string,
    operation: () => Promise<T>,
    deadline?: OperationDeadline,
    failure: OperationDeadlineFailureFactory = interruptDeadlineError
  ): Promise<T> {
    if (deadline !== undefined) {
      return runSerializedWithDeadline(
        this.tails,
        sessionId,
        deadline,
        failure,
        operation,
        interruptInvalidDeadlineError
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

function parseIntent(candidate: unknown): InterruptIntent {
  const parsed = interruptOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw interruptError("invalid_request", "validation_error", "The interrupt request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseTarget(candidate: unknown): TurnOperationTarget {
  const parsed = turnOperationTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw interruptError("invalid_request", "validation_error", "The interrupt target is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseInternalTarget(candidate: unknown): TurnOperationTarget {
  const parsed = turnOperationTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw interruptError(
      "runtime_protocol_error",
      "protocol_error",
      "Normalized turn evidence violates the interrupt target contract.",
      "not_sent",
      false,
      parsed.error
    );
  }
  return parsed.data;
}

function progress(
  record: TrackedInterrupt,
  state: SelectedOperationProgress["state"],
  updatedAt: IsoTimestamp,
  error: SelectedOperationProgress["error"]
): SelectedOperationProgress {
  const parsed = selectedOperationProgressSchema.safeParse({
    operation_id: record.intent.operation_id,
    kind: "interrupt",
    target: record.intent.target,
    state,
    updated_at: updatedAt,
    turn_id: record.intent.target.turn_id,
    error
  });
  if (!parsed.success) {
    throw interruptError(
      "runtime_protocol_error",
      "internal_error",
      "Interrupt control produced invalid operation progress.",
      "unknown",
      false,
      parsed.error
    );
  }
  return deepFreeze(parsed.data);
}

function parseOptions(candidate: unknown): ParsedOptions {
  const value = readExactOptionObject(candidate);
  const turns = value.turns;
  const states = value.states;
  if (
    turns === null ||
    typeof turns !== "object" ||
    !hasDataFunctionProperty(turns, "interruptTurn") ||
    !hasDataOrAccessorProperty(turns, "runtime_version") ||
    states === null ||
    typeof states !== "object" ||
    !hasDataFunctionProperty(states, "get") ||
    !hasDataFunctionProperty(states, "getByThreadId") ||
    (value.now !== undefined && typeof value.now !== "function")
  ) {
    throw new TypeError("Codex interrupt control requires exact turn, selected-state, and clock ports.");
  }
  return Object.freeze({
    turns: turns as Pick<CodexTurnClient, "interruptTurn" | "runtime_version">,
    states: states as CodexInterruptControlStatePort,
    max_tracked_turns: parseCapacity(value.max_tracked_turns as number | undefined),
    now: (value.now as (() => string) | undefined) ?? (() => new Date().toISOString())
  });
}

function readExactOptionObject(candidate: unknown): Readonly<Record<string, unknown>> {
  const required = ["states", "turns"];
  const allowed = [...required, "max_tracked_turns", "now"];
  const message = "Codex interrupt control options must be an exact plain data object.";
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError(message);
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })
    ) {
      throw new TypeError(message);
    }
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key as string]?.value])));
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}

function hasDataFunctionProperty(candidate: object, key: string): boolean {
  let current: object | null = candidate;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) return "value" in descriptor && typeof descriptor.value === "function";
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function hasDataOrAccessorProperty(candidate: object, key: string): boolean {
  let current: object | null = candidate;
  while (current !== null) {
    if (Object.getOwnPropertyDescriptor(current, key) !== undefined) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function parseSelectedInterruptState(candidate: unknown): SelectedSessionState | null {
  try {
    const state = readExactDataObject(candidate, selectedStateKeys);
    const mapping = selectedSessionMappingRecordSchema.safeParse(state.mapping);
    const projection = selectedSessionProjectionRecordSchema.safeParse(state.projection);
    if (!mapping.success || !projection.success) return null;
    return Object.freeze({ mapping: mapping.data, projection: projection.data });
  } catch {
    return null;
  }
}

function selectedIdentityMatches(state: SelectedSessionState): boolean {
  const session = state.projection.session;
  return (
    state.mapping.id === session.id &&
    state.mapping.name === session.name &&
    state.mapping.codex_thread_id === session.codex_thread_id &&
    state.mapping.cwd === session.cwd &&
    state.mapping.runtime_source === session.runtime_source &&
    state.mapping.runtime_version === session.runtime_version &&
    state.mapping.created_at === session.created_at &&
    state.mapping.archived_at === session.archived_at
  );
}

function readExactDataObject<const Keys extends readonly string[]>(
  candidate: unknown,
  keys: Keys
): Readonly<Record<Keys[number], unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError();
  const prototype: unknown = Object.getPrototypeOf(candidate);
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new TypeError();
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]))) as Readonly<
    Record<Keys[number], unknown>
  >;
}

function terminalWaitAborted(cause?: unknown): HostDeckCodexInterruptControlError {
  return interruptError(
    "operation_timeout",
    "operation_timeout",
    "Interrupt terminal proof was interrupted before an authoritative outcome.",
    "unknown",
    false,
    cause
  );
}

function parseCapacity(candidate: number | undefined): number {
  const definition = resourceBudgetDefinitionByKey.control_interrupt_max_tracked_turns;
  const value = candidate ?? defaultResourceBudget.control_interrupt_max_tracked_turns;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError(`Interrupt tracked-turn capacity must be between ${definition.minimum} and ${definition.maximum}.`);
  }
  return value;
}

function mapAdapterError(error: unknown, fallback: string): HostDeckCodexInterruptControlError {
  if (error instanceof HostDeckCodexInterruptControlError) return error;
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return interruptError("runtime_unavailable", "runtime_unavailable", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return interruptError("capability_unsupported", "capability_unavailable", error.message, "not_sent", false, error);
  }
  if (["request_aborted", "request_timeout"].includes(error.code)) {
    return interruptError(
      "operation_timeout",
      "operation_timeout",
      error.message,
      error.outcome === "unknown" ? "unknown" : "not_sent",
      error.outcome === "unknown" ? false : error.retry_safe,
      error
    );
  }
  if (error.outcome === "unknown" || error.outcome === "not_applicable") {
    return interruptError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.outcome === "remote_rejected") {
    return interruptError("operation_conflict", "operation_conflict", error.message, "remote_rejected", error.retry_safe, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    return interruptError("runtime_protocol_error", "protocol_error", error.message, "not_sent", error.retry_safe, error);
  }
  if (error.code === "broker_overloaded") {
    return interruptError("service_overloaded", "service_overloaded", error.message, "not_sent", error.retry_safe, error);
  }
  return interruptError("runtime_unavailable", "runtime_unavailable", error.message || fallback, "not_sent", error.retry_safe, error);
}

function requireInterruptDeadline(candidate: unknown): OperationDeadline {
  return requireOpenOperationDeadline(
    candidate,
    interruptDeadlineError,
    interruptInvalidDeadlineError
  );
}

function interruptInvalidDeadlineError(cause: unknown): HostDeckCodexInterruptControlError {
  return interruptError(
    "invalid_request",
    "validation_error",
    "The interrupt request deadline is invalid.",
    "not_sent",
    false,
    cause
  );
}

function interruptDeadlineError(cause: unknown): HostDeckCodexInterruptControlError {
  return interruptError(
    "operation_timeout",
    "operation_timeout",
    "Codex interrupt operation exceeded its request deadline.",
    "not_sent",
    true,
    cause
  );
}

function errorEnvelope(error: HostDeckCodexInterruptControlError): NonNullable<SelectedOperationProgress["error"]> {
  return { code: error.api_code, message: error.message, retryable: error.retry_safe };
}

function interruptError(
  code: CodexInterruptControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexInterruptControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexInterruptControlError {
  return new HostDeckCodexInterruptControlError(
    code,
    apiCode,
    message,
    outcome,
    retrySafe,
    cause === undefined ? undefined : { cause }
  );
}

function sameTarget(left: TurnOperationTarget, right: TurnOperationTarget): boolean {
  return (
    left.session_id === right.session_id &&
    left.codex_thread_id === right.codex_thread_id &&
    left.turn_id === right.turn_id
  );
}

function targetKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex interrupt control failed.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
