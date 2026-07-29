import {
  type ApiErrorEnvelope,
  type ApprovalResponseRequest,
  approvalProjectionEventSchema,
  approvalResponseRequestSchema,
  type PendingApproval,
  type PendingApprovalListResponse,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  runtimeRequestIdSchema,
  type SelectedProjectionEvent,
  selectedEventPageMaxSize,
  sessionIdSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  type BrowserConnectionSnapshot,
  type BrowserConnectionWriteBlockCause,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import { hostLockWriteReason } from "./host-lock-copy.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

type ApprovalEvent = Extract<SelectedProjectionEvent, { readonly type: "approval" }>;
type ApprovalDecision = ApprovalResponseRequest["decision"];
type ApprovalRisk = PendingApproval["risk"];
type ApprovalGrantScope = PendingApproval["grant_scope"];

export const approvalDecisionPhases = Object.freeze([
  "hidden",
  "loading",
  "empty",
  "ready",
  "confirming",
  "submitting",
  "approved",
  "denied",
  "unsupported",
  "read_failed",
  "decision_failed",
  "outcome_unknown"
] as const);

export type ApprovalDecisionPhase = (typeof approvalDecisionPhases)[number];
export type ApprovalDecisionTone = "connected" | "attention" | "danger" | "muted";
export type ApprovalDecisionItemState =
  | PendingApproval["state"]
  | "event_only"
  | "due"
  | "conflict";

export interface ApprovalDecisionContext {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly events: readonly ApprovalEvent[];
}

export interface ApprovalDecisionReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface ApprovalDecisionRespondInput {
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly request: ApprovalResponseRequest;
  readonly signal: AbortSignal;
}

export interface ApprovalDecisionPort {
  readonly read: (input: ApprovalDecisionReadInput) => Promise<unknown>;
  readonly respond: (input: ApprovalDecisionRespondInput) => Promise<unknown>;
}

export interface ApprovalDecisionClockPort {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface CreateApprovalDecisionControllerOptions {
  readonly sessionId: SessionId;
  readonly context: ApprovalDecisionContext;
  readonly port: ApprovalDecisionPort;
  readonly createOperationId: () => string;
  readonly clock?: ApprovalDecisionClockPort | undefined;
}

export interface ApprovalDecisionItemView {
  readonly handle: string;
  readonly eventOrder: number | null;
  readonly source: "event_and_list" | "event_only" | "list_only";
  readonly action: string;
  readonly scope: string;
  readonly reason: string | null;
  readonly risk: ApprovalRisk;
  readonly riskLabel: "Normal" | "Elevated" | "Broad";
  readonly grantScope: ApprovalGrantScope | null;
  readonly grantLabel: "One time" | "Ongoing policy" | "Unverified";
  readonly state: ApprovalDecisionItemState;
  readonly stateLabel: string;
  readonly tone: ApprovalDecisionTone;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly decision: ApprovalDecision | null;
  readonly pending: boolean;
  readonly submitting: boolean;
  readonly actionable: boolean;
  readonly approveEnabled: boolean;
  readonly denyEnabled: boolean;
  readonly approveLabel: "Approve once" | "Review & approve";
  readonly approveRequiresConfirmation: boolean;
  readonly disabledReason: string | null;
  readonly statusDetail: string;
}

export interface ApprovalDecisionConfirmationView {
  readonly handle: string;
  readonly title: "Approve elevated request?" | "Approve broad request?";
  readonly tone: Extract<ApprovalDecisionTone, "attention" | "danger">;
  readonly sessionLabel: string;
  readonly action: string;
  readonly scope: string;
  readonly reason: string | null;
  readonly riskLabel: "Elevated" | "Broad";
  readonly grantLabel: "One time";
  readonly expiresAt: string | null;
  readonly confirmEnabled: boolean;
  readonly disabledReason: string | null;
}

export interface ApprovalDecisionView {
  readonly visible: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: ApprovalDecisionPhase;
  readonly tone: ApprovalDecisionTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly items: readonly ApprovalDecisionItemView[];
  readonly confirmation: ApprovalDecisionConfirmationView | null;
  readonly refreshEnabled: boolean;
  readonly busy: boolean;
}

export interface ApprovalDecisionController {
  readonly snapshot: () => ApprovalDecisionView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: ApprovalDecisionContext) => ApprovalDecisionView;
  readonly synchronize: () => Promise<ApprovalDecisionView>;
  readonly refresh: () => Promise<ApprovalDecisionView>;
  readonly lookupEvent: (requestId: string) => ApprovalDecisionItemView | null;
  readonly beginApprove: (handle: string) => ApprovalDecisionView;
  readonly cancelApprove: () => ApprovalDecisionView;
  readonly approve: (handle: string) => Promise<ApprovalDecisionView>;
  readonly deny: (handle: string) => Promise<ApprovalDecisionView>;
  readonly confirmApprove: () => Promise<ApprovalDecisionView>;
  readonly close: () => ApprovalDecisionView;
}

interface ApprovalAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly threadId: string | null;
  readonly readEnabled: boolean;
  readonly writeEnabled: boolean;
  readonly readReason: string | null;
  readonly writeReason: string | null;
}

interface ParsedApprovalContext {
  readonly snapshot: BrowserConnectionSnapshot;
  readonly events: readonly ApprovalEvent[];
  readonly eventFingerprint: string;
}

interface ApprovalRecord {
  readonly requestId: string;
  readonly baseline: PendingApproval | null;
  readonly baselineKey: string | null;
  readonly view: ApprovalDecisionItemView;
}

interface ApprovalAttempt {
  readonly handle: string;
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly baseline: PendingApproval;
  readonly baselineKey: string;
}

type ApprovalReadState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading"; reason: "initial" | "event" | "refresh" | "expiry" | "terminal" }>
  | Readonly<{ phase: "failure"; failure: ApprovalFailure }>;

type ApprovalMutationState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "submitting"; attempt: ApprovalAttempt; operationId: string }>
  | Readonly<{ phase: "result"; handle: string; decision: ApprovalDecision }>
  | Readonly<{ phase: "failure"; failure: ApprovalFailure; attempt: ApprovalAttempt | null }>;

interface ApprovalFailure {
  readonly source: "read" | "decision";
  readonly kind: "known" | "unsupported" | "unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly requiresRefresh: boolean;
}

interface ActiveRead {
  readonly sequence: number;
  readonly controller: AbortController;
  readonly promise: Promise<ApprovalDecisionView>;
}

