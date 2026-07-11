import {
  type CodexApprovalClient,
  type CodexApprovalRequest,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import {
  approvalResponseOperationIntentSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type PendingApproval,
  pendingApprovalSchema,
  resourceBudgetDefinitionByKey,
  type SelectedOperationIntent
} from "@hostdeck/contracts";
import type { ErrorCode, IsoTimestamp } from "@hostdeck/core";
import type { SelectedSessionState, SelectedStateRepository } from "@hostdeck/storage";

type ApprovalResponseIntent = Extract<SelectedOperationIntent, { readonly kind: "approval_response" }>;

export type CodexApprovalControlErrorCode =
  | "approval_not_pending"
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

export type CodexApprovalControlOutcome = "not_sent" | "unknown";

export class HostDeckCodexApprovalControlError extends Error {
  constructor(
    readonly code: CodexApprovalControlErrorCode,
    readonly api_code: ErrorCode,
    message: string,
    readonly outcome: CodexApprovalControlOutcome,
    readonly retry_safe: boolean,
    options?: ErrorOptions
  ) {
    super(bounded(message), options);
    this.name = "HostDeckCodexApprovalControlError";
  }
}

export interface CodexApprovalControlStatePort {
  readonly get: SelectedStateRepository["get"];
  readonly getByThreadId: SelectedStateRepository["getByThreadId"];
}

export interface CodexApprovalControlServiceOptions {
  readonly approvals: CodexApprovalClient;
  readonly states: CodexApprovalControlStatePort;
  readonly expiry_ms?: number;
  readonly max_tracked_approvals?: number;
  readonly now?: () => string;
  readonly on_background_error: (error: Error) => void;
}

export interface CodexApprovalControlService {
  readonly register: (message: unknown) => PendingApproval;
  readonly snapshot: (target: unknown) => Promise<PendingApproval | null>;
  readonly list: (target: unknown) => Promise<readonly PendingApproval[]>;
  readonly respond: (intent: unknown) => Promise<PendingApproval>;
  readonly observeEvent: (event: NormalizedCodexEvent) => Promise<void>;
  readonly expireDue: () => Promise<number>;
  readonly disconnect: (generation: unknown) => Promise<number>;
  readonly close: () => void;
  readonly tracked_count: number;
  readonly pending_count: number;
}

type ResponseKind = "expiry" | "user";
type ResponseOutcome = "none" | "not_sent" | "sending" | "sent" | "unknown";

interface TrackedApproval {
  readonly request: CodexApprovalRequest;
  readonly session_id: string;
  public_state: PendingApproval;
  response_kind: ResponseKind | null;
  response_decision: "approve" | "deny" | null;
  response_outcome: ResponseOutcome;
  resolved_seen: boolean;
  item_terminal_seen: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const futureClockSkewMs = 5_000;

export function createCodexApprovalControlService(
  options: CodexApprovalControlServiceOptions
): CodexApprovalControlService {
  const implementation = new DefaultCodexApprovalControlService(options);
  return Object.freeze({
    register: (message: unknown) => implementation.register(message),
    snapshot: (target: unknown) => implementation.snapshot(target),
    list: (target: unknown) => implementation.list(target),
    respond: (intent: unknown) => implementation.respond(intent),
    observeEvent: (event: NormalizedCodexEvent) => implementation.observeEvent(event),
    expireDue: () => implementation.expireDue(),
    disconnect: (generation: unknown) => implementation.disconnect(generation),
    close: () => implementation.close(),
    get tracked_count() {
      return implementation.tracked_count;
    },
    get pending_count() {
      return implementation.pending_count;
    }
  });
}

class DefaultCodexApprovalControlService implements CodexApprovalControlService {
  private readonly records = new Map<string, TrackedApproval>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly expiryMs: number;
  private readonly maxTrackedApprovals: number;
  private readonly now: () => string;
  private closed = false;

  constructor(private readonly options: CodexApprovalControlServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.approvals?.parseRequest !== "function" ||
      typeof options.approvals.respond !== "function" ||
      typeof options.states?.get !== "function" ||
      typeof options.states.getByThreadId !== "function" ||
      typeof options.on_background_error !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Codex approval control requires approval, selected-state, clock, and background-error ports.");
    }
    this.expiryMs = parseBoundedOption(
      options.expiry_ms,
      defaultResourceBudget.control_approval_expiry_ms,
      resourceBudgetDefinitionByKey.control_approval_expiry_ms,
      "approval expiry"
    );
    this.maxTrackedApprovals = parseBoundedOption(
      options.max_tracked_approvals,
      defaultResourceBudget.protocol_max_pending_server_requests,
      resourceBudgetDefinitionByKey.protocol_max_pending_server_requests,
      "tracked approval capacity"
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get tracked_count(): number {
    return this.records.size;
  }

  get pending_count(): number {
    return [...this.records.values()].filter((record) => !record.closed).length;
  }

  register(message: unknown): PendingApproval {
    this.assertOpen();
    let request: CodexApprovalRequest;
    try {
      request = this.options.approvals.parseRequest(message);
    } catch (error) {
      throw mapAdapterError(error, "Codex approval request registration failed.");
    }
    const currentGeneration = this.activeGeneration();
    this.reconcileGeneration(currentGeneration);
    if (request.generation !== currentGeneration) {
      throw approvalError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex approval request generation does not match the active connection.",
        "not_sent",
        false
      );
    }
    const existing = this.records.get(request.request_id);
    if (existing !== undefined && !existing.closed) {
      throw approvalError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex repeated an approval request that is still unresolved.",
        "not_sent",
        false
      );
    }
    const state = this.options.states.getByThreadId(request.thread_id);
    if (state === null) {
      throw approvalError("target_not_found", "session_not_found", "Codex approval targets no managed session.", "not_sent", false);
    }
    this.requireWritableState(state);
    const now = this.timestamp();
    const startedMs = Date.parse(request.started_at);
    const nowMs = Date.parse(now);
    if (startedMs > nowMs + futureClockSkewMs) {
      throw approvalError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex approval start time is ahead of the HostDeck clock.",
        "not_sent",
        false
      );
    }
    const expiresAt = this.timestampFromMilliseconds(startedMs + this.expiryMs);
    const alreadyExpired = Date.parse(expiresAt) <= nowMs;
    const publicState = parsePendingApproval({
      target: {
        type: "approval",
        session_id: state.mapping.id,
        codex_thread_id: state.mapping.codex_thread_id,
        request_id: request.request_id
      },
      action: request.action,
      scope: request.scope ?? state.mapping.cwd,
      reason: request.reason,
      risk: request.risk,
      grant_scope: request.grant_scope,
      state: alreadyExpired ? "expired" : "pending",
      created_at: request.started_at,
      expires_at: expiresAt,
      decision: null
    });
    const record: TrackedApproval = {
      request,
      session_id: state.mapping.id,
      public_state: publicState,
      response_kind: null,
      response_decision: null,
      response_outcome: alreadyExpired ? "not_sent" : "none",
      resolved_seen: false,
      item_terminal_seen: false,
      closed: false,
      timer: null
    };
    if (existing !== undefined) this.removeRecord(existing);
    this.ensureCapacity();
    this.records.set(request.request_id, record);
    this.scheduleExpiry(record);
    return record.public_state;
  }

  async snapshot(targetInput: unknown): Promise<PendingApproval | null> {
    const target = parseApprovalTarget(targetInput);
    this.reconcileGeneration(this.activeGeneration());
    await this.expireDue();
    this.requireTarget(target.session_id, target.codex_thread_id, false);
    const record = this.records.get(target.request_id);
    if (record === undefined || record.session_id !== target.session_id || record.request.thread_id !== target.codex_thread_id) return null;
    return record.public_state;
  }

  async list(targetInput: unknown): Promise<readonly PendingApproval[]> {
    const target = parseManagedTarget(targetInput);
    this.reconcileGeneration(this.activeGeneration());
    await this.expireDue();
    this.requireTarget(target.session_id, target.codex_thread_id, false);
    return deepFreeze(
      [...this.records.values()]
        .filter((record) => record.session_id === target.session_id && record.request.thread_id === target.codex_thread_id)
        .sort((left, right) =>
          left.public_state.created_at === right.public_state.created_at
            ? left.request.request_id.localeCompare(right.request.request_id)
            : left.public_state.created_at.localeCompare(right.public_state.created_at)
        )
        .map((record) => record.public_state)
    );
  }

  async respond(input: unknown): Promise<PendingApproval> {
    const intent = parseResponseIntent(input);
    return this.serialized(intent.target.request_id, async () => {
      this.assertOpen();
      const record = this.requireRecord(intent);
      this.reconcileRecordGeneration(record);
      if (record.public_state.state === "expired") {
        try {
          await this.expireRecord(record);
        } catch (error) {
          this.observeBackgroundError(error);
        }
        throw approvalError("approval_not_pending", "approval_not_pending", "The approval request has expired.", "not_sent", false);
      }
      if (record.public_state.state !== "pending" || record.closed) {
        throw approvalError(
          "approval_not_pending",
          "approval_not_pending",
          `The approval request is ${record.public_state.state} and cannot receive another response.`,
          "not_sent",
          false
        );
      }
      this.requireTarget(intent.target.session_id, intent.target.codex_thread_id, true);
      if (this.isDue(record, this.timestamp())) {
        try {
          await this.expireRecord(record);
        } catch (error) {
          this.observeBackgroundError(error);
        }
        throw approvalError("approval_not_pending", "approval_not_pending", "The approval request has expired.", "not_sent", false);
      }

      this.clearTimer(record);
      record.response_kind = "user";
      record.response_decision = intent.decision;
      record.response_outcome = "sending";
      this.updatePublic(record, { state: "responding", decision: null });
      try {
        await this.options.approvals.respond({ request: record.request, decision: intent.decision });
        if (record.closed) {
          throw approvalError(
            "unknown_outcome",
            "unknown_error",
            "The approval target closed while its response was in flight.",
            "unknown",
            false
          );
        }
        record.response_outcome = "sent";
        this.settle(record);
        return record.public_state;
      } catch (error) {
        if (error instanceof HostDeckCodexApprovalControlError) throw error;
        const mapped = mapAdapterError(error, "Codex approval response failed.");
        if (record.closed) throw mapped;
        if (mapped.outcome === "not_sent") {
          record.response_kind = null;
          record.response_decision = null;
          record.response_outcome = "none";
          if (record.resolved_seen || record.item_terminal_seen) this.supersede(record);
          else {
            this.updatePublic(record, { state: "pending", decision: null });
            this.scheduleExpiry(record);
          }
        } else {
          record.response_outcome = "unknown";
          this.settle(record);
          if (record.closed) return record.public_state;
        }
        throw mapped;
      }
    });
  }

  async observeEvent(event: NormalizedCodexEvent): Promise<void> {
    if (!("thread_id" in event)) return;
    if (event.method === "serverRequest/resolved") {
      await this.serialized(event.request_id, async () => {
        const record = this.records.get(event.request_id);
        if (record === undefined) return;
        if (record.request.thread_id !== event.thread_id) {
          throw approvalError(
            "runtime_protocol_error",
            "protocol_error",
            "Approval resolution crossed managed thread identity.",
            "not_sent",
            false
          );
        }
        record.resolved_seen = true;
        if (record.response_kind === null) this.supersede(record);
        else this.settle(record);
      });
      return;
    }
    if (event.method === "item/completed") {
      const matching = [...this.records.values()].filter(
        (record) =>
          !record.closed &&
          record.request.thread_id === event.thread_id &&
          record.request.turn_id === event.turn_id &&
          record.request.item_id === event.item.id
      );
      await Promise.all(
        matching.map((record) =>
          this.serialized(record.request.request_id, async () => {
            const expectedCategory =
              record.request.method === "item/commandExecution/requestApproval" ? "command" : "file_change";
            if (event.item.category !== expectedCategory) {
              throw approvalError(
                "runtime_protocol_error",
                "protocol_error",
                "Approval item terminal event has the wrong item category.",
                "not_sent",
                false
              );
            }
            record.item_terminal_seen = true;
            if (record.response_kind === null) this.supersede(record);
            else this.settle(record);
          })
        )
      );
      return;
    }
    if (event.method === "turn/completed") {
      for (const record of this.records.values()) {
        if (!record.closed && record.request.thread_id === event.thread_id && record.request.turn_id === event.turn_id) {
          await this.serialized(record.request.request_id, async () => {
            if (!record.item_terminal_seen) this.supersede(record);
          });
        }
      }
      return;
    }
    if (event.method === "thread/archived") {
      await Promise.all(
        [...this.records.values()]
          .filter((record) => !record.closed && record.request.thread_id === event.thread_id)
          .map((record) =>
            this.serialized(record.request.request_id, async () => {
              this.supersede(record);
            })
          )
      );
    }
  }

  async expireDue(): Promise<number> {
    this.assertOpen();
    this.reconcileGeneration(this.activeGeneration());
    const now = this.timestamp();
    const due = [...this.records.values()].filter(
      (record) =>
        !record.closed &&
        this.isDue(record, now) &&
        (record.public_state.state === "pending" ||
          (record.public_state.state === "expired" && record.response_outcome === "not_sent"))
    );
    const outcomes = await Promise.allSettled(
      due.map((record) => this.serialized(record.request.request_id, () => this.expireRecord(record)))
    );
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "One or more expired Codex approvals could not be declined.");
    return due.length;
  }

  async disconnect(generationInput: unknown): Promise<number> {
    const generation = parseGeneration(generationInput);
    let count = 0;
    for (const record of this.records.values()) {
      if (!record.closed && record.request.generation === generation) {
        await this.serialized(record.request.request_id, async () => {
          if (!record.closed) {
            this.supersede(record);
            count += 1;
          }
        });
      }
    }
    return count;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.records.values()) {
      if (!record.closed) this.supersede(record);
      this.clearTimer(record);
    }
  }

  private async expireRecord(record: TrackedApproval): Promise<void> {
    if (record.closed) return;
    if (record.public_state.state !== "pending" && !(record.public_state.state === "expired" && record.response_outcome === "not_sent")) {
      return;
    }
    this.clearTimer(record);
    record.response_kind = "expiry";
    record.response_decision = "deny";
    record.response_outcome = "sending";
    this.updatePublic(record, { state: "expired", decision: null });
    try {
      await this.options.approvals.respond({ request: record.request, decision: "deny" });
      if (record.closed) return;
      record.response_outcome = "sent";
      this.settle(record);
    } catch (error) {
      const mapped = mapAdapterError(error, "Codex expired-approval decline failed.");
      if (record.closed) throw mapped;
      record.response_outcome = mapped.outcome === "unknown" ? "unknown" : "not_sent";
      if (mapped.outcome === "unknown") {
        this.settle(record);
        if (record.closed) return;
      } else if (record.resolved_seen || record.item_terminal_seen) {
        record.closed = true;
        this.clearTimer(record);
        return;
      }
      throw mapped;
    }
  }

  private settle(record: TrackedApproval): void {
    if (
      record.closed ||
      !record.resolved_seen ||
      !record.item_terminal_seen ||
      record.response_kind === null ||
      !["sent", "unknown"].includes(record.response_outcome)
    ) {
      return;
    }
    if (record.response_kind === "user") {
      const decision = record.response_decision;
      if (decision === null) {
        throw approvalError("runtime_protocol_error", "protocol_error", "Resolved user approval lost its decision.", "not_sent", false);
      }
      this.updatePublic(record, {
        state: decision === "approve" ? "approved" : "denied",
        decision
      });
    }
    record.closed = true;
    this.clearTimer(record);
  }

  private supersede(record: TrackedApproval): void {
    if (record.closed) return;
    this.updatePublic(record, { state: "superseded", decision: null });
    record.closed = true;
    this.clearTimer(record);
  }

  private requireRecord(intent: ApprovalResponseIntent): TrackedApproval {
    const record = this.records.get(intent.target.request_id);
    if (record === undefined) {
      throw approvalError("approval_not_pending", "approval_not_pending", "The approval request is not registered.", "not_sent", false);
    }
    if (record.session_id !== intent.target.session_id || record.request.thread_id !== intent.target.codex_thread_id) {
      throw approvalError("target_mismatch", "invalid_session_id", "Approval target identity does not match its request.", "not_sent", false);
    }
    return record;
  }

  private requireTarget(sessionId: string, threadId: string, writable: boolean): SelectedSessionState {
    const state = this.options.states.get(sessionId);
    if (state === null) {
      throw approvalError("target_not_found", "session_not_found", "The selected approval session does not exist.", "not_sent", false);
    }
    if (state.mapping.codex_thread_id !== threadId) {
      throw approvalError("target_mismatch", "invalid_session_id", "The selected approval session and thread do not match.", "not_sent", false);
    }
    if (state.mapping.archived_at !== null || state.projection.session.session_state === "archived") {
      this.supersedeSession(sessionId);
      throw approvalError("target_not_writable", "session_not_writable", "The selected approval session is archived.", "not_sent", false);
    }
    if (writable && (state.projection.session.session_state !== "active" || state.projection.session.freshness !== "current")) {
      throw approvalError(
        "target_not_writable",
        state.projection.session.freshness === "current" ? "session_not_writable" : "stale_session",
        "The selected approval session is not currently writable.",
        "not_sent",
        true
      );
    }
    return state;
  }

  private requireWritableState(state: SelectedSessionState): void {
    this.requireTarget(state.mapping.id, state.mapping.codex_thread_id, true);
  }

  private supersedeSession(sessionId: string): void {
    for (const record of this.records.values()) {
      if (!record.closed && record.session_id === sessionId) this.supersede(record);
    }
  }

  private reconcileGeneration(generation: number): void {
    for (const record of this.records.values()) {
      if (!record.closed && record.request.generation !== generation) this.supersede(record);
    }
  }

  private reconcileRecordGeneration(record: TrackedApproval): void {
    if (record.request.generation !== this.activeGeneration()) {
      this.supersede(record);
      throw approvalError(
        "approval_not_pending",
        "approval_not_pending",
        "The approval request belongs to a disconnected Codex generation.",
        "not_sent",
        false
      );
    }
  }

  private ensureCapacity(): void {
    if (this.records.size < this.maxTrackedApprovals) return;
    const evictable = [...this.records.values()]
      .filter((record) => record.closed)
      .sort((left, right) => left.public_state.created_at.localeCompare(right.public_state.created_at));
    for (const record of evictable) {
      this.removeRecord(record);
      if (this.records.size < this.maxTrackedApprovals) return;
    }
    throw approvalError(
      "service_overloaded",
      "service_overloaded",
      "Codex approval tracking capacity is exhausted by unresolved requests.",
      "not_sent",
      true
    );
  }

  private removeRecord(record: TrackedApproval): void {
    this.clearTimer(record);
    if (this.records.get(record.request.request_id) === record) this.records.delete(record.request.request_id);
  }

  private scheduleExpiry(record: TrackedApproval): void {
    this.clearTimer(record);
    if (
      record.closed ||
      record.public_state.expires_at === null ||
      (record.public_state.state !== "pending" &&
        !(record.public_state.state === "expired" && record.response_outcome === "not_sent"))
    ) {
      return;
    }
    const delay = Math.max(0, Date.parse(record.public_state.expires_at) - Date.parse(this.timestamp()));
    record.timer = setTimeout(() => {
      void this.serialized(record.request.request_id, async () => {
        if (!this.isDue(record, this.timestamp())) {
          this.scheduleExpiry(record);
          return;
        }
        await this.expireRecord(record);
      }).catch((error: unknown) => {
        this.observeBackgroundError(error);
      });
    }, delay);
    record.timer.unref();
  }

  private clearTimer(record: TrackedApproval): void {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
  }

  private isDue(record: TrackedApproval, now: IsoTimestamp): boolean {
    return record.public_state.expires_at !== null && Date.parse(record.public_state.expires_at) <= Date.parse(now);
  }

  private updatePublic(record: TrackedApproval, patch: Pick<PendingApproval, "state" | "decision">): void {
    record.public_state = parsePendingApproval({ ...record.public_state, ...patch });
  }

  private activeGeneration(): number {
    let generation: number;
    try {
      generation = this.options.approvals.generation;
    } catch (error) {
      throw mapAdapterError(error, "Codex approval connection generation is unavailable.");
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw approvalError(
        "runtime_protocol_error",
        "protocol_error",
        "Codex approval connection generation is invalid.",
        "not_sent",
        false
      );
    }
    return generation;
  }

  private timestamp(): IsoTimestamp {
    const parsed = isoTimestampSchema.safeParse(this.now());
    if (!parsed.success) {
      throw approvalError("invalid_request", "internal_error", "The approval-control clock returned an invalid timestamp.", "not_sent", false, parsed.error);
    }
    return parsed.data;
  }

  private timestampFromMilliseconds(value: number): IsoTimestamp {
    let timestamp: string;
    try {
      timestamp = new Date(value).toISOString();
    } catch (error) {
      throw approvalError(
        "runtime_protocol_error",
        "protocol_error",
        "The approval expiry timestamp is outside the supported range.",
        "not_sent",
        false,
        error
      );
    }
    const parsed = isoTimestampSchema.safeParse(timestamp);
    if (!parsed.success) {
      throw approvalError("invalid_request", "internal_error", "The approval expiry timestamp is invalid.", "not_sent", false, parsed.error);
    }
    return parsed.data;
  }

  private observeBackgroundError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.on_background_error(normalized);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw approvalError("runtime_unavailable", "runtime_unavailable", "Codex approval control is closed.", "not_sent", false);
    }
  }

  private serialized<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(requestId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate, () => gate);
    this.tails.set(requestId, tail);
    return prior
      .then(operation, operation)
      .finally(() => {
        release();
        if (this.tails.get(requestId) === tail) this.tails.delete(requestId);
      });
  }
}

