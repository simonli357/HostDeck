import {
  type ApiErrorEnvelope,
  sessionIdSchema,
  type UsageRateLimitWindow,
  type UsageSnapshot,
  type UsageTokenBreakdown,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  type BrowserConnectionSnapshot,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

export const usageControlPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "content",
  "empty",
  "stale",
  "unsupported",
  "failure"
] as const);

export type UsageControlPhase = (typeof usageControlPhases)[number];
export type UsageControlTone = "connected" | "attention" | "danger" | "focus" | "muted";
type UsageReachedType = Extract<
  UsageSnapshot["rate_limits"],
  { readonly state: "observed" }
>["reached_type"];

export interface UsageControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface UsageControlReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface UsageControlPort {
  readonly read: (input: UsageControlReadInput) => Promise<unknown>;
}

export interface CreateUsageControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: UsageControlContext;
  readonly port: UsageControlPort;
}

export interface UsageMetricView {
  readonly label: string;
  readonly value: string;
  readonly displayValue: string;
  readonly reported: boolean;
}

export interface UsageCaptureView {
  readonly measuredAt: string;
  readonly runtimeVersion: string;
  readonly freshness: "current" | "stale";
}

export interface UsageDailyBucketView {
  readonly date: string;
  readonly tokens: string;
}

export interface UsageDailyHistoryView {
  readonly state: "not_reported" | "empty" | "content";
  readonly buckets: readonly UsageDailyBucketView[];
  readonly omittedCount: number;
}

export interface UsageAccountView {
  readonly metrics: readonly UsageMetricView[];
  readonly dailyHistory: UsageDailyHistoryView;
}

export interface UsageTokenBreakdownView {
  readonly total: string;
  readonly totalExact: string;
  readonly input: string;
  readonly inputExact: string;
  readonly cachedInput: string;
  readonly cachedInputExact: string;
  readonly output: string;
  readonly outputExact: string;
  readonly reasoningOutput: string;
  readonly reasoningOutputExact: string;
}

export type UsageThreadView =
  | Readonly<{ state: "not_observed" }>
  | Readonly<{
      state: "observed";
      observedAt: string;
      total: UsageTokenBreakdownView;
      last: UsageTokenBreakdownView;
      contextWindow: UsageMetricView;
    }>;

export interface UsageRateWindowView {
  readonly usedPercent: string;
  readonly duration: string;
  readonly resetsAt: string | null;
}

export type UsageRateLimitsView =
  | Readonly<{ state: "not_observed" }>
  | Readonly<{
      state: "observed";
      observedAt: string;
      primary: UsageRateWindowView | null;
      secondary: UsageRateWindowView | null;
      reachedLabel: string | null;
    }>;

export interface UsageControlView {
  readonly visible: boolean;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly sheetOpen: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: UsageControlPhase;
  readonly tone: UsageControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly busy: boolean;
  readonly refreshEnabled: boolean;
  readonly capture: UsageCaptureView | null;
  readonly account: UsageAccountView | null;
  readonly thread: UsageThreadView | null;
  readonly rateLimits: UsageRateLimitsView | null;
}

export interface UsageControlController {
  readonly snapshot: () => UsageControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: UsageControlContext) => UsageControlView;
  readonly open: () => Promise<UsageControlView>;
  readonly refresh: () => Promise<UsageControlView>;
  readonly dismiss: () => UsageControlView;
  readonly close: () => UsageControlView;
}

type UsageControlOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "failure"; failure: UsageControlFailure }>;

interface UsageControlFailure {
  readonly kind: "unsupported" | "failure";
  readonly message: string;
}

interface UsageControlAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly authorityKey: string | null;
  readonly readEnabled: boolean;
  readonly readReason: string | null;
}

interface UsageControlProjectionInput {
  readonly sessionId: SessionId;
  readonly context: UsageControlContext;
  readonly open: boolean;
  readonly data: UsageSnapshot | null;
  readonly captureEpoch: number | null;
  readonly captureAuthorityKey: string | null;
  readonly operation: UsageControlOperation;
}

const maximumSubscribers = 32;
const visibleDailyBucketLimit = 7;
const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compactIntegerFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1
});

