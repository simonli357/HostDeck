import {
  type ApiErrorEnvelope,
  type SkillsSnapshot,
  sessionIdSchema,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  type BrowserConnectionSnapshot,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

export const skillsControlPhases = Object.freeze([
  "hidden",
  "closed",
  "loading",
  "content",
  "empty",
  "partial",
  "error",
  "stale",
  "unsupported",
  "failure"
] as const);

export type SkillsControlPhase = (typeof skillsControlPhases)[number];
export type SkillsControlTone = "connected" | "attention" | "danger" | "focus" | "muted";

export interface SkillsControlContext {
  readonly snapshot: BrowserConnectionSnapshot;
}

export interface SkillsControlReadInput {
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
}

export interface SkillsControlPort {
  readonly read: (input: SkillsControlReadInput) => Promise<unknown>;
}

export interface CreateSkillsControlControllerOptions {
  readonly sessionId: SessionId;
  readonly context: SkillsControlContext;
  readonly port: SkillsControlPort;
}

export interface SkillsCaptureView {
  readonly observedAt: string;
  readonly runtimeVersion: string;
  readonly freshness: "current" | "stale";
}

export interface SkillItemView {
  readonly name: string;
  readonly description: string | null;
  readonly descriptionState: "not_reported" | "empty" | "content";
  readonly scope: "user" | "repo" | "system" | "admin";
  readonly scopeLabel: "User" | "Project" | "System" | "Admin";
  readonly enabled: boolean;
}

export interface SkillsSummaryView {
  readonly total: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly errorCount: number;
}

export interface SkillsControlView {
  readonly visible: boolean;
  readonly actionEnabled: boolean;
  readonly actionDisabledReason: string | null;
  readonly sheetOpen: boolean;
  readonly sessionId: SessionId;
  readonly targetLabel: string | null;
  readonly phase: SkillsControlPhase;
  readonly tone: SkillsControlTone;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly busy: boolean;
  readonly refreshEnabled: boolean;
  readonly captureRevision: number | null;
  readonly capture: SkillsCaptureView | null;
  readonly snapshotState: SkillsSnapshot["state"] | null;
  readonly summary: SkillsSummaryView | null;
  readonly skills: readonly SkillItemView[] | null;
}

export interface SkillsControlController {
  readonly snapshot: () => SkillsControlView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: SkillsControlContext) => SkillsControlView;
  readonly open: () => Promise<SkillsControlView>;
  readonly refresh: () => Promise<SkillsControlView>;
  readonly dismiss: () => SkillsControlView;
  readonly close: () => SkillsControlView;
}

type SkillsControlOperation =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "failure"; failure: SkillsControlFailure }>;

interface SkillsControlFailure {
  readonly kind: "unsupported" | "failure";
  readonly message: string;
}

interface SkillsControlAvailability {
  readonly visible: boolean;
  readonly targetLabel: string | null;
  readonly targetKey: string | null;
  readonly authorityKey: string | null;
  readonly readEnabled: boolean;
  readonly readReason: string | null;
}

interface ActiveRead {
  readonly sequence: number;
  readonly targetKey: string;
  readonly authorityKey: string;
  readonly controller: AbortController;
}

const maximumSubscribers = 32;

