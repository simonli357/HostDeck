import {
  codexThreadIdSchema,
  codexTurnIdSchema,
  managedSessionTargetSchema,
  type PromptDispatchResponse,
  type PromptSessionRequest,
  positiveSafeIntegerSchema,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  promptTurnControlSnapshotSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  type CodexPromptControlService,
  HostDeckCodexPromptControlError
} from "./codex-prompt-control-service.js";
import { assertHostDeckCsrfPolicy, type HostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { assertHostDeckHostLockPolicy, type HostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  HostDeckManagedCodexThreadServiceError,
  type ManagedCodexThreadService
} from "./managed-thread-service.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import {
  assertHostDeckSelectedWriteAdmissionPolicy,
  type HostDeckSelectedWriteAdmissionPolicy
} from "./selected-write-admission-policy.js";
import {
  assertHostDeckSelectedWriteAuditExecutor,
  type HostDeckSelectedWriteAuditExecutor
} from "./selected-write-audit-executor.js";
import { createHostDeckSelectedWriteGate } from "./selected-write-gate.js";
import {
  createHostDeckSelectedWriteAuditPort,
  createHostDeckSelectedWriteTargetResolution,
  createHostDeckSelectedWriteUnresolvedMutation,
  type HostDeckSelectedWriteAuditExecute,
  readExactDataObject
} from "./selected-write-gate-contracts.js";

export const hostDeckPromptRouteRegistrationId = "selected-prompt-dispatch";

export interface HostDeckPromptRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckPromptRouteRegistrationInput {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly prompts: Pick<CodexPromptControlService, "dispatch" | "snapshot">;
  readonly runtime: HostDeckPromptRuntimePort;
  readonly sessions: Pick<ManagedCodexThreadService, "read">;
}

type DispatchPrompt = CodexPromptControlService["dispatch"];
type ReadPromptSnapshot = CodexPromptControlService["snapshot"];
type ReadRuntime = HostDeckPromptRuntimePort["read"];
type ReadSession = ManagedCodexThreadService["read"];
type PromptParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedRoutePorts {
  readonly dispatchPrompt: DispatchPrompt;
  readonly readPromptSnapshot: ReadPromptSnapshot;
  readonly readRuntime: ReadRuntime;
  readonly readSession: ReadSession;
}

interface PromptResolution {
  readonly runtime_version: string;
}

interface ResolvedManagedTarget {
  readonly target: z.infer<typeof managedSessionTargetSchema>;
  readonly runtime_version: string;
  readonly turn_state: "completed" | "failed" | "idle" | "in_progress" | "interrupted";
}

