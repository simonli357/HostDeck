import {
  type CodexCompactAccepted,
  type CodexCompactClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  compactOperationIntentSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  positiveSafeIntegerSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent,
  type SelectedOperationProgress,
  selectedOperationProgressSchema
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";

type CompactIntent = Extract<SelectedOperationIntent, { readonly kind: "compact" }>;
type CompactItemEvent = Extract<
  NormalizedCodexEvent,
  { readonly method: "item/started" | "item/completed" }
>;
type CompactLifecycleEvent = Extract<
  NormalizedCodexEvent,
  {
    readonly method:
      | "item/started"
      | "item/completed"
      | "thread/archived"
      | "turn/started"
      | "turn/completed";
  }
>;

export type CodexCompactControlErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "observation_conflict"
  | "operation_conflict"
  | "runtime_protocol_error"
  | "runtime_unavailable"
  | "service_overloaded"
  | "state_unavailable"
  | "target_mismatch"
  | "target_not_found"
  | "target_not_writable"
  | "target_stale"
  | "unknown_outcome";

export type CodexCompactControlOutcome = "not_sent" | "remote_rejected" | "unknown";

export class HostDeckCodexCompactControlError extends Error {
  constructor(
    readonly code: CodexCompactControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexCompactControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexCompactControlError";
  }
}

export interface CodexCompactControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexCompactControlServiceOptions {
  readonly compact: CodexCompactClient;
  readonly states: CodexCompactControlStatePort;
  readonly max_tracked_operations?: number;
  readonly now?: () => string;
}

export interface CodexCompactControlService {
  readonly compact: (intent: unknown, signal?: AbortSignal) => Promise<SelectedOperationProgress>;
  readonly snapshot: (target: unknown) => Promise<SelectedOperationProgress | null>;
  readonly observe: (event: NormalizedCodexEvent, generation: unknown) => Promise<boolean>;
  readonly active_count: number;
  readonly connection_generation: number | null;
  readonly tracked_count: number;
}

type CompactPhase = "accepted" | "item_completed" | "running" | "sending" | "terminal" | "unknown";

interface TrackedCompact {
  readonly intent: CompactIntent;
  readonly requested_at: IsoTimestamp;
  generation: number;
  phase: CompactPhase;
  accepted_at: IsoTimestamp | null;
  turn_id: string | null;
  turn_started_at: IsoTimestamp | null;
  item_id: string | null;
  item_started_at: IsoTimestamp | null;
  item_completed_at: IsoTimestamp | null;
  terminal_status: "completed" | "failed" | "interrupted" | null;
  last_sequence: number | null;
  last_event_at: IsoTimestamp | null;
  progress: SelectedOperationProgress | null;
}

interface ParsedOptions {
  readonly compact: CodexCompactClient;
  readonly states: CodexCompactControlStatePort;
  readonly max_tracked_operations: number;
  readonly now: () => string;
}

const compactEventMethods = new Set([
  "item/started",
  "item/completed",
  "thread/archived",
  "turn/started",
  "turn/completed"
]);
const terminalTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const openPhases = new Set<CompactPhase>(["sending", "accepted", "running", "item_completed", "unknown"]);

export function createCodexCompactControlService(
  options: CodexCompactControlServiceOptions
): CodexCompactControlService {
  const implementation = new DefaultCodexCompactControlService(parseOptions(options));
  return Object.freeze({
    compact: (intent: unknown, signal?: AbortSignal) => implementation.compact(intent, signal),
    snapshot: (target: unknown) => implementation.snapshot(target),
    observe: (event: NormalizedCodexEvent, generation: unknown) => implementation.observe(event, generation),
    get active_count() {
      return implementation.active_count;
    },
    get connection_generation() {
      return implementation.connection_generation;
    },
    get tracked_count() {
      return implementation.tracked_count;
    }
  });
}

class DefaultCodexCompactControlService implements CodexCompactControlService {
  private readonly bySession = new Map<string, TrackedCompact>();
  private readonly tails = new Map<string, Promise<void>>();
  private currentGeneration: number | null = null;

  constructor(private readonly options: ParsedOptions) {}

  get active_count(): number {
    return [...this.bySession.values()].filter((record) => openPhases.has(record.phase)).length;
  }

  get connection_generation(): number | null {
    return this.currentGeneration;
  }

  get tracked_count(): number {
    return this.bySession.size;
  }

  async compact(candidate: unknown, signal?: AbortSignal): Promise<SelectedOperationProgress> {
    const intent = parseIntent(candidate);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw compactError(
        "invalid_request",
        "validation_error",
        "The compact request signal is invalid.",
        "not_sent",
        true
      );
    }
    return this.serialized(intent.target.session_id, async () => {
      const state = this.requireCurrentTarget(intent.target, true);
      const runtime = this.readCurrentRuntime();
      this.requireRuntimeMatch(state, runtime.version);
      const requestedAt = this.timestamp();
      this.synchronizeGeneration(runtime.generation, requestedAt);

      const existing = this.bySession.get(intent.target.session_id);
      if (existing !== undefined && openPhases.has(existing.phase)) {
        throw compactError(
          "operation_conflict",
          existing.phase === "unknown" ? "unknown_error" : "operation_conflict",
          "A prior compact operation for this session still lacks authoritative terminal reconciliation.",
          "not_sent",
          false
        );
      }
      this.ensureCapacity(intent.target.session_id);

      const record: TrackedCompact = {
        intent,
        requested_at: requestedAt,
        generation: runtime.generation,
        phase: "sending",
        accepted_at: null,
        turn_id: null,
        turn_started_at: null,
        item_id: null,
        item_started_at: null,
        item_completed_at: null,
        terminal_status: null,
        last_sequence: null,
        last_event_at: null,
        progress: null
      };
      this.bySession.set(intent.target.session_id, record);

      try {
        const accepted = await this.options.compact.compactThread({
          operation_id: intent.operation_id,
          thread_id: intent.target.codex_thread_id,
          ...(signal === undefined ? {} : { signal })
        });
        const acceptedAt = this.validateAcceptance(record, accepted, runtime);
        record.phase = "accepted";
        record.accepted_at = acceptedAt;
        record.progress = this.progress(record, "accepted", null, acceptedAt);
        this.validatePostSendContinuity(record, runtime);
        return record.progress;
      } catch (error) {
        let mapped = mapAdapterError(error, "Codex compact dispatch failed.");
        if (record.phase === "accepted" && mapped.outcome !== "unknown") {
          mapped = compactError(
            "unknown_outcome",
            "unknown_error",
            "Codex accepted compaction but HostDeck lost target or runtime continuity before returning it.",
            "unknown",
            false,
            mapped
          );
        }
        if (mapped.outcome === "unknown") {
          record.phase = "unknown";
          record.progress = this.progress(record, "incomplete", errorEnvelope(mapped), this.timestampAfter(record));
        } else {
          this.bySession.delete(intent.target.session_id);
        }
        throw mapped;
      }
    });
  }

  async snapshot(candidate: unknown): Promise<SelectedOperationProgress | null> {
    const target = parseTarget(candidate);
    return this.serialized(target.session_id, async () => {
      this.requireIdentity(target);
      const record = this.bySession.get(target.session_id);
      if (record === undefined || !sameTarget(record.intent.target, target)) return null;
      return record.progress;
    });
  }

  async observe(event: NormalizedCodexEvent, generationCandidate: unknown): Promise<boolean> {
    if (!isCompactLifecycleEvent(event)) return false;
    if (isItemEvent(event) && event.item.category !== "compaction") return false;
    const generation = parseGeneration(generationCandidate);
    const state = this.readStateByThreadId(event.thread_id);
    if (state === null) return false;
    const sessionId = state.mapping.id;

    return this.serialized(sessionId, async () => {
      const activeGeneration = this.readCurrentRuntime().generation;
      this.synchronizeGeneration(activeGeneration, event.captured_at);
      if (generation !== activeGeneration) {
        throw compactError(
          "runtime_unavailable",
          "runtime_unavailable",
          "The compact lifecycle event belongs to a stale connection generation.",
          "not_sent",
          true
        );
      }
      const record = this.bySession.get(sessionId);
      if (record === undefined) return false;
      if (record.generation !== generation) return false;
      return this.applyEvent(record, event);
    });
  }

  private applyEvent(record: TrackedCompact, event: CompactLifecycleEvent): boolean {
    if (record.phase === "terminal") {
      if ("turn_id" in event && record.turn_id !== null && event.turn_id === record.turn_id) {
        throw compactError(
          "observation_conflict",
          "protocol_error",
          "The terminal compact operation received another lifecycle event for its exact turn.",
          "not_sent",
          false
        );
      }
      return false;
    }
    this.assertNewerEvent(record, event);

    if (event.method === "thread/archived") {
      this.markIncomplete(
        record,
        event.captured_at,
        "session_not_writable",
        "The managed thread archived before compact terminal proof."
      );
      return true;
    }
    if (event.method === "turn/started") {
      if (record.turn_id !== null) {
        return this.failObservation(record, event, "A second or duplicate turn started during one compact operation.");
      }
      record.turn_id = event.turn_id;
      record.turn_started_at = event.captured_at;
      this.acceptEventOrder(record, event);
      return true;
    }
    if (event.method === "item/started") {
      if (event.item.state !== "started") {
        return this.failObservation(record, event, "Compact item start carried a contradictory normalized state.");
      }
      if (record.turn_id === null || record.turn_started_at === null || record.turn_id !== event.turn_id) {
        return this.failObservation(record, event, "Context compaction started without the matching observed compact turn.");
      }
      if (record.item_id !== null) {
        return this.failObservation(record, event, "A second or duplicate context-compaction item started.");
      }
      record.item_id = event.item.id;
      record.item_started_at = event.captured_at;
      record.phase = "running";
      this.acceptEventOrder(record, event);
      record.progress = this.progress(record, "running", null, event.captured_at);
      return true;
    }
    if (event.method === "item/completed") {
      if (event.item.state !== "completed") {
        return this.failObservation(record, event, "Compact item completion carried a contradictory normalized state.");
      }
      if (
        record.phase !== "running" ||
        record.turn_id !== event.turn_id ||
        record.item_id === null ||
        record.item_id !== event.item.id
      ) {
        return this.failObservation(record, event, "Context compaction completed without its exact active item identity.");
      }
      record.item_completed_at = event.captured_at;
      record.phase = "item_completed";
      this.acceptEventOrder(record, event);
      record.progress = this.progress(record, "running", null, event.captured_at);
      return true;
    }

    if (event.method !== "turn/completed") {
      return this.failObservation(record, event, "Compact lifecycle event kind could not be resolved.");
    }
    if (record.turn_id === null || record.turn_id !== event.turn_id) {
      return this.failObservation(record, event, "A turn terminated without the exact observed compact-turn identity.");
    }
    record.terminal_status = event.status;
    this.acceptEventOrder(record, event);
    if (record.item_id === null || record.item_started_at === null) {
      this.markIncomplete(
        record,
        event.captured_at,
        "protocol_error",
        "The candidate turn terminated without context-compaction item evidence."
      );
      return true;
    }
    if (event.status === "completed") {
      if (record.item_completed_at === null || record.phase !== "item_completed") {
        this.markIncomplete(
          record,
          event.captured_at,
          "protocol_error",
          "The compact turn completed without authoritative context-compaction item completion."
        );
        return true;
      }
      record.phase = "terminal";
      record.progress = this.progress(record, "completed", null, event.captured_at);
      return true;
    }
    record.phase = "terminal";
    if (event.status === "interrupted") {
      record.progress = this.progress(record, "interrupted", null, event.captured_at);
      return true;
    }
    record.progress = this.progress(
      record,
      "failed",
      {
        code: "unknown_error",
        message: bounded(event.error_message ?? "The compact turn failed without a bounded runtime reason."),
        retryable: false
      },
      event.captured_at
    );
    return true;
  }

  private validateAcceptance(
    record: TrackedCompact,
    candidate: CodexCompactAccepted,
    runtime: { readonly version: string; readonly generation: number }
  ): IsoTimestamp {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
    ) {
      throw postSendProtocol("Codex compact acceptance is not an object.");
    }
    const keys = Object.keys(candidate).sort();
    const expected = ["accepted_at", "connection_generation", "runtime_version", "state", "thread_id"].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw postSendProtocol("Codex compact acceptance fields are invalid.");
    }
    const acceptedAt = isoTimestampSchema.safeParse(candidate.accepted_at);
    if (!acceptedAt.success || Date.parse(acceptedAt.data) < Date.parse(record.requested_at)) {
      throw postSendProtocol("Codex compact acceptance time is invalid or precedes dispatch.", acceptedAt.success ? undefined : acceptedAt.error);
    }
    if (
      candidate.state !== "accepted" ||
      candidate.thread_id !== record.intent.target.codex_thread_id ||
      candidate.runtime_version !== runtime.version ||
      candidate.connection_generation !== runtime.generation
    ) {
      throw postSendProtocol("Codex compact acceptance changed the exact target, runtime, generation, or state.");
    }
    return acceptedAt.data;
  }

  private validatePostSendContinuity(
    record: TrackedCompact,
    expected: { readonly version: string; readonly generation: number }
  ): void {
    let current: { readonly version: string; readonly generation: number };
    try {
      current = this.readCurrentRuntime();
      const state = this.requireCurrentTarget(record.intent.target, false);
      this.requireRuntimeMatch(state, expected.version);
    } catch (error) {
      throw compactError(
        "unknown_outcome",
        "unknown_error",
        "Codex compact acceptance lost runtime or selected-target continuity.",
        "unknown",
        false,
        error
      );
    }
    if (current.version !== expected.version || current.generation !== expected.generation) {
      throw compactError(
        "unknown_outcome",
        "unknown_error",
        "Codex compact acceptance crossed a runtime version or connection generation.",
        "unknown",
        false
      );
    }
  }

  private assertNewerEvent(record: TrackedCompact, event: CompactLifecycleEvent): void {
    if (
      Date.parse(event.captured_at) < Date.parse(record.requested_at) ||
      (record.last_sequence !== null && event.sequence <= record.last_sequence) ||
      (record.last_event_at !== null && Date.parse(event.captured_at) < Date.parse(record.last_event_at))
    ) {
      this.markIncomplete(record, event.captured_at, "protocol_error", "Compact lifecycle evidence moved backward or repeated.");
      throw compactError(
        "observation_conflict",
        "protocol_error",
        "Compact lifecycle evidence moved backward or repeated.",
        "not_sent",
        false
      );
    }
  }

  private acceptEventOrder(record: TrackedCompact, event: CompactLifecycleEvent): void {
    record.last_sequence = event.sequence;
    record.last_event_at = event.captured_at;
  }

  private failObservation(record: TrackedCompact, event: CompactLifecycleEvent, message: string): never {
    this.acceptEventOrder(record, event);
    this.markIncomplete(record, event.captured_at, "protocol_error", message);
    throw compactError("observation_conflict", "protocol_error", message, "not_sent", false);
  }

  private markIncomplete(record: TrackedCompact, at: IsoTimestamp, code: ErrorCode, message: string): void {
    record.phase = "terminal";
    record.progress = this.progress(
      record,
      "incomplete",
      { code, message: bounded(message), retryable: false },
      at
    );
  }

  private progress(
    record: TrackedCompact,
    state: SelectedOperationProgress["state"],
    error: SelectedOperationProgress["error"],
    at: IsoTimestamp
  ): SelectedOperationProgress {
    const turnId = record.item_id === null ? null : record.turn_id;
    const parsed = selectedOperationProgressSchema.safeParse({
      operation_id: record.intent.operation_id,
      kind: "compact",
      target: record.intent.target,
      state,
      updated_at: latestTimestamp(record.progress?.updated_at ?? record.requested_at, at),
      turn_id: turnId,
      error
    });
    if (!parsed.success) {
      throw compactError(
        "runtime_protocol_error",
        "internal_error",
        "Compact control produced invalid operation progress.",
        "unknown",
        false,
        parsed.error
      );
    }
    return deepFreeze(parsed.data);
  }

  private synchronizeGeneration(generation: number, at: IsoTimestamp): void {
    if (this.currentGeneration === null) {
      this.currentGeneration = generation;
      return;
    }
    if (this.currentGeneration === generation) return;
    this.currentGeneration = generation;
    for (const record of this.bySession.values()) {
      if (!openPhases.has(record.phase)) continue;
      this.markIncomplete(
        record,
        at,
        "runtime_unavailable",
        "Connection generation changed before compact terminal proof."
      );
    }
  }

  private readCurrentRuntime(): { readonly version: string; readonly generation: number } {
    try {
      const version = this.options.compact.runtime_version;
      if (typeof version !== "string" || version.length === 0) {
        throw compactError(
          "runtime_protocol_error",
          "protocol_error",
          "Codex compact runtime version is invalid.",
          "not_sent",
          false
        );
      }
      return Object.freeze({ version, generation: parseGeneration(this.options.compact.connection_generation) });
    } catch (error) {
      if (error instanceof HostDeckCodexCompactControlError) throw error;
      throw mapAdapterError(error, "Codex compact runtime is unavailable.");
    }
  }

  private requireRuntimeMatch(state: SelectedSessionState, runtimeVersion: string): void {
    if (
      state.mapping.runtime_version !== runtimeVersion ||
      state.projection.session.runtime_version !== runtimeVersion
    ) {
      throw compactError(
        "target_stale",
        "stale_session",
        "The selected session belongs to a different Codex runtime version.",
        "not_sent",
        true
      );
    }
  }

  private requireCurrentTarget(target: ManagedSessionTarget, requireStartable: boolean): SelectedSessionState {
    const state = this.requireIdentity(target);
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      throw compactError(
        "target_not_writable",
        "session_not_writable",
        "The selected managed session is archived.",
        "not_sent",
        false
      );
    }
    if (
      state.mapping.disposition !== "selected" ||
      state.projection.session.session_state !== "active" ||
      state.projection.session.freshness !== "current"
    ) {
      throw compactError(
        state.mapping.disposition === "selected" ? "target_not_writable" : "target_stale",
        state.mapping.disposition === "selected" ? "session_not_writable" : "stale_session",
        "The selected managed session is not currently writable.",
        "not_sent",
        true
      );
    }
    if (requireStartable && !terminalTurnStates.has(state.projection.session.turn_state)) {
      throw compactError(
        "operation_conflict",
        "operation_conflict",
        "Compaction requires a proven terminal or idle thread state.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private requireIdentity(target: ManagedSessionTarget): SelectedSessionState {
    let state: SelectedSessionState | null;
    try {
      state = this.options.states.get(target.session_id);
    } catch (error) {
      throw compactError(
        "state_unavailable",
        "storage_error",
        "Selected state could not read the compact target.",
        "not_sent",
        true,
        error
      );
    }
    if (state === null) {
      this.bySession.delete(target.session_id);
      throw compactError(
        "target_not_found",
        "session_not_found",
        "The selected managed session does not exist.",
        "not_sent",
        false
      );
    }
    if (state.mapping.codex_thread_id !== target.codex_thread_id) {
      throw compactError(
        "target_mismatch",
        "invalid_session_id",
        "The selected session and compact thread identity do not match.",
        "not_sent",
        false
      );
    }
    return state;
  }

  private readStateByThreadId(threadId: string): SelectedSessionState | null {
    try {
      return this.options.states.getByThreadId(threadId);
    } catch (error) {
      throw compactError(
        "state_unavailable",
        "storage_error",
        "Selected state could not resolve the compact event thread.",
        "not_sent",
        true,
        error
      );
    }
  }

  private ensureCapacity(sessionId: string): void {
    if (this.bySession.has(sessionId) || this.bySession.size < this.options.max_tracked_operations) return;
    const terminal = [...this.bySession.entries()]
      .filter(([, record]) => record.phase === "terminal")
      .sort((left, right) =>
        (left[1].progress?.updated_at ?? left[1].requested_at).localeCompare(
          right[1].progress?.updated_at ?? right[1].requested_at
        )
      );
    for (const [candidate] of terminal) {
      this.bySession.delete(candidate);
      if (this.bySession.size < this.options.max_tracked_operations) return;
    }
    throw compactError(
      "service_overloaded",
      "service_overloaded",
      "Compact tracked-operation capacity is exhausted.",
      "not_sent",
      true
    );
  }

  private timestamp(): IsoTimestamp {
    const parsed = isoTimestampSchema.safeParse(this.options.now());
    if (!parsed.success) {
      throw compactError(
        "invalid_request",
        "internal_error",
        "The compact-control clock returned an invalid timestamp.",
        "not_sent",
        false,
        parsed.error
      );
    }
    return parsed.data;
  }

  private timestampAfter(record: TrackedCompact): IsoTimestamp {
    return record.progress?.updated_at ?? record.accepted_at ?? record.requested_at;
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

function parseOptions(candidate: unknown): ParsedOptions {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("Codex compact control options must be a plain object.");
  }
  const value = candidate as Readonly<Record<string, unknown>>;
  if (Object.keys(value).some((key) => !["compact", "max_tracked_operations", "now", "states"].includes(key))) {
    throw new TypeError("Codex compact control option fields are invalid.");
  }
  if (
    value.compact === null ||
    typeof value.compact !== "object" ||
    typeof (value.compact as { readonly compactThread?: unknown }).compactThread !== "function" ||
    !("connection_generation" in value.compact) ||
    !("runtime_version" in value.compact) ||
    value.states === null ||
    typeof value.states !== "object" ||
    typeof (value.states as { readonly get?: unknown }).get !== "function" ||
    typeof (value.states as { readonly getByThreadId?: unknown }).getByThreadId !== "function" ||
    (value.now !== undefined && typeof value.now !== "function")
  ) {
    throw new TypeError("Codex compact control requires exact compact, selected-state, and clock ports.");
  }
  return Object.freeze({
    compact: value.compact as CodexCompactClient,
    states: value.states as CodexCompactControlStatePort,
    max_tracked_operations: parseCapacity(value.max_tracked_operations),
    now: (value.now as (() => string) | undefined) ?? (() => new Date().toISOString())
  });
}

function parseIntent(candidate: unknown): CompactIntent {
  const parsed = compactOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw compactError(
      "invalid_request",
      "validation_error",
      "The compact request is invalid.",
      "not_sent",
      true,
      parsed.error
    );
  }
  return parsed.data;
}