interface ActiveMutation {
  readonly sequence: number;
  readonly controller: AbortController;
}

interface EventGroup {
  readonly requestId: string;
  readonly firstOrder: number;
  readonly latest: ApprovalEvent;
  readonly conflict: boolean;
}

interface ReconciliationInput {
  readonly sessionId: SessionId;
  readonly context: ParsedApprovalContext;
  readonly availability: ApprovalAvailability;
  readonly list: PendingApprovalListResponse | null;
  readonly listEpoch: number | null;
  readonly listEventFingerprint: string | null;
  readonly readState: ApprovalReadState;
  readonly mutationState: ApprovalMutationState;
  readonly confirmationHandle: string | null;
  readonly terminalOverrides: ReadonlyMap<string, PendingApproval>;
  readonly nowMs: number;
  readonly handleFor: (requestId: string) => string;
}

interface ReconciliationResult {
  readonly records: readonly ApprovalRecord[];
  readonly confirmation: ApprovalDecisionConfirmationView | null;
  readonly view: ApprovalDecisionView;
  readonly nextExpiryMs: number | null;
}

const maximumSubscribers = 32;
const maximumTerminalOverrides = 64;
const maximumTimerDelayMs = 2_147_000_000;
const terminalStates = new Set<PendingApproval["state"]>([
  "approved",
  "denied",
  "expired",
  "superseded"
]);
const unsupportedApiCodes = new Set<ApiErrorEnvelope["code"]>([
  "capability_unavailable",
  "incompatible_runtime"
]);
const ambiguousApiCodes = new Set<ApiErrorEnvelope["code"]>([
  "audit_unavailable",
  "internal_error",
  "operation_timeout",
  "protocol_error",
  "unknown_error"
]);