export function createSkillsControlController(
  candidateOptions: CreateSkillsControlControllerOptions
): SkillsControlController {
  const options = parseCreateOptions(candidateOptions);
  const sessionId = parseSessionId(options.sessionId);
  let context = parseContext(options.context);
  const port = parsePort(options.port);
  let sheetOpen = false;
  let data: SkillsSnapshot | null = null;
  let captureRevision = 0;
  let installedCaptureRevision: number | null = null;
  let captureEpoch: number | null = null;
  let captureAuthorityKey: string | null = null;
  let captureTargetKey: string | null = null;
  let operation: SkillsControlOperation = idleOperation();
  let sequence = 0;
  let activeRead: ActiveRead | null = null;
  let closed = false;
  const subscribers = new Set<() => void>();
  let currentView = project();

  function project(): SkillsControlView {
    const availability = deriveAvailability(context.snapshot, sessionId);
    const authorizedCapture =
      data !== null &&
      captureAuthorityKey !== null &&
      captureTargetKey !== null &&
      availability.authorityKey === captureAuthorityKey &&
      availability.targetKey === captureTargetKey;
    const stale =
      authorizedCapture &&
      (captureEpoch !== context.snapshot.epoch ||
        !availability.readEnabled ||
        operation.phase !== "idle");
    const projectedData = authorizedCapture ? data : null;
    const statusValue = deriveStatus({
      availability,
      data: projectedData,
      operation,
      sheetOpen: sheetOpen && availability.visible,
      stale
    });
    const projectedSnapshot = projectedData === null
      ? null
      : projectSnapshot(projectedData, stale);
    const unsupported =
      operation.phase === "failure" && operation.failure.kind === "unsupported";

    return deepFreeze({
      visible: availability.visible,
      actionEnabled: availability.readEnabled,
      actionDisabledReason: availability.readReason,
      sheetOpen: sheetOpen && availability.visible,
      sessionId,
      targetLabel: availability.targetLabel,
      phase: statusValue.phase,
      tone: statusValue.tone,
      status: statusValue.label,
      statusDetail: statusValue.detail,
      busy: operation.phase === "loading",
      refreshEnabled:
        sheetOpen &&
        availability.readEnabled &&
        operation.phase !== "loading" &&
        !unsupported,
      captureRevision: authorizedCapture ? installedCaptureRevision : null,
      capture: projectedSnapshot?.capture ?? null,
      snapshotState: projectedSnapshot?.state ?? null,
      summary: projectedSnapshot?.summary ?? null,
      skills: projectedSnapshot?.skills ?? null
    });
  }

  const publish = (): SkillsControlView => {
    currentView = project();
    for (const listener of [...subscribers]) {
      if (subscribers.has(listener)) listener();
    }
    return currentView;
  };

  const cancelActive = (): void => {
    sequence += 1;
    activeRead?.controller.abort();
    activeRead = null;
  };

  const clearCapture = (): void => {
    data = null;
    installedCaptureRevision = null;
    captureEpoch = null;
    captureAuthorityKey = null;
    captureTargetKey = null;
  };

  const installCapture = (candidate: unknown): void => {
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (
      !availability.readEnabled ||
      availability.authorityKey === null ||
      availability.targetKey === null
    ) {
      throw new HostDeckBrowserConnectionError("not_ready");
    }
    const nextData = freezeSnapshot(candidate, context.snapshot, sessionId);
    const nextCaptureRevision = captureRevision + 1;
    if (!Number.isSafeInteger(nextCaptureRevision)) {
      throw new TypeError("HostDeck Skills capture revision is exhausted.");
    }
    data = nextData;
    captureRevision = nextCaptureRevision;
    installedCaptureRevision = nextCaptureRevision;
    captureEpoch = context.snapshot.epoch;
    captureAuthorityKey = availability.authorityKey;
    captureTargetKey = availability.targetKey;
  };

  const runRead = async (): Promise<SkillsControlView> => {
    if (closed || !sheetOpen || !currentView.actionEnabled || activeRead !== null) {
      return currentView;
    }
    const availability = deriveAvailability(context.snapshot, sessionId);
    if (availability.targetKey === null || availability.authorityKey === null) {
      return currentView;
    }
    cancelActive();
    const requestController = new AbortController();
    const requestSequence = sequence;
    activeRead = Object.freeze({
      sequence: requestSequence,
      targetKey: availability.targetKey,
      authorityKey: availability.authorityKey,
      controller: requestController
    });
    operation = loadingOperation();
    publish();
    try {
      const response = await Reflect.apply(port.read, undefined, [
        Object.freeze({ sessionId, signal: requestController.signal })
      ]);
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      installCapture(response);
      operation = idleOperation();
      return publish();
    } catch (error) {
      if (closed || requestSequence !== sequence || !sheetOpen) return currentView;
      operation = failureOperation(classifyReadFailure(error));
      if (data === null) clearCapture();
      return publish();
    } finally {
      if (activeRead?.sequence === requestSequence) activeRead = null;
    }
  };

  const controller: SkillsControlController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== "function" || subscribers.has(listener)) {
        throw new TypeError("HostDeck skills-control listener is invalid.");
      }
      if (subscribers.size >= maximumSubscribers) {
        throw new TypeError("HostDeck skills-control listener capacity is exhausted.");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    updateContext(nextContext: SkillsControlContext): SkillsControlView {
      if (closed) throw new TypeError("HostDeck skills control is closed.");
      const previousEpoch = context.snapshot.epoch;
      context = parseContext(nextContext);
      const availability = deriveAvailability(context.snapshot, sessionId);
      const authorityReplaced =
        (captureAuthorityKey !== null && availability.authorityKey !== captureAuthorityKey) ||
        (activeRead !== null && availability.authorityKey !== activeRead.authorityKey);
      const targetReplaced =
        (captureTargetKey !== null && availability.targetKey !== captureTargetKey) ||
        (activeRead !== null && availability.targetKey !== activeRead.targetKey);
      if (!availability.visible || authorityReplaced || targetReplaced) {
        cancelActive();
        sheetOpen = false;
        clearCapture();
        operation = idleOperation();
        return publish();
      }
      if (
        activeRead !== null &&
        (context.snapshot.epoch !== previousEpoch || !availability.readEnabled)
      ) {
        cancelActive();
        operation = data === null
          ? failureOperation({
              kind: "failure",
              message: "Session state changed before Skills could be loaded. Refresh Session Detail."
            })
          : idleOperation();
      }
      return publish();
    },
    async open(): Promise<SkillsControlView> {
      if (closed || sheetOpen || !currentView.actionEnabled) return currentView;
      sheetOpen = true;
      clearCapture();
      operation = idleOperation();
      publish();
      return runRead();
    },
    refresh(): Promise<SkillsControlView> {
      if (closed || !sheetOpen || !currentView.refreshEnabled) {
        return Promise.resolve(currentView);
      }
      return runRead();
    },
    dismiss(): SkillsControlView {
      if (closed || !sheetOpen) return currentView;
      cancelActive();
      sheetOpen = false;
      clearCapture();
      operation = idleOperation();
      return publish();
    },
    close(): SkillsControlView {
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
): SkillsControlAvailability {
  const detail = matchingSession(snapshot, sessionId);
  const visible =
    detail !== null &&
    snapshot.access.data?.can_read_sessions === true &&
    snapshot.access.state !== "blocked" &&
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed";
  if (!visible || detail === null) {
    return availability(
      false,
      null,
      null,
      null,
      false,
      "Session details are not available."
    );
  }
  const authorityKey = readAuthorityKey(snapshot);
  const targetKey = skillsTargetKey(detail);
  const currentConnection =
    snapshot.access.state === "current" &&
    snapshot.targetState.state === "current" &&
    authorityKey !== null;
  let readReason: string | null = null;
  if (detail.archived_at !== null || detail.session_state === "archived") {
    readReason = "Archived sessions do not have current structured Skills.";
  } else if (detail.session_state !== "active" || detail.freshness !== "current") {
    readReason = "Session state is stale. Refresh Session Detail before loading Skills.";
  } else if (!currentConnection) {
    readReason = "Connection state is not current. Refresh Session Detail before loading Skills.";
  }
  return availability(
    true,
    detail.name,
    targetKey,
    authorityKey,
    readReason === null,
    readReason
  );
}

function deriveStatus(input: Readonly<{
  availability: SkillsControlAvailability;
  data: SkillsSnapshot | null;
  operation: SkillsControlOperation;
  sheetOpen: boolean;
  stale: boolean;
}>): Readonly<{
  phase: SkillsControlPhase;
  tone: SkillsControlTone;
  label: string;
  detail: string | null;
}> {
  if (!input.availability.visible) {
    return status("hidden", "muted", "Skills unavailable", null);
  }
  if (!input.sheetOpen) {
    return status(
      "closed",
      input.availability.readEnabled ? "focus" : "attention",
      "Skills closed",
      input.availability.readReason
    );
  }
  if (input.operation.phase === "loading") {
    return input.data === null
      ? status("loading", "attention", "Loading Skills", "Reading one current structured snapshot.")
      : status("stale", "attention", "Refreshing Skills", "The previous capture remains stale until this read succeeds.");
  }
  if (input.operation.phase === "failure") {
    return input.operation.failure.kind === "unsupported"
      ? status("unsupported", "attention", "Structured Skills unsupported", input.operation.failure.message)
      : status(
          "failure",
          "danger",
          input.data === null ? "Skills could not be loaded" : "Skills refresh failed",
          input.operation.failure.message
        );
  }
  if (input.data === null) {
    return status("loading", "muted", "Skills unavailable", "Open this utility again to load current state.");
  }
  if (input.stale) {
    return status("stale", "attention", "Skills capture stale", "Refresh to verify the selected session's current Skills data.");
  }
  switch (input.data.state) {
    case "content":
      return status(
        "content",
        "connected",
        "Skills capture current",
        `${input.data.skills.length} structured ${input.data.skills.length === 1 ? "skill" : "skills"} reported.`
      );
    case "empty":
      return status("empty", "muted", "No skills reported", "The current structured snapshot contains no skills or reported errors.");
    case "partial":
      return status(
        "partial",
        "attention",
        "Skills capture partial",
        reportedErrorDetail(input.data.error_count, false)
      );
    case "error":
      return status(
        "error",
        "danger",
        "Skills snapshot reported errors",
        reportedErrorDetail(input.data.error_count, true)
      );
  }
}

function reportedErrorDetail(count: number, noReadableSkills: boolean): string {
  const reported = `${count} skill-loading ${count === 1 ? "error was" : "errors were"} reported`;
  return noReadableSkills
    ? `${reported}; no readable skills were returned.`
    : `${reported} without private details.`;
}

function projectSnapshot(
  snapshot: SkillsSnapshot,
  stale: boolean
): Readonly<{
  capture: SkillsCaptureView;
  state: SkillsSnapshot["state"];
  summary: SkillsSummaryView;
  skills: readonly SkillItemView[];
}> {
  const skills = snapshot.skills.map(projectSkill);
  const enabled = snapshot.skills.reduce(
    (count, skill) => count + (skill.enabled ? 1 : 0),
    0
  );
  return deepFreeze({
    capture: {
      observedAt: snapshot.observed_at,
      runtimeVersion: snapshot.runtime_version,
      freshness: stale ? "stale" as const : "current" as const
    },
    state: snapshot.state,
    summary: {
      total: snapshot.skills.length,
      enabled,
      disabled: snapshot.skills.length - enabled,
      errorCount: snapshot.error_count
    },
    skills
  });
}

function projectSkill(skill: SkillsSnapshot["skills"][number]): SkillItemView {
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    descriptionState: skill.description === null
      ? "not_reported" as const
      : skill.description.length === 0
        ? "empty" as const
        : "content" as const,
    scope: skill.scope,
    scopeLabel: scopeLabel(skill.scope),
    enabled: skill.enabled
  });
}

