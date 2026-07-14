import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  hostDeckLoopbackOriginSchema,
  type RemoteProxyTrustDecision,
  type RequestIngressProvenance,
  remoteExternalOriginSchema,
  remoteProxyTrustDecisionSchema,
  remoteProxyTrustRejectionReasons,
  resourceBudgetDefinitionByKey,
  tailscaleForwardingHeaderNames,
  tailscaleStandardIdentityHeaderNames,
  tailscaleUntrustedHeaderPrefix
} from "@hostdeck/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { installHostDeckCorsResponseGuard } from "./fastify-cors-response-guard.js";
import { type HostDeckInternalErrorObserver, sendHostDeckError } from "./fastify-error-policy.js";
import {
  createHostDeckRequestTrustPolicy,
  evaluateHostDeckRequestTrust,
  HostDeckRequestTrustError,
  type HostDeckRequestTrustPolicy,
  type HostDeckRequestTrustProbe,
  hostDeckLocalAdminRequestHeaderName
} from "./fastify-request-trust.js";

export interface TailscaleServeRemoteAdmissionSnapshot {
  readonly admission: "open" | "closed";
  readonly external_origin: string | null;
  readonly generation: number;
}

export interface TailscaleServeProxyTrustLimitsInput {
  readonly http_headers_max_bytes?: number;
  readonly http_headers_max_count?: number;
  readonly http_url_max_bytes?: number;
}

export interface CreateTailscaleServeProxyTrustPolicyInput {
  readonly limits?: TailscaleServeProxyTrustLimitsInput;
  readonly localOrigin: string;
  readonly readRemoteAdmission: () => unknown;
}

export interface TailscaleServeProxyTrustLimits {
  readonly http_headers_max_bytes: number;
  readonly http_headers_max_count: number;
  readonly http_url_max_bytes: number;
}

export interface TailscaleServeProxyTrustPolicy {
  readonly limits: TailscaleServeProxyTrustLimits;
  readonly local_origin: string;
}

export type TailscaleServeProxyTrustProbe = HostDeckRequestTrustProbe;

export type TailscaleServeProxyTrustRejectionReason =
  (typeof remoteProxyTrustRejectionReasons)[number];

export interface TailscaleServeProxyTrustSnapshot {
  readonly accepted_local_requests: number;
  readonly accepted_remote_requests: number;
  readonly cors_response_violations: number;
  readonly rejected_requests: Readonly<Record<TailscaleServeProxyTrustRejectionReason, number>>;
  readonly stale_remote_context_rejections: number;
}

export interface TailscaleServeRequestTrustContext {
  readonly origin_kind: "same_origin" | "safe_no_origin" | "local_non_browser";
  readonly provenance: RequestIngressProvenance;
}

export class TailscaleServeRequestIngressError extends Error {
  readonly code = "remote_generation_stale" as const;

  constructor() {
    super("Tailscale Serve request ingress is no longer current.");
    this.name = "TailscaleServeRequestIngressError";
    Object.freeze(this);
  }
}

interface ProxyTrustPolicyRuntime {
  readonly localPolicy: HostDeckRequestTrustPolicy;
  readonly readRemoteAdmission: () => unknown;
}

interface ProxyTrustGateRuntime {
  acceptedLocalRequests: number;
  acceptedRemoteRequests: number;
  corsResponseViolations: number;
  readonly rejectedRequests: Record<TailscaleServeProxyTrustRejectionReason, number>;
  staleRemoteContextRejections: number;
}

interface NormalizedProbe extends TailscaleServeProxyTrustProbe {
  readonly rawHeaders: readonly string[];
}

interface HeaderScan {
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly hasProxySignal: boolean;
  readonly localAdminSignal: boolean;
  readonly preflight: boolean;
  readonly standardIdentity: "absent" | "present" | "invalid";
  readonly unknownReservedContext: boolean;
  readonly untrustedLookalikePresent: boolean;
}

interface ForwardingAssessment {
  readonly assessment: "absent" | "exact" | "invalid";
  readonly forwardedHost: string | null;
  readonly reason:
    | "duplicate_forwarding_header"
    | "invalid_forwarded_proto"
    | "missing_forwarding_header"
    | "source_invalid"
    | "unknown_proxy_context"
    | null;
  readonly sourceAddress: string | null;
}