export function createApprovalDecisionController(
  options: CreateApprovalDecisionControllerOptions
): ApprovalDecisionController {
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context, sessionId);
  const port = parsePort(options.port);
  const createOperationId = parseOperationIdFactory(options.createOperationId);
  const clock = parseClock(options.clock);
  let list: PendingApprovalListResponse | null = null;
  let listEpoch: number | null = null;
  let listEventFingerprint: string | null = null;
  let readState: ApprovalReadState = idleRead();
  let mutationState: ApprovalMutationState = idleMutation();
  let confirmationHandle: string | null = null;
  let readSequence = 0;
  let mutationSequence = 0;
  let activeRead: ActiveRead | null = null;
  let activeMutation: ActiveMutation | null = null;
  let expiryTimer: unknown = null;
  let expiryTimerGeneration = 0;
  let nextHandle = 1;
  let closed = false;
  const handles = new Map<string, string>();
  const terminalOverrides = new Map<string, PendingApproval>();
  const subscribers = new Set<() => void>();
  let records: readonly ApprovalRecord[] = Object.freeze([]);
  let currentView: ApprovalDecisionView;

  const handleFor = (requestId: string): string => {
    const existing = handles.get(requestId);
    if (existing !== undefined) return existing;
    if (!Number.isSafeInteger(nextHandle)) {
      throw new TypeError("HostDeck approval handle capacity is exhausted.");
    }
    const handle = `approval-${nextHandle++}`;
    handles.set(requestId, handle);
    return handle;
  };

  const reconcile = (): ReconciliationResult =>
    reconcileApprovalState({
      sessionId,
      context,
      availability: deriveAvailability(context.snapshot, sessionId),
      list,
      listEpoch,
      listEventFingerprint,
      readState,
      mutationState,
      confirmationHandle,
      terminalOverrides,
      nowMs: readNow(clock),
      handleFor
    });

  const publish = (): ApprovalDecisionView => {
    const result = reconcile();
    records = result.records;
    const currentRequestIds = new Set(records.map((record) => record.requestId));
    for (const requestId of handles.keys()) {
      if (!currentRequestIds.has(requestId)) handles.delete(requestId);
    }
    currentView = result.view;
    scheduleExpiry(result.nextExpiryMs);
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const cancelExpiry = (): void => {
    expiryTimerGeneration += 1;
    if (expiryTimer !== null) {
      Reflect.apply(clock.clearTimeout, undefined, [expiryTimer]);
      expiryTimer = null;
    }
  };

  function scheduleExpiry(nextExpiryMs: number | null): void {
    cancelExpiry();
    if (closed || nextExpiryMs === null) return;
    const generation = expiryTimerGeneration;
    const delay = Math.min(maximumTimerDelayMs, Math.max(0, nextExpiryMs - readNow(clock)));
    expiryTimer = Reflect.apply(clock.setTimeout, undefined, [() => {
      if (closed || generation !== expiryTimerGeneration) return;
      expiryTimer = null;
      publish();
      void runRead("expiry", true);
    }, delay]);
  }

  const cancelRead = (): void => {
    readSequence += 1;
    activeRead?.controller.abort();
    activeRead = null;
  };

  const cancelMutation = (): void => {
    mutationSequence += 1;
    activeMutation?.controller.abort();
    activeMutation = null;
  };

  const clearPrivateState = (): void => {
    cancelRead();
    cancelMutation();
    cancelExpiry();
    list = null;
    listEpoch = null;
    listEventFingerprint = null;
    readState = idleRead();
    mutationState = idleMutation();
    confirmationHandle = null;
    terminalOverrides.clear();
    handles.clear();
    nextHandle = 1;
  };

  const installList = (candidate: unknown, requestEpoch: number, eventFingerprint: string): void => {
    const parsed = pendingApprovalListResponseSchema.parse(candidate);
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (
      parsed.target.session_id !== sessionId ||
      availability.threadId === null ||
      parsed.target.codex_thread_id !== availability.threadId
    ) {
      throw new TypeError("HostDeck approval list changed the selected target.");
    }
    list = deepFreeze(parsed);
    listEpoch = requestEpoch;
    listEventFingerprint = eventFingerprint;
  };

  const reconcileAttemptAfterRead = (): void => {
    if (mutationState.phase !== "failure" || list === null) {
      return;
    }
    if (mutationState.attempt === null) {
      mutationState = idleMutation();
      return;
    }
    const attempt = mutationState.attempt;
    const current = list.approvals.find(
      (approval) => approval.target.request_id === attempt.requestId
    );
    if (current === undefined || immutableApprovalKey(current) !== attempt.baselineKey) {
      mutationState = idleMutation();
      return;
    }
    if (current.state === "pending" && current.decision === null) {
      mutationState = idleMutation();
      return;
    }
    const expectedState = attempt.decision === "approve" ? "approved" : "denied";
    if (current.state === expectedState && current.decision === attempt.decision) {
      installTerminalOverride(terminalOverrides, attempt.requestId, current);
      mutationState = deepFreeze({
        phase: "result" as const,
        handle: attempt.handle,
        decision: attempt.decision
      });
      return;
    }
    if (current.state !== "responding") mutationState = idleMutation();
  };

  const runRead = (
    reason: "initial" | "event" | "refresh" | "expiry" | "terminal",
    replace: boolean
  ): Promise<ApprovalDecisionView> => {
    if (closed) return Promise.resolve(currentView);
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (!availability.readEnabled) return Promise.resolve(currentView);
    if (activeRead !== null && !replace) return activeRead.promise;
    cancelRead();
    const controller = new AbortController();
    const sequence = readSequence;
    const requestEpoch = context.snapshot.epoch;
    const eventFingerprint = context.eventFingerprint;
    readState = deepFreeze({ phase: "loading" as const, reason });
    publish();

    const promise = (async (): Promise<ApprovalDecisionView> => {
      try {
        const candidate = await Reflect.apply(port.read, undefined, [
          Object.freeze({ sessionId, signal: controller.signal })
        ]);
        if (
          closed ||
          sequence !== readSequence ||
          context.snapshot.epoch !== requestEpoch ||
          context.eventFingerprint !== eventFingerprint ||
          !deriveAvailability(context.snapshot, sessionId).readEnabled
        ) {
          return currentView;
        }
        installList(candidate, requestEpoch, eventFingerprint);
        readState = idleRead();
        reconcileAttemptAfterRead();
        return publish();
      } catch (error) {
        if (closed || sequence !== readSequence) return currentView;
        if (
          context.snapshot.epoch !== requestEpoch ||
          context.eventFingerprint !== eventFingerprint ||
          !deriveAvailability(context.snapshot, sessionId).readEnabled
        ) {
          return currentView;
        }
        readState = deepFreeze({ phase: "failure" as const, failure: classifyReadFailure(error) });
        return publish();
      } finally {
        if (activeRead?.sequence === sequence) activeRead = null;
      }
    })();
    activeRead = Object.freeze({ sequence, controller, promise });
    return promise;
  };

  const runDecision = async (
    handle: string,
    decision: ApprovalDecision,
    fromConfirmation: boolean
  ): Promise<ApprovalDecisionView> => {
    if (closed || activeMutation !== null || mutationState.phase === "submitting") {
      return currentView;
    }
    const record = recordForHandle(records, handle);
    if (
      record === null ||
      !record.view.actionable ||
      record.baseline === null ||
      record.baselineKey === null ||
      (decision === "approve" && record.view.approveRequiresConfirmation !== fromConfirmation) ||
      (confirmationHandle !== null && !fromConfirmation)
    ) {
      return currentView;
    }
    const attempt = deepFreeze({
      handle,
      requestId: record.requestId,
      decision,
      baseline: record.baseline,
      baselineKey: record.baselineKey
    });
    let operationId: string;
    let request: ApprovalResponseRequest;
    try {
      operationId = createOperationId();
      request = approvalResponseRequestSchema.parse({
        operation_id: operationId,
        kind: "approval_response",
        decision,
        confirm: true
      });
    } catch {
      confirmationHandle = null;
      mutationState = deepFreeze({
        phase: "failure" as const,
        failure: decisionFailure(
          "known",
          "Secure approval control is unavailable. Reload HostDeck.",
          false,
          true
        ),
        attempt
      });
      return publish();
    }

    cancelRead();
    const controller = new AbortController();
    const sequence = mutationSequence;
    const requestEpoch = context.snapshot.epoch;
    if (!fromConfirmation) confirmationHandle = null;
    mutationState = deepFreeze({ phase: "submitting" as const, attempt, operationId });
    activeMutation = Object.freeze({ sequence, controller });
    publish();

    try {
      const candidate = await Reflect.apply(port.respond, undefined, [
        Object.freeze({
          sessionId,
          requestId: attempt.requestId,
          request,
          signal: controller.signal
        })
      ]);
      if (
        closed ||
        sequence !== mutationSequence ||
        context.snapshot.epoch !== requestEpoch
      ) {
        return currentView;
      }
      const response = pendingApprovalResponseSchema.safeParse(candidate);
      if (
        !response.success ||
        !correlateResponse(response.data, operationId, attempt)
      ) {
        confirmationHandle = null;
        mutationState = deepFreeze({
          phase: "failure" as const,
          failure: unknownDecisionFailure(),
          attempt
        });
        return publish();
      }
      installTerminalOverride(terminalOverrides, attempt.requestId, response.data.approval);
      confirmationHandle = null;
      mutationState = deepFreeze({ phase: "result" as const, handle, decision });
      const result = publish();
      void runRead("terminal", true);
      return result;
    } catch (error) {
      if (closed || sequence !== mutationSequence) return currentView;
      confirmationHandle = null;
      mutationState = deepFreeze({
        phase: "failure" as const,
        failure: classifyDecisionFailure(error),
        attempt
      });
      return publish();
    } finally {
      if (activeMutation?.sequence === sequence) activeMutation = null;
    }
  };

  currentView = reconcile().view;
  publish();

  const controller: ApprovalDecisionController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck approval listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck approval listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(candidate: ApprovalDecisionContext): ApprovalDecisionView {
      if (closed) throw new TypeError("HostDeck approval controller is closed.");
      const previous = context;
      const previousAvailability = deriveAvailability(previous.snapshot, sessionId);
      context = parseContext(candidate, sessionId);
      const availability = deriveAvailability(context.snapshot, sessionId);
      const epochChanged = context.snapshot.epoch !== previous.snapshot.epoch;
      const eventChanged = context.eventFingerprint !== previous.eventFingerprint;

      if (!availability.visible) {
        clearPrivateState();
        return publish();
      }
      if (epochChanged) {
        const attempt = mutationState.phase === "submitting" ? mutationState.attempt : null;
        clearPrivateState();
        if (attempt !== null) {
          mutationState = deepFreeze({
            phase: "failure" as const,
            failure: unknownDecisionFailure(),
            attempt: null
          });
        }
        return publish();
      }
      if (eventChanged) {
        cancelRead();
        readState = idleRead();
      }
      if (
        mutationState.phase === "submitting" &&
        (previousAvailability.writeEnabled && !availability.writeEnabled)
      ) {
        const attempt = mutationState.attempt;
        cancelMutation();
        mutationState = deepFreeze({
          phase: "failure" as const,
          failure: unknownDecisionFailure(),
          attempt
        });
      }
      if (confirmationHandle !== null) {
        const result = reconcile();
        const record = recordForHandle(result.records, confirmationHandle);
        const submittingConfirmation =
          mutationState.phase === "submitting" &&
          mutationState.attempt.handle === confirmationHandle;
        if (
          record === null ||
          (!record.view.actionable && !submittingConfirmation) ||
          !record.view.approveRequiresConfirmation
        ) {
          confirmationHandle = null;
        }
      }
      return publish();
    },
    synchronize(): Promise<ApprovalDecisionView> {
      if (closed) return Promise.resolve(currentView);
      const availability = deriveAvailability(context.snapshot, sessionId);
      if (!availability.readEnabled || mutationState.phase === "submitting") {
        return Promise.resolve(currentView);
      }
      if (readState.phase === "failure") return Promise.resolve(currentView);
      if (
        list !== null &&
        listEpoch === context.snapshot.epoch &&
        listEventFingerprint === context.eventFingerprint
      ) {
        return Promise.resolve(currentView);
      }
      const reason = list === null ? "initial" : "event";
      return runRead(reason, false);
    },
    refresh(): Promise<ApprovalDecisionView> {
      if (closed || !currentView.refreshEnabled || mutationState.phase === "submitting") {
        return Promise.resolve(currentView);
      }
      return runRead("refresh", true);
    },
    lookupEvent(requestId: string): ApprovalDecisionItemView | null {
      const parsed = runtimeRequestIdSchema.safeParse(requestId);
      if (!parsed.success) return null;
      return records.find((record) => record.requestId === parsed.data)?.view ?? null;
    },
    beginApprove(handle: string): ApprovalDecisionView {
      if (closed || confirmationHandle !== null || typeof handle !== "string") return currentView;
      const record = recordForHandle(records, handle);
      if (
        record === null ||
        !record.view.approveEnabled ||
        !record.view.approveRequiresConfirmation
      ) {
        return currentView;
      }
      confirmationHandle = handle;
      mutationState = clearKnownFailure(mutationState);
      return publish();
    },
    cancelApprove(): ApprovalDecisionView {
      if (closed || confirmationHandle === null || mutationState.phase === "submitting") {
        return currentView;
      }
      confirmationHandle = null;
      return publish();
    },
    approve(handle: string): Promise<ApprovalDecisionView> {
      return runDecision(handle, "approve", false);
    },
    deny(handle: string): Promise<ApprovalDecisionView> {
      return runDecision(handle, "deny", false);
    },
    confirmApprove(): Promise<ApprovalDecisionView> {
      if (confirmationHandle === null) return Promise.resolve(currentView);
      return runDecision(confirmationHandle, "approve", true);
    },
    close(): ApprovalDecisionView {
      if (closed) return currentView;
      closed = true;
      clearPrivateState();
      context = deepFreeze({
        ...context,
        events: Object.freeze([]),
        eventFingerprint: "closed"
      });
      currentView = hiddenView(sessionId);
      records = Object.freeze([]);
      subscribers.clear();
      return currentView;
    }
  });

  return controller;
}

