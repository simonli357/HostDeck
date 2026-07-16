import {
  type InterruptRequest,
  type InterruptResponse,
  interruptRequestSchema,
  interruptResponseSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SessionTurnParams,
  selectedOperationProgressSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionTurnParamsSchema,
  type TurnOperationTarget,
  turnOperationTargetSchema
} from "@hostdeck/contracts";
import type { ErrorCode } from "@hostdeck/core";
import type { SelectedStateRepository } from "@hostdeck/storage";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  type CodexInterruptControlService,
  HostDeckCodexInterruptControlError
} from "./codex-interrupt-control-service.js";
import { assertHostDeckCsrfPolicy, type HostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { assertHostDeckHostLockPolicy, type HostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
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

export const hostDeckInterruptRouteRegistrationId = "selected-interrupt-control";

export interface HostDeckInterruptRuntimePort {
  readonly read: () => unknown;
}

export interface CreateHostDeckInterruptRouteRegistrationInput {
  readonly interrupts: Pick<
    CodexInterruptControlService,
    "interrupt" | "requireInterruptible" | "waitForTerminal"
  >;
  readonly audit: HostDeckSelectedWriteAuditExecutor;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
  readonly runtime: HostDeckInterruptRuntimePort;
  readonly state: Pick<SelectedStateRepository, "get">;
}

type GetState = SelectedStateRepository["get"];
type InterruptTurn = CodexInterruptControlService["interrupt"];
type ReadRuntime = HostDeckInterruptRuntimePort["read"];
type RequireInterruptible = CodexInterruptControlService["requireInterruptible"];
type WaitForTerminal = CodexInterruptControlService["waitForTerminal"];

interface ParsedInterruptPorts {
  readonly getState: GetState;
  readonly interrupt: InterruptTurn;
  readonly readRuntime: ReadRuntime;
  readonly requireInterruptible: RequireInterruptible;
  readonly waitForTerminal: WaitForTerminal;
}

interface InterruptAdmission {
  readonly runtime_key: string;
  readonly runtime_version: string;
  readonly target: TurnOperationTarget;
  readonly target_key: string;
}

const registrationInputKeys = ["audit", "csrf", "interrupts", "lock", "runtime", "state"] as const;
const interruptPortKeys = ["interrupt", "requireInterruptible", "waitForTerminal"] as const;
const runtimePortKeys = ["read"] as const;
const statePortKeys = ["get"] as const;
const routeCandidateKeys = ["body", "params"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

export function createHostDeckInterruptRouteRegistration(
  input: CreateHostDeckInterruptRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, registrationInputKeys, "HostDeck interrupt route input is invalid.");
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostLockPolicy(values.lock);
  const ports = parseInterruptPorts(values.interrupts, values.runtime, values.state);
  const manifest = requireInterruptManifestEntry();
  const audit = createHostDeckSelectedWriteAuditPort<"interrupt">({
    executor: "selected_write_gate",
    execute: values.audit.execute as HostDeckSelectedWriteAuditExecute<"interrupt">
  });
  const gate = createHostDeckSelectedWriteGate({ manifest, audit, csrf: values.csrf, lock: values.lock });
  let registered = false;

  return Object.freeze({
    id: hostDeckInterruptRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) throw new TypeError("HostDeck interrupt route is already registered.");
      registered = true;

      app.post(
        manifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request, reply) {
            applyNoStore(reply);
          },
          schema: {
            params: sessionTurnParamsSchema,
            querystring: noQuerySchema,
            body: interruptRequestSchema,
            response: { 200: interruptResponseSchema }
          }
        },
        async (request, reply) => {
          const result = await gate.executeUnresolved<
            SessionTurnParams,
            InterruptRequest,
            InterruptAdmission,
            InterruptResponse,
            InterruptResponse
          >({
            request,
            candidate: Object.freeze({ body: request.body, params: request.params }),
            parse(candidate) {
              const routeCandidate = readExactDataObject(
                candidate,
                routeCandidateKeys,
                "Interrupt route candidate is invalid."
              );
              const body = interruptRequestSchema.safeParse(routeCandidate.body);
              const params = sessionTurnParamsSchema.safeParse(routeCandidate.params);
              if (!body.success || !params.success) {
                throw interruptHttpError(400, "validation_error", "Interrupt request is invalid.", false);
              }
              return createHostDeckSelectedWriteUnresolvedMutation({
                operation_id: body.data.operation_id,
                action: "interrupt",
                accepted_summary: Object.freeze({ schema_version: 1 as const, confirmed: true as const }),
                selector: params.data,
                value: body.data
              });
            },
            async resolve_target(mutation) {
              const params = sessionTurnParamsSchema.parse(mutation.selector);
              const admitted = await resolveInterruptAdmission(ports, params, true);
              return createHostDeckSelectedWriteTargetResolution({
                target: admitted.target,
                capability: "turn_interrupt",
                value: admitted
              });
            },
            async dispatch(context) {
              const body = interruptRequestSchema.parse(context.mutation.value);
              const target = turnOperationTargetSchema.parse(context.mutation.target);
              if (
                context.accepted_audit === null ||
                context.resolution.target.type !== "turn" ||
                !sameTarget(context.resolution.target, target)
              ) {
                return incompleteTransition("internal_error");
              }

              try {
                const current = await resolveInterruptAdmission(
                  ports,
                  { session_id: target.session_id, turn_id: target.turn_id },
                  true
                );
                requireSameAdmission(context.resolution.value, current);
              } catch (error) {
                if (error instanceof HostDeckHttpError) return failedTransition(error.code);
                return failedTransition("internal_error");
              }

              let progress: ReturnType<typeof selectedOperationProgressSchema.parse> | null = null;
              let waitForProof = false;
              try {
                const candidate = await Reflect.apply(ports.interrupt, undefined, [
                  {
                    operation_id: body.operation_id,
                    target,
                    kind: "interrupt",
                    confirm: true
                  },
                  request.signal
                ]);
                progress = parseInterruptProgress(candidate, body, target);
                waitForProof = progress.state === "accepted";
              } catch (error) {
                if (!(error instanceof HostDeckCodexInterruptControlError)) {
                  return incompleteTransition("internal_error");
                }
                if (error.outcome !== "unknown") return interruptFailureTransition(error);
                waitForProof = true;
              }

              if (progress !== null && !waitForProof) {
                const terminalFailure = progressFailureTransition(progress);
                if (terminalFailure !== null) return terminalFailure;
              }

              if (waitForProof) {
                let terminalCandidate: unknown;
                try {
                  terminalCandidate = await Reflect.apply(ports.waitForTerminal, undefined, [target, request.signal]);
                } catch (error) {
                  if (error instanceof HostDeckCodexInterruptControlError) {
                    return incompleteTransition(mapInterruptErrorCode(error));
                  }
                  return incompleteTransition("internal_error");
                }
                try {
                  progress = parseInterruptProgress(terminalCandidate, body, target);
                } catch {
                  return incompleteTransition("protocol_error");
                }
              }

              if (progress === null) return incompleteTransition("protocol_error");
              const terminalFailure = progressFailureTransition(progress);
              if (terminalFailure !== null) return terminalFailure;
              if (progress.state !== "interrupted") return incompleteTransition("protocol_error");

              let response: InterruptResponse;
              try {
                response = deepFreeze(interruptResponseSchema.parse(progress));
                const current = resolveInterruptContinuity(
                  ports,
                  { session_id: target.session_id, turn_id: target.turn_id },
                  true
                );
                requireSameAdmission(context.resolution.value, current);
              } catch (error) {
                if (error instanceof HostDeckHttpError) return incompleteTransition(error.code);
                return incompleteTransition("protocol_error");
              }

              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({ schema_version: 1 as const, interrupted: true as const }),
                response
              });
            },
            prepare_response(candidate) {
              return deepFreeze(interruptResponseSchema.parse(candidate));
            }
          });
          if (result.outcome !== "succeeded") throw publicInterruptFailure(result.error_code);
          return reply.code(200).send(result.response);
        }
      );
    }
  });
}

