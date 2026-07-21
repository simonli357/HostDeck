import {
  codexItemIdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey,
  runtimeRequestIdSchema
} from "@hostdeck/contracts";
import type {
  CodexItemId,
  CodexThreadId,
  CodexTurnId,
  IsoTimestamp,
  OperationDeadline,
  RuntimeRequestId
} from "@hostdeck/core";
import { z } from "zod";
import type { CodexServerResponseOptions } from "./broker.js";
import { type CodexOperationOutcome, HostDeckCodexAdapterError } from "./errors.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { CodexRequestId } from "./protocol.js";
import { codexRequestOptionsFromDeadline } from "./request-deadline.js";

export type CodexApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

export interface CodexApprovalRequest {
  readonly method: CodexApprovalMethod;
  readonly protocol_request_id: CodexRequestId;
  readonly request_id: RuntimeRequestId;
  readonly thread_id: CodexThreadId;
  readonly turn_id: CodexTurnId;
  readonly item_id: CodexItemId;
  readonly generation: number;
  readonly started_at: IsoTimestamp;
  readonly action: string;
  readonly scope: string | null;
  readonly reason: string | null;
  readonly risk: "elevated" | "broad";
  readonly grant_scope: "one_time";
}

export interface CodexApprovalResponseInput {
  readonly request: CodexApprovalRequest;
  readonly decision: "approve" | "deny";
  readonly deadline?: OperationDeadline;
}

export interface CodexApprovalRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
  readonly respondToServerRequest: (
    id: CodexRequestId,
    result: unknown,
    options?: CodexServerResponseOptions
  ) => Promise<void>;
}

export interface CodexApprovalClientOptions {
  readonly mutation_timeout_ms?: number;
}

export interface CodexApprovalClient {
  readonly runtime_version: string;
  readonly generation: number;
  readonly parseRequest: (message: unknown) => CodexApprovalRequest;
  readonly respond: (input: CodexApprovalResponseInput) => Promise<void>;
}

const approvalFieldLength = 1_000;
const maximumProtocolRequestIdLength = 120;
const maximumDecisionCount = 16;
const maximumApprovalListLength = 64;
const maximumUnixMilliseconds = 8_640_000_000_000_000;

const protocolRequestIdSchema = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().min(1).max(maximumProtocolRequestIdLength)
]);
const approvalTextSchema = z
  .string()
  .max(approvalFieldLength)
  .refine((value) => !hasUnsafeControlCharacter(value), "must not contain unsafe control characters");
const nonEmptyApprovalTextSchema = approvalTextSchema.pipe(z.string().min(1));
const commandActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("read"),
      command: approvalTextSchema,
      name: approvalTextSchema,
      path: nonEmptyApprovalTextSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("listFiles"),
      command: approvalTextSchema,
      path: approvalTextSchema.nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal("search"),
      command: approvalTextSchema,
      query: approvalTextSchema.nullable(),
      path: approvalTextSchema.nullable()
    })
    .strict(),
  z.object({ type: z.literal("unknown"), command: approvalTextSchema }).strict()
]);
const fileSystemSpecialPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("minimal") }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: approvalTextSchema.nullable() }).strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(),
  z.object({ kind: z.literal("slash_tmp") }).strict(),
  z
    .object({ kind: z.literal("unknown"), path: nonEmptyApprovalTextSchema, subpath: approvalTextSchema.nullable() })
    .strict()
]);
const fileSystemPathSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: nonEmptyApprovalTextSchema }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: nonEmptyApprovalTextSchema }).strict(),
  z.object({ type: z.literal("special"), value: fileSystemSpecialPathSchema }).strict()
]);
const fileSystemEntrySchema = z
  .object({ path: fileSystemPathSchema, access: z.enum(["read", "write", "deny"]) })
  .strict();
const additionalFileSystemPermissionsSchema = z
  .object({
    read: z.array(nonEmptyApprovalTextSchema).max(maximumApprovalListLength).nullable(),
    write: z.array(nonEmptyApprovalTextSchema).max(maximumApprovalListLength).nullable(),
    globScanMaxDepth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    entries: z.array(fileSystemEntrySchema).max(maximumApprovalListLength).optional()
  })
  .strict();
const additionalPermissionProfileSchema = z
  .object({
    network: z.object({ enabled: z.boolean().nullable() }).strict().nullable(),
    fileSystem: additionalFileSystemPermissionsSchema.nullable()
  })
  .strict();
const networkApprovalContextSchema = z
  .object({
    host: nonEmptyApprovalTextSchema,
    protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"])
  })
  .strict();