export function projectUsageControl(input: UsageControlProjectionInput): UsageControlView {
  const sessionId = parseSessionId(input.sessionId);
  const context = parseContext(input.context);
  const availability = deriveAvailability(context.snapshot, sessionId);
  const sheetOpen = input.open && availability.visible;
  const data = input.data === null ? null : freezeSnapshot(input.data, context.snapshot, sessionId);
  const authorizedCapture =
    data !== null &&
    input.captureAuthorityKey !== null &&
    availability.authorityKey === input.captureAuthorityKey;
  const stale =
    authorizedCapture &&
    (input.captureEpoch !== context.snapshot.epoch ||
      !availability.readEnabled ||
      input.operation.phase !== "idle");
  const status = deriveStatus(input.operation, data, sheetOpen, availability, stale);
  const projectedData = authorizedCapture && data !== null ? projectSnapshot(data, stale) : null;

  return deepFreeze({
    visible: availability.visible,
    actionEnabled: availability.readEnabled,
    actionDisabledReason: availability.readReason,
    sheetOpen,
    sessionId,
    targetLabel: availability.targetLabel,
    phase: status.phase,
    tone: status.tone,
    status: status.label,
    statusDetail: status.detail,
    busy: input.operation.phase === "loading",
    refreshEnabled:
      sheetOpen &&
      availability.readEnabled &&
      input.operation.phase !== "loading" &&
      !(input.operation.phase === "failure" && input.operation.failure.kind === "unsupported"),
    capture: projectedData?.capture ?? null,
    account: projectedData?.account ?? null,
    thread: projectedData?.thread ?? null,
    rateLimits: projectedData?.rateLimits ?? null
  });
}

export function createUsageControlController(
  options: CreateUsageControlControllerOptions
): UsageControlController {
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  let sheetOpen = false;
  let data: UsageSnapshot | null = null;
  let captureEpoch: number | null = null;
  let captureAuthorityKey: string | null = null;
  let operation: UsageControlOperation = idleOperation();
  let sequence = 0;
  let activeRequest: Readonly<{ sequence: number; controller: AbortController }> | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): UsageControlView {
    return projectUsageControl({
      sessionId,
      context,
      open: sheetOpen,
      data,
      captureEpoch,
      captureAuthorityKey,
      operation
    });
  }

  const publish = (): UsageControlView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const cancelActive = (): void => {
    sequence += 1;
    activeRequest?.controller.abort();
    activeRequest = null;
  };

  const clearCapture = (): void => {
    data = null;
    captureEpoch = null;
    captureAuthorityKey = null;
  };

  const runRead = async (): Promise<UsageControlView> => {
    if (closed || !sheetOpen || !currentView.actionEnabled || activeRequest !== null) {
      return currentView;
    }
    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRequest = Object.freeze({ sequence: requestSequence, controller: requestController });
    operation = loadingOperation();
    publish();
    try {
      const candidate = await Reflect.apply(port.read, undefined, [
        Object.freeze({ sessionId, signal: requestController.signal })
      ]);
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      const availability = deriveAvailability(context.snapshot, sessionId);
      if (!availability.readEnabled || availability.authorityKey === null) {
        operation = failureOperation(
          "failure",
          "Session access changed before usage could be confirmed. Refresh Session Detail."
        );
        clearCapture();
        return publish();
      }
      data = freezeSnapshot(candidate, context.snapshot, sessionId);
      captureEpoch = context.snapshot.epoch;
      captureAuthorityKey = availability.authorityKey;
      operation = idleOperation();
      return publish();
    } catch (error) {
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      operation = failureFromError(error);
      if (data === null) clearCapture();
      return publish();
    } finally {
      if (activeRequest?.sequence === requestSequence) activeRequest = null;
    }
  };

  const controller: UsageControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck usage-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck usage-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: UsageControlContext): UsageControlView {
      if (closed) throw new TypeError("HostDeck usage control is closed.");
      const previousEpoch = context.snapshot.epoch;
      context = parseContext(nextContext);
      const availability = deriveAvailability(context.snapshot, sessionId);
      const authorityReplaced =
        captureAuthorityKey !== null && availability.authorityKey !== captureAuthorityKey;
      const targetReplaced =
        data !== null && !matchesCaptureTarget(data, context.snapshot, sessionId);
      if (!availability.visible || authorityReplaced || targetReplaced) {
        cancelActive();
        sheetOpen = false;
        clearCapture();
        operation = idleOperation();
      } else if (
        activeRequest !== null &&
        (context.snapshot.epoch !== previousEpoch || !availability.readEnabled)
      ) {
        cancelActive();
        operation =
          data === null
            ? failureOperation(
                "failure",
                "Session state changed before usage could be loaded. Refresh Session Detail."
              )
            : idleOperation();
      }
      return publish();
    },
    async open(): Promise<UsageControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) return currentView;
      sheetOpen = true;
      clearCapture();
      operation = idleOperation();
      publish();
      return runRead();
    },
    refresh(): Promise<UsageControlView> {
      if (closed || !sheetOpen || !currentView.refreshEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    dismiss(): UsageControlView {
      if (closed || !sheetOpen) return currentView;
      cancelActive();
      sheetOpen = false;
      clearCapture();
      operation = idleOperation();
      return publish();
    },
    close(): UsageControlView {
      if (closed) return currentView;
      closed = true;
      cancelActive();
      sheetOpen = false;
      clearCapture();
      operation = idleOperation();
      subscribers.clear();
      currentView = hiddenView(sessionId);
      return currentView;
    }
  });

  return controller;
}

