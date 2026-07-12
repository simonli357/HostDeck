import { randomBytes } from "node:crypto";
import {
  assertResolvedResourceBudget,
  authDeviceRecordSchema,
  pairingClaimSourceKeySchema,
  pairingCodeRecordSchema,
  type ResourceBudget,
  type SelectedPairClaimRequest,
  type SelectedPairClaimResponse,
  type SelectedPairRequest,
  type SelectedPairRequestResponse,
  selectedPairClaimRequestSchema,
  selectedPairClaimResponseSchema,
  selectedPairingDeviceIdSchema,
  selectedPairingIdSchema,
  selectedPairRequestResponseSchema,
  selectedPairRequestSchema,
  selectedRawCsrfTokenSchema,
  selectedRawDeviceSecretSchema,
  selectedRawPairingCodeSchema
} from "@hostdeck/contracts";
import { type ErrorCode, isErrorCode } from "@hostdeck/core";
import {
  type ClaimSelectedPairingCodeInput,
  HostDeckAuthRepositoryError,
  hashSecret,
  type IssuePairingCodeInput
} from "@hostdeck/storage";
import { serialize as serializeCookie } from "cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  hostDeckDeviceCookieName,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  HostDeckRequestTrustError,
  hostDeckPairClaimSourceKey,
  hostDeckRequestTrustContext
} from "./fastify-request-trust.js";
import {
  assertHostDeckSecurityMutationAuditExecutor,
  HostDeckSecurityMutationAuditExecutorError,
  type SecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckPairingRouteRegistrationId = "selected-pairing";

export interface HostDeckPairingPort {
  readonly issue: (input: IssuePairingCodeInput) => unknown;
  readonly claim: (input: ClaimSelectedPairingCodeInput) => unknown;
}

export interface CreateHostDeckPairingPolicyInput {
  readonly pairing: HostDeckPairingPort;
  readonly now: () => Date;
  readonly createPairingId?: () => string;
}

export interface HostDeckPairingPolicy {
  readonly issue: HostDeckPairingPort["issue"];
  readonly claim: HostDeckPairingPort["claim"];
  readonly now: () => Date;
  readonly createPairingId: () => string;
}

export interface HostDeckPairingPolicySnapshot {
  readonly active_claims: number;
  readonly active_sources: number;
  readonly audit_failures: number;
  readonly claim_failures: number;
  readonly claim_successes: number;
  readonly global_admission_rejections: number;
  readonly issue_failures: number;
  readonly issue_successes: number;
  readonly source_admission_rejections: number;
  readonly storage_failures: number;
}

export interface CreateHostDeckPairingRouteRegistrationInput {
  readonly audit: SecurityMutationAuditExecutor;
  readonly pairing: HostDeckPairingPolicy;
}

interface MutablePairingCounters {
  auditFailures: number;
  claimFailures: number;
  claimSuccesses: number;
  globalAdmissionRejections: number;
  issueFailures: number;
  issueSuccesses: number;
  sourceAdmissionRejections: number;
  storageFailures: number;
}

interface PairClaimLimiter {
  activeGlobal: number;
  readonly activeSources: Map<string, number>;
  readonly globalLimit: number;
  readonly sourceLimit: number;
}

interface PairingPolicyRuntime {
  readonly counters: MutablePairingCounters;
  limiter: PairClaimLimiter | null;
}

interface ParsedIssuedPairing {
  readonly pairingCode: ReturnType<typeof pairingCodeRecordSchema.parse>;
  readonly rawCode: string;
}

interface ParsedPairingClaim {
  readonly device: ReturnType<typeof authDeviceRecordSchema.parse>;
  readonly pairingCode: ReturnType<typeof pairingCodeRecordSchema.parse>;
  readonly rawCsrfToken: string;
  readonly rawDeviceToken: string;
}

interface PreparedPairClaimResponse {
  readonly body: SelectedPairClaimResponse;
  readonly setCookie: string;
}

type ExecuteAudit = SecurityMutationAuditExecutor["execute"];
type IssuePairing = HostDeckPairingPort["issue"];
type ClaimPairing = HostDeckPairingPort["claim"];

const acceptedPolicies = new WeakSet<object>();
const policyRuntimes = new WeakMap<HostDeckPairingPolicy, PairingPolicyRuntime>();
const registeredPolicies = new WeakSet<object>();
const pendingPairClaimCookies = new WeakMap<FastifyRequest, string>();
const policyInputAllowedKeys = ["createPairingId", "now", "pairing"] as const;
const policyInputRequiredKeys = ["now", "pairing"] as const;
const policyPortKeys = ["claim", "issue"] as const;
const routeInputKeys = ["audit", "pairing"] as const;
const auditPortKeys = ["execute", "reject", "snapshot"] as const;
const issuedKeys = ["pairingCode", "rawCode"] as const;
const claimKeys = ["pairingCode", "device", "rawDeviceToken", "rawCsrfToken"] as const;
const pairingCodeKeys = [
  "id",
  "code_hash",
  "permission",
  "client_label",
  "created_at",
  "expires_at",
  "used_at",
  "revoked_at",
  "claim_contract_version",
  "claimed_device_id"
] as const;
const authDeviceKeys = [
  "id",
  "token_hash",
  "csrf_token_hash",
  "csrf_generation",
  "csrf_rotated_at",
  "client_label",
  "permission",
  "created_at",
  "last_used_at",
  "expires_at",
  "revoked_at"
] as const;
const claimResponseStateKeys = ["device", "rawDeviceToken"] as const;
const preparedClaimKeys = ["body", "setCookie"] as const;
const auditResultKeys = ["outcome", "response"] as const;
const auditFailureResultKeys = ["outcome", "error_code"] as const;
const noPairingQuerySchema = z.object({}).strict();
const maxCounter = Number.MAX_SAFE_INTEGER;

class HostDeckPairingContractError extends Error {
  constructor() {
    super("Selected pairing route contract failed.");
    this.name = "HostDeckPairingContractError";
  }
}

export function createHostDeckPairingPolicy(
  input: CreateHostDeckPairingPolicyInput
): HostDeckPairingPolicy {
  const values = readDataObjectWithOptionalKeys(
    input,
    policyInputAllowedKeys,
    policyInputRequiredKeys,
    "HostDeck pairing policy input is invalid."
  );
  const port = readExactDataObject(
    values.pairing,
    policyPortKeys,
    "HostDeck pairing port is invalid."
  );
  if (
    typeof port.issue !== "function" ||
    typeof port.claim !== "function" ||
    typeof values.now !== "function" ||
    (values.createPairingId !== undefined && typeof values.createPairingId !== "function")
  ) {
    throw new TypeError("HostDeck pairing policy ports are invalid.");
  }
  const policy = Object.freeze({
    issue: port.issue as IssuePairing,
    claim: port.claim as ClaimPairing,
    now: values.now as () => Date,
    createPairingId: (values.createPairingId ?? defaultPairingId) as () => string
  });
  acceptedPolicies.add(policy);
  policyRuntimes.set(policy, {
    counters: {
      auditFailures: 0,
      claimFailures: 0,
      claimSuccesses: 0,
      globalAdmissionRejections: 0,
      issueFailures: 0,
      issueSuccesses: 0,
      sourceAdmissionRejections: 0,
      storageFailures: 0
    },
    limiter: null
  });
  return policy;
}

export function assertHostDeckPairingPolicy(
  candidate: unknown
): asserts candidate is HostDeckPairingPolicy {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedPolicies.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck pairing policy must be created by createHostDeckPairingPolicy."
    );
  }
}