function reconcileApprovalState(input: ReconciliationInput): ReconciliationResult {
  if (!input.availability.visible) {
    return deepFreeze({
      records: [],
      confirmation: null,
      view: hiddenView(input.sessionId),
      nextExpiryMs: null
    });
  }

  const eventGroups = groupEvents(input.context.events);
  const listEntries = new Map<string, PendingApproval>();
  for (const approval of input.list?.approvals ?? []) {
    listEntries.set(approval.target.request_id, approval);
  }
  const requestIds = new Set<string>([
    ...eventGroups.keys(),
    ...listEntries.keys(),
    ...input.terminalOverrides.keys()
  ]);
  const ordered = [...requestIds].sort((left, right) =>
    compareApprovalIdentity(left, right, eventGroups, listEntries, input.terminalOverrides)
  );
  const listFresh =
    input.list !== null &&
    input.listEpoch === input.context.snapshot.epoch &&
    input.listEventFingerprint === input.context.eventFingerprint &&
    input.readState.phase === "idle";
  const records: ApprovalRecord[] = [];
  let nextExpiryMs: number | null = null;

  for (const requestId of ordered) {
    const eventGroup = eventGroups.get(requestId) ?? null;
    const listEntry = listEntries.get(requestId) ?? null;
    const terminalOverride = input.terminalOverrides.get(requestId) ?? null;
    const baseline = listEntry?.state === "pending" ? listEntry : null;
    const commonConflict =
      eventGroup?.conflict === true ||
      (eventGroup !== null && listEntry !== null && !sameSharedApproval(eventGroup.latest, listEntry)) ||
      (eventGroup !== null && terminalOverride !== null && !sameSharedApproval(eventGroup.latest, terminalOverride)) ||
      (listEntry !== null && terminalOverride !== null && !sameImmutableApproval(listEntry, terminalOverride)) ||
      terminalTruthConflict(eventGroup?.latest ?? null, listEntry, terminalOverride);
    const source = eventGroup !== null && (listEntry !== null || terminalOverride !== null)
      ? "event_and_list" as const
      : eventGroup !== null
        ? "event_only" as const
        : "list_only" as const;
    const display = listEntry ?? terminalOverride ?? eventGroup?.latest;
    if (display === undefined) continue;
    const effective = effectiveApprovalState(eventGroup?.latest ?? null, listEntry, terminalOverride, commonConflict);
    const expiresAt = display.expires_at;
    const expiryMs = expiresAt === null ? null : Date.parse(expiresAt);
    const due =
      effective.state === "pending" &&
      expiryMs !== null &&
      Number.isFinite(expiryMs) &&
      expiryMs <= input.nowMs;
    if (
      effective.state === "pending" &&
      expiryMs !== null &&
      Number.isFinite(expiryMs) &&
      expiryMs > input.nowMs
    ) {
      nextExpiryMs = nextExpiryMs === null ? expiryMs : Math.min(nextExpiryMs, expiryMs);
    }
    const handle = input.handleFor(requestId);
    const state: ApprovalDecisionItemState = commonConflict
      ? "conflict"
      : due
        ? "due"
        : effective.state === "pending" && listEntry === null && terminalOverride === null
          ? "event_only"
          : effective.state;
    const disabledReason = decisionDisabledReason({
      availability: input.availability,
      listFresh,
      source,
      state,
      grantScope: "grant_scope" in display ? display.grant_scope : null,
      readState: input.readState,
      mutationState: input.mutationState,
      handle
    });
    const actionable = disabledReason === null;
    const risk = display.risk;
    const grantScope = "grant_scope" in display ? display.grant_scope : null;
    const decision = effective.decision;
    const submitting =
      input.mutationState.phase === "submitting" &&
      input.mutationState.attempt.handle === handle;
    const view = deepFreeze({
      handle,
      eventOrder: eventGroup?.firstOrder ?? null,
      source,
      action: display.action,
      scope: display.scope,
      reason: display.reason,
      risk,
      riskLabel: riskLabel(risk),
      grantScope,
      grantLabel: grantLabel(grantScope),
      state,
      stateLabel: approvalStateLabel(state),
      tone: approvalTone(state, risk),
      createdAt: "created_at" in display ? display.created_at : null,
      expiresAt,
      decision,
      pending: state === "pending" || state === "event_only" || state === "due" || state === "responding",
      submitting,
      actionable,
      approveEnabled: actionable,
      denyEnabled: actionable,
      approveLabel: risk === "normal" ? "Approve once" as const : "Review & approve" as const,
      approveRequiresConfirmation: risk !== "normal",
      disabledReason,
      statusDetail: approvalStatusDetail(state, grantScope, input.readState, input.mutationState, handle)
    });
    records.push(deepFreeze({
      requestId,
      baseline,
      baselineKey: baseline === null ? null : immutableApprovalKey(baseline),
      view
    }));
  }

  const confirmationRecord = input.confirmationHandle === null
    ? null
    : recordForHandle(records, input.confirmationHandle);
  const confirmationSubmitting =
    input.mutationState.phase === "submitting" &&
    input.mutationState.attempt.handle === input.confirmationHandle;
  const confirmation = confirmationRecord === null ||
      (!confirmationRecord.view.actionable && !confirmationSubmitting) ||
      !confirmationRecord.view.approveRequiresConfirmation ||
      confirmationRecord.view.grantScope !== "one_time"
    ? null
    : confirmationView(
        confirmationRecord.view,
        input.availability.targetLabel ?? "Selected session",
        confirmationSubmitting
      );
  const status = globalStatus(input, records, confirmation);
  const view = deepFreeze({
    visible: true,
    sessionId: input.sessionId,
    targetLabel: input.availability.targetLabel,
    phase: status.phase,
    tone: status.tone,
    status: status.label,
    statusDetail: status.detail,
    items: records.map((record) => record.view),
    confirmation,
    refreshEnabled:
      input.availability.readEnabled &&
      input.mutationState.phase !== "submitting" &&
      input.readState.phase !== "loading",
    busy: input.readState.phase === "loading" || input.mutationState.phase === "submitting"
  });
  return deepFreeze({ records, confirmation, view, nextExpiryMs });
}