function parseInterruptPorts(
  interruptsCandidate: unknown,
  runtimeCandidate: unknown,
  stateCandidate: unknown
): ParsedInterruptPorts {
  const interrupts = readExactDataObject(
    interruptsCandidate,
    interruptPortKeys,
    "HostDeck interrupt service port is invalid."
  );
  const runtime = readExactDataObject(runtimeCandidate, runtimePortKeys, "HostDeck interrupt runtime port is invalid.");
  const state = readExactDataObject(stateCandidate, statePortKeys, "HostDeck interrupt state port is invalid.");
  if (
    typeof interrupts.interrupt !== "function" ||
    typeof interrupts.requireInterruptible !== "function" ||
    typeof interrupts.waitForTerminal !== "function" ||
    typeof runtime.read !== "function" ||
    typeof state.get !== "function"
  ) {
    throw new TypeError("HostDeck interrupt route ports are invalid.");
  }
  return Object.freeze({
    getState: state.get as GetState,
    interrupt: interrupts.interrupt as InterruptTurn,
    readRuntime: runtime.read as ReadRuntime,
    requireInterruptible: interrupts.requireInterruptible as RequireInterruptible,
    waitForTerminal: interrupts.waitForTerminal as WaitForTerminal
  });
}

function requireInterruptManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === "turn_interrupt");
  const manifest = matches[0];
  const audit = manifest?.audit;
  if (
    matches.length !== 1 ||
    manifest === undefined ||
    !Object.isFrozen(manifest) ||
    !Object.isFrozen(manifest.request) ||
    !Object.isFrozen(manifest.response) ||
    audit === null ||
    audit === undefined ||
    !Object.isFrozen(audit) ||
    manifest.family !== "controls" ||
    manifest.method !== "POST" ||
    manifest.path !== "/api/v1/sessions/:session_id/turns/:turn_id/interrupt" ||
    manifest.transport !== "json" ||
    manifest.request.params !== "session_turn_params_v1" ||
    manifest.request.query !== null ||
    manifest.request.body !== "interrupt_request_v1" ||
    manifest.response.success !== "interrupt_response_v1" ||
    manifest.response.error !== "selected_api_error_v1" ||
    manifest.auth !== "local_admin_or_device_cookie" ||
    manifest.authority !== "session_write" ||
    manifest.csrf !== "required_for_device" ||
    manifest.lock !== "requires_unlocked_host" ||
    manifest.target !== "turn" ||
    manifest.operation_kind !== "interrupt" ||
    audit.executor !== "selected_write_gate" ||
    audit.action !== "interrupt" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    manifest.credential_effect !== "none" ||
    manifest.handler !== "controls.interruptTurn" ||
    manifest.owner_task !== "IFC-V1-045"
  ) {
    throw new TypeError("Selected interrupt route manifest entry is invalid.");
  }
  return manifest;
}

