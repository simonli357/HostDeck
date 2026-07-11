import {
  type CodexTurnClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  interruptOperationIntentSchema,
  isoTimestampSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  type SelectedOperationProgress,
  selectedOperationProgressSchema,
  type TurnOperationTarget,
  turnOperationTargetSchema
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";

type InterruptIntent = Extract<SelectedOperationIntent, { readonly kind: "interrupt" }>;
type TurnCompletedEvent = Extract<NormalizedCodexEvent, { readonly method: "turn/completed" }>;

export type CodexInterruptControlErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "operation_conflict"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_writable"
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
  readonly turns: Pick<CodexTurnClient, "interruptTurn">;
  readonly states: CodexInterruptControlStatePort;
  readonly max_tracked_turns?: number;
  readonly now?: () => string;
}

export interface CodexInterruptControlService {
  readonly snapshot: (target: unknown) => Promise<SelectedOperationProgress | null>;
  readonly interrupt: (intent: unknown, signal?: AbortSignal) => Promise<SelectedOperationProgress>;
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

const activeProjectionStates = new Set(["in_progress", "waiting_for_approval", "waiting_for_input"]);

export function createCodexInterruptControlService(
  options: CodexInterruptControlServiceOptions
): CodexInterruptControlService {
  const implementation = new DefaultCodexInterruptControlService(options);
  return Object.freeze({
    snapshot: (target: unknown) => implementation.snapshot(target),
    interrupt: (intent: unknown, signal?: AbortSignal) => implementation.interrupt(intent, signal),
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
  private readonly maxTrackedTurns: number;
  private readonly now: () => string;

  constructor(private readonly options: CodexInterruptControlServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.turns?.interruptTurn !== "function" ||
      typeof options.states?.get !== "function" ||
      typeof options.states.getByThreadId !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Codex interrupt control requires exact turn, selected-state, and clock ports.");
    }
    this.maxTrackedTurns = parseCapacity(options.max_tracked_turns);
    this.now = options.now ?? (() => new Date().toISOString());
  }

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

  async snapshot(targetInput: unknown): Promise<SelectedOperationProgress | null> {
    const target = parseTarget(targetInput);
    return this.serialized(target.session_id, async () => {
      this.requireIdentity(target);
      const record = this.interruptsBySession.get(target.session_id);
      if (record === undefined || !sameTarget(record.intent.target, target)) return null;
      return record.progress;
    });
  }

  async interrupt(input: unknown, signal?: AbortSignal): Promise<SelectedOperationProgress> {
    const intent = parseIntent(input);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw interruptError("invalid_request", "validation_error", "The interrupt request signal is invalid.", "not_sent", true);
    }
    return this.serialized(intent.target.session_id, async () => {
      const state = this.requireWritableTarget(intent.target);
      if (!activeProjectionStates.has(state.projection.session.turn_state)) {
        throw interruptError(
          "operation_conflict",
          "operation_conflict",
          `The selected turn projection is ${state.projection.session.turn_state}, not actively interruptible.`,
          "not_sent",
          true
        );
      }
      const active = this.activeBySession.get(intent.target.session_id);
      if (active === undefined) {
        throw interruptError(
          "operation_conflict",
          "operation_conflict",
          "The selected turn has no matching normalized turn-start evidence.",
          "not_sent",
          true
        );
      }
      if (!sameTarget(active.target, intent.target)) {
        throw interruptError(
          "operation_conflict",
          "operation_conflict",
          "The requested interrupt does not match the event-proven active turn.",
          "not_sent",
          true
        );
      }

      const existing = this.interruptsBySession.get(intent.target.session_id);
      if (existing !== undefined && ["accepted", "sending", "unknown"].includes(existing.phase)) {
        throw interruptError(
          "operation_conflict",
          existing.phase === "unknown" ? "unknown_error" : "operation_conflict",
          "A prior interrupt for this session is still awaiting authoritative reconciliation.",
          "not_sent",
          false
        );
      }
      if (existing !== undefined && sameTarget(existing.intent.target, intent.target)) {
        throw interruptError(
          "operation_conflict",
          "operation_conflict",
          "The exact turn already has a terminal interrupt attempt.",
          "not_sent",
          false
        );
      }

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
        const accepted = await this.options.turns.interruptTurn({
          operation_id: intent.operation_id,
          thread_id: intent.target.codex_thread_id,
          turn_id: intent.target.turn_id,
          ...(signal === undefined ? {} : { signal })
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
    });
  }

  async observeEvent(event: NormalizedCodexEvent): Promise<void> {
    if (!("thread_id" in event)) return;
    const state = this.options.states.getByThreadId(event.thread_id);
    if (state === null) return;
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
      const detail = event.status === "failed" && event.error_message !== null ? `: ${event.error_message}` : "";
      record.progress = progress(record, "failed", event.captured_at, {
        code: "operation_conflict",
        message: bounded(`The turn reached ${event.status} instead of interrupted${detail}.`),
        retryable: false
      });
    }
    return record.progress;
  }

  private markArchived(record: TrackedInterrupt, at: IsoTimestamp): SelectedOperationProgress {
    record.phase = "terminal";
    record.progress = progress(record, "incomplete", at, {
      code: "session_not_writable",
      message: "The session archived before interrupt terminal proof.",
      retryable: false
    });
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
    const state = this.options.states.get(target.session_id);
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
    return state;
  }

  private requireWritableTarget(target: TurnOperationTarget): SelectedSessionState {
    const state = this.requireIdentity(target);
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

  private ensureCapacity(sessionId: string): void {
    const trackedSessions = new Set([...this.activeBySession.keys(), ...this.interruptsBySession.keys()]);
    if (trackedSessions.has(sessionId) || trackedSessions.size < this.maxTrackedTurns) return;
    const evictable = [...this.interruptsBySession.entries()]
      .filter(([candidate, record]) => record.phase === "terminal" && !this.activeBySession.has(candidate))
      .sort((left, right) => (left[1].progress?.updated_at ?? "").localeCompare(right[1].progress?.updated_at ?? ""));
    for (const [candidate] of evictable) {
      this.interruptsBySession.delete(candidate);
      trackedSessions.delete(candidate);
      if (trackedSessions.size < this.maxTrackedTurns) return;
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
    const parsed = isoTimestampSchema.safeParse(this.now());
    if (!parsed.success) {
      throw interruptError("invalid_request", "internal_error", "The interrupt-control clock returned an invalid timestamp.", "not_sent", false, parsed.error);
    }
    return parsed.data;
  }

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
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