const execPolicyAmendmentSchema = z.array(approvalTextSchema).max(maximumApprovalListLength);
const networkPolicyAmendmentSchema = z
  .object({ host: nonEmptyApprovalTextSchema, action: z.enum(["allow", "deny"]) })
  .strict();
const commandApprovalDecisionSchema = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z
    .object({
      acceptWithExecpolicyAmendment: z.object({ execpolicy_amendment: execPolicyAmendmentSchema }).strict()
    })
    .strict(),
  z
    .object({
      applyNetworkPolicyAmendment: z.object({ network_policy_amendment: networkPolicyAmendmentSchema }).strict()
    })
    .strict()
]);
const identityShape = {
  threadId: codexThreadIdSchema,
  turnId: codexTurnIdSchema,
  itemId: codexItemIdSchema,
  startedAtMs: z.number().int().nonnegative().max(maximumUnixMilliseconds)
} as const;
const commandRequestSchema = z
  .object({
    ...identityShape,
    approvalId: z.string().min(1).max(240).nullable().optional(),
    environmentId: z.string().min(1).max(240).nullable(),
    reason: approvalTextSchema.nullable().optional(),
    networkApprovalContext: networkApprovalContextSchema.nullable().optional(),
    command: approvalTextSchema.nullable().optional(),
    cwd: nonEmptyApprovalTextSchema.nullable().optional(),
    commandActions: z.array(commandActionSchema).max(maximumApprovalListLength).nullable().optional(),
    additionalPermissions: additionalPermissionProfileSchema.nullable().optional(),
    proposedExecpolicyAmendment: execPolicyAmendmentSchema.nullable().optional(),
    proposedNetworkPolicyAmendments: z.array(networkPolicyAmendmentSchema).max(maximumApprovalListLength).nullable().optional(),
    availableDecisions: z.array(commandApprovalDecisionSchema).max(maximumDecisionCount).nullable().optional()
  })
  .strict();
const fileChangeRequestSchema = z
  .object({
    ...identityShape,
    reason: approvalTextSchema.nullable().optional(),
    grantRoot: nonEmptyApprovalTextSchema.nullable().optional()
  })
  .strict();
const serverRequestEnvelopeSchema = z
  .object({
    kind: z.literal("server_request"),
    id: protocolRequestIdSchema,
    method: z.enum(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]),
    params: z.unknown(),
    classification: z.literal("supported")
  })
  .strict();
const approvalRequestSchema = z
  .object({
    method: z.enum(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]),
    protocol_request_id: protocolRequestIdSchema,
    request_id: runtimeRequestIdSchema,
    thread_id: codexThreadIdSchema,
    turn_id: codexTurnIdSchema,
    item_id: codexItemIdSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    started_at: isoTimestampSchema,
    action: nonEmptyApprovalTextSchema,
    scope: nonEmptyApprovalTextSchema.nullable(),
    reason: approvalTextSchema.nullable(),
    risk: z.enum(["elevated", "broad"]),
    grant_scope: z.literal("one_time")
  })
  .strict();

export function createCodexApprovalClient(
  port: CodexApprovalRequestPort,
  options: CodexApprovalClientOptions = {}
): CodexApprovalClient {
  if (
    port === null ||
    typeof port !== "object" ||
    typeof port.respondToServerRequest !== "function" ||
    !Number.isSafeInteger(port.generation) ||
    port.generation < 0
  ) {
    throw new TypeError("Codex approval client requires a compatible generation-aware server-request port.");
  }
  const implementation = new DefaultCodexApprovalClient(
    port,
    parseOptions(options)
  );
  return Object.freeze({
    get runtime_version() {
      return implementation.runtime_version;
    },
    get generation() {
      return implementation.generation;
    },
    parseRequest: (message: unknown) => implementation.parseRequest(message),
    respond: (input: CodexApprovalResponseInput) => implementation.respond(input)
  });
}

class DefaultCodexApprovalClient implements CodexApprovalClient {
  constructor(
    private readonly port: CodexApprovalRequestPort,
    private readonly mutationTimeoutMs: number
  ) {}

  get runtime_version(): string {
    return requireApprovalRuntime(this.port.compatibility);
  }

