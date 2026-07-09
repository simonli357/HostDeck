const sessionIdBrand: unique symbol = Symbol("SessionId");
const sessionNameBrand: unique symbol = Symbol("SessionName");
const absoluteCwdBrand: unique symbol = Symbol("AbsoluteCwd");
const isoTimestampBrand: unique symbol = Symbol("IsoTimestamp");
const outputCursorBrand: unique symbol = Symbol("OutputCursor");

export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type SessionName = string & { readonly [sessionNameBrand]: "SessionName" };
export type AbsoluteCwd = string & { readonly [absoluteCwdBrand]: "AbsoluteCwd" };
export type IsoTimestamp = string & { readonly [isoTimestampBrand]: "IsoTimestamp" };
export type OutputCursor = number & { readonly [outputCursorBrand]: "OutputCursor" };

export const lifecycleStates = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "crashed",
  "stale",
  "unknown"
] as const;

export type LifecycleState = (typeof lifecycleStates)[number];

export const sessionStatuses = [
  "idle",
  "running",
  "waiting_for_user",
  "waiting_for_approval",
  "tests_failed",
  "tests_passed",
  "compacting",
  "disconnected",
  "failed",
  "unknown"
] as const;

export type SessionStatus = (typeof sessionStatuses)[number];

export const attentionLevels = [
  "none",
  "watch",
  "needs_input",
  "needs_approval",
  "failed",
  "stuck",
  "unknown"
] as const;

export type AttentionLevel = (typeof attentionLevels)[number];

/** @deprecated Legacy pre-DEC-018 backend. New V1 code uses selectedRuntimeSource and CodexThreadId. */
export type SessionBackend = "tmux";

export interface TmuxTargetMetadata {
  readonly sessionName: string;
  readonly windowName?: string;
  readonly paneId?: string;
}

export interface SessionBackendMetadata {
  readonly type: SessionBackend;
  readonly tmux: TmuxTargetMetadata;
}

export interface RecentOutputSummary {
  readonly text: string;
  readonly cursor: OutputCursor | null;
  readonly lineCount: number;
  readonly truncated: boolean;
}

export interface ManagedSession {
  readonly id: SessionId;
  readonly name: SessionName;
  readonly cwd: AbsoluteCwd;
  readonly backend: SessionBackendMetadata;
  readonly lifecycleState: LifecycleState;
  readonly status: SessionStatus;
  readonly attention: AttentionLevel;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastActivityAt: IsoTimestamp | null;
  readonly branch: string | null;
  readonly recentOutput: RecentOutputSummary;
}

export type ValidationIssueCode =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_format"
  | "not_absolute"
  | "not_integer"
  | "negative";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ValidationIssueCode; readonly message: string };

const sessionIdPattern = /^sess_[a-z0-9][a-z0-9_-]{5,63}$/u;
const sessionNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const allowedLifecycleTransitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  starting: ["running", "stopping", "stopped", "crashed", "stale", "unknown"],
  running: ["stopping", "stopped", "crashed", "stale", "unknown"],
  stopping: ["stopped", "crashed", "stale", "unknown"],
  stopped: [],
  crashed: ["stale"],
  stale: [],
  unknown: ["starting", "running", "stale"]
};

const attentionPriorityByLevel: Readonly<Record<AttentionLevel, number>> = {
  failed: 60,
  stuck: 50,
  needs_approval: 40,
  needs_input: 30,
  unknown: 20,
  watch: 10,
  none: 0
};

export function parseSessionId(value: string): ValidationResult<SessionId> {
  if (value.length === 0) {
    return invalid("empty", "Session id is required.");
  }

  if (value.length < 11) {
    return invalid("too_short", "Session id is too short.");
  }

  if (!sessionIdPattern.test(value)) {
    return invalid("invalid_format", "Session id must match sess_<lowercase-id>.");
  }

  return valid(value as SessionId);
}

export function isSessionId(value: string): value is SessionId {
  return parseSessionId(value).ok;
}

export function parseSessionName(value: string): ValidationResult<SessionName> {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return invalid("empty", "Session name is required.");
  }

  if (trimmed.length > 64) {
    return invalid("too_long", "Session name must be 64 characters or fewer.");
  }

  if (!sessionNamePattern.test(trimmed)) {
    return invalid("invalid_format", "Session name must start with a letter or number and use letters, numbers, dots, underscores, or dashes.");
  }

  return valid(trimmed as SessionName);
}

export function isSessionName(value: string): value is SessionName {
  return parseSessionName(value).ok;
}

export function hasSessionNameCollision(existingNames: readonly SessionName[], candidate: SessionName): boolean {
  return existingNames.some((name) => name === candidate);
}

export function parseAbsoluteCwd(value: string): ValidationResult<AbsoluteCwd> {
  if (value.length === 0) {
    return invalid("empty", "Working directory is required.");
  }

  if (!value.startsWith("/")) {
    return invalid("not_absolute", "Working directory must be an absolute path.");
  }

  if (value.includes("\0")) {
    return invalid("invalid_format", "Working directory must not contain NUL bytes.");
  }

  return valid(value as AbsoluteCwd);
}

export function parseIsoTimestamp(value: string): ValidationResult<IsoTimestamp> {
  if (!isoTimestampPattern.test(value)) {
    return invalid("invalid_format", "Timestamp must be an ISO-8601 UTC string with milliseconds.");
  }

  const parsedTime = Date.parse(value);

  if (Number.isNaN(parsedTime)) {
    return invalid("invalid_format", "Timestamp must be a valid date.");
  }

  return valid(value as IsoTimestamp);
}

export function parseOutputCursor(value: number): ValidationResult<OutputCursor> {
  if (!Number.isInteger(value)) {
    return invalid("not_integer", "Output cursor must be an integer.");
  }

  if (value < 0) {
    return invalid("negative", "Output cursor must be non-negative.");
  }

  return valid(value as OutputCursor);
}

export function isWritableLifecycleState(state: LifecycleState): boolean {
  return state === "running";
}

export function canTransitionLifecycle(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) {
    return true;
  }

  return allowedLifecycleTransitions[from].includes(to);
}

export function attentionForStatus(status: SessionStatus): AttentionLevel {
  switch (status) {
    case "waiting_for_user":
      return "needs_input";
    case "waiting_for_approval":
      return "needs_approval";
    case "tests_failed":
    case "failed":
      return "failed";
    case "running":
    case "compacting":
    case "disconnected":
      return "watch";
    case "unknown":
      return "unknown";
    case "idle":
    case "tests_passed":
      return "none";
  }
}

export function attentionPriority(level: AttentionLevel): number {
  return attentionPriorityByLevel[level];
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid(code: ValidationIssueCode, message: string): ValidationResult<never> {
  return { ok: false, code, message };
}