export function hostDeckPairingPolicySnapshot(
  policy: HostDeckPairingPolicy
): HostDeckPairingPolicySnapshot {
  assertHostDeckPairingPolicy(policy);
  const runtime = requireRuntime(policy);
  return Object.freeze({
    active_claims: runtime.limiter?.activeGlobal ?? 0,
    active_sources: runtime.limiter?.activeSources.size ?? 0,
    audit_failures: runtime.counters.auditFailures,
    claim_failures: runtime.counters.claimFailures,
    claim_successes: runtime.counters.claimSuccesses,
    global_admission_rejections: runtime.counters.globalAdmissionRejections,
    issue_failures: runtime.counters.issueFailures,
    issue_successes: runtime.counters.issueSuccesses,
    source_admission_rejections: runtime.counters.sourceAdmissionRejections,
    storage_failures: runtime.counters.storageFailures
  });
}

export function createHostDeckPairingRouteRegistration(
  input: CreateHostDeckPairingRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    routeInputKeys,
    "HostDeck pairing route input is invalid."
  );
  assertHostDeckPairingPolicy(values.pairing);
  assertHostDeckSecurityMutationAuditExecutor(values.audit);
  const audit = readExactFrozenDataObject(values.audit, auditPortKeys);
  if (
    typeof audit.execute !== "function" ||
    typeof audit.reject !== "function" ||
    typeof audit.snapshot !== "function"
  ) {
    throw new TypeError("HostDeck security audit executor is invalid.");
  }
  const policy = values.pairing;
  if (registeredPolicies.has(policy)) {
    throw new TypeError("HostDeck pairing policy already owns a route registration.");
  }
  const issueManifest = requirePairRequestManifestEntry();
  const claimManifest = requirePairClaimManifestEntry();
  const execute = audit.execute as ExecuteAudit;
  let registered = false;
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckPairingRouteRegistrationId,
    surface: "api",
    register(app, context) {
      if (registered) throw new TypeError("HostDeck pairing routes are already registered.");
      assertResolvedResourceBudget(context.resourceBudget);
      registered = true;
      installPairClaimLimiter(policy, context.resourceBudget);

      app.post(
        issueManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(request, reply) {
            applyNoStore(reply);
            requireHostDeckRequestAuthentication(request, "local_admin");
          },
          schema: {
            body: selectedPairRequestSchema,
            querystring: noPairingQuerySchema,
            response: { 200: selectedPairRequestResponseSchema }
          }
        },
        async (request) => {
          requireHostDeckRequestAuthentication(request, "local_admin");
          return executePairRequest(
            execute,
            policy,
            context.resourceBudget,
            request.body as SelectedPairRequest
          );
        }
      );

      app.post(
        claimManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(request, reply) {
            applyNoStore(reply);
            requirePairClaimTrust(request);
          },
          async onRequestAbort(request) {
            pendingPairClaimCookies.delete(request);
          },
          async onError(request, reply) {
            pendingPairClaimCookies.delete(request);
            reply.removeHeader("set-cookie");
          },
          async onSend(request, reply, payload) {
            const setCookie = pendingPairClaimCookies.get(request);
            pendingPairClaimCookies.delete(request);
            if (setCookie !== undefined && reply.statusCode >= 200 && reply.statusCode < 300) {
              reply.header("set-cookie", setCookie);
            } else {
              reply.removeHeader("set-cookie");
            }
            return payload;
          },
          async onResponse(request) {
            pendingPairClaimCookies.delete(request);
          },
          schema: {
            body: selectedPairClaimRequestSchema,
            querystring: noPairingQuerySchema,
            response: { 200: selectedPairClaimResponseSchema }
          }
        },
        async (request) => {
          const trust = requirePairClaimTrust(request);
          const sourceKey = requirePairClaimSource(request);
          const lease = acquirePairClaim(policy, sourceKey);
          try {
            const prepared = await executePairClaim(
              execute,
              policy,
              context.resourceBudget,
              request.body as SelectedPairClaimRequest,
              trust.configured_origin,
              sourceKey
            );
            pendingPairClaimCookies.set(request, prepared.setCookie);
            return prepared.body;
          } finally {
            lease.release();
          }
        }
      );
    }
  };
  registeredPolicies.add(policy);
  return Object.freeze(registration);
}