  get generation(): number {
    const generation = this.port.generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw adapterError("protocol_violation", "Codex approval connection generation is invalid.", "not_sent", false);
    }
    return generation;
  }

  parseRequest(message: unknown): CodexApprovalRequest {
    void this.runtime_version;
    const envelope = serverRequestEnvelopeSchema.safeParse(message);
    if (!envelope.success) {
      throw adapterError("invalid_protocol_message", "Codex approval server request envelope is invalid.", "not_sent", false, envelope.error);
    }
    const identity =
      envelope.data.method === "item/commandExecution/requestApproval"
        ? parseCommandRequest(envelope.data.params)
        : parseFileChangeRequest(envelope.data.params);
    const parsed = approvalRequestSchema.safeParse({
      method: envelope.data.method,
      protocol_request_id: envelope.data.id,
      request_id: canonicalRequestId(envelope.data.id),
      generation: this.generation,
      ...identity
    });
    if (!parsed.success) {
      throw adapterError("invalid_protocol_message", "Codex approval request could not be normalized.", "not_sent", false, parsed.error);
    }
    return deepFreeze(parsed.data);
  }

  async respond(input: CodexApprovalResponseInput): Promise<void> {
    void this.runtime_version;
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["deadline", "decision", "request"].includes(key)) ||
      !Object.hasOwn(input, "decision") ||
      !Object.hasOwn(input, "request")
    ) {
      throw adapterError("invalid_protocol_message", "Codex approval response input is invalid.", "not_sent", true);
    }
    const request = approvalRequestSchema.safeParse(input.request);
    if (!request.success || !["approve", "deny"].includes(input.decision)) {
      throw adapterError(
        "invalid_protocol_message",
        "Codex approval response request or decision is invalid.",
        "not_sent",
        true,
        request.success ? undefined : request.error
      );
    }
    if (request.data.request_id !== canonicalRequestId(request.data.protocol_request_id)) {
      throw adapterError("invalid_protocol_message", "Codex approval request id contradicts its protocol id.", "not_sent", false);
    }
    if (request.data.generation !== this.generation) {
      throw adapterError("unknown_outcome", "Codex approval request belongs to another connection generation.", "unknown", false);
    }
    const responseOptions = codexRequestOptionsFromDeadline(
      input.deadline,
      this.mutationTimeoutMs
    );
    if (request.data.method === "item/commandExecution/requestApproval") {
      const response: CommandExecutionRequestApprovalResponse = {
        decision: input.decision === "approve" ? "accept" : "decline"
      };
      await this.port.respondToServerRequest(
        request.data.protocol_request_id,
        response,
        responseOptions
      );
      return;
    }
    const response: FileChangeRequestApprovalResponse = {
      decision: input.decision === "approve" ? "accept" : "decline"
    };
    await this.port.respondToServerRequest(
      request.data.protocol_request_id,
      response,
      responseOptions
    );
  }
}

function parseOptions(candidate: unknown): number {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Codex approval client options must be an object.");
  }
  const value = candidate as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "mutation_timeout_ms")) {
    throw new TypeError("Codex approval client options contain unsupported fields.");
  }
  const definition = resourceBudgetDefinitionByKey.protocol_mutation_timeout_ms;
  const timeout = value.mutation_timeout_ms ?? defaultResourceBudget.protocol_mutation_timeout_ms;
  if (
    !Number.isSafeInteger(timeout) ||
    (timeout as number) < definition.minimum ||
    (timeout as number) > definition.maximum
  ) {
    throw new TypeError(
      `Codex approval mutation timeout must be between ${definition.minimum} and ${definition.maximum} milliseconds.`
    );
  }
  return timeout as number;
}

function parseCommandRequest(candidate: unknown): Omit<CodexApprovalRequest, "method" | "protocol_request_id" | "request_id" | "generation"> {
  const parsed = commandRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw adapterError("invalid_protocol_message", "Codex command approval request is invalid.", "not_sent", false, parsed.error);
  }
  const action = parsed.data.command;
  if (action === undefined || action === null || action.trim().length === 0 || hasUnsafeControlCharacter(action)) {
    throw adapterError("invalid_protocol_message", "Codex command approval omits the complete command action.", "not_sent", false);
  }
  const broad =
    parsed.data.networkApprovalContext != null ||
    parsed.data.additionalPermissions != null;
  return {
    thread_id: parsed.data.threadId,
    turn_id: parsed.data.turnId,
    item_id: parsed.data.itemId,
    started_at: timestampFromMilliseconds(parsed.data.startedAtMs),
    action,
    scope: commandScope(parsed.data),
    reason: parsed.data.reason ?? null,
    risk: broad ? "broad" : "elevated",
    grant_scope: "one_time"
  };
}

function parseFileChangeRequest(candidate: unknown): Omit<CodexApprovalRequest, "method" | "protocol_request_id" | "request_id" | "generation"> {
  const parsed = fileChangeRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw adapterError("invalid_protocol_message", "Codex file-change approval request is invalid.", "not_sent", false, parsed.error);
  }
  return {
    thread_id: parsed.data.threadId,
    turn_id: parsed.data.turnId,
    item_id: parsed.data.itemId,
    started_at: timestampFromMilliseconds(parsed.data.startedAtMs),
    action: "Apply proposed file changes",
    scope: parsed.data.grantRoot ?? null,
    reason: parsed.data.reason ?? null,
    risk: parsed.data.grantRoot == null ? "elevated" : "broad",
    grant_scope: "one_time"
  };
}