const routeInputKeys = ["admission", "audit", "csrf", "lock", "prompts", "runtime", "sessions"] as const;
const promptPortKeys = ["dispatch", "snapshot"] as const;
const runtimePortKeys = ["read"] as const;
const sessionPortKeys = ["read"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const promptResultKeys = [
  "action",
  "model_revision",
  "plan_revision",
  "state",
  "steerable",
  "thread_id",
  "turn_id"
] as const;
const noQuerySchema = z.object({}).strict();
const startableTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const promptDispatchResultSchema = z
  .object({
    thread_id: codexThreadIdSchema,
    turn_id: codexTurnIdSchema,
    state: z.literal("accepted"),
    action: z.enum(["start", "steer"]),
    model_revision: positiveSafeIntegerSchema.nullable(),
    plan_revision: positiveSafeIntegerSchema.nullable(),
    steerable: z.boolean()
  })
  .strict();

export function createHostDeckPromptRouteRegistration(
  input: CreateHostDeckPromptRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, routeInputKeys, "HostDeck prompt route input is invalid.");
  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseRoutePorts(values.prompts, values.runtime, values.sessions);
  const manifest = requirePromptManifestEntry();
  const audit = createHostDeckSelectedWriteAuditPort<"prompt">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"prompt">
  });
  const gate = createHostDeckSelectedWriteGate({
    admission: values.admission,
    manifest,
    audit,
    csrf: values.csrf,
    lock: values.lock
  });
  let registered = false;
  return Object.freeze({
    id: hostDeckPromptRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck prompt route is already registered.");
      registered = true;
      app.post(
        manifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            body: promptSessionRequestSchema,
            response: { 202: promptDispatchResponseSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            PromptParams,
            PromptSessionRequest,
            PromptResolution,
            PromptDispatchResponse,
            PromptDispatchResponse
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Prompt route candidate is invalid."
              );
              const body = promptSessionRequestSchema.safeParse(routeCandidate.body);
              const params = sessionIdParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw promptHttpError(400, "validation_error", "Prompt request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "prompt",
                accepted_summary: Object.freeze({
                  schema_version: 1 as const,
                  text_length: body.data.text.length
                }),
                selector: params.data,
                value: body.data
              });
            },
            async resolve_target(mutation) {
              const params = sessionIdParamsSchema.parse(mutation.selector);
              const admitted = await resolvePromptAdmission(ports, params.session_id);
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.target,
                capability: "turn_input",
                value: Object.freeze({ runtime_version: admitted.runtime_version })
              });
            },
            async dispatch(context) {
              const body = promptSessionRequestSchema.parse(context.mutation.value);
              const target = managedSessionTargetSchema.parse(context.mutation.target);
              const receipt = context.accepted_audit;
              if (
                receipt === null ||
                context.resolution.target.type !== "managed_session" ||
                context.resolution.target.session_id !== target.session_id ||
                context.resolution.target.codex_thread_id !== target.codex_thread_id
              ) {
                throw new TypeError("Prompt gate target or audit receipt is contradictory.");
              }

              try {
                const admitted = await resolvePromptAdmission(ports, target.session_id);
                if (
                  admitted.target.codex_thread_id !== target.codex_thread_id ||
                  admitted.runtime_version !== context.resolution.value.runtime_version
                ) {
                  return failedTransition("stale_session");
                }
              } catch (error) {
                if (error instanceof HostDeckHttpError) {
                  return failedTransition(error.envelope.code);
                }
                throw error;
              }

              let candidate: unknown;
              try {
                candidate = await Reflect.apply(ports.dispatchPrompt, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "prompt",
                    text: body.text
                  },
                  request.signal
                ]);
              } catch (error) {
                if (!(error instanceof HostDeckCodexPromptControlError)) throw error;
                return promptFailureTransition(error);
              }

              let response: PromptDispatchResponse;
              try {
                const result = parsePromptDispatchResult(candidate);
                if (result.thread_id !== target.codex_thread_id) {
                  throw new TypeError("Prompt service accepted a different Codex thread.");
                }
                response = parsePromptResponse({
                  operation_id: body.operation_id,
                  kind: "prompt",
                  target,
                  state: "accepted",
                  accepted_at: receipt.accepted_at,
                  audit_record_id: receipt.audit_record_id,
                  turn_id: result.turn_id,
                  action: result.action
                });
              } catch {
                return Object.freeze({
                  outcome: "incomplete" as const,
                  error_code: "internal_error" as const,
                  payload_summary: Object.freeze({ schema_version: 1 as const })
                });
              }
              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1 as const,
                  accepted: true as const
                }),
                response
              });
            },
            prepare_response(candidate) {
              return parsePromptResponse(candidate);
            }
          });
          if (result.outcome !== "succeeded") throw publicPromptFailure(result.error_code);
          return reply.code(202).send(result.response);
        }
      );
    }
  });
}

function parseRoutePorts(
  promptsCandidate: unknown,
  runtimeCandidate: unknown,
  sessionsCandidate: unknown
): ParsedRoutePorts {
  const prompts = readExactDataObject(promptsCandidate, promptPortKeys, "HostDeck prompt service port is invalid.");
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck prompt runtime port is invalid.");
  const sessions = readExactDataObject(sessionsCandidate, sessionPortKeys, "HostDeck prompt session port is invalid.");
  if (
    typeof prompts.dispatch !== "function" ||
    typeof prompts.snapshot !== "function" ||
    typeof runtime.read !== "function" ||
    typeof sessions.read !== "function"
  ) {
    throw new TypeError("HostDeck prompt route ports are invalid.");
  }
  return Object.freeze({
    dispatchPrompt: prompts.dispatch as DispatchPrompt,
    readPromptSnapshot: prompts.snapshot as ReadPromptSnapshot,
    readRuntime: runtime.read as ReadRuntime,
    readSession: sessions.read as ReadSession
  });
}

function requirePromptManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === "prompt_dispatch");
  const entry = matches[0];
  const audit = entry?.audit;
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    entry.family !== "controls" ||
    entry.method !== "POST" ||
    entry.path !== "/api/v1/sessions/:session_id/prompts" ||
    entry.transport !== "json" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== null ||
    entry.request.body !== "prompt_dispatch_request_v1" ||
    entry.response.success !== "prompt_dispatch_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "local_admin_or_device_cookie" ||
    entry.authority !== "session_write" ||
    entry.csrf !== "required_for_device" ||
    entry.lock !== "requires_unlocked_host" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== "prompt" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "prompt" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "controls.prompt" ||
    entry.owner_task !== "IFC-V1-041"
  ) {
    throw new TypeError("Selected prompt route manifest entry is invalid.");
  }
  return entry;
}