async function resolveInterruptAdmission(
  ports: ParsedInterruptPorts,
  params: SessionTurnParams,
  requireMutation: boolean
): Promise<InterruptAdmission> {
  const admitted = resolveInterruptContinuity(ports, params, requireMutation);
  try {
    await Reflect.apply(ports.requireInterruptible, undefined, [admitted.target]);
  } catch (error) {
    if (error instanceof HostDeckCodexInterruptControlError) {
      throw publicInterruptFailure(mapInterruptErrorCode(error));
    }
    throw interruptHttpError(500, "internal_error", "Interrupt active-turn state could not be read.", false);
  }
  return admitted;
}

function resolveInterruptContinuity(
  ports: ParsedInterruptPorts,
  params: SessionTurnParams,
  requireMutation: boolean
): InterruptAdmission {
  const managed = resolveManagedTarget(ports.getState, params.session_id);
  const runtime = resolveRuntime(ports.readRuntime, requireMutation);
  if (managed.runtime_version !== runtime.runtime_version) {
    throw interruptHttpError(
      409,
      "stale_session",
      "Managed session runtime version requires reconciliation before interrupt control.",
      false
    );
  }
  return Object.freeze({
    target: deepFreeze(
      turnOperationTargetSchema.parse({
        type: "turn",
        session_id: managed.session_id,
        codex_thread_id: managed.codex_thread_id,
        turn_id: params.turn_id
      })
    ),
    target_key: managed.target_key,
    runtime_key: runtime.runtime_key,
    runtime_version: runtime.runtime_version
  });
}