function scopeLabel(scope: SkillItemView["scope"]): SkillItemView["scopeLabel"] {
  switch (scope) {
    case "user":
      return "User";
    case "repo":
      return "Project";
    case "system":
      return "System";
    case "admin":
      return "Admin";
  }
}

function freezeSnapshot(
  candidate: unknown,
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): SkillsSnapshot {
  const parsed = skillsSnapshotSchema.parse(candidate);
  const detail = matchingSession(snapshot, sessionId);
  if (
    detail === null ||
    parsed.target.session_id !== sessionId ||
    parsed.target.codex_thread_id !== detail.codex_thread_id ||
    parsed.runtime_version !== detail.runtime_version
  ) {
    throw new TypeError("HostDeck Skills response target is invalid.");
  }
  return deepFreeze(parsed);
}

function classifyReadFailure(error: unknown): SkillsControlFailure {
  const apiError = error instanceof HostDeckBrowserHttpError ? error.apiError : null;
  if (apiError !== null) {
    const unsupported = ["capability_unavailable", "incompatible_runtime"].includes(apiError.code);
    return deepFreeze({
      kind: unsupported ? "unsupported" as const : "failure" as const,
      message: skillsReadFailureMessage(apiError)
    });
  }
  if (error instanceof HostDeckBrowserConnectionError) {
    return deepFreeze({
      kind: "failure" as const,
      message: error.reason === "closed"
        ? "HostDeck closed before Skills could be loaded. Reload to continue."
        : "Session authority is not current. Refresh Session Detail before trying again."
    });
  }
  return deepFreeze({
    kind: "failure" as const,
    message: "Structured Skills could not be loaded. Check the connection and try again."
  });
}