async function executePairRequest(
  execute: ExecuteAudit,
  policy: HostDeckPairingPolicy,
  budget: ResourceBudget,
  request: SelectedPairRequest
): Promise<SelectedPairRequestResponse> {
  let createdAt: Date;
  let expiresAt: Date;
  try {
    createdAt = readPolicyNow(policy);
    expiresAt = addMilliseconds(
      createdAt,
      budget.pairing_code_lifetime_ms,
      false
    );
  } catch {
    throw pairingContractFailure();
  }
  const runtime = requireRuntime(policy);
  let rawResult: unknown;
  try {
    rawResult = await Reflect.apply(execute, undefined, [
      {
        operation_id: request.operation_id,
        actor: {
          type: "cli",
          device_id: null,
          permission: "local_admin",
          origin: null
        },
        action: "pair_request",
        target: { type: "host", host_id: "local_host" },
        accepted_summary: {
          schema_version: 1,
          permission: request.permission,
          client_label_present: request.client_label !== undefined,
          expires_at: expiresAt.toISOString()
        },
        emergency_lock_on_audit_unavailable: false,
        transition: () =>
          issuePairingCode(policy, budget, request, createdAt, expiresAt),
        prepare_response: preparePairRequestResponse
      }
    ]);
  } catch (error) {
    if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
      runtime.counters.auditFailures = increment(runtime.counters.auditFailures);
      throw publicPairingFailure(error.api_code, error.retry_safe);
    }
    runtime.counters.auditFailures = increment(runtime.counters.auditFailures);
    throw pairingContractFailure();
  }
  const result = parseAuditResult(rawResult);
  if (result.outcome === "succeeded") {
    return parsePreparedPairRequestResponse(result.response);
  }
  throw publicPairingFailure(result.error_code, isRetryablePairingCode(result.error_code));
}

