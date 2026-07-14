import { isDeepStrictEqual } from "node:util";
import {
  type SelectedAuditActor,
  type SelectedRequestAuthenticationContext,
  selectedAuditActorSchema
} from "@hostdeck/contracts";
import {
  type ErrorCode,
  type OperationDeadline,
  operationCapability,
  type RuntimeCapability
} from "@hostdeck/core";
import type { FastifyRequest } from "fastify";
import {
  assertHostDeckCsrfPolicy,
  type HostDeckCsrfAuthorizationReceipt,
  type HostDeckCsrfPolicy,
  requireHostDeckRequestCsrfWriteAuthorization
} from "./csrf-routes.js";
import type { HostDeckActiveDeviceAuthorityLease } from "./device-authority-lifecycle.js";
import { hostDeckRequestDeadline } from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  requireHostDeckRequestActiveDeviceAuthority,
  requireHostDeckRequestAuthentication,
  requireHostDeckRequestWritePermission
} from "./fastify-request-authentication.js";
import {
  assertHostDeckHostLockPolicy,
  type HostDeckDurableLockState,
  type HostDeckHostLockPolicy,
  requireHostDeckHostUnlocked
} from "./host-lock-routes.js";
import {
  HostDeckSecurityMutationAuditExecutorError,
  type SecurityMutationExecutionResult
} from "./security-mutation-audit-executor.js";
import type {
  SelectedApiAuditAction,
  SelectedApiRouteManifestEntry
} from "./selected-api-route-manifest.js";
import {
  assertAcceptedAuditContext,
  assertHostDeckSelectedWriteAuditPort,
  assertHostDeckSelectedWriteMutation,
  assertHostDeckSelectedWriteTargetResolution,
  type HostDeckSelectedWriteAuditPort,
  type HostDeckSelectedWriteMutation,
  type HostDeckSelectedWriteTargetResolution,
  type ParsedSelectedWriteTransition,
  parseSelectedWriteAuditResult,
  parseSelectedWriteTransition,
  readExactDataObject,
  requireSelectedWriteManifest
} from "./selected-write-gate-contracts.js";

export * from "./selected-write-gate-contracts.js";

export type HostDeckSelectedWriteGateStage =
  | "audit"
  | "authorization"
  | "configuration"
  | "dispatch"
  | "input"
  | "lock"
  | "parse"
  | "target";

export type HostDeckSelectedWriteGateErrorCode =
  | "audit_contract_failed"
  | "authorization_contract_failed"
  | "configuration_invalid"
  | "dispatch_contract_failed"
  | "input_invalid"
  | "lock_contract_failed"
  | "parse_contract_failed"
  | "target_contract_failed";

export class HostDeckSelectedWriteGateError extends Error {
  constructor(
    readonly code: HostDeckSelectedWriteGateErrorCode,
    readonly api_code: "internal_error" | "validation_error",
    readonly stage: HostDeckSelectedWriteGateStage,
    readonly retry_safe: boolean
  ) {
    super(gateErrorMessages[code]);
    this.name = "HostDeckSelectedWriteGateError";
    Object.freeze(this);
  }
}

export interface HostDeckSelectedWriteAuthorizationContext {
  readonly actor: SelectedAuditActor;
  readonly authentication: SelectedRequestAuthenticationContext;
  readonly authorization: HostDeckCsrfAuthorizationReceipt;
  readonly deviceAuthority: HostDeckActiveDeviceAuthorityLease | null;
}

export interface HostDeckSelectedWriteTargetContext {
  readonly manifest: SelectedApiRouteManifestEntry;
  readonly authority: HostDeckSelectedWriteAuthorizationContext;
  readonly lock: HostDeckDurableLockState | null;
  readonly deadline: OperationDeadline;
}

export interface HostDeckSelectedWriteDispatchContext<
  TAction extends SelectedApiAuditAction,
  TParsedValue,
  TResolvedValue
> extends HostDeckSelectedWriteTargetContext {
  readonly mutation: HostDeckSelectedWriteMutation<TAction, TParsedValue>;
  readonly resolution: HostDeckSelectedWriteTargetResolution<TResolvedValue>;
}