function commandScope(request: z.infer<typeof commandRequestSchema>): string | null {
  const parts: string[] = [];
  if (request.cwd !== undefined && request.cwd !== null) parts.push(`Working directory: ${request.cwd}`);
  if (request.networkApprovalContext !== undefined && request.networkApprovalContext !== null) {
    parts.push(`Network target: ${request.networkApprovalContext.protocol}://${request.networkApprovalContext.host}`);
  }
  const network = request.additionalPermissions?.network;
  if (network !== undefined && network !== null) {
    const state = network.enabled === null ? "unspecified" : network.enabled ? "enabled" : "disabled";
    parts.push(`Additional network access: ${state}`);
  }
  const fileSystem = request.additionalPermissions?.fileSystem;
  if (fileSystem !== undefined && fileSystem !== null) {
    if (fileSystem.read !== null) parts.push(`Additional read paths: ${fileSystem.read.join(", ") || "none"}`);
    if (fileSystem.write !== null) parts.push(`Additional write paths: ${fileSystem.write.join(", ") || "none"}`);
    if (fileSystem.globScanMaxDepth !== undefined) parts.push(`Glob scan max depth: ${fileSystem.globScanMaxDepth}`);
    if (fileSystem.entries !== undefined) {
      const entries = fileSystem.entries.map((entry) => `${entry.access}:${formatFileSystemPath(entry.path)}`).join(", ");
      parts.push(`Additional filesystem entries: ${entries || "none"}`);
    }
  }
  if (parts.length === 0) return null;
  if (parts.length === 1 && request.cwd !== undefined && request.cwd !== null) return request.cwd;
  const scope = parts.join("\n");
  if (scope.length > approvalFieldLength) {
    throw adapterError("invalid_protocol_message", "Codex command approval scope exceeds the inspectable limit.", "not_sent", false);
  }
  return scope;
}

function formatFileSystemPath(path: z.infer<typeof fileSystemPathSchema>): string {
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return `glob:${path.pattern}`;
  if (path.value.kind === "project_roots") return `special:project_roots:${path.value.subpath ?? ""}`;
  if (path.value.kind === "unknown") return `special:unknown:${path.value.path}:${path.value.subpath ?? ""}`;
  return `special:${path.value.kind}`;
}

function timestampFromMilliseconds(value: number): IsoTimestamp {
  let timestamp: string;
  try {
    timestamp = new Date(value).toISOString();
  } catch (error) {
    throw adapterError("invalid_protocol_message", "Codex approval start timestamp is outside the supported range.", "not_sent", false, error);
  }
  const parsed = isoTimestampSchema.safeParse(timestamp);
  if (!parsed.success) {
    throw adapterError("invalid_protocol_message", "Codex approval start timestamp is invalid.", "not_sent", false, parsed.error);
  }
  return parsed.data;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      (code >= 127 && code <= 159) ||
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function canonicalRequestId(value: CodexRequestId): RuntimeRequestId {
  const parsed = runtimeRequestIdSchema.safeParse(`${typeof value === "number" ? "number" : "string"}:${value}`);
  if (!parsed.success) {
    throw adapterError("invalid_protocol_message", "Codex approval request id cannot be normalized.", "not_sent", false, parsed.error);
  }
  return parsed.data;
}

function requireApprovalRuntime(compatibility: RuntimeCompatibility): string {
  const capability = compatibility.capabilities.find((candidate) => candidate.name === "approvals");
  if (capability?.state === "unavailable") {
    throw adapterError("unsupported_method", "The connected Codex runtime does not support structured approvals.", "not_sent", false);
  }
  if (
    capability?.state !== "available" ||
    !["degraded", "ready"].includes(compatibility.state) ||
    compatibility.observed_version === null ||
    compatibility.binding_id === null ||
    compatibility.mutation_policy !== "allowed"
  ) {
    throw adapterError("handshake_failed", "Codex approvals require a connected compatible runtime.", "not_sent", true);
  }
  return compatibility.observed_version;
}

function adapterError(
  code: ConstructorParameters<typeof HostDeckCodexAdapterError>[0],
  message: string,
  outcome: CodexOperationOutcome,
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, { outcome, retry_safe: retrySafe, ...(cause === undefined ? {} : { cause }) });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