function issuePairingCode(
  policy: HostDeckPairingPolicy,
  budget: ResourceBudget,
  request: SelectedPairRequest,
  createdAt: Date,
  expiresAt: Date
): Readonly<Record<string, unknown>> {
  const runtime = requireRuntime(policy);
  let dispatchAt: Date;
  try {
    dispatchAt = readPolicyNow(policy);
  } catch {
    return failedTransition("incomplete", "internal_error");
  }
  if (dispatchAt.getTime() < createdAt.getTime()) {
    runtime.counters.issueFailures = increment(runtime.counters.issueFailures);
    return failedTransition("failed", "operation_conflict");
  }
  if (expiresAt.getTime() - dispatchAt.getTime() < budget.pair_claim_window_ms) {
    runtime.counters.issueFailures = increment(runtime.counters.issueFailures);
    return failedTransition("failed", "operation_timeout");
  }

  let pairingId: string;
  try {
    pairingId = Reflect.apply(policy.createPairingId, undefined, []);
    if (!selectedPairingIdSchema.safeParse(pairingId).success) throw new TypeError();
  } catch {
    runtime.counters.issueFailures = increment(runtime.counters.issueFailures);
    return failedTransition("incomplete", "internal_error");
  }

  let raw: unknown;
  try {
    raw = Reflect.apply(policy.issue, undefined, [
      Object.freeze({
        id: pairingId,
        permission: request.permission,
        clientLabel: request.client_label ?? null,
        createdAt: new Date(createdAt.getTime())
      })
    ]);
  } catch (error) {
    const mapped = mapPairIssueFailure(error, runtime.counters);
    return failedTransition(mapped.outcome, mapped.errorCode);
  }

  let issued: ParsedIssuedPairing;
  try {
    issued = parseIssuedPairing(raw);
    if (
      issued.pairingCode.id !== pairingId ||
      issued.pairingCode.permission !== request.permission ||
      issued.pairingCode.client_label !== (request.client_label ?? null) ||
      issued.pairingCode.created_at !== createdAt.toISOString() ||
      issued.pairingCode.expires_at !== expiresAt.toISOString() ||
      issued.pairingCode.used_at !== null ||
      issued.pairingCode.revoked_at !== null ||
      issued.pairingCode.claim_contract_version !== 1 ||
      issued.pairingCode.claimed_device_id !== null ||
      issued.pairingCode.code_hash !==
        hashSecret(issued.rawCode, {
          label: "Selected pairing code",
          minLength: 22
        })
    ) {
      throw new TypeError();
    }
  } catch {
    runtime.counters.issueFailures = increment(runtime.counters.issueFailures);
    runtime.counters.storageFailures = increment(runtime.counters.storageFailures);
    return failedTransition("incomplete", "internal_error");
  }
  runtime.counters.issueSuccesses = increment(runtime.counters.issueSuccesses);
  return Object.freeze({
    outcome: "succeeded",
    response: issued,
    payload_summary: Object.freeze({ schema_version: 1, pairing_id: pairingId })
  });
}

async function executePairClaim(
  execute: ExecuteAudit,
  policy: HostDeckPairingPolicy,
  budget: ResourceBudget,
  request: SelectedPairClaimRequest,
  origin: string,
  sourceKey: string
): Promise<PreparedPairClaimResponse> {
  const runtime = requireRuntime(policy);
  let rawResult: unknown;
  try {
    rawResult = await Reflect.apply(execute, undefined, [
      {
        operation_id: request.operation_id,
        actor: {
          type: "pairing_client",
          device_id: null,
          permission: null,
          origin
        },
        action: "pair_claim",
        target: { type: "host", host_id: "local_host" },
        accepted_summary: {
          schema_version: 1,
          client_label_present: request.client_label !== undefined
        },
        emergency_lock_on_audit_unavailable: false,
        transition: () => claimPairingCode(policy, budget, request, sourceKey),
        prepare_response: preparePairClaimResponse
      }
    ]);
  } catch (error) {
    if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
      runtime.counters.auditFailures = increment(runtime.counters.auditFailures);
      throw publicPairingFailure(error.api_code, error.retry_safe);
    }
    runtime.counters.auditFailures = increment(runtime.counters.auditFailures);
    throw pairingContractFailure();
  }
  const result = parseAuditResult(rawResult);
  if (result.outcome === "succeeded") return parsePreparedPairClaimResponse(result.response);
  throw publicPairingFailure(result.error_code, isRetryablePairingCode(result.error_code));
}

async function claimPairingCode(
  policy: HostDeckPairingPolicy,
  budget: ResourceBudget,
  request: SelectedPairClaimRequest,
  sourceKey: string
): Promise<Readonly<Record<string, unknown>>> {
  const runtime = requireRuntime(policy);
  let now: Date;
  let deviceExpiresAt: Date;
  try {
    now = readPolicyNow(policy);
    deviceExpiresAt = addMilliseconds(now, budget.paired_device_lifetime_ms, true);
  } catch {
    runtime.counters.claimFailures = increment(runtime.counters.claimFailures);
    return failedTransition("incomplete", "internal_error");
  }

  let raw: unknown;
  try {
    raw = await Reflect.apply(policy.claim, undefined, [
      Object.freeze({
        rawCode: request.code,
        sourceKey,
        now: new Date(now.getTime()),
        clientLabel: request.client_label ?? null,
        deviceExpiresAt: new Date(deviceExpiresAt.getTime())
      })
    ]);
  } catch (error) {
    const mapped = mapPairClaimFailure(error, runtime.counters);
    return failedTransition(mapped.outcome, mapped.errorCode);
  }

  let claim: ParsedPairingClaim;
  try {
    claim = parsePairingClaim(raw);
    const expectedLabel = request.client_label ?? claim.pairingCode.client_label;
    if (
      claim.pairingCode.permission !== claim.device.permission ||
      claim.pairingCode.used_at !== now.toISOString() ||
      claim.pairingCode.revoked_at !== null ||
      claim.pairingCode.claim_contract_version !== 1 ||
      claim.pairingCode.claimed_device_id !== claim.device.id ||
      claim.device.client_label !== expectedLabel ||
      claim.device.created_at !== now.toISOString() ||
      claim.device.last_used_at !== null ||
      claim.device.expires_at !== deviceExpiresAt.toISOString() ||
      claim.device.revoked_at !== null ||
      claim.device.csrf_generation !== 1 ||
      claim.device.csrf_rotated_at !== now.toISOString() ||
      claim.rawDeviceToken === claim.rawCsrfToken ||
      claim.pairingCode.code_hash !==
        hashSecret(request.code, {
          label: "Selected pairing code",
          minLength: 22
        }) ||
      claim.device.token_hash !==
        hashSecret(claim.rawDeviceToken, {
          label: "Selected device token",
          minLength: 43
        }) ||
      claim.device.csrf_token_hash !==
        hashSecret(claim.rawCsrfToken, {
          label: "Selected CSRF token",
          minLength: 43
        })
    ) {
      throw new TypeError();
    }
  } catch {
    runtime.counters.claimFailures = increment(runtime.counters.claimFailures);
    runtime.counters.storageFailures = increment(runtime.counters.storageFailures);
    return failedTransition("incomplete", "internal_error");
  }
  runtime.counters.claimSuccesses = increment(runtime.counters.claimSuccesses);
  return Object.freeze({
    outcome: "succeeded",
    response: Object.freeze({
      device: claim.device,
      rawDeviceToken: claim.rawDeviceToken
    }),
    payload_summary: Object.freeze({
      schema_version: 1,
      permission: claim.device.permission,
      device_created: true,
      device_id: claim.device.id
    })
  });
}