function deriveAvailability(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): UsageControlAvailability {
  const detail = matchingSession(snapshot, sessionId);
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return availability(false, null, null, false, "Session details are not available.");
  }
  const authorityKey = readAuthorityKey(snapshot);
  const currentConnection =
    snapshot.access.state === "current" &&
    snapshot.targetState.state === "current" &&
    authorityKey !== null;
  let readReason: string | null = null;
  if (detail.archived_at !== null || detail.session_state === "archived") {
    readReason = "Archived sessions do not have current usage data.";
  } else if (detail.freshness !== "current") {
    readReason = "Session state is stale. Refresh Session Detail before loading usage.";
  } else if (!currentConnection) {
    readReason = "Connection state is not current. Refresh Session Detail before loading usage.";
  }
  return availability(
    true,
    detail.name,
    authorityKey,
    readReason === null,
    readReason
  );
}

function deriveStatus(
  operation: UsageControlOperation,
  data: UsageSnapshot | null,
  sheetOpen: boolean,
  availabilityValue: UsageControlAvailability,
  stale: boolean
): Readonly<{
  phase: UsageControlPhase;
  tone: UsageControlTone;
  label: string;
  detail: string | null;
}> {
  if (!availabilityValue.visible) {
    return status("hidden", "muted", "Usage unavailable", null);
  }
  if (!sheetOpen) {
    return status(
      "closed",
      availabilityValue.readEnabled ? "focus" : "attention",
      "Usage closed",
      availabilityValue.readReason
    );
  }
  if (operation.phase === "loading") {
    return data === null
      ? status("loading", "attention", "Loading usage", "Reading current usage data.")
      : status("stale", "attention", "Refreshing usage", "The previous capture remains visible as stale until this read succeeds.");
  }
  if (operation.phase === "failure") {
    return operation.failure.kind === "unsupported"
      ? status("unsupported", "attention", "Usage unavailable", operation.failure.message)
      : status(
          "failure",
          "danger",
          data === null ? "Usage could not be loaded" : "Usage refresh failed",
          data === null
            ? operation.failure.message
            : `${operation.failure.message} The previous capture remains stale.`
        );
  }
  if (data === null) {
    return status("loading", "muted", "Usage data unavailable", "Open this utility again to load current usage.");
  }
  if (stale) {
    return status("stale", "attention", "Usage capture is stale", "Refresh to read current account, thread, and rate-limit observations.");
  }
  if (isEmptySnapshot(data)) {
    return status("empty", "muted", "No usage observations reported", "The runtime returned no account summary, daily history, thread, or rate-limit observation.");
  }
  return status("content", "connected", "Usage capture current", "Account, thread, and rate-limit scopes remain separate.");
}

function projectSnapshot(
  data: UsageSnapshot,
  stale: boolean
): Readonly<{
  capture: UsageCaptureView;
  account: UsageAccountView;
  thread: UsageThreadView;
  rateLimits: UsageRateLimitsView;
}> {
  return deepFreeze({
    capture: {
      measuredAt: data.measured_at,
      runtimeVersion: data.runtime_version,
      freshness: stale ? "stale" : "current"
    },
    account: projectAccount(data),
    thread: projectThread(data),
    rateLimits: projectRateLimits(data)
  });
}