export interface ExecuteHostDeckSelectedWriteGateInput<
  TAction extends SelectedApiAuditAction,
  TParsedValue,
  TResolvedValue,
  TResponse,
  TPreparedResponse
> {
  readonly request: FastifyRequest;
  readonly candidate: unknown;
  readonly parse: (
    this: void,
    candidate: unknown
  ) => HostDeckSelectedWriteMutation<TAction, TParsedValue>;
  readonly resolve_target: (
    this: void,
    mutation: HostDeckSelectedWriteMutation<TAction, TParsedValue>,
    context: HostDeckSelectedWriteTargetContext
  ) =>
    | Promise<HostDeckSelectedWriteTargetResolution<TResolvedValue>>
    | HostDeckSelectedWriteTargetResolution<TResolvedValue>;
  readonly dispatch: (
    this: void,
    context: HostDeckSelectedWriteDispatchContext<TAction, TParsedValue, TResolvedValue>
  ) => Promise<unknown> | unknown;
  readonly prepare_response: (
    this: void,
    response: TResponse
  ) => Promise<TPreparedResponse> | TPreparedResponse;
}

export interface CreateHostDeckSelectedWriteGateInput<
  TAction extends SelectedApiAuditAction
> {
  readonly manifest: SelectedApiRouteManifestEntry;
  readonly audit: HostDeckSelectedWriteAuditPort<TAction>;
  readonly csrf: HostDeckCsrfPolicy;
  readonly lock: HostDeckHostLockPolicy;
}

export interface HostDeckSelectedWriteGateSnapshot {
  readonly attempts: number;
  readonly audit_failures: number;
  readonly authorization_failures: number;
  readonly contract_failures: number;
  readonly dispatches: number;
  readonly failed_results: number;
  readonly incomplete_results: number;
  readonly lock_failures: number;
  readonly parse_failures: number;
  readonly pre_dispatch_timeouts: number;
  readonly response_preparations: number;
  readonly succeeded_results: number;
  readonly target_failures: number;
}

export interface HostDeckSelectedWriteGate<TAction extends SelectedApiAuditAction> {
  readonly execute: <TParsedValue, TResolvedValue, TResponse, TPreparedResponse>(
    input: ExecuteHostDeckSelectedWriteGateInput<
      TAction,
      TParsedValue,
      TResolvedValue,
      TResponse,
      TPreparedResponse
    >
  ) => Promise<SecurityMutationExecutionResult<TPreparedResponse>>;
  readonly snapshot: () => HostDeckSelectedWriteGateSnapshot;
}

interface MutableCounters {
  attempts: number;
  auditFailures: number;
  authorizationFailures: number;
  contractFailures: number;
  dispatches: number;
  failedResults: number;
  incompleteResults: number;
  lockFailures: number;
  parseFailures: number;
  preDispatchTimeouts: number;
  responsePreparations: number;
  succeededResults: number;
  targetFailures: number;
}

interface AuditObservation<TPreparedResponse> {
  transitionCalls: number;
  transitionOutcome: "failed" | "incomplete" | "succeeded" | null;
  transitionErrorCode: string | null;
  prepareCalls: number;
  preparedResponse: TPreparedResponse | undefined;
}

const acceptedGates = new WeakSet<object>();
const acceptedGateErrors = new WeakSet<object>();
const gateErrorMessages: Record<HostDeckSelectedWriteGateErrorCode, string> = {
  audit_contract_failed: "Selected-write audit boundary returned invalid state.",
  authorization_contract_failed: "Selected-write authorization boundary returned invalid state.",
  configuration_invalid: "Selected-write gate configuration is invalid.",
  dispatch_contract_failed: "Selected-write dispatcher returned invalid state.",
  input_invalid: "Selected-write execution input is invalid.",
  lock_contract_failed: "Selected-write lock boundary returned invalid state.",
  parse_contract_failed: "Selected-write parser returned invalid state.",
  target_contract_failed: "Selected-write target boundary returned invalid state."
};
const timeoutSummary = Object.freeze({ schema_version: 1 as const });
const maxCounter = Number.MAX_SAFE_INTEGER;

export function createHostDeckSelectedWriteGate<
  TAction extends SelectedApiAuditAction