function resolveManagedTarget(
  getState: GetState,
  sessionId: string
): {
  readonly codex_thread_id: string;
  readonly runtime_version: string;
  readonly session_id: string;
  readonly target_key: string;
} {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw interruptHttpError(500, "storage_error", "Managed session state is unavailable.", true);
  }
  if (candidate === null) throw interruptHttpError(404, "session_not_found", "Managed session was not found.", false);
  try {
    const state = readExactDataObject(candidate, selectedStateKeys, "Selected interrupt state is invalid.");
    const mapping = selectedSessionMappingRecordSchema.parse(state.mapping);
    const projection = selectedSessionProjectionRecordSchema.parse(state.projection);
    const session = projection.session;
    if (
      mapping.id !== sessionId ||
      session.id !== sessionId ||
      mapping.id !== session.id ||
      mapping.name !== session.name ||
      mapping.codex_thread_id !== session.codex_thread_id ||
      mapping.cwd !== session.cwd ||
      mapping.runtime_source !== session.runtime_source ||
      mapping.runtime_version !== session.runtime_version ||
      mapping.created_at !== session.created_at ||
      mapping.archived_at !== session.archived_at
    ) {
      throw interruptHttpError(409, "stale_session", "Managed session identity requires reconciliation.", false);
    }
    if (mapping.archived_at !== null || session.session_state === "archived") {
      throw interruptHttpError(409, "session_not_writable", "Managed session is archived.", false);
    }
    if (mapping.disposition !== "selected" || session.session_state !== "active" || session.freshness !== "current") {
      throw interruptHttpError(409, "stale_session", "Managed session is not current for interrupt control.", false);
    }
    return Object.freeze({
      session_id: mapping.id,
      codex_thread_id: mapping.codex_thread_id,
      runtime_version: mapping.runtime_version,
      target_key: JSON.stringify([
        mapping.id,
        mapping.name,
        mapping.codex_thread_id,
        mapping.cwd,
        mapping.runtime_source,
        mapping.runtime_version,
        mapping.created_at,
        mapping.archived_at,
        mapping.disposition,
        session.session_state,
        session.freshness
      ])
    });
  } catch (error) {
    if (error instanceof HostDeckHttpError) throw error;
    throw interruptHttpError(500, "storage_error", "Managed session state is invalid.", false);
  }
}

function resolveRuntime(
  readRuntime: ReadRuntime,
  requireMutation: boolean
): Pick<InterruptAdmission, "runtime_key" | "runtime_version"> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(readRuntime, undefined, []);
  } catch {
    throw interruptHttpError(503, "runtime_unavailable", "Selected runtime state is unavailable.", true);
  }
  if (candidate === null) throw interruptHttpError(503, "runtime_unavailable", "Selected runtime is unavailable.", true);
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) throw interruptHttpError(500, "internal_error", "Selected runtime compatibility is invalid.", false);
  const runtime = parsed.data;
  if (runtime.state === "disconnected") {
    throw interruptHttpError(503, "runtime_unavailable", "Selected runtime is disconnected.", true);
  }
  const capability = runtime.capabilities.find((entry) => entry.name === "turn_interrupt");
  if (capability?.state !== "available") {
    throw interruptHttpError(409, "capability_unavailable", "Structured interrupt control is unavailable.", false);
  }
  if (
    (runtime.state !== "ready" && runtime.state !== "degraded") ||
    runtime.observed_version === null ||
    runtime.binding_id === null
  ) {
    throw interruptHttpError(409, "incompatible_runtime", "Selected runtime cannot provide interrupt control.", false);
  }
  if (requireMutation && runtime.mutation_policy !== "allowed") {
    throw interruptHttpError(409, "incompatible_runtime", "Selected runtime blocks interrupt control.", false);
  }
  return Object.freeze({
    runtime_key: runtimeAdmissionKey(runtime),
    runtime_version: runtime.observed_version
  });
}

function parseInterruptProgress(
  candidate: unknown,
  request: InterruptRequest,
  target: TurnOperationTarget
): ReturnType<typeof selectedOperationProgressSchema.parse> {
  const parsed = selectedOperationProgressSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.kind !== "interrupt" ||
    parsed.data.target.type !== "turn" ||
    !sameTarget(parsed.data.target, target) ||
    parsed.data.turn_id !== target.turn_id ||
    !["accepted", "interrupted", "failed", "incomplete"].includes(parsed.data.state)
  ) {
    throw new TypeError("Interrupt service progress is invalid.");
  }
  return deepFreeze(parsed.data);
}

function progressFailureTransition(progress: ReturnType<typeof selectedOperationProgressSchema.parse>) {
  if (progress.state === "failed") return failedTransition(progress.error?.code ?? "protocol_error");
  if (progress.state === "incomplete") return incompleteTransition(progress.error?.code ?? "protocol_error");
  return null;
}