function groupEvents(events: readonly ApprovalEvent[]): Map<string, EventGroup> {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const existing = groups.get(event.request_id);
    if (existing === undefined) {
      groups.set(event.request_id, Object.freeze({
        requestId: event.request_id,
        firstOrder: event.cursor,
        latest: event,
        conflict: false
      }));
      continue;
    }
    const conflict =
      existing.conflict ||
      !sameSharedApproval(existing.latest, event) ||
      invalidEventTransition(existing.latest, event);
    groups.set(event.request_id, Object.freeze({
      requestId: event.request_id,
      firstOrder: existing.firstOrder,
      latest: event,
      conflict
    }));
  }
  return groups;
}

function invalidEventTransition(previous: ApprovalEvent, next: ApprovalEvent): boolean {
  if (terminalStates.has(previous.state)) {
    return next.state !== previous.state || next.decision !== previous.decision;
  }
  return false;
}

function effectiveApprovalState(
  event: ApprovalEvent | null,
  list: PendingApproval | null,
  override: PendingApproval | null,
  conflict: boolean
): Readonly<{ state: PendingApproval["state"]; decision: ApprovalDecision | null }> {
  if (conflict) return Object.freeze({ state: "superseded", decision: null });
  const terminals = [override, list, event].filter(
    (candidate): candidate is PendingApproval | ApprovalEvent =>
      candidate !== null && terminalStates.has(candidate.state)
  );
  if (terminals.length > 0) {
    const first = terminals[0];
    if (first === undefined) throw new TypeError("HostDeck approval terminal state is invalid.");
    return Object.freeze({ state: first.state, decision: first.decision });
  }
  if (list?.state === "responding") return Object.freeze({ state: "responding", decision: null });
  if (override?.state === "responding") return Object.freeze({ state: "responding", decision: null });
  return Object.freeze({ state: "pending", decision: null });
}

function compareApprovalIdentity(
  left: string,
  right: string,
  events: ReadonlyMap<string, EventGroup>,
  list: ReadonlyMap<string, PendingApproval>,
  overrides: ReadonlyMap<string, PendingApproval>
): number {
  const leftEvent = events.get(left);
  const rightEvent = events.get(right);
  if (leftEvent !== undefined || rightEvent !== undefined) {
    if (leftEvent === undefined) return 1;
    if (rightEvent === undefined) return -1;
    return leftEvent.firstOrder - rightEvent.firstOrder;
  }
  const leftCreated = list.get(left)?.created_at ?? overrides.get(left)?.created_at ?? "";
  const rightCreated = list.get(right)?.created_at ?? overrides.get(right)?.created_at ?? "";
  return leftCreated.localeCompare(rightCreated) || left.localeCompare(right);
}

function decisionDisabledReason(input: Readonly<{
  availability: ApprovalAvailability;
  listFresh: boolean;
  source: ApprovalDecisionItemView["source"];
  state: ApprovalDecisionItemState;
  grantScope: ApprovalGrantScope | null;
  readState: ApprovalReadState;
  mutationState: ApprovalMutationState;
  handle: string;
}>): string | null {
  if (input.state === "conflict") return "Approval details conflict. Check current status.";
  if (input.state === "event_only") return "Current approval status has not been verified.";
  if (input.state === "due") return "The expiry time was reached. Check current status.";
  if (input.state === "responding") return "A decision is already being confirmed.";
  if (input.state === "approved") return "This request was approved.";
  if (input.state === "denied") return "This request was denied.";
  if (input.state === "expired") return "This request expired without a user decision.";
  if (input.state === "superseded") return "This request is no longer current.";
  if (input.grantScope === "session") return "Ongoing policy grants are not supported in HostDeck V1.";
  if (input.grantScope !== "one_time") return "The one-time grant has not been verified.";
  if (input.source === "event_only" || !input.listFresh) return "Check current approval status before deciding.";
  if (input.readState.phase === "loading") return "Current approval status is loading.";
  if (input.mutationState.phase === "submitting") {
    return input.mutationState.attempt.handle === input.handle
      ? "This decision is being confirmed."
      : "Another approval decision is being confirmed.";
  }
  if (input.mutationState.phase === "failure" && input.mutationState.failure.requiresRefresh) {
    return "Check current approval status before another decision.";
  }
  return input.availability.writeEnabled ? null : input.availability.writeReason;
}