function skillsReadFailureMessage(error: ApiErrorEnvelope): string {
  switch (error.code) {
    case "session_not_found":
      return "This session no longer exists.";
    case "session_not_writable":
    case "stale_session":
    case "invalid_session_id":
      return "Session state changed. Refresh Session Detail before trying again.";
    case "permission_denied":
    case "read_only":
      return "This phone cannot read Skills for this session.";
    case "runtime_unavailable":
      return "The Codex runtime is unavailable. Check the laptop and try again.";
    case "incompatible_runtime":
    case "capability_unavailable":
      return "The installed Codex runtime does not support structured Skills.";
    case "operation_timeout":
      return "The Skills read timed out.";
    case "rate_limited":
      return "Skills reads are temporarily rate limited.";
    case "service_overloaded":
      return "HostDeck is temporarily too busy to read Skills.";
    case "protocol_error":
      return "Structured Skills data failed validation.";
    case "invalid_origin":
    case "insecure_transport":
      return "Secure Skills access was rejected.";
    default:
      return "HostDeck could not verify structured Skills data.";
  }
}

function matchingSession(snapshot: BrowserConnectionSnapshot, sessionId: SessionId) {
  const targetData = snapshot.targetState.data;
  return snapshot.target?.kind === "session_detail" &&
    snapshot.target.sessionId === sessionId &&
    targetData?.kind === "session_detail" &&
    targetData.response.session.session.id === sessionId
    ? targetData.response.session.session
    : null;
}