function requireSameAdmission(expected: InterruptAdmission, actual: InterruptAdmission): void {
  if (!sameTarget(expected.target, actual.target) || expected.target_key !== actual.target_key) {
    throw interruptHttpError(409, "stale_session", "Managed session identity changed during interrupt control.", false);
  }
  if (expected.runtime_version !== actual.runtime_version || expected.runtime_key !== actual.runtime_key) {
    throw interruptHttpError(409, "incompatible_runtime", "Selected runtime changed during interrupt control.", false);
  }
}

function runtimeAdmissionKey(runtime: RuntimeCompatibility): string {
  const capability = runtime.capabilities.find((entry) => entry.name === "turn_interrupt");
  return JSON.stringify([
    runtime.state,
    runtime.mutation_policy,
    runtime.observed_version,
    runtime.binding_id,
    capability?.state ?? null
  ]);
}

function interruptFailureTransition(error: HostDeckCodexInterruptControlError) {
  const errorCode = mapInterruptErrorCode(error);
  return error.outcome === "unknown" ? incompleteTransition(errorCode) : failedTransition(errorCode);
}

function mapInterruptErrorCode(error: HostDeckCodexInterruptControlError): ErrorCode {
  switch (error.code) {
    case "target_not_found":
      return "session_not_found";
    case "target_mismatch":
    case "target_stale":
      return "stale_session";
    case "target_not_writable":
      return error.api_code === "stale_session" ? "stale_session" : "session_not_writable";
    case "capability_unsupported":
      return "capability_unavailable";
    case "operation_conflict":
      return "operation_conflict";
    case "runtime_protocol_error":
      return "protocol_error";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "service_overloaded":
      return "service_overloaded";
    case "state_unavailable":
      return "storage_error";
    case "unknown_outcome":
      return error.api_code === "operation_timeout" ? "operation_timeout" : "unknown_error";
    case "invalid_request":
      return "internal_error";
  }
}

function failedTransition(errorCode: ErrorCode) {
  return Object.freeze({
    outcome: "failed" as const,
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function incompleteTransition(errorCode: ErrorCode) {
  return Object.freeze({
    outcome: "incomplete" as const,
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 as const })
  });
}

function publicInterruptFailure(code: ErrorCode): HostDeckHttpError {
  switch (code) {
    case "validation_error":
      return interruptHttpError(400, code, "Interrupt request is invalid.", false);
    case "session_not_found":
      return interruptHttpError(404, code, "Managed session was not found.", false);
    case "session_not_writable":
      return interruptHttpError(409, code, "Managed session cannot provide interrupt control.", false);
    case "stale_session":
    case "invalid_session_id":
      return interruptHttpError(409, "stale_session", "Managed session requires reconciliation before interrupt control.", false);
    case "incompatible_runtime":
    case "capability_unavailable":
      return interruptHttpError(409, code, "Structured interrupt control is unavailable for the selected runtime.", false);
    case "operation_conflict":
      return interruptHttpError(409, code, "Interrupt conflicts with current turn state.", false);
    case "unknown_error":
      return interruptHttpError(409, code, "Interrupt outcome is unknown and requires reconciliation.", false);
    case "protocol_error":
      return interruptHttpError(502, code, "Codex interrupt state failed protocol validation.", false);
    case "operation_timeout":
      return interruptHttpError(504, code, "Interrupt exceeded its request deadline before terminal proof.", false);
    case "runtime_unavailable":
      return interruptHttpError(503, code, "Codex interrupt control is unavailable.", true);
    case "audit_unavailable":
      return interruptHttpError(503, code, "Interrupt audit is unavailable.", true);
    case "service_overloaded":
      return interruptHttpError(503, code, "Interrupt control capacity is exhausted.", true);
    case "storage_error":
      return interruptHttpError(500, code, "Managed session storage is unavailable.", true);
    case "permission_denied":
      return interruptHttpError(401, code, "Interrupt authority is no longer valid.", false);
    case "read_only":
      return interruptHttpError(403, code, "Write permission is required to interrupt a turn.", false);
    default:
      return interruptHttpError(500, code, "Interrupt operation did not complete.", false);
  }
}

function sameTarget(left: TurnOperationTarget, right: TurnOperationTarget): boolean {
  return (
    left.session_id === right.session_id &&
    left.codex_thread_id === right.codex_thread_id &&
    left.turn_id === right.turn_id
  );
}

function interruptHttpError(status: number, code: ErrorCode, message: string, retryable: boolean): HostDeckHttpError {
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