function globalStatus(
  input: ReconciliationInput,
  records: readonly ApprovalRecord[],
  confirmation: ApprovalDecisionConfirmationView | null
): Readonly<{
  phase: ApprovalDecisionPhase;
  tone: ApprovalDecisionTone;
  label: string;
  detail: string | null;
}> {
  if (input.mutationState.phase === "submitting") {
    return status("submitting", "attention", "Confirming decision", "HostDeck sent one decision and is waiting for the confirmed approval result.");
  }
  if (confirmation !== null) {
    return status("confirming", confirmation.tone, "Approval confirmation open", "No response is sent until Approve once is submitted.");
  }
  if (input.mutationState.phase === "failure") {
    const failure = input.mutationState.failure;
    return status(
      failure.kind === "unknown" ? "outcome_unknown" : failure.kind === "unsupported" ? "unsupported" : "decision_failed",
      failure.kind === "known" ? "attention" : "danger",
      failure.kind === "unknown" ? "Decision outcome unknown" : failure.kind === "unsupported" ? "Approval unsupported" : "Decision not sent",
      failure.message
    );
  }
  if (input.mutationState.phase === "result") {
    const approved = input.mutationState.decision === "approve";
    const readDetail = input.readState.phase === "failure"
      ? "The decision is confirmed, but the current approval list could not be refreshed."
      : "The decision was confirmed and recorded.";
    return status(approved ? "approved" : "denied", approved ? "connected" : "danger", approved ? "Approved once" : "Denied", readDetail);
  }
  if (input.readState.phase === "loading" && input.list === null) {
    return status("loading", "attention", "Loading approvals", "Checking current laptop approval state.");
  }
  if (input.readState.phase === "failure") {
    const failure = input.readState.failure;
    return status(
      failure.kind === "unsupported" ? "unsupported" : "read_failed",
      failure.kind === "unsupported" ? "muted" : "danger",
      failure.kind === "unsupported" ? "Approvals unsupported" : "Approval status unavailable",
      failure.message
    );
  }
  if (records.length === 0) {
    return status("empty", "muted", "No current approvals", "No current approval requests are visible for this session.");
  }
  const actionable = records.filter((record) => record.view.actionable).length;
  const detail = input.readState.phase === "loading"
    ? "Refreshing current approval status. Decisions are temporarily disabled."
    : actionable > 0
      ? `${actionable} ${actionable === 1 ? "request requires" : "requests require"} a decision.`
      : input.availability.writeReason ?? "Approval history is read-only.";
  return status("ready", actionable > 0 ? "attention" : "muted", actionable > 0 ? "Approval required" : "Approvals read only", detail);
}

function confirmationView(
  item: ApprovalDecisionItemView,
  sessionLabel: string,
  submitting: boolean
): ApprovalDecisionConfirmationView {
  if (item.risk === "normal" || item.grantScope !== "one_time") {
    throw new TypeError("HostDeck approval confirmation target is invalid.");
  }
  return deepFreeze({
    handle: item.handle,
    title: item.risk === "broad" ? "Approve broad request?" as const : "Approve elevated request?" as const,
    tone: item.risk === "broad" ? "danger" as const : "attention" as const,
    sessionLabel,
    action: item.action,
    scope: item.scope,
    reason: item.reason,
    riskLabel: item.riskLabel as "Elevated" | "Broad",
    grantLabel: "One time" as const,
    expiresAt: item.expiresAt,
    confirmEnabled: item.actionable && !submitting,
    disabledReason: submitting ? "Waiting for the confirmed decision." : item.disabledReason
  });
}

function approvalStatusDetail(
  state: ApprovalDecisionItemState,
  grantScope: ApprovalGrantScope | null,
  readState: ApprovalReadState,
  mutationState: ApprovalMutationState,
  handle: string
): string {
  if (mutationState.phase === "submitting" && mutationState.attempt.handle === handle) {
    return "Decision sent; waiting for the confirmed result.";
  }
  if (state === "pending") {
    if (readState.phase === "loading") return "Current status is being refreshed.";
    return grantScope === "one_time"
      ? "One decision is required before this work can continue."
      : "This request cannot be answered through the selected one-time V1 flow.";
  }
  if (state === "event_only") return "The timeline request is retained, but current approval state is not verified.";
  if (state === "due") return readState.phase === "loading"
    ? "The expiry time was reached; server status is being checked."
    : "The expiry time was reached; check current server status.";
  if (state === "responding") return "A response may already have been sent. HostDeck will not send another.";
  if (state === "approved") return "The selected request was approved once.";
  if (state === "denied") return "The selected request was denied.";
  if (state === "expired") return "The request expired without a recorded user decision.";
  if (state === "superseded") return "The request ended without a recorded user decision.";
  return "Timeline and current approval details disagree. Refresh before continuing.";
}

function approvalStateLabel(state: ApprovalDecisionItemState): string {
  switch (state) {
    case "pending": return "Pending";
    case "responding": return "Responding";
    case "approved": return "Approved";
    case "denied": return "Denied";
    case "expired": return "Expired";
    case "superseded": return "Superseded";
    case "event_only": return "Checking";
    case "due": return "Expiry reached";
    case "conflict": return "Conflict";
  }
}

function approvalTone(state: ApprovalDecisionItemState, risk: ApprovalRisk): ApprovalDecisionTone {
  if (state === "approved") return "connected";
  if (state === "denied" || state === "conflict") return "danger";
  if (state === "pending" || state === "responding" || state === "due") {
    return risk === "broad" ? "danger" : "attention";
  }
  return "muted";
}

function riskLabel(risk: ApprovalRisk): "Normal" | "Elevated" | "Broad" {
  return risk === "normal" ? "Normal" : risk === "elevated" ? "Elevated" : "Broad";
}