>(input: CreateHostDeckSelectedWriteGateInput<TAction>): HostDeckSelectedWriteGate<TAction> {
  let values: Readonly<Record<"audit" | "csrf" | "lock" | "manifest", unknown>>;
  try {
    values = readExactDataObject(
      input,
      ["audit", "csrf", "lock", "manifest"],
      "HostDeck selected-write gate input is invalid."
    );
    assertHostDeckSelectedWriteAuditPort<TAction>(values.audit);
    assertHostDeckCsrfPolicy(values.csrf);
    assertHostDeckHostLockPolicy(values.lock);
  } catch {
    throw gateError("configuration_invalid", "internal_error", "configuration", false);
  }
  let manifest: SelectedApiRouteManifestEntry;
  try {
    manifest = requireSelectedWriteManifest(
      values.manifest,
      (values.audit as HostDeckSelectedWriteAuditPort<TAction>).executor
    );
  } catch {
    throw gateError("configuration_invalid", "internal_error", "configuration", false);
  }
  const implementation = new DefaultHostDeckSelectedWriteGate(
    manifest,
    values.audit as HostDeckSelectedWriteAuditPort<TAction>,
    values.csrf as HostDeckCsrfPolicy,
    values.lock as HostDeckHostLockPolicy
  );
  const gate: HostDeckSelectedWriteGate<TAction> = Object.freeze({
    execute: <TParsedValue, TResolvedValue, TResponse, TPreparedResponse>(
      execution: ExecuteHostDeckSelectedWriteGateInput<
        TAction,
        TParsedValue,
        TResolvedValue,
        TResponse,
        TPreparedResponse
      >
    ) =>
      implementation.execute<TParsedValue, TResolvedValue, TResponse, TPreparedResponse>(
        execution
      ),
    snapshot: () => implementation.snapshot()
  });
  acceptedGates.add(gate);
  return gate;
}

export function assertHostDeckSelectedWriteGate<TAction extends SelectedApiAuditAction>(
  candidate: unknown
): asserts candidate is HostDeckSelectedWriteGate<TAction> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedGates.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck selected-write gate must be created by createHostDeckSelectedWriteGate."
    );
  }
}

class DefaultHostDeckSelectedWriteGate<TAction extends SelectedApiAuditAction> {
  private readonly counters: MutableCounters = {
    attempts: 0,
    auditFailures: 0,
    authorizationFailures: 0,
    contractFailures: 0,
    dispatches: 0,
    failedResults: 0,
    incompleteResults: 0,
    lockFailures: 0,
    parseFailures: 0,
    preDispatchTimeouts: 0,
    responsePreparations: 0,
    succeededResults: 0,
    targetFailures: 0
  };

  constructor(
    private readonly manifest: SelectedApiRouteManifestEntry,
    private readonly audit: HostDeckSelectedWriteAuditPort<TAction>,
    private readonly csrf: HostDeckCsrfPolicy,
    private readonly lock: HostDeckHostLockPolicy
  ) {}

  snapshot(): HostDeckSelectedWriteGateSnapshot {
    return Object.freeze({
      attempts: this.counters.attempts,
      audit_failures: this.counters.auditFailures,
      authorization_failures: this.counters.authorizationFailures,
      contract_failures: this.counters.contractFailures,
      dispatches: this.counters.dispatches,
      failed_results: this.counters.failedResults,
      incomplete_results: this.counters.incompleteResults,
      lock_failures: this.counters.lockFailures,
      parse_failures: this.counters.parseFailures,
      pre_dispatch_timeouts: this.counters.preDispatchTimeouts,
      response_preparations: this.counters.responsePreparations,
      succeeded_results: this.counters.succeededResults,
      target_failures: this.counters.targetFailures
    });
  }