async function resolvePromptAdmission(
  ports: ParsedRoutePorts,
  sessionId: string
): Promise<ResolvedManagedTarget> {
  const managed = resolveManagedTarget(ports.readSession, sessionId);
  const runtime = resolveRuntime(ports.readRuntime);
  if (managed.runtime_version !== runtime.runtime_version) {
    throw promptHttpError(
      409,
      "incompatible_runtime",
      "Managed session runtime version requires reconciliation before prompt dispatch.",
      false
    );
  }

  let snapshotCandidate: unknown;
  try {
    snapshotCandidate = await Reflect.apply(ports.readPromptSnapshot, undefined, [managed.target]);
  } catch (error) {
    if (error instanceof HostDeckCodexPromptControlError) throw publicPromptFailure(mapPromptErrorCode(error));
    throw error;
  }
  const snapshot = promptTurnControlSnapshotSchema.safeParse(snapshotCandidate);
  if (!snapshot.success) throw new TypeError("Prompt service snapshot is invalid.");
  if (managed.turn_state === "in_progress") {
    if (snapshot.data.phase !== "steerable" || snapshot.data.turn_id === null) {
      throw promptHttpError(
        409,
        "operation_conflict",
        "The active turn is not proven steerable.",
        true
      );
    }
  } else if (snapshot.data.phase !== "idle") {
    throw promptHttpError(
      409,
      snapshot.data.phase === "unknown" ? "unknown_error" : "operation_conflict",
      "A prior prompt operation still requires reconciliation.",
      false
    );
  }
  return managed;
}

function resolveManagedTarget(readSession: ReadSession, sessionId: string): ResolvedManagedTarget {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readSession, undefined, [sessionId]);
  } catch (error) {
    if (error instanceof HostDeckManagedCodexThreadServiceError) {
      throw publicPromptFailure(mapManagedServiceErrorCode(error));
    }
    throw error;
  }
  const values = readExactDataObject(candidate, selectedStateKeys, "Managed prompt session state is invalid.");
  const mapping = selectedSessionMappingRecordSchema.parse(values.mapping);
  const projection = selectedSessionProjectionRecordSchema.parse(values.projection);
  const session = projection.session;
  if (
    mapping.id !== session.id ||
    mapping.name !== session.name ||
    mapping.codex_thread_id !== session.codex_thread_id ||
    mapping.cwd !== session.cwd ||
    mapping.runtime_source !== session.runtime_source ||
    mapping.runtime_version !== session.runtime_version ||
    mapping.created_at !== session.created_at ||
    mapping.archived_at !== session.archived_at ||
    mapping.id !== sessionId
  ) {
    throw promptHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
  }
  if (mapping.archived_at !== null || session.session_state === "archived") {
    throw promptHttpError(409, "session_not_writable", "Managed session is archived.", false);
  }
  if (
    mapping.disposition !== "selected" ||
    session.session_state !== "active" ||
    session.freshness !== "current"
  ) {
    throw promptHttpError(409, "stale_session", "Managed session is not current for prompt dispatch.", false);
  }
  if (session.turn_state !== "in_progress" && !startableTurnStates.has(session.turn_state)) {
    throw promptHttpError(409, "session_not_writable", "Managed session cannot accept a prompt now.", true);
  }
  return Object.freeze({
    target: deepFreeze(
      managedSessionTargetSchema.parse({
        type: "managed_session",
        session_id: mapping.id,
        codex_thread_id: mapping.codex_thread_id
      })
    ),
    runtime_version: mapping.runtime_version,
    turn_state: session.turn_state as ResolvedManagedTarget["turn_state"]
  });
}

function resolveRuntime(readRuntime: ReadRuntime): PromptResolution {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw promptHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) {
    throw promptHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  }
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Selected runtime compatibility is invalid.");
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw promptHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  if (!runtimeAllowsPrompt(runtime)) {
    throw promptHttpError(409, "incompatible_runtime", "Selected runtime cannot dispatch prompts.", false);
  }
  return Object.freeze({ runtime_version: runtime.observed_version });
}