function projectAccount(data: UsageSnapshot): UsageAccountView {
  const summary = data.account.summary;
  const daily = data.account.daily_buckets;
  const visibleBuckets = daily === null ? [] : daily.slice(-visibleDailyBucketLimit);
  return deepFreeze({
    metrics: [
      metric("Lifetime tokens", summary.lifetime_tokens),
      metric("Peak daily tokens", summary.peak_daily_tokens),
      metric("Longest running turn", summary.longest_running_turn_seconds, " sec"),
      metric(
        "Current streak",
        summary.current_streak_days,
        summary.current_streak_days === 1 ? " day" : " days"
      ),
      metric(
        "Longest streak",
        summary.longest_streak_days,
        summary.longest_streak_days === 1 ? " day" : " days"
      )
    ],
    dailyHistory: {
      state: daily === null ? "not_reported" : daily.length === 0 ? "empty" : "content",
      buckets: visibleBuckets.map((bucket) =>
        Object.freeze({ date: bucket.start_date, tokens: formatInteger(bucket.tokens) })
      ),
      omittedCount: daily === null ? 0 : Math.max(0, daily.length - visibleBuckets.length)
    }
  });
}

function projectThread(data: UsageSnapshot): UsageThreadView {
  if (data.thread.state === "not_observed") {
    return Object.freeze({ state: "not_observed" as const });
  }
  return deepFreeze({
    state: "observed" as const,
    observedAt: data.thread.observed_at,
    total: projectBreakdown(data.thread.total),
    last: projectBreakdown(data.thread.last),
    contextWindow: metric("Context capacity", data.thread.model_context_window)
  });
}

function projectBreakdown(value: UsageTokenBreakdown): UsageTokenBreakdownView {
  return Object.freeze({
    total: formatCompactInteger(value.total_tokens),
    totalExact: formatInteger(value.total_tokens),
    input: formatCompactInteger(value.input_tokens),
    inputExact: formatInteger(value.input_tokens),
    cachedInput: formatCompactInteger(value.cached_input_tokens),
    cachedInputExact: formatInteger(value.cached_input_tokens),
    output: formatCompactInteger(value.output_tokens),
    outputExact: formatInteger(value.output_tokens),
    reasoningOutput: formatCompactInteger(value.reasoning_output_tokens),
    reasoningOutputExact: formatInteger(value.reasoning_output_tokens)
  });
}

function projectRateLimits(data: UsageSnapshot): UsageRateLimitsView {
  if (data.rate_limits.state === "not_observed") {
    return Object.freeze({ state: "not_observed" as const });
  }
  return deepFreeze({
    state: "observed" as const,
    observedAt: data.rate_limits.observed_at,
    primary: projectRateWindow(data.rate_limits.primary),
    secondary: projectRateWindow(data.rate_limits.secondary),
    reachedLabel: reachedLabel(data.rate_limits.reached_type)
  });
}

function projectRateWindow(value: UsageRateLimitWindow | null): UsageRateWindowView | null {
  if (value === null) return null;
  return Object.freeze({
    usedPercent: `${String(value.used_percent)}%`,
    duration:
      value.window_duration_minutes === null
        ? "Not reported"
        : `${formatInteger(value.window_duration_minutes)} min`,
    resetsAt: value.resets_at
  });
}

function reachedLabel(value: UsageReachedType): string | null {
  switch (value) {
    case null:
      return null;
    case "rate_limit_reached":
      return "Rate limit reached";
    case "workspace_owner_credits_depleted":
      return "Workspace owner credits depleted";
    case "workspace_member_credits_depleted":
      return "Workspace member credits depleted";
    case "workspace_owner_usage_limit_reached":
      return "Workspace owner usage limit reached";
    case "workspace_member_usage_limit_reached":
      return "Workspace member usage limit reached";
    default:
      throw new TypeError("HostDeck usage reached state is invalid.");
  }
}

function isEmptySnapshot(data: UsageSnapshot): boolean {
  const summary = data.account.summary;
  return (
    Object.values(summary).every((value) => value === null) &&
    data.account.daily_buckets === null &&
    data.thread.state === "not_observed" &&
    data.rate_limits.state === "not_observed"
  );
}

function freezeSnapshot(
  candidate: unknown,
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): UsageSnapshot {
  const parsed = usageSnapshotSchema.parse(candidate);
  if (!matchesCaptureTarget(parsed, snapshot, sessionId)) {
    throw new TypeError("HostDeck usage response target is invalid.");
  }
  return deepFreeze(parsed);
}

function matchesCaptureTarget(
  data: UsageSnapshot,
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): boolean {
  const detail = matchingSession(snapshot, sessionId);
  return (
    detail !== null &&
    data.target.session_id === sessionId &&
    data.target.codex_thread_id === detail.codex_thread_id &&
    data.runtime_version === detail.runtime_version
  );
}