interface AdmittedServeRequest {
  readonly policy: TailscaleServeProxyTrustPolicy;
  readonly runtime: ProxyTrustGateRuntime;
  readonly trust: TailscaleServeRequestTrustContext;
}

const policyInputKeys = ["limits", "localOrigin", "readRemoteAdmission"] as const;
const policyLimitKeys = ["http_headers_max_bytes", "http_headers_max_count", "http_url_max_bytes"] as const;
const admissionKeys = ["admission", "external_origin", "generation"] as const;
const probeKeys = ["method", "rawHeaders", "remoteAddress", "requestTarget", "secure"] as const;
const tailscaleHeadersInfoValue = "https://tailscale.com/s/serve-headers";
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const acceptedPolicies = new WeakSet<object>();
const policyRuntimes = new WeakMap<TailscaleServeProxyTrustPolicy, ProxyTrustPolicyRuntime>();
const gateRuntimes = new WeakMap<FastifyInstance, ProxyTrustGateRuntime>();
const admittedServeRequests = new WeakMap<FastifyRequest, AdmittedServeRequest>();
const invalidatedServeRequests = new WeakSet<FastifyRequest>();

export function createTailscaleServeProxyTrustPolicy(
  input: CreateTailscaleServeProxyTrustPolicyInput
): TailscaleServeProxyTrustPolicy {
  assertPlainAllowedObject(input, policyInputKeys, ["localOrigin", "readRemoteAdmission"], "Tailscale Serve proxy trust policy input");
  if (typeof input.readRemoteAdmission !== "function") {
    throw new TypeError("Tailscale Serve proxy trust admission reader must be a function.");
  }

  const localOriginResult = hostDeckLoopbackOriginSchema.safeParse(input.localOrigin);
  if (!localOriginResult.success) {
    throw new TypeError("Tailscale Serve proxy trust requires one canonical IPv4 loopback HTTP origin.");
  }
  const limits = parseLimits(input.limits);
  const policy: TailscaleServeProxyTrustPolicy = Object.freeze({
    limits,
    local_origin: localOriginResult.data
  });
  const localPolicy = createHostDeckRequestTrustPolicy({
    allowedOrigins: [localOriginResult.data],
    mode: "loopback",
    transport: "http"
  });
  acceptedPolicies.add(policy);
  policyRuntimes.set(policy, Object.freeze({ localPolicy, readRemoteAdmission: input.readRemoteAdmission }));
  return policy;
}

export function assertTailscaleServeProxyTrustPolicy(
  policy: unknown
): asserts policy is TailscaleServeProxyTrustPolicy {
  if (
    policy === null ||
    typeof policy !== "object" ||
    !acceptedPolicies.has(policy) ||
    !Object.isFrozen(policy) ||
    !Object.isFrozen((policy as Partial<TailscaleServeProxyTrustPolicy>).limits) ||
    !policyRuntimes.has(policy as TailscaleServeProxyTrustPolicy)
  ) {
    throw new TypeError("Tailscale Serve proxy trust policy must be created by createTailscaleServeProxyTrustPolicy.");
  }
}

export function evaluateTailscaleServeProxyTrust(
  policy: TailscaleServeProxyTrustPolicy,
  probe: TailscaleServeProxyTrustProbe
): RemoteProxyTrustDecision {
  assertTailscaleServeProxyTrustPolicy(policy);
  const normalizedProbe = normalizeProbe(probe, policy.limits);
  if (normalizedProbe === null) return rejectDecision(invalidHeaderAssessment(), "unknown_proxy_context");

  const scan = scanHeaders(normalizedProbe.rawHeaders);
  const forwarding = assessForwarding(scan.byName);
  const headers = Object.freeze({
    forwarding: forwarding.assessment,
    standard_identity: scan.standardIdentity,
    untrusted_lookalike_present: scan.untrustedLookalikePresent
  });

  if (!scan.hasProxySignal) {
    if (scan.preflight || normalizedProbe.method.toUpperCase() === "OPTIONS") {
      return rejectDecision(headers, "unknown_proxy_context");
    }
    if (!isIpv4LoopbackPeer(normalizedProbe.remoteAddress)) {
      return rejectDecision(headers, "direct_non_loopback");
    }
    if (normalizedProbe.secure || !isOriginFormTarget(normalizedProbe.requestTarget)) {
      return rejectDecision(headers, "unknown_proxy_context");
    }
    return evaluateDirectLocal(policy, normalizedProbe, headers);
  }
  return evaluateRemote(policy, normalizedProbe, scan, forwarding, headers);
}

