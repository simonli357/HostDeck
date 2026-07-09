import type { ValidationIssueCode, ValidationResult } from "./session.js";

const codexThreadIdBrand: unique symbol = Symbol("CodexThreadId");
const codexTurnIdBrand: unique symbol = Symbol("CodexTurnId");
const codexItemIdBrand: unique symbol = Symbol("CodexItemId");
const runtimeRequestIdBrand: unique symbol = Symbol("RuntimeRequestId");
const clientOperationIdBrand: unique symbol = Symbol("ClientOperationId");

export type CodexThreadId = string & { readonly [codexThreadIdBrand]: "CodexThreadId" };
export type CodexTurnId = string & { readonly [codexTurnIdBrand]: "CodexTurnId" };
export type CodexItemId = string & { readonly [codexItemIdBrand]: "CodexItemId" };
export type RuntimeRequestId = string & { readonly [runtimeRequestIdBrand]: "RuntimeRequestId" };
export type ClientOperationId = string & { readonly [clientOperationIdBrand]: "ClientOperationId" };

export const selectedRuntimeSource = "codex_app_server" as const;

export const managedSessionStates = ["starting", "active", "archived", "stale", "incompatible", "unknown"] as const;
export type ManagedSessionState = (typeof managedSessionStates)[number];

export const turnStates = [
  "idle",
  "in_progress",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "interrupted",
  "failed",
  "unknown"
] as const;
export type TurnState = (typeof turnStates)[number];

export const projectionFreshnessStates = ["current", "stale", "disconnected", "incompatible"] as const;
export type ProjectionFreshness = (typeof projectionFreshnessStates)[number];

export const runtimeConnectionStates = ["ready", "degraded", "incompatible", "disconnected"] as const;
export type RuntimeConnectionState = (typeof runtimeConnectionStates)[number];

export const runtimeCapabilities = [
  "thread_lifecycle",
  "turn_input",
  "turn_steer",
  "turn_interrupt",
  "model",
  "goal",
  "plan",
  "usage",
  "compact",
  "skills",
  "approvals",
  "multi_client"
] as const;
export type RuntimeCapability = (typeof runtimeCapabilities)[number];

export const requiredRuntimeCapabilities = [
  "thread_lifecycle",
  "turn_input",
  "turn_steer",
  "turn_interrupt",
  "model",
  "goal",
  "plan",
  "approvals",
  "multi_client"
] as const satisfies readonly RuntimeCapability[];

export const runtimeCapabilityStates = ["available", "unavailable", "unknown"] as const;
export type RuntimeCapabilityState = (typeof runtimeCapabilityStates)[number];

export const structuredControlKinds = ["model", "goal", "plan", "usage", "compact", "skills"] as const;
export type StructuredControlKind = (typeof structuredControlKinds)[number];

export const selectedOperationKinds = [
  "prompt",
  "model",
  "goal",
  "plan",
  "usage",
  "compact",
  "skills",
  "approval_response",
  "interrupt",
  "archive"
] as const;
export type SelectedOperationKind = (typeof selectedOperationKinds)[number];

export const selectedMutationOperationKinds = [
  "prompt",
  "model",
  "goal",
  "plan",
  "compact",
  "approval_response",
  "interrupt",
  "archive"
] as const;
export type SelectedMutationOperationKind = (typeof selectedMutationOperationKinds)[number];

export const selectedAuditOutcomes = ["accepted", "succeeded", "failed", "rejected", "incomplete"] as const;
export type SelectedAuditOutcome = (typeof selectedAuditOutcomes)[number];

export const selectedAuditActions = [
  ...selectedOperationKinds,
  "pair_request",
  "pair_claim",
  "device_revoke",
  "lock",
  "unlock",
  "lan_configure",
  "lan_enable",
  "lan_disable",
  "certificate_rotate"
] as const;
export type SelectedAuditAction = (typeof selectedAuditActions)[number];

export const projectionEventKinds = [
  "message",
  "turn",
  "activity",
  "approval",
  "control",
  "runtime",
  "replay_boundary",
  "unknown_optional"
] as const;
export type ProjectionEventKind = (typeof projectionEventKinds)[number];

export const projectionContentStates = ["complete", "redacted", "truncated", "redacted_and_truncated"] as const;
export type ProjectionContentState = (typeof projectionContentStates)[number];

const mobileAttentionPriorityByLevel = {
  needs_approval: 60,
  needs_input: 50,
  failed: 40,
  stuck: 30,
  unknown: 30,
  watch: 20,
  none: 0
} as const;

const opaqueRuntimeIdPattern = /^\S{1,128}$/u;
const clientOperationIdPattern = /^op_[a-z0-9][a-z0-9_-]{7,95}$/u;
const mutationOperationSet = new Set<string>(selectedMutationOperationKinds);

export function parseCodexThreadId(value: string): ValidationResult<CodexThreadId> {
  return parseOpaqueRuntimeId(value, "Codex thread id", (id) => id as CodexThreadId);
}

export function parseCodexTurnId(value: string): ValidationResult<CodexTurnId> {
  return parseOpaqueRuntimeId(value, "Codex turn id", (id) => id as CodexTurnId);
}

export function parseCodexItemId(value: string): ValidationResult<CodexItemId> {
  return parseOpaqueRuntimeId(value, "Codex item id", (id) => id as CodexItemId);
}

export function parseRuntimeRequestId(value: string): ValidationResult<RuntimeRequestId> {
  return parseOpaqueRuntimeId(value, "Runtime request id", (id) => id as RuntimeRequestId);
}

export function parseClientOperationId(value: string): ValidationResult<ClientOperationId> {
  if (value.length === 0) {
    return invalid("empty", "Client operation id is required.");
  }

  if (value.length > 99) {
    return invalid("too_long", "Client operation id must be 99 characters or fewer.");
  }

  if (!clientOperationIdPattern.test(value)) {
    return invalid("invalid_format", "Client operation id must match op_<lowercase-id>.");
  }

  return valid(value as ClientOperationId);
}

export function isSelectedOperationKind(value: string): value is SelectedOperationKind {
  return (selectedOperationKinds as readonly string[]).includes(value);
}

export function isSelectedMutationOperation(value: SelectedOperationKind): value is SelectedMutationOperationKind {
  return mutationOperationSet.has(value);
}

export function operationCapability(kind: SelectedOperationKind): RuntimeCapability {
  switch (kind) {
    case "prompt":
      return "turn_input";
    case "model":
      return "model";
    case "goal":
      return "goal";
    case "plan":
      return "plan";
    case "usage":
      return "usage";
    case "compact":
      return "compact";
    case "skills":
      return "skills";
    case "approval_response":
      return "approvals";
    case "interrupt":
      return "turn_interrupt";
    case "archive":
      return "thread_lifecycle";
  }
}

export function mobileAttentionPriority(level: keyof typeof mobileAttentionPriorityByLevel): number {
  return mobileAttentionPriorityByLevel[level];
}

function parseOpaqueRuntimeId<T>(value: string, label: string, brand: (value: string) => T): ValidationResult<T> {
  if (value.length === 0) {
    return invalid("empty", `${label} is required.`);
  }

  if (value.length > 128) {
    return invalid("too_long", `${label} must be 128 characters or fewer.`);
  }

  if (!opaqueRuntimeIdPattern.test(value) || hasControlCharacter(value)) {
    return invalid("invalid_format", `${label} must not contain whitespace or control characters.`);
  }

  return valid(brand(value));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid(code: ValidationIssueCode, message: string): ValidationResult<never> {
  return { ok: false, code, message };
}