function preparePairRequestResponse(candidate: unknown): SelectedPairRequestResponse {
  const issued = parseIssuedPairing(candidate);
  const parsed = selectedPairRequestResponseSchema.safeParse({
    pairing_id: issued.pairingCode.id,
    code: issued.rawCode,
    permission: issued.pairingCode.permission,
    client_label: issued.pairingCode.client_label,
    created_at: issued.pairingCode.created_at,
    expires_at: issued.pairingCode.expires_at
  });
  if (!parsed.success) throw new TypeError("Pairing-code response is invalid.");
  return Object.freeze({ ...parsed.data });
}

function preparePairClaimResponse(candidate: unknown): PreparedPairClaimResponse {
  const values = readExactFrozenDataObject(candidate, claimResponseStateKeys);
  const device = parseFrozenAuthDevice(values.device);
  const token = selectedRawDeviceSecretSchema.safeParse(values.rawDeviceToken);
  if (!token.success || device.expires_at === null) {
    throw new TypeError("Pair-claim response state is invalid.");
  }
  const bodyResult = selectedPairClaimResponseSchema.safeParse({
    device_id: device.id,
    permission: device.permission,
    client_label: device.client_label,
    created_at: device.created_at,
    expires_at: device.expires_at,
    csrf_bootstrap_required: true
  });
  if (!bodyResult.success) throw new TypeError("Pair-claim response is invalid.");
  const expiry = new Date(device.expires_at);
  const setCookie = serializeCookie(hostDeckDeviceCookieName, token.data, {
    path: "/",
    expires: expiry,
    httpOnly: true,
    secure: true,
    sameSite: "strict"
  });
  const expected = `${hostDeckDeviceCookieName}=${token.data}; Path=/; Expires=${expiry.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
  if (setCookie !== expected || /[\r\n]/u.test(setCookie)) {
    throw new TypeError("Pair-claim cookie serialization is invalid.");
  }
  return Object.freeze({
    body: Object.freeze({ ...bodyResult.data }),
    setCookie
  });
}

function parsePreparedPairRequestResponse(candidate: unknown): SelectedPairRequestResponse {
  const values = readExactFrozenDataObject(candidate, [
    "pairing_id",
    "code",
    "permission",
    "client_label",
    "created_at",
    "expires_at"
  ] as const);
  const parsed = selectedPairRequestResponseSchema.safeParse(values);
  if (!parsed.success) throw pairingContractFailure();
  return Object.freeze({ ...parsed.data });
}

function parsePreparedPairClaimResponse(candidate: unknown): PreparedPairClaimResponse {
  const values = readExactFrozenDataObject(candidate, preparedClaimKeys);
  const bodyValues = readExactFrozenDataObject(values.body, [
    "device_id",
    "permission",
    "client_label",
    "created_at",
    "expires_at",
    "csrf_bootstrap_required"
  ] as const);
  const body = selectedPairClaimResponseSchema.safeParse(bodyValues);
  if (!body.success || typeof values.setCookie !== "string") {
    throw pairingContractFailure();
  }
  const expiry = new Date(body.data.expires_at);
  const cookiePrefix = `${hostDeckDeviceCookieName}=`;
  const suffix = `; Path=/; Expires=${expiry.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
  const rawToken =
    values.setCookie.startsWith(cookiePrefix) && values.setCookie.endsWith(suffix)
      ? values.setCookie.slice(cookiePrefix.length, -suffix.length)
      : null;
  if (
    !selectedRawDeviceSecretSchema.safeParse(rawToken).success ||
    /[\r\n]/u.test(values.setCookie)
  ) {
    throw pairingContractFailure();
  }
  return Object.freeze({
    body: Object.freeze({ ...body.data }),
    setCookie: values.setCookie
  });
}

function parseIssuedPairing(candidate: unknown): ParsedIssuedPairing {
  const values = readExactFrozenDataObject(candidate, issuedKeys);
  const pairingCode = parseFrozenPairingCode(values.pairingCode);
  const rawCode = selectedRawPairingCodeSchema.safeParse(values.rawCode);
  if (!rawCode.success || !selectedPairingIdSchema.safeParse(pairingCode.id).success) {
    throw new TypeError("Issued pairing result is invalid.");
  }
  return Object.freeze({ pairingCode, rawCode: rawCode.data });
}

function parsePairingClaim(candidate: unknown): ParsedPairingClaim {
  const values = readExactFrozenDataObject(candidate, claimKeys);
  const pairingCode = parseFrozenPairingCode(values.pairingCode);
  const device = parseFrozenAuthDevice(values.device);
  const rawDeviceToken = selectedRawDeviceSecretSchema.safeParse(values.rawDeviceToken);
  const rawCsrfToken = selectedRawCsrfTokenSchema.safeParse(values.rawCsrfToken);
  if (
    !rawDeviceToken.success ||
    !rawCsrfToken.success ||
    !selectedPairingDeviceIdSchema.safeParse(device.id).success
  ) {
    throw new TypeError("Pairing claim result is invalid.");
  }
  return Object.freeze({
    pairingCode,
    device,
    rawDeviceToken: rawDeviceToken.data,
    rawCsrfToken: rawCsrfToken.data
  });
}

function parseFrozenPairingCode(candidate: unknown) {
  const values = readExactFrozenDataObject(candidate, pairingCodeKeys);
  const parsed = pairingCodeRecordSchema.safeParse(values);
  if (!parsed.success) throw new TypeError("Selected pairing-code result is invalid.");
  return Object.freeze({ ...parsed.data });
}

function parseFrozenAuthDevice(candidate: unknown) {
  const values = readExactFrozenDataObject(candidate, authDeviceKeys);
  const parsed = authDeviceRecordSchema.safeParse(values);
  if (!parsed.success) throw new TypeError("Selected auth-device result is invalid.");
  return Object.freeze({ ...parsed.data });
}

function parseAuditResult(candidate: unknown):
  | Readonly<{ outcome: "succeeded"; response: unknown }>
  | Readonly<{ outcome: "failed" | "incomplete"; error_code: ErrorCode }> {
  let values: Readonly<Record<string, unknown>>;
  try {
    values = readExactFrozenVariant(candidate, [
      auditResultKeys,
      auditFailureResultKeys
    ]);
  } catch {
    throw pairingContractFailure();
  }
  if (values.outcome === "succeeded") {
    return Object.freeze({ outcome: "succeeded", response: values.response });
  }
  if (
    (values.outcome === "failed" || values.outcome === "incomplete") &&
    typeof values.error_code === "string" &&
    isErrorCode(values.error_code)
  ) {
    return Object.freeze({
      outcome: values.outcome,
      error_code: values.error_code
    });
  }
  throw pairingContractFailure();
}

function mapPairIssueFailure(
  error: unknown,
  counters: MutablePairingCounters
): { readonly outcome: "failed" | "incomplete"; readonly errorCode: ErrorCode } {
  counters.issueFailures = increment(counters.issueFailures);
  if (error instanceof HostDeckAuthRepositoryError) {
    if (error.code === "pairing_code_exists") {
      return { outcome: "failed", errorCode: "operation_conflict" };
    }
    if (error.code === "invalid_time") {
      return { outcome: "failed", errorCode: "operation_conflict" };
    }
  }
  counters.storageFailures = increment(counters.storageFailures);
  return { outcome: "incomplete", errorCode: "storage_error" };
}

function mapPairClaimFailure(
  error: unknown,
  counters: MutablePairingCounters
): { readonly outcome: "failed" | "incomplete"; readonly errorCode: ErrorCode } {
  counters.claimFailures = increment(counters.claimFailures);
  if (error instanceof HostDeckAuthRepositoryError) {
    switch (error.code) {
      case "pairing_code_expired":
      case "pairing_code_legacy":
      case "pairing_code_not_found":
      case "pairing_code_revoked":
      case "pairing_code_used":
        return { outcome: "failed", errorCode: "permission_denied" };
      case "pairing_claim_rate_limited":
        return { outcome: "failed", errorCode: "rate_limited" };
      case "pairing_claim_capacity":
        return { outcome: "failed", errorCode: "service_overloaded" };
      case "pairing_claim_time_conflict":
        return { outcome: "failed", errorCode: "operation_conflict" };
    }
  }
  counters.storageFailures = increment(counters.storageFailures);
  return { outcome: "incomplete", errorCode: "storage_error" };
}

function failedTransition(
  outcome: "failed" | "incomplete",
  errorCode: ErrorCode
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    outcome,
    error_code: errorCode,
    payload_summary: Object.freeze({ schema_version: 1 })
  });
}