export function installTailscaleServeProxyTrustGate(
  app: FastifyInstance,
  policy: TailscaleServeProxyTrustPolicy,
  observeInternalError: HostDeckInternalErrorObserver
): void {
  assertTailscaleServeProxyTrustPolicy(policy);
  if (typeof observeInternalError !== "function") {
    throw new TypeError("Tailscale Serve proxy trust internal-error observer must be a function.");
  }
  if (gateRuntimes.has(app)) throw new TypeError("Tailscale Serve proxy trust gate is already installed.");

  const runtime: ProxyTrustGateRuntime = {
    acceptedLocalRequests: 0,
    acceptedRemoteRequests: 0,
    corsResponseViolations: 0,
    rejectedRequests: createRejectionCounters(),
    staleRemoteContextRejections: 0
  };
  installHostDeckCorsResponseGuard(app, observeInternalError, () => {
    runtime.corsResponseViolations = incrementCounter(runtime.corsResponseViolations);
  });

  app.addHook("onRequest", async (request, reply) => {
    const socket = request.raw.socket as typeof request.raw.socket & { readonly encrypted?: unknown };
    const decision = evaluateTailscaleServeProxyTrust(policy, {
      method: request.method,
      rawHeaders: request.raw.rawHeaders,
      remoteAddress: socket.remoteAddress,
      requestTarget: request.raw.url ?? request.url,
      secure: socket.encrypted === true
    });
    if (decision.decision === "admitted") {
      const provenance = requireProvenance(decision);
      admittedServeRequests.set(
        request,
        Object.freeze({
          policy,
          runtime,
          trust: Object.freeze({
            origin_kind: admittedOriginKind(request.method, request.raw.rawHeaders),
            provenance
          })
        })
      );
      if (provenance.kind === "local_loopback") {
        runtime.acceptedLocalRequests = incrementCounter(runtime.acceptedLocalRequests);
      } else {
        runtime.acceptedRemoteRequests = incrementCounter(runtime.acceptedRemoteRequests);
      }
      return;
    }

    const reason = requireRejectionReason(decision);
    runtime.rejectedRequests[reason] = incrementCounter(runtime.rejectedRequests[reason]);
    reply.header("connection", "close");
    return sendHostDeckError(reply, request, 403, {
      code: "invalid_origin",
      message: "Request origin is not permitted.",
      retryable: false
    });
  });
  app.addHook("onResponse", async (request) => {
    admittedServeRequests.delete(request);
  });
  app.addHook("onRequestAbort", async (request) => {
    admittedServeRequests.delete(request);
  });
  gateRuntimes.set(app, runtime);
}

export function tailscaleServeRequestIngressProvenance(request: FastifyRequest): RequestIngressProvenance {
  return requireAdmittedServeRequest(request).trust.provenance;
}

export function tailscaleServeRequestTrustContext(
  request: FastifyRequest
): TailscaleServeRequestTrustContext {
  return requireAdmittedServeRequest(request).trust;
}

export function assertTailscaleServeRequestIngressCurrent(request: FastifyRequest): void {
  const admitted = requireAdmittedServeRequest(request);
  const provenance = admitted.trust.provenance;
  if (provenance.kind === "local_loopback") return;

  const policyRuntime = requirePolicyRuntime(admitted.policy);
  const before = readAdmission(policyRuntime.readRemoteAdmission);
  const after = readAdmission(policyRuntime.readRemoteAdmission);
  if (
    sameOpenAdmission(before, after) &&
    before.external_origin === provenance.origin &&
    before.generation === provenance.remote_generation
  ) {
    return;
  }
  if (!invalidatedServeRequests.has(request)) {
    invalidatedServeRequests.add(request);
    admitted.runtime.staleRemoteContextRejections = incrementCounter(
      admitted.runtime.staleRemoteContextRejections
    );
  }
  throw new TailscaleServeRequestIngressError();
}

export function tailscaleServeProxyTrustSnapshot(app: FastifyInstance): TailscaleServeProxyTrustSnapshot {
  const runtime = gateRuntimes.get(app);
  if (runtime === undefined) throw new TypeError("Fastify instance has no Tailscale Serve proxy trust gate.");
  return Object.freeze({
    accepted_local_requests: runtime.acceptedLocalRequests,
    accepted_remote_requests: runtime.acceptedRemoteRequests,
    cors_response_violations: runtime.corsResponseViolations,
    rejected_requests: Object.freeze({ ...runtime.rejectedRequests }),
    stale_remote_context_rejections: runtime.staleRemoteContextRejections
  });
}