  async execute<TParsedValue, TResolvedValue, TResponse, TPreparedResponse>(
    input: ExecuteHostDeckSelectedWriteGateInput<
      TAction,
      TParsedValue,
      TResolvedValue,
      TResponse,
      TPreparedResponse
    >
  ): Promise<SecurityMutationExecutionResult<TPreparedResponse>> {
    increment(this.counters, "attempts");
    let execution: Readonly<Record<string, unknown>>;
    try {
      execution = readExactDataObject(
        input,
        ["candidate", "dispatch", "parse", "prepare_response", "request", "resolve_target"],
        "HostDeck selected-write execution input is invalid."
      );
      if (
        typeof execution.parse !== "function" ||
        typeof execution.resolve_target !== "function" ||
        typeof execution.dispatch !== "function" ||
        typeof execution.prepare_response !== "function" ||
        execution.request === null ||
        typeof execution.request !== "object"
      ) {
        throw new TypeError();
      }
    } catch {
      this.contractFailure();
      throw gateError("input_invalid", "validation_error", "input", true);
    }

    let mutation: HostDeckSelectedWriteMutation<TAction, TParsedValue>;
    try {
      mutation = Reflect.apply(execution.parse as (candidate: unknown) => unknown, undefined, [
        execution.candidate
      ]) as HostDeckSelectedWriteMutation<TAction, TParsedValue>;
      assertHostDeckSelectedWriteMutation<TAction, TParsedValue>(mutation);
      assertMutationMatchesManifest(mutation, this.manifest);
    } catch (error) {
      increment(this.counters, "parseFailures");
      throw callbackFailure(
        error,
        "parse_contract_failed",
        "parse",
        "Selected mutation input is invalid."
      );
    }

    const request = execution.request as FastifyRequest;
    let authority: HostDeckSelectedWriteAuthorizationContext;
    try {
      authority = authorizeRequest(request, this.manifest, this.csrf);
    } catch (error) {
      increment(this.counters, "authorizationFailures");
      throw ownedBoundaryFailure(error, "authorization_contract_failed", "authorization");
    }

    let lockState: HostDeckDurableLockState | null = null;
    try {
      if (this.manifest.lock === "requires_unlocked_host") {
        lockState = requireHostDeckHostUnlocked(this.lock);
      }
    } catch (error) {
      increment(this.counters, "lockFailures");
      throw ownedBoundaryFailure(error, "lock_contract_failed", "lock");
    }

    let deadline: OperationDeadline;
    try {
      deadline = hostDeckRequestDeadline(request);
      if (deadline.signal !== request.signal) throw new TypeError();
      requireOpenDeadline(deadline);
    } catch (error) {
      increment(this.counters, "targetFailures");
      throw callbackFailure(
        error,
        "target_contract_failed",
        "target",
        "Selected mutation target is unavailable."
      );
    }

    const targetContext: HostDeckSelectedWriteTargetContext = Object.freeze({
      manifest: this.manifest,
      authority,
      lock: lockState,
      deadline
    });
    let resolution: HostDeckSelectedWriteTargetResolution<TResolvedValue>;
    try {
      resolution = (await Reflect.apply(
        execution.resolve_target as (...args: unknown[]) => unknown,
        undefined,
        [mutation, targetContext]
      )) as HostDeckSelectedWriteTargetResolution<TResolvedValue>;
      assertHostDeckSelectedWriteTargetResolution<TResolvedValue>(resolution);
      assertResolutionMatchesMutation(resolution, mutation, this.manifest);
      requireOpenDeadline(deadline);
    } catch (error) {
      increment(this.counters, "targetFailures");
      if (deadline.signal.aborted) throw timeoutError();
      throw callbackFailure(
        error,
        "target_contract_failed",
        "target",
        "Selected mutation target is unavailable."
      );
    }

    const dispatchContext: HostDeckSelectedWriteDispatchContext<
      TAction,
      TParsedValue,
      TResolvedValue
    > = Object.freeze({
      ...targetContext,
      mutation,
      resolution
    });
    const observation: AuditObservation<TPreparedResponse> = {
      transitionCalls: 0,
      transitionOutcome: null,
      transitionErrorCode: null,
      prepareCalls: 0,
      preparedResponse: undefined
    };
    let auditCallbacksOpen = true;
    const transition = async (auditContext: unknown) => {
      if (!auditCallbacksOpen) {
        this.contractFailure();
        throw gateError("dispatch_contract_failed", "internal_error", "dispatch", false);
      }
      observation.transitionCalls += 1;
      if (observation.transitionCalls !== 1) {
        this.contractFailure();
        throw gateError("dispatch_contract_failed", "internal_error", "dispatch", false);
      }
      assertAcceptedAuditContext(auditContext);
      if (isDeadlineClosed(deadline)) {
        increment(this.counters, "preDispatchTimeouts");
        observation.transitionOutcome = "failed";
        observation.transitionErrorCode = "operation_timeout";
        return Object.freeze({
          outcome: "failed" as const,
          error_code: "operation_timeout" as const,
          payload_summary: timeoutSummary
        });
      }
      try {
        assertHostDeckRequestAuthenticationCurrent(request, authority.authentication);
      } catch (error) {
        if (error instanceof HostDeckHttpError && error.code === "permission_denied") {
          const revoked = parseSelectedWriteTransition<TResponse>(
            mutation.action,
            Object.freeze({
              outcome: "failed" as const,
              error_code: "permission_denied" as const,
              payload_summary: Object.freeze({ schema_version: 1 as const })
            })
          );
          if (revoked.outcome === "succeeded") throw new TypeError();
          observation.transitionOutcome = revoked.outcome;
          observation.transitionErrorCode = revoked.error_code;
          return revoked;
        }
        throw error;
      }
      increment(this.counters, "dispatches");
      let raw: unknown;
      try {
        raw = await Reflect.apply(
          execution.dispatch as (context: unknown) => unknown,
          undefined,
          [dispatchContext]
        );
      } catch (error) {
        if (isDeadlineClosed(deadline)) {
          observation.transitionOutcome = "incomplete";
          observation.transitionErrorCode = "operation_timeout";
          return Object.freeze({
            outcome: "incomplete" as const,
            error_code: "operation_timeout" as const,
            payload_summary: timeoutSummary
          });
        }
        throw error;
      }
      let parsed: ParsedSelectedWriteTransition<TResponse>;
      try {
        parsed = parseSelectedWriteTransition<TResponse>(mutation.action, raw);
      } catch {
        this.contractFailure();
        throw gateError("dispatch_contract_failed", "internal_error", "dispatch", false);
      }
      observation.transitionOutcome = parsed.outcome;
      observation.transitionErrorCode =
        parsed.outcome === "succeeded" ? null : parsed.error_code;
      return parsed;
    };
    const prepareResponse = async (response: TResponse): Promise<TPreparedResponse> => {
      if (!auditCallbacksOpen) {
        this.contractFailure();
        throw gateError("dispatch_contract_failed", "internal_error", "dispatch", false);
      }
      observation.prepareCalls += 1;
      if (observation.transitionOutcome !== "succeeded" || observation.prepareCalls !== 1) {
        this.contractFailure();
        throw gateError("dispatch_contract_failed", "internal_error", "dispatch", false);
      }
      increment(this.counters, "responsePreparations");
      observation.preparedResponse = await Reflect.apply(
        execution.prepare_response as (value: TResponse) => TPreparedResponse | Promise<TPreparedResponse>,
        undefined,
        [response]
      );
      return observation.preparedResponse;
    };

    let rawAuditResult: unknown;
    try {
      rawAuditResult = await Reflect.apply(this.audit.execute, undefined, [
        Object.freeze({
          operation_id: mutation.operation_id,
          actor: authority.actor,
          action: mutation.action,
          target: mutation.target,
          accepted_summary: mutation.accepted_summary,
          emergency_lock_on_audit_unavailable: false,
          transition,
          prepare_response: prepareResponse
        })
      ]);
    } catch (error) {
      rethrowStaleIngressFailure(request, authority.authentication);
      increment(this.counters, "auditFailures");
      if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
        throw auditExecutorFailure(error);
      }
      if (isOwnedGateError(error)) {
        throw error;
      }
      throw gateError("audit_contract_failed", "internal_error", "audit", false);
    } finally {
      auditCallbacksOpen = false;
    }