function skillsTargetKey(detail: NonNullable<ReturnType<typeof matchingSession>>): string {
  return JSON.stringify([
    detail.id,
    detail.codex_thread_id,
    detail.runtime_source,
    detail.runtime_version,
    detail.created_at
  ]);
}

function readAuthorityKey(snapshot: BrowserConnectionSnapshot): string | null {
  const access = snapshot.access.data;
  if (access === null || access.can_read_sessions !== true) return null;
  if (access.authentication_state === "paired_device") {
    if (
      access.device_id === null ||
      (access.permission !== "read" && access.permission !== "write")
    ) {
      return null;
    }
    return JSON.stringify(["paired_device", access.configured_origin, access.device_id]);
  }
  if (access.authentication_state === "local_admin") {
    return JSON.stringify(["local_admin", access.configured_origin]);
  }
  if (access.authentication_state === "unpaired" && access.network_mode === "loopback") {
    return JSON.stringify(["unpaired_loopback", access.configured_origin]);
  }
  return null;
}

function availability(
  visible: boolean,
  targetLabel: string | null,
  targetKey: string | null,
  authorityKey: string | null,
  readEnabled: boolean,
  readReason: string | null
): SkillsControlAvailability {
  return Object.freeze({
    visible,
    targetLabel,
    targetKey,
    authorityKey,
    readEnabled,
    readReason
  });
}

function status(
  phase: SkillsControlPhase,
  tone: SkillsControlTone,
  label: string,
  detail: string | null
) {
  return Object.freeze({ phase, tone, label, detail });
}

function idleOperation(): SkillsControlOperation {
  return Object.freeze({ phase: "idle" as const });
}

function loadingOperation(): SkillsControlOperation {
  return Object.freeze({ phase: "loading" as const });
}

function failureOperation(failure: SkillsControlFailure): SkillsControlOperation {
  return deepFreeze({ phase: "failure" as const, failure });
}

function parseCreateOptions(
  candidate: unknown
): CreateSkillsControlControllerOptions {
  const value = readExactObject(
    candidate,
    ["sessionId", "context", "port"] as const,
    "HostDeck skills-control options are invalid."
  );
  return Object.freeze({
    sessionId: value.sessionId as SessionId,
    context: value.context as SkillsControlContext,
    port: value.port as SkillsControlPort
  });
}

function parseSessionId(candidate: unknown): SessionId {
  return sessionIdSchema.parse(candidate) as SessionId;
}

function parseContext(candidate: unknown): SkillsControlContext {
  const value = readExactObject(
    candidate,
    ["snapshot"] as const,
    "HostDeck skills-control context is invalid."
  );
  if (value.snapshot === null || typeof value.snapshot !== "object" || Array.isArray(value.snapshot)) {
    throw new TypeError("HostDeck skills-control context is invalid.");
  }
  return Object.freeze({ snapshot: value.snapshot as BrowserConnectionSnapshot });
}

function parsePort(candidate: unknown): SkillsControlPort {
  const value = readExactObject(
    candidate,
    ["read"] as const,
    "HostDeck skills-control port is invalid."
  );
  if (typeof value.read !== "function") {
    throw new TypeError("HostDeck skills-control port is invalid.");
  }
  return Object.freeze({ read: value.read as SkillsControlPort["read"] });
}

function readExactObject<const Keys extends readonly string[]>(
  candidate: unknown,
  keys: Keys,
  message: string
): Readonly<Record<Keys[number], unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(message);
  }
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
    throw new TypeError(message);
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]))
  ) as Readonly<Record<Keys[number], unknown>>;
}

function hiddenView(sessionId: SessionId): SkillsControlView {
  return deepFreeze({
    visible: false,
    actionEnabled: false,
    actionDisabledReason: "Session details are not available.",
    sheetOpen: false,
    sessionId,
    targetLabel: null,
    phase: "hidden" as const,
    tone: "muted" as const,
    status: "Skills unavailable",
    statusDetail: null,
    busy: false,
    refreshEnabled: false,
    captureRevision: null,
    capture: null,
    snapshotState: null,
    summary: null,
    skills: null
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