function evaluateDirectLocal(
  policy: TailscaleServeProxyTrustPolicy,
  probe: NormalizedProbe,
  headers: RemoteProxyTrustDecision["headers"]
): RemoteProxyTrustDecision {
  const runtime = requirePolicyRuntime(policy);
  try {
    evaluateHostDeckRequestTrust(runtime.localPolicy, probe);
  } catch (error) {
    if (!(error instanceof HostDeckRequestTrustError)) throw error;
    return rejectDecision(headers, "unknown_proxy_context");
  }
  return admittedDecision({
    kind: "local_loopback",
    transport: "loopback_http",
    origin: policy.local_origin,
    remote_generation: null,
    source_key: null,
    tailnet_identity_present: false,
    app_authorization: "not_evaluated"
  }, headers);
}

function evaluateRemote(
  policy: TailscaleServeProxyTrustPolicy,
  probe: NormalizedProbe,
  scan: HeaderScan,
  forwarding: ForwardingAssessment,
  headers: RemoteProxyTrustDecision["headers"]
): RemoteProxyTrustDecision {
  const runtime = requirePolicyRuntime(policy);
  const before = readAdmission(runtime.readRemoteAdmission);

  let reason: TailscaleServeProxyTrustRejectionReason | null = null;
  if (scan.untrustedLookalikePresent) reason = "untrusted_tailscale_lookalike";
  else if (
    scan.unknownReservedContext ||
    scan.localAdminSignal ||
    scan.preflight ||
    probe.method.toUpperCase() === "OPTIONS"
  ) {
    reason = "unknown_proxy_context";
  } else if (scan.standardIdentity === "invalid") reason = "standard_identity_invalid";
  else if (!isIpv4LoopbackPeer(probe.remoteAddress)) reason = "direct_non_loopback";
  else if (probe.secure || !isOriginFormTarget(probe.requestTarget)) reason = "unknown_proxy_context";
  else if (forwarding.assessment === "absent") reason = "missing_forwarding_header";
  else reason = forwarding.reason;
  if (reason === null) {
    const hostValues = scan.byName.get("host") ?? [];
    if (hostValues.length !== 1) {
      reason = "host_mismatch";
    } else if (before?.admission === "open") {
      const authority = new URL(before.external_origin as string).host;
      if (hostValues[0] !== authority || forwarding.forwardedHost !== authority) reason = "host_mismatch";
    }
  }

  if (reason === null) {
    const originValues = scan.byName.get("origin") ?? [];
    if (originValues.length > 1 || (!isSafeMethod(probe.method) && originValues.length !== 1)) {
      reason = "origin_mismatch";
    } else if (
      originValues.length === 1 &&
      before?.admission === "open" &&
      originValues[0] !== before.external_origin
    ) {
      reason = "origin_mismatch";
    }
  }

  const after = readAdmission(runtime.readRemoteAdmission);
  if (reason !== null) return rejectDecision(headers, reason);
  if (!sameOpenAdmission(before, after)) return rejectDecision(headers, "remote_generation_stale");
  if (forwarding.sourceAddress === null) return rejectDecision(headers, "source_invalid");

  return admittedDecision({
    kind: "admitted_remote",
    transport: "tailscale_serve_https",
    origin: before.external_origin,
    remote_generation: before.generation,
    source_key: deriveSourceKey(forwarding.sourceAddress),
    tailnet_identity_present: scan.standardIdentity === "present",
    app_authorization: "not_evaluated"
  }, headers);
}

function parseLimits(input: TailscaleServeProxyTrustLimitsInput | undefined): TailscaleServeProxyTrustLimits {
  if (input !== undefined) {
    assertPlainAllowedObject(input, policyLimitKeys, [], "Tailscale Serve proxy trust limits");
  }
  return Object.freeze({
    http_headers_max_bytes: parseLimit(
      input?.http_headers_max_bytes,
      resourceBudgetDefinitionByKey.http_headers_max_bytes
    ),
    http_headers_max_count: parseLimit(
      input?.http_headers_max_count,
      resourceBudgetDefinitionByKey.http_headers_max_count
    ),
    http_url_max_bytes: parseLimit(input?.http_url_max_bytes, resourceBudgetDefinitionByKey.http_url_max_bytes)
  });
}