function parseTarget(candidate: unknown): ManagedSessionTarget {
  const parsed = managedSessionTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw compactError(
      "invalid_request",
      "validation_error",
      "The compact target is invalid.",
      "not_sent",
      true,
      parsed.error
    );
  }
  return parsed.data;
}

function parseGeneration(candidate: unknown): number {
  const parsed = positiveSafeIntegerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw compactError(
      "runtime_protocol_error",
      "protocol_error",
      "The compact connection generation is invalid.",
      "not_sent",
      false,
      parsed.error
    );
  }
  return parsed.data;
}

function parseCapacity(candidate: unknown): number {
  const definition = resourceBudgetDefinitionByKey.control_compact_max_tracked_operations;
  const value = candidate ?? defaultResourceBudget.control_compact_max_tracked_operations;
  if (!Number.isSafeInteger(value) || (value as number) < definition.minimum || (value as number) > definition.maximum) {
    throw new TypeError(
      `Codex compact tracked-operation capacity must be between ${definition.minimum} and ${definition.maximum}.`
    );
  }
  return value as number;
}

function isCompactLifecycleEvent(event: NormalizedCodexEvent): event is CompactLifecycleEvent {
  return "thread_id" in event && compactEventMethods.has(event.method);
}

function isItemEvent(event: CompactLifecycleEvent): event is CompactItemEvent {
  return event.method === "item/started" || event.method === "item/completed";
}