function grantLabel(scope: ApprovalGrantScope | null): "One time" | "Ongoing policy" | "Unverified" {
  return scope === "one_time" ? "One time" : scope === "session" ? "Ongoing policy" : "Unverified";
}

function deriveAvailability(snapshot: BrowserConnectionSnapshot, sessionId: SessionId): ApprovalAvailability {
  const data = snapshot.targetState.data;
  const detail =
    snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    data?.kind === "session_detail" &&
    data.response.session.session.id === sessionId
      ? data.response.session.session
      : null;
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return deepFreeze({
      visible: false,
      targetLabel: null,
      threadId: null,
      readEnabled: false,
      writeEnabled: false,
      readReason: "Session details are not available.",
      writeReason: "Session details are not available."
    });
  }
  const readEnabled = snapshot.access.state === "current" && snapshot.targetState.state === "current";
  const readReason = readEnabled
    ? null
    : "Session access is not current. Refresh Session Detail.";
  const writeCause = snapshot.writeEligibility.causes[0];
  let writeReason = snapshot.writeEligibility.eligible && writeCause === undefined
    ? null
    : writeDisabledReason(writeCause ?? "connection_not_current");
  if (detail.session_state === "archived" || detail.archived_at !== null) {
    writeReason = "Archived sessions cannot answer approvals.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    writeReason = "Session state is stale. Refresh before answering approvals.";
  } else if (snapshot.stream.state === "idle" || snapshot.stream.state === "connecting") {
    writeReason = "Wait for current session activity before answering approvals.";
  } else if (snapshot.stream.state === "reconnecting") {
    writeReason = "Session activity is reconnecting.";
  } else if (snapshot.stream.state !== "connected") {
    writeReason = "Live session activity is unavailable.";
  } else if (
    snapshot.stream.continuity !== "contiguous" &&
    snapshot.stream.continuity !== "boundary"
  ) {
    writeReason = "Session activity continuity is not proven yet.";
  }
  return deepFreeze({
    visible: true,
    targetLabel: detail.name,
    threadId: detail.codex_thread_id,
    readEnabled,
    writeEnabled: readEnabled && writeReason === null,
    readReason,
    writeReason
  });
}

function writeDisabledReason(cause: BrowserConnectionWriteBlockCause): string {
  switch (cause) {
    case "connection_not_current":
      return "Connection state is not current. Refresh before answering approvals.";
    case "unpaired":
    case "invalid_device":
    case "expired_device":
    case "revoked_device":
    case "permission_denied":
      return "Pair this phone again to answer approvals.";
    case "read_only_access":
      return "Read-only access cannot answer approvals.";
    case "host_lock_pending":
    case "host_lock_unconfirmed":
    case "host_locked":
      return hostLockWriteReason(cause);
    case "host_status_unavailable":
    case "host_not_ready":
      return "Laptop write services are not ready.";
    case "csrf_not_ready":
      return "Secure write setup is not ready.";
  }
}

function correlateResponse(
  response: ReturnType<typeof pendingApprovalResponseSchema.parse>,
  operationId: string,
  attempt: ApprovalAttempt
): boolean {
  return response.operation_id === operationId &&
    response.requested_decision === attempt.decision &&
    response.approval.target.session_id === attempt.baseline.target.session_id &&
    response.approval.target.codex_thread_id === attempt.baseline.target.codex_thread_id &&
    response.approval.target.request_id === attempt.requestId &&
    sameImmutableApproval(response.approval, attempt.baseline) &&
    response.approval.state === (attempt.decision === "approve" ? "approved" : "denied") &&
    response.approval.decision === attempt.decision;
}

function sameSharedApproval(left: ApprovalEvent, right: ApprovalEvent | PendingApproval): boolean {
  const rightRequestId = "target" in right ? right.target.request_id : right.request_id;
  return left.request_id === rightRequestId &&
    left.action === right.action &&
    left.scope === right.scope &&
    left.reason === right.reason &&
    left.risk === right.risk &&
    left.expires_at === right.expires_at;
}

function sameImmutableApproval(left: PendingApproval, right: PendingApproval): boolean {
  return left.target.session_id === right.target.session_id &&
    left.target.codex_thread_id === right.target.codex_thread_id &&
    left.target.request_id === right.target.request_id &&
    left.action === right.action &&
    left.scope === right.scope &&
    left.reason === right.reason &&
    left.risk === right.risk &&
    left.grant_scope === right.grant_scope &&
    left.created_at === right.created_at &&
    left.expires_at === right.expires_at;
}

function terminalTruthConflict(
  event: ApprovalEvent | null,
  list: PendingApproval | null,
  override: PendingApproval | null
): boolean {
  const terminal = [event, list, override].filter(
    (candidate): candidate is ApprovalEvent | PendingApproval =>
      candidate !== null && terminalStates.has(candidate.state)
  );
  const first = terminal[0];
  return first !== undefined && terminal.some(
    (candidate) => candidate.state !== first.state || candidate.decision !== first.decision
  );
}

function installTerminalOverride(
  overrides: Map<string, PendingApproval>,
  requestId: string,
  approval: PendingApproval
): void {
  overrides.delete(requestId);
  overrides.set(requestId, deepFreeze(approval));
  while (overrides.size > maximumTerminalOverrides) {
    const oldest = overrides.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    overrides.delete(oldest);
  }
}

function immutableApprovalKey(approval: PendingApproval): string {
  return JSON.stringify([
    approval.target.session_id,
    approval.target.codex_thread_id,
    approval.target.request_id,
    approval.action,
    approval.scope,
    approval.reason,
    approval.risk,
    approval.grant_scope,
    approval.created_at,
    approval.expires_at
  ]);
}

function classifyReadFailure(error: unknown): ApprovalFailure {
  if (error instanceof HostDeckBrowserHttpError && error.apiError !== null) {
    const unsupported = unsupportedApiCodes.has(error.apiError.code);
    return deepFreeze({
      source: "read" as const,
      kind: unsupported ? "unsupported" as const : "known" as const,
      message: apiFailureMessage(error.apiError, "read"),
      retryable: !unsupported && error.apiError.retryable,
      requiresRefresh: false
    });
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return deepFreeze({
      source: "read" as const,
      kind: "known" as const,
      message: error.reason === "closed"
        ? "HostDeck closed before approvals could be loaded. Reload to continue."
        : "Session access is not current. Refresh Session Detail.",
      retryable: false,
      requiresRefresh: true
    });
  }
  return deepFreeze({
    source: "read" as const,
    kind: "known" as const,
    message: "Current approval status could not be loaded. Check the connection and try again.",
    retryable: true,
    requiresRefresh: false
  });
}