function parseLimit(
  candidate: number | undefined,
  definition: { readonly default_value: number; readonly maximum: number; readonly minimum: number }
): number {
  const value = candidate ?? definition.default_value;
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) {
    throw new TypeError("Tailscale Serve proxy trust limit is outside its selected resource range.");
  }
  return value;
}

function normalizeProbe(
  probe: unknown,
  limits: TailscaleServeProxyTrustLimits
): NormalizedProbe | null {
  if (!isPlainExactObject(probe, probeKeys)) return null;
  const value = probe as Partial<TailscaleServeProxyTrustProbe>;
  if (
    typeof value.method !== "string" ||
    value.method.length < 1 ||
    value.method.length > 32 ||
    !/^[A-Za-z]+$/u.test(value.method) ||
    !Array.isArray(value.rawHeaders) ||
    value.rawHeaders.length % 2 !== 0 ||
    value.rawHeaders.length / 2 > limits.http_headers_max_count ||
    (value.remoteAddress !== undefined &&
      (typeof value.remoteAddress !== "string" ||
        value.remoteAddress.length < 1 ||
        value.remoteAddress.length > 128 ||
        !isVisibleAscii(value.remoteAddress))) ||
    typeof value.requestTarget !== "string" ||
    value.requestTarget.length > limits.http_url_max_bytes ||
    Buffer.byteLength(value.requestTarget, "utf8") > limits.http_url_max_bytes ||
    typeof value.secure !== "boolean"
  ) {
    return null;
  }

  let headerBytes = 0;
  for (let index = 0; index < value.rawHeaders.length; index += 2) {
    const name = value.rawHeaders[index];
    const headerValue = value.rawHeaders[index + 1];
    if (
      typeof name !== "string" ||
      typeof headerValue !== "string" ||
      name.length < 1 ||
      name.length > 256 ||
      !headerNamePattern.test(name) ||
      headerValue.length > limits.http_headers_max_bytes ||
      hasForbiddenHeaderValueControl(headerValue)
    ) {
      return null;
    }
    headerBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(headerValue, "utf8") + 4;
    if (!Number.isSafeInteger(headerBytes) || headerBytes > limits.http_headers_max_bytes) return null;
  }

  return {
    method: value.method,
    rawHeaders: value.rawHeaders,
    remoteAddress: value.remoteAddress,
    requestTarget: value.requestTarget,
    secure: value.secure
  };
}

function scanHeaders(rawHeaders: readonly string[]): HeaderScan {
  const mutable = new Map<string, string[]>();
  let hasProxySignal = false;
  let localAdminSignal = false;
  let preflight = false;
  let unknownReservedContext = false;
  let untrustedLookalikePresent = false;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = (rawHeaders[index] as string).toLowerCase();
    const value = rawHeaders[index + 1] as string;
    const values = mutable.get(name);
    if (values === undefined) mutable.set(name, [value]);
    else values.push(value);

    if (name.startsWith(tailscaleUntrustedHeaderPrefix)) {
      hasProxySignal = true;
      untrustedLookalikePresent = true;
      continue;
    }
    if (name === hostDeckLocalAdminRequestHeaderName) {
      localAdminSignal = true;
      continue;
    }
    if ((tailscaleForwardingHeaderNames as readonly string[]).includes(name)) {
      hasProxySignal = true;
      continue;
    }
    if ((tailscaleStandardIdentityHeaderNames as readonly string[]).includes(name)) {
      hasProxySignal = true;
      continue;
    }
    if (name.startsWith("tailscale-")) {
      hasProxySignal = true;
      unknownReservedContext = true;
      continue;
    }
    if (
      name === "forwarded" ||
      name === "via" ||
      name === "x-forwarded" ||
      name === "x-real-ip" ||
      name === "proxy-connection" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-original-")
    ) {
      hasProxySignal = true;
      unknownReservedContext = true;
      continue;
    }
    if (name.startsWith("access-control-request-")) {
      preflight = true;
      unknownReservedContext = true;
    }
  }

  const byName = new Map<string, readonly string[]>();
  for (const [name, values] of mutable) byName.set(name, Object.freeze([...values]));
  return {
    byName,
    hasProxySignal,
    localAdminSignal,
    preflight,
    standardIdentity: assessStandardIdentity(byName),
    unknownReservedContext,
    untrustedLookalikePresent
  };
}