    let result: SecurityMutationExecutionResult<TPreparedResponse>;
    try {
      result = parseSelectedWriteAuditResult<TPreparedResponse>(rawAuditResult);
      if (
        observation.transitionCalls !== 1 ||
        observation.transitionOutcome !== result.outcome
      ) {
        throw new TypeError();
      }
      if (result.outcome === "succeeded") {
        if (
          observation.prepareCalls !== 1 ||
          !Object.is(result.response, observation.preparedResponse)
        ) {
          throw new TypeError();
        }
      } else if (
        observation.prepareCalls !== 0 ||
        result.error_code !== observation.transitionErrorCode
      ) {
        throw new TypeError();
      }
    } catch {
      increment(this.counters, "auditFailures");
      this.contractFailure();
      throw gateError("audit_contract_failed", "internal_error", "audit", false);
    }

    if (result.outcome === "succeeded") increment(this.counters, "succeededResults");
    else if (result.outcome === "failed") increment(this.counters, "failedResults");
    else increment(this.counters, "incompleteResults");
    return result;
  }

  private contractFailure(): void {
    increment(this.counters, "contractFailures");
  }
}

function rethrowStaleIngressFailure(
  request: FastifyRequest,
  authentication: SelectedRequestAuthenticationContext
): void {
  try {
    assertHostDeckRequestAuthenticationCurrent(request, authentication);
  } catch (error) {
    if (error instanceof HostDeckHttpError && error.code === "invalid_origin") {
      throw error;
    }
  }
}