function installPairClaimLimiter(
  policy: HostDeckPairingPolicy,
  budget: ResourceBudget
): void {
  const runtime = requireRuntime(policy);
  if (runtime.limiter !== null) throw new TypeError("HostDeck pair-claim limiter is already installed.");
  runtime.limiter = {
    activeGlobal: 0,
    activeSources: new Map(),
    globalLimit: budget.pair_claim_max_in_flight,
    sourceLimit: budget.pair_claim_max_in_flight_per_source
  };
}

function acquirePairClaim(
  policy: HostDeckPairingPolicy,
  sourceKey: string
): Readonly<{ release: () => void }> {
  const runtime = requireRuntime(policy);
  const limiter = runtime.limiter;
  if (limiter === null) throw pairingContractFailure();
  const sourceCount = limiter.activeSources.get(sourceKey) ?? 0;
  if (sourceCount >= limiter.sourceLimit) {
    runtime.counters.sourceAdmissionRejections = increment(
      runtime.counters.sourceAdmissionRejections
    );
    throw serviceOverloaded();
  }
  if (limiter.activeGlobal >= limiter.globalLimit) {
    runtime.counters.globalAdmissionRejections = increment(
      runtime.counters.globalAdmissionRejections
    );
    throw serviceOverloaded();
  }
  limiter.activeSources.set(sourceKey, sourceCount + 1);
  limiter.activeGlobal += 1;
  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      const current = limiter.activeSources.get(sourceKey);
      if (current === undefined || current < 1 || limiter.activeGlobal < 1) {
        limiter.activeSources.delete(sourceKey);
        limiter.activeGlobal = Math.max(0, limiter.activeGlobal - 1);
        throw pairingContractFailure();
      }
      if (current === 1) limiter.activeSources.delete(sourceKey);
      else limiter.activeSources.set(sourceKey, current - 1);
      limiter.activeGlobal -= 1;
    }
  });
}