function assessStandardIdentity(
  byName: ReadonlyMap<string, readonly string[]>
): "absent" | "present" | "invalid" {
  const bundles = tailscaleStandardIdentityHeaderNames.map((name) => byName.get(name) ?? []);
  if (bundles.every((values) => values.length === 0)) return "absent";
  if (bundles.some((values) => values.length !== 1)) return "invalid";

  const [info, login, name, profilePic] = bundles.map((values) => values[0] as string) as [
    string,
    string,
    string,
    string
  ];
  if (info !== tailscaleHeadersInfoValue) return "invalid";
  if (![login, name, profilePic].every(isBoundedIdentityValue)) return "invalid";
  return "present";
}

function assessForwarding(byName: ReadonlyMap<string, readonly string[]>): ForwardingAssessment {
  const sourceValues = byName.get("x-forwarded-for") ?? [];
  const hostValues = byName.get("x-forwarded-host") ?? [];
  const protoValues = byName.get("x-forwarded-proto") ?? [];
  const counts = [sourceValues.length, hostValues.length, protoValues.length];
  if (counts.every((count) => count === 0)) {
    return { assessment: "absent", forwardedHost: null, reason: null, sourceAddress: null };
  }
  if (counts.some((count) => count > 1)) {
    return {
      assessment: "invalid",
      forwardedHost: null,
      reason: "duplicate_forwarding_header",
      sourceAddress: null
    };
  }
  if (counts.some((count) => count !== 1)) {
    return {
      assessment: "invalid",
      forwardedHost: null,
      reason: "missing_forwarding_header",
      sourceAddress: null
    };
  }
  if (protoValues[0] !== "https") {
    return {
      assessment: "invalid",
      forwardedHost: null,
      reason: "invalid_forwarded_proto",
      sourceAddress: null
    };
  }
  const sourceAddress = canonicalCgnatAddress(sourceValues[0] as string);
  if (sourceAddress === null) {
    return { assessment: "invalid", forwardedHost: null, reason: "source_invalid", sourceAddress: null };
  }
  const forwardedHost = parseCanonicalHttpsAuthority(hostValues[0] as string);
  if (forwardedHost === null) {
    return {
      assessment: "invalid",
      forwardedHost: null,
      reason: "unknown_proxy_context",
      sourceAddress
    };
  }
  return { assessment: "exact", forwardedHost, reason: null, sourceAddress };
}

function readAdmission(reader: () => unknown): TailscaleServeRemoteAdmissionSnapshot | null {
  let value: unknown;
  try {
    value = reader();
  } catch {
    return null;
  }
  if (!isPlainExactObject(value, admissionKeys)) return null;
  const candidate = value as Partial<TailscaleServeRemoteAdmissionSnapshot>;
  if (
    (candidate.admission !== "open" && candidate.admission !== "closed") ||
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 0
  ) {
    return null;
  }
  if (candidate.admission === "closed") {
    if (candidate.external_origin !== null) return null;
  } else if (!remoteExternalOriginSchema.safeParse(candidate.external_origin).success) {
    return null;
  }
  return Object.freeze({
    admission: candidate.admission,
    external_origin: candidate.external_origin as string | null,
    generation: candidate.generation as number
  });
}

function sameOpenAdmission(
  before: TailscaleServeRemoteAdmissionSnapshot | null,
  after: TailscaleServeRemoteAdmissionSnapshot | null
): before is TailscaleServeRemoteAdmissionSnapshot & { readonly admission: "open"; readonly external_origin: string } {
  return (
    before !== null &&
    after !== null &&
    before.admission === "open" &&
    after.admission === "open" &&
    before.generation === after.generation &&
    before.external_origin === after.external_origin
  );
}

function admittedDecision(
  provenance: RequestIngressProvenance,
  headers: RemoteProxyTrustDecision["headers"]
): RemoteProxyTrustDecision {
  return freezeDecision({ decision: "admitted", provenance, headers, reason: null });
}

function rejectDecision(
  headers: RemoteProxyTrustDecision["headers"],
  reason: TailscaleServeProxyTrustRejectionReason
): RemoteProxyTrustDecision {
  return freezeDecision({ decision: "rejected", provenance: null, headers, reason });
}