function classifyDecisionFailure(error: unknown): ApprovalFailure {
  if (error instanceof HostDeckBrowserConnectionError) {
    return decisionFailure("known", "Approval access is not current. Check current status.", false, true);
  }
  if (error instanceof HostDeckBrowserCsrfError) {
    if (error.apiError !== null) {
      if (ambiguousApiCodes.has(error.apiError.code) ||
          (error.apiError.code === "operation_conflict" && !error.apiError.retryable)) {
        return unknownDecisionFailure();
      }
      const unsupported = unsupportedApiCodes.has(error.apiError.code);
      return decisionFailure(
        unsupported ? "unsupported" : "known",
        apiFailureMessage(error.apiError, "decision"),
        false,
        true
      );
    }
    if (["client_contract", "not_ready", "bootstrap_unavailable"].includes(error.reason)) {
      return decisionFailure("known", "Secure approval access is not ready. Check current status.", false, true);
    }
  }
  return unknownDecisionFailure();
}

function decisionFailure(
  kind: ApprovalFailure["kind"],
  message: string,
  retryable: boolean,
  requiresRefresh: boolean
): ApprovalFailure {
  return deepFreeze({ source: "decision" as const, kind, message, retryable, requiresRefresh });
}

function unknownDecisionFailure(): ApprovalFailure {
  return decisionFailure(
    "unknown",
    "Check current approval status before another decision. HostDeck will not retry automatically.",
    false,
    true
  );
}

function apiFailureMessage(error: ApiErrorEnvelope, operation: "read" | "decision"): string {
  switch (error.code) {
    case "session_not_found": return "This session no longer exists.";
    case "session_not_writable": return "This session cannot answer approvals now.";
    case "stale_session": return "Session state changed. Check current approval status.";
    case "approval_not_pending": return "This approval is no longer pending. Check current status.";
    case "host_locked": return hostLockWriteReason("host_locked");
    case "permission_denied":
    case "read_only": return operation === "read"
      ? "This phone cannot read approvals."
      : "This phone has read-only approval access.";
    case "runtime_unavailable": return "The Codex runtime is unavailable. Check the laptop and refresh.";
    case "incompatible_runtime":
    case "capability_unavailable": return "The installed Codex runtime does not support approval controls.";
    case "operation_conflict": return "Another decision won or approval state changed. Check current status.";
    case "operation_timeout": return "HostDeck could not prove the approval outcome.";
    case "rate_limited": return "Approval requests are temporarily rate limited.";
    case "service_overloaded": return "HostDeck is temporarily too busy for this approval.";
    case "audit_unavailable": return "HostDeck could not prove the audited approval outcome.";
    case "invalid_origin":
    case "insecure_transport": return "Secure approval access was rejected.";
    case "validation_error": return "Approval state changed. Check current status.";
    default: return operation === "read"
      ? "HostDeck could not read current approvals."
      : "HostDeck could not verify the approval decision.";
  }
}

function parseContext(candidate: unknown, sessionId: SessionId): ParsedApprovalContext {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 2 ||
    !("snapshot" in candidate) ||
    !("events" in candidate) ||
    candidate.snapshot === null ||
    typeof candidate.snapshot !== "object" ||
    Array.isArray(candidate.snapshot) ||
    !Array.isArray(candidate.events) ||
    candidate.events.length > selectedEventPageMaxSize
  ) {
    throw new TypeError("HostDeck approval context is invalid.");
  }
  const events: ApprovalEvent[] = [];
  let previousCursor = -1;
  for (const value of candidate.events) {
    const parsed = approvalProjectionEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.session_id !== sessionId || parsed.data.cursor <= previousCursor) {
      throw new TypeError("HostDeck approval event context is invalid.");
    }
    previousCursor = parsed.data.cursor;
    events.push(deepFreeze(parsed.data));
  }
  const frozenEvents = Object.freeze(events);
  return deepFreeze({
    snapshot: candidate.snapshot as BrowserConnectionSnapshot,
    events: frozenEvents,
    eventFingerprint: JSON.stringify(frozenEvents)
  });
}

function parsePort(candidate: unknown): ApprovalDecisionPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 2 ||
    !("read" in candidate) ||
    typeof candidate.read !== "function" ||
    !("respond" in candidate) ||
    typeof candidate.respond !== "function"
  ) {
    throw new TypeError("HostDeck approval port is invalid.");
  }
  return Object.freeze({
    read: candidate.read as ApprovalDecisionPort["read"],
    respond: candidate.respond as ApprovalDecisionPort["respond"]
  });
}

function parseClock(candidate: ApprovalDecisionClockPort | undefined): ApprovalDecisionClockPort {
  if (candidate === undefined) {
    return Object.freeze({
      now: Date.now,
      setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });
  }
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 3 ||
    typeof candidate.now !== "function" ||
    typeof candidate.setTimeout !== "function" ||
    typeof candidate.clearTimeout !== "function"
  ) {
    throw new TypeError("HostDeck approval clock is invalid.");
  }
  return Object.freeze(candidate);
}

function parseOperationIdFactory(candidate: unknown): () => string {
  if (typeof candidate !== "function") {
    throw new TypeError("HostDeck approval operation-id factory is invalid.");
  }
  return candidate as () => string;
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function readNow(clock: ApprovalDecisionClockPort): number {
  const value = Reflect.apply(clock.now, undefined, []) as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("HostDeck approval clock returned invalid time.");
  }
  return value;
}

function recordForHandle(records: readonly ApprovalRecord[], handle: string): ApprovalRecord | null {
  return records.find((record) => record.view.handle === handle) ?? null;
}

function clearKnownFailure(state: ApprovalMutationState): ApprovalMutationState {
  return state.phase === "failure" && state.failure.kind === "known" && !state.failure.requiresRefresh
    ? idleMutation()
    : state;
}

function idleRead(): ApprovalReadState {
  return Object.freeze({ phase: "idle" as const });
}

function idleMutation(): ApprovalMutationState {
  return Object.freeze({ phase: "idle" as const });
}

function status(
  phase: ApprovalDecisionPhase,
  tone: ApprovalDecisionTone,
  label: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, label, detail });
}

function hiddenView(sessionId: SessionId): ApprovalDecisionView {
  return deepFreeze({
    visible: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Approvals unavailable",
    statusDetail: null,
    items: [],
    confirmation: null,
    refreshEnabled: false,
    busy: false
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (value instanceof Map || value instanceof Set) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