function authorizeRequest(
  request: FastifyRequest,
  manifest: SelectedApiRouteManifestEntry,
  csrf: HostDeckCsrfPolicy
): HostDeckSelectedWriteAuthorizationContext {
  if (manifest.auth !== "local_admin_or_device_cookie") {
    throw new TypeError("Selected-write manifest authentication is invalid.");
  }
  const authentication = requireHostDeckRequestAuthentication(
    request,
    "local_admin_or_device_cookie"
  );
  requireHostDeckRequestWritePermission(authentication);
  if (authentication.state === "paired_device" && authentication.transport !== "https") {
    throw new HostDeckHttpError({
      code: "insecure_transport",
      message: "Secure request transport is required for paired mutations.",
      retryable: false,
      status: 426
    });
  }
  const authorization = requireHostDeckRequestCsrfWriteAuthorization(
    request,
    "local_admin_or_device_cookie",
    csrf
  );
  const deviceAuthority =
    authentication.state === "paired_device"
      ? requireHostDeckRequestActiveDeviceAuthority(request)
      : null;
  const actor = auditActor(authentication);
  if (authorization.authority === "local_admin") {
    if (authentication.state !== "local_admin" || authorization.device_id !== null) {
      throw new TypeError("Local-admin write authorization is contradictory.");
    }
  } else if (
    authentication.state !== "paired_device" ||
    authentication.permission !== "write" ||
    authentication.device_id !== authorization.device_id ||
    authentication.csrf_generation !== authorization.csrf_generation ||
    authorization.permission !== "write" ||
    authorization.verified_at === null
  ) {
    throw new TypeError("Paired write authorization is contradictory.");
  }
  return Object.freeze({ actor, authentication, authorization, deviceAuthority });
}

function auditActor(context: SelectedRequestAuthenticationContext): SelectedAuditActor {
  const parsed = selectedAuditActorSchema.safeParse(
    context.state === "local_admin"
      ? { type: "cli", device_id: null, permission: "local_admin", origin: null }
      : {
          type: "dashboard",
          device_id: context.device_id,
          permission: context.permission,
          origin: context.configured_origin
        }
  );
  if (!parsed.success) throw new TypeError("Selected-write audit actor is invalid.");
  return deepFreeze(parsed.data);
}

function assertMutationMatchesManifest<TAction extends SelectedApiAuditAction>(
  mutation: HostDeckSelectedWriteMutation<TAction, unknown>,
  manifest: SelectedApiRouteManifestEntry
): void {
  if (manifest.audit === null || mutation.action !== manifest.audit.action) throw new TypeError();
  const expectedTarget = expectedAuditTargetType(manifest);
  if (mutation.target.type !== expectedTarget) throw new TypeError();
}

function assertResolutionMatchesMutation<TAction extends SelectedApiAuditAction>(
  resolution: HostDeckSelectedWriteTargetResolution<unknown>,
  mutation: HostDeckSelectedWriteMutation<TAction, unknown>,
  manifest: SelectedApiRouteManifestEntry
): void {
  if (!isDeepStrictEqual(resolution.target, mutation.target)) {
    throw new TypeError("Selected-write target resolution changed the parsed target.");
  }
  if (resolution.capability !== expectedCapability(manifest)) {
    throw new TypeError("Selected-write target resolution proved the wrong capability.");
  }
}