function freezeDecision(value: RemoteProxyTrustDecision): RemoteProxyTrustDecision {
  return deepFreeze(remoteProxyTrustDecisionSchema.parse(value));
}

function invalidHeaderAssessment(): RemoteProxyTrustDecision["headers"] {
  return Object.freeze({
    forwarding: "invalid",
    standard_identity: "absent",
    untrusted_lookalike_present: false
  });
}

function requirePolicyRuntime(policy: TailscaleServeProxyTrustPolicy): ProxyTrustPolicyRuntime {
  const runtime = policyRuntimes.get(policy);
  if (runtime === undefined) throw new Error("Tailscale Serve proxy trust policy runtime is unavailable.");
  return runtime;
}

function requireAdmittedServeRequest(request: FastifyRequest): AdmittedServeRequest {
  const admitted = admittedServeRequests.get(request);
  if (admitted === undefined) {
    throw new Error("Tailscale Serve request ingress provenance is unavailable before trust admission.");
  }
  return admitted;
}

function admittedOriginKind(
  method: string,
  rawHeaders: readonly string[]
): TailscaleServeRequestTrustContext["origin_kind"] {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "origin") return "same_origin";
  }
  return isSafeMethod(method) ? "safe_no_origin" : "local_non_browser";
}

function requireProvenance(decision: RemoteProxyTrustDecision): RequestIngressProvenance {
  if (decision.decision !== "admitted" || decision.provenance === null) {
    throw new Error("Admitted Tailscale Serve proxy decision has no provenance.");
  }
  return decision.provenance;
}

function requireRejectionReason(
  decision: RemoteProxyTrustDecision
): TailscaleServeProxyTrustRejectionReason {
  if (decision.decision !== "rejected" || decision.reason === null) {
    throw new Error("Rejected Tailscale Serve proxy decision has no reason.");
  }
  return decision.reason;
}

function createRejectionCounters(): Record<TailscaleServeProxyTrustRejectionReason, number> {
  return Object.fromEntries(remoteProxyTrustRejectionReasons.map((reason) => [reason, 0])) as Record<
    TailscaleServeProxyTrustRejectionReason,
    number
  >;
}

function parseCanonicalHttpsAuthority(candidate: string): string | null {
  if (!isVisibleAscii(candidate) || candidate.length > 253 || /[\\/@#?,%*]/u.test(candidate)) return null;
  try {
    const parsed = new URL(`https://${candidate}/`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.host !== candidate ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

function canonicalCgnatAddress(candidate: string): string | null {
  if (candidate.length < 7 || candidate.length > 15 || isIP(candidate) !== 4) return null;
  const octets = candidate.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(octet))) return null;
  const numbers = octets.map(Number);
  if (numbers.some((value) => value > 255) || numbers.map(String).join(".") !== candidate) return null;
  if (numbers[0] !== 100 || (numbers[1] as number) < 64 || (numbers[1] as number) > 127) return null;
  return candidate;
}

function isIpv4LoopbackPeer(candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  const mapped = candidate.toLowerCase().startsWith("::ffff:") ? candidate.slice(7) : candidate;
  if (isIP(mapped) !== 4) return false;
  const octets = mapped.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(octet))) return false;
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((value) => value <= 255) && numbers.map(String).join(".") === mapped;
}

function deriveSourceKey(sourceAddress: string): `sha256:${string}` {
  const input = `hostdeck:tailscale-serve-source:v1\0ipv4\0${sourceAddress}`;
  return `sha256:${createHash("sha256").update(input, "ascii").digest("hex")}`;
}

function isBoundedIdentityValue(value: string): boolean {
  if (value.trim().length < 1) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function hasForbiddenHeaderValueControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function isOriginFormTarget(target: string): boolean {
  const normalized = target.toLowerCase();
  if (
    target.length < 1 ||
    target[0] !== "/" ||
    target[1] === "/" ||
    target.includes("\\") ||
    target.includes("#") ||
    normalized.startsWith("/%2f") ||
    normalized.includes("%5c") ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/u.test(normalized)
  ) {
    return false;
  }
  for (const character of target) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isSafeMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function isVisibleAscii(value: string): boolean {
  if (value.length < 1) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function incrementCounter(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function assertPlainAllowedObject(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string
): void {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
  const actual = Object.keys(value);
  if (
    actual.some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function isPlainExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