function requirePairClaimTrust(request: FastifyRequest) {
  const trust = hostDeckRequestTrustContext(request);
  if (trust.transport !== "https") {
    throw new HostDeckHttpError({
      code: "insecure_transport",
      message: "Secure request transport is required for pairing claim.",
      retryable: false,
      status: 426
    });
  }
  if (trust.origin_kind !== "same_origin") throw invalidPairClaimOrigin();
  requirePairClaimSource(request);
  return trust;
}

function requirePairClaimSource(request: FastifyRequest): string {
  try {
    const sourceKey = hostDeckPairClaimSourceKey(request);
    if (!pairingClaimSourceKeySchema.safeParse(sourceKey).success) throw new TypeError();
    return sourceKey;
  } catch (error) {
    if (error instanceof HostDeckRequestTrustError) throw invalidPairClaimOrigin();
    throw invalidPairClaimOrigin();
  }
}

function requirePairRequestManifestEntry(): SelectedApiRouteManifestEntry {
  const entry = uniqueManifestEntry("pair_request");
  const audit = entry.audit;
  if (
    entry.family !== "access" ||
    entry.method !== "POST" ||
    entry.path !== "/api/v1/access/pairing-codes" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== null ||
    entry.request.body !== "pair_request_v1" ||
    entry.response.success !== "pair_request_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "local_admin" ||
    entry.authority !== "local_admin" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "host" ||
    entry.operation_kind !== null ||
    audit === null ||
    audit.executor !== "security_executor" ||
    audit.action !== "pair_request" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "access.createPairingCode" ||
    entry.owner_task !== "IFC-V1-028"
  ) {
    throw new TypeError("Selected pair-request manifest entry is invalid.");
  }
  return entry;
}

function requirePairClaimManifestEntry(): SelectedApiRouteManifestEntry {
  const entry = uniqueManifestEntry("pair_claim");
  const audit = entry.audit;
  if (
    entry.family !== "access" ||
    entry.method !== "POST" ||
    entry.path !== "/api/v1/access/pairing-claims" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== null ||
    entry.request.body !== "pair_claim_v1" ||
    entry.response.success !== "pair_claim_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "pairing_code" ||
    entry.authority !== "pair_claim" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "host" ||
    entry.operation_kind !== null ||
    audit === null ||
    audit.executor !== "security_executor" ||
    audit.action !== "pair_claim" ||
    audit.catalog_state !== "selected" ||
    audit.catalog_owner_task !== null ||
    entry.credential_effect !== "set_device_cookie" ||
    entry.handler !== "access.claimPairingCode" ||
    entry.owner_task !== "IFC-V1-028"
  ) {
    throw new TypeError("Selected pair-claim manifest entry is invalid.");
  }
  return entry;
}