function parseResponseIntent(candidate: unknown): ApprovalResponseIntent {
  const parsed = approvalResponseOperationIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw approvalError("invalid_request", "validation_error", "The approval response request is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseApprovalTarget(candidate: unknown): ApprovalResponseIntent["target"] {
  const parsed = approvalResponseOperationIntentSchema.shape.target.safeParse(candidate);
  if (!parsed.success) {
    throw approvalError("invalid_request", "validation_error", "The approval target is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parseManagedTarget(candidate: unknown): ManagedSessionTarget {
  const parsed = managedSessionTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw approvalError("invalid_request", "validation_error", "The managed approval target is invalid.", "not_sent", true, parsed.error);
  }
  return parsed.data;
}

function parsePendingApproval(candidate: unknown): PendingApproval {
  const parsed = pendingApprovalSchema.safeParse(candidate);
  if (!parsed.success) {
    throw approvalError("runtime_protocol_error", "protocol_error", "Approval state violates its selected contract.", "not_sent", false, parsed.error);
  }
  return deepFreeze(parsed.data);
}

function parseGeneration(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw approvalError("invalid_request", "validation_error", "Codex approval generation is invalid.", "not_sent", true);
  }
  return candidate as number;
}

function parseBoundedOption(
  candidate: number | undefined,
  fallback: number,
  definition: { readonly minimum: number; readonly maximum: number },
  label: string
): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError(`Codex ${label} must be a safe integer from ${definition.minimum} to ${definition.maximum}.`);
  }
  return value;
}

