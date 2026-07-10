import { generatedCodexBindingManifest } from "./binding-manifest.generated.js";
import type { ClientRequest } from "./generated/ClientRequest.js";
import type { InitializeCapabilities } from "./generated/InitializeCapabilities.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";

export interface CodexBindingManifest {
  readonly schemaVersion: 1;
  readonly codexVersion: string;
  readonly experimentalApi: true;
  readonly generationArgs: readonly ["app-server", "generate-ts", "--experimental", "--out"];
  readonly fileCount: number;
  readonly treeSha256: string;
  readonly bindingId: string;
}

export interface CodexProtocolSurface {
  readonly client_methods: readonly string[];
  readonly server_requests: readonly string[];
  readonly server_notifications: readonly string[];
  readonly turn_start_fields: readonly string[];
  readonly policy_evidence: readonly string[];
}

export interface CodexBindingDescriptor {
  readonly codex_version: string;
  readonly binding_id: string;
  readonly experimental_api: true;
  readonly file_count: number;
  readonly tree_sha256: string;
  readonly surface: CodexProtocolSurface;
}

type ClientMethod = ClientRequest["method"];
type ServerRequestMethod = ServerRequest["method"];
type ServerNotificationMethod = ServerNotification["method"];

const selectedClientMethods = [
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/name/set",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "thread/compact/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list",
  "collaborationMode/list",
  "account/usage/read",
  "skills/list"
] as const satisfies readonly ClientMethod[];

const selectedServerRequests = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
] as const satisfies readonly ServerRequestMethod[];

const selectedServerNotifications = [
  "account/rateLimits/updated",
  "item/agentMessage/delta",
  "item/completed",
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/name/updated",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/plan/delta",
  "item/started",
  "serverRequest/resolved"
] as const satisfies readonly ServerNotificationMethod[];

const selectedTurnStartFields = ["threadId", "input", "model", "collaborationMode"] as const satisfies readonly (keyof TurnStartParams)[];
const experimentalApiEvidence = fieldEvidence<InitializeCapabilities>("experimental_api", "experimentalApi");
const commandApprovalResponseEvidence = fieldEvidence<CommandExecutionRequestApprovalResponse>(
  "command_approval_response_type",
  "decision"
);
const fileApprovalResponseEvidence = fieldEvidence<FileChangeRequestApprovalResponse>("file_approval_response_type", "decision");
const contextCompactionItemEvidence = variantEvidence<ThreadItem["type"]>("context_compaction_item_type", "contextCompaction");

export const codexBindingManifest: CodexBindingManifest = Object.freeze({
  ...generatedCodexBindingManifest,
  generationArgs: Object.freeze(generatedCodexBindingManifest.generationArgs)
});

export const codexBindingDescriptor: CodexBindingDescriptor = Object.freeze({
  codex_version: codexBindingManifest.codexVersion,
  binding_id: codexBindingManifest.bindingId,
  experimental_api: true,
  file_count: codexBindingManifest.fileCount,
  tree_sha256: codexBindingManifest.treeSha256,
  surface: Object.freeze({
    client_methods: Object.freeze([...selectedClientMethods]),
    server_requests: Object.freeze([...selectedServerRequests]),
    server_notifications: Object.freeze([...selectedServerNotifications]),
    turn_start_fields: Object.freeze([...selectedTurnStartFields]),
    policy_evidence: Object.freeze([
      experimentalApiEvidence,
      commandApprovalResponseEvidence,
      fileApprovalResponseEvidence,
      contextCompactionItemEvidence,
      "multi_client_version_policy",
      "plan_mode_catalog"
    ])
  })
});

function fieldEvidence<T extends object>(label: string, ...fields: readonly (keyof T)[]): string {
  if (fields.length === 0) throw new Error(`Generated field evidence ${label} must name at least one field.`);
  return label;
}

function variantEvidence<Variant extends string>(label: string, variant: Variant): string {
  if (variant.length === 0) throw new Error(`Generated variant evidence ${label} must name a variant.`);
  return label;
}