function uniqueManifestEntry(id: "pair_request" | "pair_claim"): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.audit === null ||
    !Object.isFrozen(entry.audit)
  ) {
    throw new TypeError(`Selected ${id} manifest entry is invalid.`);
  }
  return entry;
}

function publicPairingFailure(code: ErrorCode, retryable: boolean): HostDeckHttpError {
  const status =
    code === "permission_denied"
      ? 401
      : code === "rate_limited"
        ? 429
        : code === "operation_conflict"
          ? 409
          : code === "operation_timeout"
            ? 504
            : code === "audit_unavailable" ||
                code === "runtime_unavailable" ||
                code === "service_overloaded"
              ? 503
              : code === "validation_error"
                ? 400
                : 500;
  const message =
    code === "permission_denied"
      ? "Pairing claim was not accepted."
      : code === "rate_limited"
        ? "Pairing claim rate is exhausted."
        : code === "service_overloaded"
          ? "Pairing claim capacity is exhausted."
          : code === "operation_conflict"
            ? "Pairing operation conflicts with current state."
            : code === "operation_timeout"
              ? "Pairing operation expired before dispatch."
              : code === "audit_unavailable"
                ? "Pairing audit is unavailable."
                : code === "storage_error"
                  ? "Pairing storage is unavailable."
                  : "Pairing operation failed.";
  return new HostDeckHttpError({ code, message, retryable, status });
}

function invalidPairClaimOrigin(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "invalid_origin",
    message: "Request origin is not permitted.",
    retryable: false,
    status: 403
  });
}

function serviceOverloaded(): HostDeckHttpError {
  return new HostDeckHttpError({
    code: "service_overloaded",
    message: "Pairing claim capacity is exhausted.",
    retryable: true,
    status: 503
  });
}

function isRetryablePairingCode(code: ErrorCode): boolean {
  return code === "rate_limited" || code === "service_overloaded";
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function readPolicyNow(policy: HostDeckPairingPolicy): Date {
  let raw: unknown;
  try {
    raw = Reflect.apply(policy.now, undefined, []);
  } catch {
    throw pairingContractFailure();
  }
  if (!(raw instanceof Date)) throw pairingContractFailure();
  let time: number;
  try {
    time = Date.prototype.getTime.call(raw);
  } catch {
    throw pairingContractFailure();
  }
  if (!Number.isFinite(time)) throw pairingContractFailure();
  return new Date(time);
}

function addMilliseconds(start: Date, milliseconds: number, floorToSecond: boolean): Date {
  const raw = start.getTime() + milliseconds;
  if (!Number.isSafeInteger(raw)) throw pairingContractFailure();
  const time = floorToSecond ? Math.floor(raw / 1_000) * 1_000 : raw;
  const result = new Date(time);
  if (!Number.isFinite(result.getTime()) || result.getTime() <= start.getTime()) {
    throw pairingContractFailure();
  }
  return result;
}

function defaultPairingId(): string {
  return `pair_${randomBytes(18).toString("base64url")}`;
}

function requireRuntime(policy: HostDeckPairingPolicy): PairingPolicyRuntime {
  const runtime = policyRuntimes.get(policy);
  if (runtime === undefined) throw new TypeError("HostDeck pairing policy runtime is unavailable.");
  return runtime;
}

function pairingContractFailure(): HostDeckPairingContractError {
  return new HostDeckPairingContractError();
}

function increment(value: number): number {
  return value < maxCounter ? value + 1 : value;
}

function readDataObjectWithOptionalKeys<const Key extends string>(
  candidate: unknown,
  allowedKeys: readonly Key[],
  requiredKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    const values = readDataObject(candidate, message);
    const keys = Object.keys(values);
    if (
      keys.some((key) => !(allowedKeys as readonly string[]).includes(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(values, key))
    ) {
      throw new TypeError();
    }
    return values as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    const values = readDataObject(candidate, message);
    const keys = Object.keys(values);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => !(expectedKeys as readonly string[]).includes(key))
    ) {
      throw new TypeError();
    }
    return values as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}

function readExactFrozenDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  if (!Object.isFrozen(candidate)) throw new TypeError();
  return readExactDataObject(candidate, expectedKeys, "Selected pairing result is invalid.");
}

function readExactFrozenVariant(
  candidate: unknown,
  variants: readonly (readonly string[])[]
): Readonly<Record<string, unknown>> {
  if (!Object.isFrozen(candidate)) throw new TypeError();
  const values = readDataObject(candidate, "Selected pairing result is invalid.");
  const keys = Object.keys(values).sort();
  if (
    !variants.some((variant) => {
      const expected = [...variant].sort();
      return expected.length === keys.length && expected.every((key, index) => key === keys[index]);
    })
  ) {
    throw new TypeError();
  }
  return values;
}

function readDataObject(
  candidate: unknown,
  message: string
): Readonly<Record<string, unknown>> {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    throw new TypeError(message);
  }
}