function mapAdapterError(error: unknown, fallback: string): HostDeckCodexApprovalControlError {
  if (error instanceof HostDeckCodexApprovalControlError) return error;
  if (!(error instanceof HostDeckCodexAdapterError)) {
    return approvalError("runtime_unavailable", "runtime_unavailable", fallback, "unknown", false, error);
  }
  if (error.code === "unsupported_method") {
    return approvalError("capability_unsupported", "capability_unavailable", error.message, "not_sent", false, error);
  }
  if (error.outcome === "unknown" || error.outcome === "not_applicable") {
    return approvalError("unknown_outcome", "unknown_error", error.message, "unknown", false, error);
  }
  if (["invalid_protocol_message", "protocol_violation"].includes(error.code)) {
    return approvalError("runtime_protocol_error", "protocol_error", error.message, "not_sent", error.retry_safe, error);
  }
  if (error.code === "broker_overloaded") {
    return approvalError("service_overloaded", "service_overloaded", error.message, "not_sent", error.retry_safe, error);
  }
  return approvalError("runtime_unavailable", "runtime_unavailable", error.message || fallback, "not_sent", error.retry_safe, error);
}

function approvalError(
  code: CodexApprovalControlErrorCode,
  apiCode: ErrorCode,
  message: string,
  outcome: CodexApprovalControlOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexApprovalControlError {
  return new HostDeckCodexApprovalControlError(
    code,
    apiCode,
    message,
    outcome,
    retrySafe,
    cause === undefined ? undefined : { cause }
  );
}

function bounded(value: string): string {
  let printable = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const code = character.charCodeAt(0);
    printable += code <= 31 || code === 127 ? " " : character;
  }
  const normalized = printable.replace(/\s+/gu, " ").trim() || "Approval control failed.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