function sameTarget(left: ManagedSessionTarget, right: ManagedSessionTarget): boolean {
  return left.session_id === right.session_id && left.codex_thread_id === right.codex_thread_id;
}

function latestTimestamp(first: string, second: string): IsoTimestamp {
  return (Date.parse(second) > Date.parse(first) ? second : first) as IsoTimestamp;
}

function postSendProtocol(message: string, cause?: unknown): HostDeckCodexCompactControlError {
  return compactError("unknown_outcome", "unknown_error", message, "unknown", false, cause);
}

function mapAdapterError(error: unknown, fallback: string): HostDeckCodexCompactControlError {
  if (error instanceof HostDeckCodexCompactControlError) return error;
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return compactError("unknown_outcome", "unknown_error", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return compactError(
      "capability_unsupported",
      "capability_unavailable",
      error.message,
      "not_sent",
      false,
      error
    );
  }
  if (error.outcome === "unknown" || error.outcome === "not_applicable") {
    return compactError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (error.outcome === "remote_rejected") {
    return compactError(
      "operation_conflict",
      "operation_conflict",
      error.message,
      "remote_rejected",
      error.retry_safe,
      error
    );
  }
  if (error.code === "broker_overloaded") {
    return compactError(
      "service_overloaded",
      "service_overloaded",
      error.message,
      "not_sent",
      error.retry_safe,
      error
    );
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    return compactError(
      "runtime_protocol_error",
      "protocol_error",
      error.message,
      "not_sent",
      false,
      error
    );
  }
  return compactError(
    "runtime_unavailable",
    "runtime_unavailable",
    error.message || fallback,
    "not_sent",
    error.retry_safe,
    error
  );
}

function errorEnvelope(error: HostDeckCodexCompactControlError): NonNullable<SelectedOperationProgress["error"]> {
  return { code: error.api_code, message: error.message, retryable: error.retry_safe };
}

function compactError(
  code: CodexCompactControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexCompactControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexCompactControlError {
  return new HostDeckCodexCompactControlError(code, apiCode, message, outcome, retrySafe, { cause });
}

function bounded(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Codex compact control failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