function expectedAuditTargetType(
  manifest: SelectedApiRouteManifestEntry
): "approval" | "device" | "host" | "managed_session" | "turn" {
  switch (manifest.target) {
    case "new_managed_session":
      return "host";
    case "managed_session":
      return "managed_session";
    case "approval":
      return "approval";
    case "turn":
      return "turn";
    case "device":
      return "device";
    default:
      throw new TypeError("Selected-write manifest has no exact audit target mapping.");
  }
}

function expectedCapability(manifest: SelectedApiRouteManifestEntry): RuntimeCapability | null {
  if (manifest.operation_kind !== null) return operationCapability(manifest.operation_kind);
  if (manifest.id === "session_start") return "thread_lifecycle";
  return null;
}

function requireOpenDeadline(deadline: OperationDeadline): void {
  if (isDeadlineClosed(deadline)) throw timeoutError();
}

function isDeadlineClosed(deadline: OperationDeadline): boolean {
  return deadline.signal.aborted || deadline.remainingMs() <= 0;
}

function timeoutError(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "operation_timeout",
    message: "Selected mutation request deadline exceeded.",
    retryable: false,
    status: 504
  });
}

function auditExecutorFailure(
  error: HostDeckSecurityMutationAuditExecutorError
): HostDeckHttpError {
  return new HostDeckHttpError({
    code: error.api_code,
    message: auditFailureMessage(error.api_code),
    retryable: error.retry_safe,
    status: auditFailureStatus(error.api_code)
  });
}

function auditFailureStatus(code: ErrorCode): number {
  switch (code) {
    case "validation_error":
      return 400;
    case "permission_denied":
      return 401;
    case "read_only":
      return 403;
    case "operation_conflict":
      return 409;
    case "operation_timeout":
      return 504;
    case "audit_unavailable":
    case "runtime_unavailable":
    case "service_overloaded":
      return 503;
    default:
      return 500;
  }
}

function auditFailureMessage(code: ErrorCode): string {
  switch (code) {
    case "operation_conflict":
      return "Selected mutation conflicts with an existing operation.";
    case "audit_unavailable":
      return "Selected mutation audit is unavailable.";
    case "operation_timeout":
      return "Selected mutation audit exceeded its request deadline.";
    case "validation_error":
      return "Selected mutation audit input is invalid.";
    default:
      return "Selected mutation audit could not be completed.";
  }
}

function ownedBoundaryFailure(
  error: unknown,
  code: Exclude<HostDeckSelectedWriteGateErrorCode, "configuration_invalid" | "input_invalid">,
  stage: Exclude<HostDeckSelectedWriteGateStage, "configuration" | "input">
): Error {
  if (error instanceof HostDeckHttpError || isOwnedGateError(error)) return error;
  return gateError(code, "internal_error", stage, false);
}

function callbackFailure(
  error: unknown,
  code: Exclude<HostDeckSelectedWriteGateErrorCode, "configuration_invalid" | "input_invalid">,
  stage: "parse" | "target",
  message: string
): Error {
  if (error instanceof HostDeckHttpError) {
    return new HostDeckHttpError({
      code: error.code,
      message,
      retryable: error.envelope.retryable,
      status: error.statusCode
    });
  }
  return gateError(code, "internal_error", stage, false);
}

function isOwnedGateError(error: unknown): error is HostDeckSelectedWriteGateError {
  return (
    error instanceof HostDeckSelectedWriteGateError &&
    acceptedGateErrors.has(error)
  );
}

function gateError(
  code: HostDeckSelectedWriteGateErrorCode,
  apiCode: "internal_error" | "validation_error",
  stage: HostDeckSelectedWriteGateStage,
  retrySafe: boolean
): HostDeckSelectedWriteGateError {
  const error = new HostDeckSelectedWriteGateError(code, apiCode, stage, retrySafe);
  acceptedGateErrors.add(error);
  return error;
}

function increment(counters: MutableCounters, key: keyof MutableCounters): void {
  if (counters[key] < maxCounter) counters[key] += 1;
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