function matchingSession(snapshot: BrowserConnectionSnapshot, sessionId: SessionId) {
  const data = snapshot.targetState.data;
  return snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    data?.kind === "session_detail" &&
    data.response.session.session.id === sessionId
    ? data.response.session.session
    : null;
}

function readAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  const access = snapshot.access.data;
  if (access === null || access.can_read_sessions !== true) return null;
  if (access.authentication_state === "paired_device") {
    if (access.device_id === null || (access.permission !== "read" && access.permission !== "write")) {
      return null;
    }
    return JSON.stringify([
      "paired_device",
      access.configured_origin,
      access.device_id
    ]);
  }
  if (access.authentication_state === "local_admin") {
    return JSON.stringify(["local_admin", access.configured_origin]);
  }
  if (
    access.authentication_state === "unpaired" &&
    access.network_mode === "loopback"
  ) {
    return JSON.stringify(["unpaired_loopback", access.configured_origin]);
  }
  return null;
}

function failureFromError(error: unknown): UsageControlOperation {
  if (error instanceof HostDeckBrowserHttpError && error.apiError !== null) {
    const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(
      error.apiError.code
    );
    return failureOperation(
      unsupported ? "unsupported" : "failure",
      usageApiFailureMessage(error.apiError)
    );
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return failureOperation(
      "failure",
      error.reason === "closed"
        ? "HostDeck closed before usage could be loaded. Reload to continue."
        : "Session access is not current. Refresh Session Detail before trying again."
    );
  }
  return failureOperation(
    "failure",
    "Usage data could not be loaded. Check the connection and try again."
  );
}

function usageApiFailureMessage(error: ApiErrorEnvelope): string {
  switch (error.code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
      return "Archived sessions do not have current usage data.";
    case "stale_session":
    case "invalid_session_id":
      return "Session state changed. Refresh Session Detail before trying again.";
    case "permission_denied":
    case "read_only":
      return "This phone cannot read usage for this session.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable. Check the laptop and try again.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The installed Codex runtime does not support usage controls.";
    case "operation_timeout":
      return "The usage read timed out before HostDeck received a complete snapshot.";
    case "rate_limited":
      return "Usage reads are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy to read usage.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure usage access was rejected.";
    case "protocol_error":
    case "storage_error":
    case "internal_error":
      return "HostDeck could not verify complete usage data.";
    default:
      return "HostDeck could not read usage data.";
  }
}

function metric(label: string, value: number | null, suffix = ""): UsageMetricView {
  const exactValue = value === null ? "Not reported" : `${formatInteger(value)}${suffix}`;
  return Object.freeze({
    label,
    value: exactValue,
    displayValue:
      value === null ? exactValue : `${formatCompactInteger(value)}${suffix}`,
    reported: value !== null
  });
}

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatCompactInteger(value: number): string {
  return value < 1_000_000 ? formatInteger(value) : compactIntegerFormatter.format(value);
}

function availability(
  visible: boolean,
  targetLabel: string | null,
  authorityKey: string | null,
  readEnabled: boolean,
  readReason: string | null
): UsageControlAvailability {
  return Object.freeze({ visible, targetLabel, authorityKey, readEnabled, readReason });
}

function status(
  phase: UsageControlPhase,
  tone: UsageControlTone,
  label: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, label, detail });
}

function idleOperation(): UsageControlOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): UsageControlOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(
  kind: UsageControlFailure["kind"],
  message: string
): UsageControlOperation {
  return deepFreeze({ phase: "failure" as const, failure: { kind, message } });
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseContext(candidate: unknown): UsageControlContext {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 1 ||
    !("snapshot" in candidate) ||
    candidate.snapshot === null ||
    typeof candidate.snapshot !== "object" ||
    Array.isArray(candidate.snapshot)
  ) {
    throw new TypeError("HostDeck usage-control context is invalid.");
  }
  return Object.freeze({ snapshot: candidate.snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): UsageControlPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Reflect.ownKeys(candidate).length !== 1 ||
    !("read" in candidate) ||
    typeof candidate.read !== "function"
  ) {
    throw new TypeError("HostDeck usage-control port is invalid.");
  }
  return Object.freeze({ read: candidate.read as UsageControlPort["read"] });
}

function hiddenView(sessionId: SessionId): UsageControlView {
  return deepFreeze({
    visible: false,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    sheetOpen: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Usage unavailable",
    statusDetail: null,
    busy: false,
    refreshEnabled: false,
    capture: null,
    account: null,
    thread: null,
    rateLimits: null
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