function runtimeAllowsPrompt(
  runtime: RuntimeCompatibility
): runtime is RuntimeCompatibility & { readonly observed_version: string } {
  return (
    (runtime.state === "ready" || runtime.state === "degraded") &&
    runtime.mutation_policy === "allowed" &&
    runtime.binding_id !== null &&
    runtime.observed_version !== null &&
    runtime.capabilities.some(
      (capability) => capability.name === "turn_input" && capability.state === "available"
    ) &&
    runtime.capabilities.some(
      (capability) => capability.name === "turn_steer" && capability.state === "available"
    )
  );
}

function parsePromptDispatchResult(candidate: unknown): z.infer<typeof promptDispatchResultSchema> {
  const values = readExactDataObject(candidate, promptResultKeys, "Prompt dispatch result is invalid.");
  const parsed = promptDispatchResultSchema.safeParse(values);
  if (!parsed.success) throw new TypeError("Prompt dispatch result is invalid.");
  return deepFreeze(parsed.data);
}

function parsePromptResponse(candidate: unknown): PromptDispatchResponse {
  const parsed = promptDispatchResponseSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Prompt dispatch response is invalid.");
  return deepFreeze(parsed.data);
}

function promptFailureTransition(error: HostDeckCodexPromptControlError) {
  return Object.freeze({
    outcome: error.outcome === "unknown" ? ("incomplete" as const) : ("failed" as const),
    error_code: mapPromptErrorCode(error),
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function failedTransition(errorCode: ErrorCode) {
  return Object.freeze({
    outcome: "failed" as const,
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function mapPromptErrorCode(error: HostDeckCodexPromptControlError): ErrorCode {
  switch (error.code) {
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
      return "stale_session";
    case "target_not_writable":
      return error.api_code === "stale_session" ? "stale_session" : "session_not_writable";
    case "capability_unsupported":
      return "incompatible_runtime";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "service_overloaded":
      return "service_overloaded";
    case "operation_conflict":
      return error.api_code === "unknown_error" ? "unknown_error" : "operation_conflict";
    case "unknown_outcome":
      return "unknown_error";
    case "runtime_protocol_error":
      return error.outcome === "unknown" ? "unknown_error" : "protocol_error";
    case "invalid_request":
      return "internal_error";
  }
}

function mapManagedServiceErrorCode(error: HostDeckManagedCodexThreadServiceError): ErrorCode {
  switch (error.code) {
    case "thread_not_found":
      return "session_not_found";
    case "thread_already_archived":
    case "thread_not_writable":
      return "session_not_writable";
    case "operation_timeout":
      return "operation_timeout";
    case "runtime_incompatible":
      return "incompatible_runtime";
    case "runtime_unavailable":
    case "unknown_outcome":
      return "runtime_unavailable";
    case "storage_error":
      return "storage_error";
    case "identity_mismatch":
    case "recovery_required":
    case "thread_conflict":
      return "stale_session";
    case "duplicate_session_name":
    case "invalid_cwd":
    case "invalid_request":
      return "internal_error";
  }
}

function publicPromptFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "session_not_found":
      return promptHttpError(404, code, "Managed session does not exist.", false);
    case "session_not_writable":
      return promptHttpError(409, code, "Managed session cannot accept a prompt now.", true);
    case "stale_session":
      return promptHttpError(409, code, "Managed session requires reconciliation before prompt dispatch.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
    case "protocol_error":
      return promptHttpError(409, code, "Selected runtime cannot safely dispatch this prompt.", false);
    case "operation_conflict":
      return promptHttpError(409, code, "Another prompt operation is still active for this session.", true);
    case "unknown_error":
      return promptHttpError(409, code, "Prompt outcome is unknown; wait for session events before another attempt.", false);
    case "operation_timeout":
      return promptHttpError(504, code, "Prompt dispatch exceeded its request deadline.", false);
    case "permission_denied":
      return promptHttpError(401, code, "Prompt authority is no longer valid.", false);
    case "read_only":
      return promptHttpError(403, code, "Write permission is required to dispatch a prompt.", false);
    case "runtime_unavailable":
    case "audit_unavailable":
    case "service_overloaded":
      return promptHttpError(503, code, "Prompt dispatch is temporarily unavailable.", true);
    case "storage_error":
      return promptHttpError(500, code, "Prompt state storage is unavailable.", true);
    default:
      return promptHttpError(500, code, "Prompt dispatch did not complete.", false);
  }
}

function promptHttpError(
  status: number,
  code: ErrorCode,
  message: string,
  retryable: boolean
): HostDeckHttpError {
  return new HostDeckHttpError({ status, code, message, retryable });
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
