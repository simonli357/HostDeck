import type { ErrorCode } from "./errors.js";
import { isWritableLifecycleState, type LifecycleState, type SessionId } from "./session.js";

/** @deprecated Legacy terminal-write intents retained until INT-V1-008. Use selectedOperationKinds. */
export const commandIntents = [
  "prompt",
  "slash",
  "stop",
  "raw_input",
  "lock",
  "unlock",
  "lan_enable",
  "lan_disable",
  "pair",
  "token_revoke"
] as const;

export type CommandIntent = (typeof commandIntents)[number];

/** @deprecated Legacy tmux write actions retained until route migration. Use selectedMutationOperationKinds. */
export const writeActions = ["prompt", "slash", "stop", "raw_input"] as const;
export type WriteAction = (typeof writeActions)[number];

export const primarySlashCommands = ["/model", "/goal", "/plan"] as const;
export type PrimarySlashCommand = (typeof primarySlashCommands)[number];

export const utilitySlashCommands = ["/usage", "/compact", "/skills"] as const;
export type UtilitySlashCommand = (typeof utilitySlashCommands)[number];

export const allowedSlashCommands = [...primarySlashCommands, ...utilitySlashCommands] as const;
export type AllowedSlashCommand = (typeof allowedSlashCommands)[number];

export type WriteDenialCode =
  | "multi_session_write"
  | "invalid_action"
  | "unsupported_slash"
  | "untrusted"
  | "read_only"
  | "locked"
  | "stale"
  | "stopped"
  | "crashed"
  | "unknown"
  | "not_running"
  | "raw_input_confirmation_required"
  | "audit_unavailable";

export interface WriteEligibilityContext {
  readonly action: WriteAction | string;
  readonly sessionId: SessionId;
  readonly targetSessionIds: readonly SessionId[];
  readonly lifecycleState: LifecycleState;
  readonly trusted: boolean;
  readonly readOnly: boolean;
  readonly hostLocked: boolean;
  readonly auditAvailable: boolean;
  readonly slashCommand?: string;
  readonly rawInputConfirmed?: boolean;
}

export type WriteEligibility =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: WriteDenialCode;
      readonly errorCode: ErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };

const writeActionSet = new Set<string>(writeActions);
const slashCommandSet = new Set<string>(allowedSlashCommands);

export function isCommandIntent(value: string): value is CommandIntent {
  return (commandIntents as readonly string[]).includes(value);
}

export function isWriteAction(value: string): value is WriteAction {
  return writeActionSet.has(value);
}

export function isAllowedSlashCommand(value: string): value is AllowedSlashCommand {
  return slashCommandSet.has(value);
}

export function slashCommandKind(command: AllowedSlashCommand): "primary" | "utility" {
  return (primarySlashCommands as readonly string[]).includes(command) ? "primary" : "utility";
}

export function checkWriteEligibility(context: WriteEligibilityContext): WriteEligibility {
  if (context.targetSessionIds.length !== 1 || context.targetSessionIds[0] !== context.sessionId) {
    return deny("multi_session_write", "Write actions must target exactly one selected session.");
  }

  if (!isWriteAction(context.action)) {
    return deny("invalid_action", "Write action is not supported in V1.");
  }

  if (!context.trusted) {
    return deny("untrusted", "Write action requires a trusted paired client.");
  }

  if (context.readOnly) {
    return deny("read_only", "Read-only clients cannot write to sessions.");
  }

  if (context.hostLocked) {
    return deny("locked", "HostDeck is locked and cannot accept writes.");
  }

  if (context.action === "slash" && !isAllowedSlashCommand(context.slashCommand ?? "")) {
    return deny("unsupported_slash", "Slash command is not supported in V1.");
  }

  const lifecycleDenial = denialForLifecycle(context.lifecycleState);

  if (lifecycleDenial !== null) {
    return lifecycleDenial;
  }

  if (context.action === "raw_input" && context.rawInputConfirmed !== true) {
    return deny("raw_input_confirmation_required", "Raw terminal input requires advanced-mode confirmation.");
  }

  if (!context.auditAvailable) {
    return deny("audit_unavailable", "Write action cannot continue because audit logging is unavailable.");
  }

  return { allowed: true };
}

function denialForLifecycle(state: LifecycleState): WriteEligibility | null {
  if (isWritableLifecycleState(state)) {
    return null;
  }

  switch (state) {
    case "stale":
      return deny("stale", "Cannot write to a stale session.");
    case "stopped":
      return deny("stopped", "Cannot write to a stopped session.");
    case "crashed":
      return deny("crashed", "Cannot write to a crashed session.");
    case "unknown":
      return deny("unknown", "Cannot write to a session with unknown state.");
    case "starting":
    case "stopping":
      return deny("not_running", "Cannot write until the session is running.");
    case "running":
      return null;
  }
}

function deny(code: WriteDenialCode, message: string): WriteEligibility {
  return {
    allowed: false,
    code,
    errorCode: errorCodeForDenial(code),
    message,
    retryable: code === "audit_unavailable" || code === "not_running"
  };
}

function errorCodeForDenial(code: WriteDenialCode): ErrorCode {
  switch (code) {
    case "multi_session_write":
    case "invalid_action":
      return "validation_error";
    case "unsupported_slash":
      return "unsupported_slash";
    case "untrusted":
      return "permission_denied";
    case "read_only":
      return "read_only";
    case "locked":
      return "host_locked";
    case "stale":
      return "stale_session";
    case "stopped":
    case "crashed":
    case "unknown":
    case "not_running":
    case "raw_input_confirmation_required":
      return "session_not_writable";
    case "audit_unavailable":
      return "audit_unavailable";
  }
}
