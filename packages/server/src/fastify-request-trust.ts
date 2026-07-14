import { createHash } from "node:crypto";
import { isIP, SocketAddress } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { installHostDeckCorsResponseGuard } from "./fastify-cors-response-guard.js";
import { type HostDeckInternalErrorObserver, sendHostDeckError } from "./fastify-error-policy.js";

export const hostDeckRequestTrustModes = ["loopback", "lan"] as const;
export type HostDeckRequestTrustMode = (typeof hostDeckRequestTrustModes)[number];

export const hostDeckRequestTransports = ["http", "https"] as const;
export type HostDeckRequestTransport = (typeof hostDeckRequestTransports)[number];

export const hostDeckRequestOriginKinds = ["same_origin", "safe_no_origin", "local_non_browser"] as const;
export type HostDeckRequestOriginKind = (typeof hostDeckRequestOriginKinds)[number];

export const hostDeckLocalAdminRequestHeaderName = "x-hostdeck-local-admin";
export const hostDeckLocalAdminRequestHeaderValue = "cli-v1";

export interface CreateHostDeckRequestTrustPolicyInput {
  readonly allowedOrigins: readonly string[];
  readonly mode: HostDeckRequestTrustMode;
  readonly transport: HostDeckRequestTransport;
}

export interface HostDeckRequestTrustPolicy {
  readonly allowedOrigins: readonly string[];
  readonly mode: HostDeckRequestTrustMode;
  readonly transport: HostDeckRequestTransport;
}

export interface HostDeckRequestTrustContext {
  readonly authority: string;
  readonly configured_origin: string;
  readonly network_mode: HostDeckRequestTrustMode;
  readonly origin_kind: HostDeckRequestOriginKind;
  readonly transport: HostDeckRequestTransport;
}

export interface HostDeckRequestTrustProbe {
  readonly method: string;
  readonly rawHeaders: readonly string[];
  readonly remoteAddress: string | undefined;
  readonly requestTarget: string;
  readonly secure: boolean;
}

export interface HostDeckRequestTrustSnapshot {
  readonly accepted_requests: number;
  readonly rejected_forbidden_cors: number;
  readonly rejected_insecure_transport_requests: number;
  readonly rejected_invalid_origin_requests: number;
}

export type HostDeckRequestTrustErrorKind = "forbidden_cors" | "insecure_transport" | "invalid_origin";

export class HostDeckRequestTrustError extends Error {
  constructor(readonly kind: HostDeckRequestTrustErrorKind) {
    super(
      kind === "insecure_transport"
        ? "Request transport is not permitted."
        : kind === "forbidden_cors"
          ? "Cross-origin resource sharing is not permitted."
          : "Request origin is not permitted."
    );
    this.name = "HostDeckRequestTrustError";
    Object.freeze(this);
  }
}

interface RequestTrustRuntime {
  acceptedRequests: number;
  rejectedForbiddenCors: number;
  rejectedInsecureTransportRequests: number;
  rejectedInvalidOriginRequests: number;
}

type RequestWithTrustContext = FastifyRequest & {
  [requestTrustContext]?: AdmittedRequestTrust;
};

interface AdmittedRequestTrust {
  readonly context: HostDeckRequestTrustContext;
  readonly pairClaimSourceKey: string | null;
}

const policyKeys = ["allowedOrigins", "mode", "transport"];
const maxAllowedOrigins = 8;
const maxOriginBytes = 512;
const maxAuthorityBytes = 512;
const acceptedPolicies = new WeakSet<object>();
const requestTrustContext = Symbol("hostdeckRequestTrustContext");
const requestTrustRuntimes = new WeakMap<FastifyInstance, RequestTrustRuntime>();

export function createHostDeckRequestTrustPolicy(
  input: CreateHostDeckRequestTrustPolicyInput
): HostDeckRequestTrustPolicy {
  assertPlainExactObject(input, policyKeys, "HostDeck request trust policy input");
  if (!(hostDeckRequestTrustModes as readonly unknown[]).includes(input.mode)) {
    throw new TypeError("HostDeck request trust mode is invalid.");
  }
  if (!(hostDeckRequestTransports as readonly unknown[]).includes(input.transport)) {
    throw new TypeError("HostDeck request transport is invalid.");
  }
  if (input.mode === "lan" && input.transport !== "https") {
    throw new TypeError("HostDeck LAN request trust requires HTTPS.");
  }
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length < 1 || input.allowedOrigins.length > maxAllowedOrigins) {
    throw new TypeError(`HostDeck request trust requires 1 to ${maxAllowedOrigins} allowed origins.`);
  }

  const origins = input.allowedOrigins.map((origin) => parseConfiguredOrigin(origin, input.mode, input.transport));
  if (new Set(origins).size !== origins.length) {
    throw new TypeError("HostDeck request trust allowed origins must be unique.");
  }

  const policy: HostDeckRequestTrustPolicy = Object.freeze({
    allowedOrigins: Object.freeze(origins),
    mode: input.mode,
    transport: input.transport
  });
  acceptedPolicies.add(policy);
  return policy;
}

export function assertHostDeckRequestTrustPolicy(
  policy: unknown
): asserts policy is HostDeckRequestTrustPolicy {
  if (
    policy === null ||
    typeof policy !== "object" ||
    !acceptedPolicies.has(policy) ||
    !Object.isFrozen(policy) ||
    !Object.isFrozen((policy as Partial<HostDeckRequestTrustPolicy>).allowedOrigins)
  ) {
    throw new TypeError("HostDeck request trust policy must be created by createHostDeckRequestTrustPolicy.");
  }
}

export function evaluateHostDeckRequestTrust(
  policy: HostDeckRequestTrustPolicy,
  probe: HostDeckRequestTrustProbe
): HostDeckRequestTrustContext {
  assertHostDeckRequestTrustPolicy(policy);
  assertRequestTrustProbe(probe);
  if (hasForbiddenForwardingHeader(probe.rawHeaders)) throw new HostDeckRequestTrustError("invalid_origin");
  if (!isOriginFormTarget(probe.requestTarget)) throw new HostDeckRequestTrustError("invalid_origin");

  const transport: HostDeckRequestTransport = probe.secure ? "https" : "http";
  if (transport !== policy.transport) throw new HostDeckRequestTrustError("insecure_transport");
  const loopbackPeer = isLoopbackAddress(probe.remoteAddress);
  if (policy.mode === "loopback" && !loopbackPeer) throw new HostDeckRequestTrustError("invalid_origin");

  const hostValues = rawHeaderValues(probe.rawHeaders, "host");
  if (hostValues.length !== 1) throw new HostDeckRequestTrustError("invalid_origin");
  const authority = parseRequestAuthority(hostValues[0], transport);
  if (authority === null) throw new HostDeckRequestTrustError("invalid_origin");

  const configuredOrigin = policy.allowedOrigins.find((origin) => new URL(origin).host === authority);
  if (configuredOrigin === undefined) throw new HostDeckRequestTrustError("invalid_origin");

  const originValues = rawHeaderValues(probe.rawHeaders, "origin");
  const localAdminValues = rawHeaderValues(
    probe.rawHeaders,
    hostDeckLocalAdminRequestHeaderName
  );
  const corsPreflight = hasHeaderPrefix(probe.rawHeaders, "access-control-request-");
  if (corsPreflight) throw new HostDeckRequestTrustError("forbidden_cors");
  if (originValues.length > 1) throw new HostDeckRequestTrustError("invalid_origin");
  if (localAdminValues.length > 0) {
    if (
      localAdminValues.length !== 1 ||
      localAdminValues[0] !== hostDeckLocalAdminRequestHeaderValue ||
      policy.mode !== "loopback" ||
      !loopbackPeer ||
      probe.method.toUpperCase() !== "GET" ||
      originValues.length !== 0 ||
      rawHeaderValues(probe.rawHeaders, "cookie").length !== 0 ||
      hasHeaderPrefix(probe.rawHeaders, "sec-fetch-")
    ) {
      throw new HostDeckRequestTrustError("invalid_origin");
    }
  }

  let originKind: HostDeckRequestOriginKind;
  if (localAdminValues.length === 1) {
    originKind = "local_non_browser";
  } else if (originValues.length === 1) {
    if (parseRequestOrigin(originValues[0]) !== configuredOrigin) {
      throw new HostDeckRequestTrustError("invalid_origin");
    }
    originKind = "same_origin";
  } else if (isSafeMethod(probe.method)) {
    originKind = "safe_no_origin";
  } else if (loopbackPeer && !hasHeaderPrefix(probe.rawHeaders, "sec-fetch-")) {
    originKind = "local_non_browser";
  } else {
    throw new HostDeckRequestTrustError("invalid_origin");
  }

  return Object.freeze({
    authority,
    configured_origin: configuredOrigin,
    network_mode: policy.mode,
    origin_kind: originKind,
    transport
  });
}

export function installHostDeckRequestTrustGate(
  app: FastifyInstance,
  policy: HostDeckRequestTrustPolicy,
  observeInternalError: HostDeckInternalErrorObserver
): void {
  assertHostDeckRequestTrustPolicy(policy);
  if (typeof observeInternalError !== "function") throw new TypeError("HostDeck request trust observer must be a function.");
  if (requestTrustRuntimes.has(app)) throw new TypeError("HostDeck request trust gate is already installed.");
  const runtime: RequestTrustRuntime = {
    acceptedRequests: 0,
    rejectedForbiddenCors: 0,
    rejectedInsecureTransportRequests: 0,
    rejectedInvalidOriginRequests: 0
  };
  installHostDeckCorsResponseGuard(app, observeInternalError, () => {
    runtime.rejectedForbiddenCors = incrementCounter(runtime.rejectedForbiddenCors);
  });

  app.addHook("onRequest", async (request, reply) => {
    try {
      const socket = request.raw.socket as typeof request.raw.socket & { readonly encrypted?: unknown };
      const remoteAddress = socket.remoteAddress;
      const context = evaluateHostDeckRequestTrust(policy, {
        method: request.method,
        rawHeaders: request.raw.rawHeaders,
        remoteAddress,
        requestTarget: request.raw.url ?? request.url,
        secure: socket.encrypted === true
      });
      (request as RequestWithTrustContext)[requestTrustContext] = Object.freeze({
        context,
        pairClaimSourceKey: tryDerivePairClaimSourceKey(remoteAddress)
      });
      runtime.acceptedRequests = incrementCounter(runtime.acceptedRequests);
    } catch (error) {
      if (!(error instanceof HostDeckRequestTrustError)) throw error;
      reply.header("connection", "close");
      if (error.kind === "insecure_transport") {
        runtime.rejectedInsecureTransportRequests = incrementCounter(runtime.rejectedInsecureTransportRequests);
        return sendHostDeckError(reply, request, 426, {
          code: "insecure_transport",
          message: "Secure request transport is required.",
          retryable: false
        });
      }
      if (error.kind === "forbidden_cors") runtime.rejectedForbiddenCors = incrementCounter(runtime.rejectedForbiddenCors);
      else runtime.rejectedInvalidOriginRequests = incrementCounter(runtime.rejectedInvalidOriginRequests);
      return sendHostDeckError(reply, request, 403, {
        code: "invalid_origin",
        message: "Request origin is not permitted.",
        retryable: false
      });
    }
  });
  requestTrustRuntimes.set(app, runtime);
}

export function hostDeckRequestTrustContext(request: FastifyRequest): HostDeckRequestTrustContext {
  const admitted = (request as RequestWithTrustContext)[requestTrustContext];
  if (admitted === undefined) throw new Error("HostDeck request trust context is unavailable before trust admission.");
  return admitted.context;
}

export function hostDeckPairClaimSourceKey(request: FastifyRequest): string {
  const admitted = (request as RequestWithTrustContext)[requestTrustContext];
  if (admitted === undefined) throw new Error("HostDeck pair-claim source is unavailable before trust admission.");
  if (admitted.pairClaimSourceKey === null) throw new HostDeckRequestTrustError("invalid_origin");
  return admitted.pairClaimSourceKey;
}

export function deriveHostDeckPairClaimSourceKey(remoteAddress: unknown): string {
  if (
    typeof remoteAddress !== "string" ||
    remoteAddress.length > 128 ||
    !isBoundedVisibleAscii(remoteAddress, 128) ||
    remoteAddress.includes("%")
  ) {
    throw new HostDeckRequestTrustError("invalid_origin");
  }
  const canonical = canonicalPairClaimPeer(remoteAddress);
  if (canonical === null) throw new HostDeckRequestTrustError("invalid_origin");
  const input = `hostdeck:pair-claim-source:v1\0${canonical.family}\0${canonical.address}`;
  return `sha256:${createHash("sha256").update(input, "ascii").digest("hex")}`;
}

export function hostDeckRequestTrustSnapshot(app: FastifyInstance): HostDeckRequestTrustSnapshot {
  const runtime = requestTrustRuntimes.get(app);
  if (runtime === undefined) throw new TypeError("Fastify instance has no HostDeck request trust gate.");
  return Object.freeze({
    accepted_requests: runtime.acceptedRequests,
    rejected_forbidden_cors: runtime.rejectedForbiddenCors,
    rejected_insecure_transport_requests: runtime.rejectedInsecureTransportRequests,
    rejected_invalid_origin_requests: runtime.rejectedInvalidOriginRequests
  });
}

function parseConfiguredOrigin(
  candidate: unknown,
  mode: HostDeckRequestTrustMode,
  transport: HostDeckRequestTransport
): string {
  if (typeof candidate !== "string" || !isBoundedVisibleAscii(candidate, maxOriginBytes)) {
    throw new TypeError("HostDeck request trust origin must be bounded visible ASCII.");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError("HostDeck request trust origin is malformed.");
  }
  if (
    parsed.origin === "null" ||
    parsed.origin !== candidate ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === "0" ||
    parsed.protocol !== `${transport}:` ||
    parsed.hostname.includes("*") ||
    unwrapIpv6Hostname(parsed.hostname).length > 253
  ) {
    throw new TypeError("HostDeck request trust origin must be one canonical bare configured origin.");
  }
  const loopbackHost = isLoopbackHostname(parsed.hostname);
  if (mode === "loopback" && !loopbackHost) {
    throw new TypeError("HostDeck loopback request trust origins must use a loopback host.");
  }
  if (mode === "lan" && (loopbackHost || isUnspecifiedHostname(parsed.hostname))) {
    throw new TypeError("HostDeck LAN request trust origins must use a non-loopback configured host.");
  }
  return parsed.origin;
}

function assertRequestTrustProbe(probe: unknown): asserts probe is HostDeckRequestTrustProbe {
  try {
    assertPlainExactObject(
      probe,
      ["method", "rawHeaders", "remoteAddress", "requestTarget", "secure"],
      "HostDeck request trust probe"
    );
    const value = probe as Partial<HostDeckRequestTrustProbe>;
    if (
      typeof value.method !== "string" ||
      !isBoundedVisibleAscii(value.method, 32) ||
      !Array.isArray(value.rawHeaders) ||
      value.rawHeaders.length > 512 ||
      value.rawHeaders.some((header) => typeof header !== "string" || header.length > 65_536) ||
      (value.remoteAddress !== undefined &&
        (typeof value.remoteAddress !== "string" || !isBoundedVisibleAscii(value.remoteAddress, 128))) ||
      typeof value.requestTarget !== "string" ||
      value.requestTarget.length > 65_536 ||
      typeof value.secure !== "boolean"
    ) {
      throw new TypeError("HostDeck request trust probe fields are invalid.");
    }
  } catch {
    throw new HostDeckRequestTrustError("invalid_origin");
  }
}

function parseRequestAuthority(candidate: string | undefined, transport: HostDeckRequestTransport): string | null {
  if (candidate === undefined || !isBoundedVisibleAscii(candidate, maxAuthorityBytes)) return null;
  if (["/", "\\", "@", "#", "?", ",", "%", "*"].some((character) => candidate.includes(character))) return null;
  try {
    const parsed = new URL(`${transport}://${candidate}/`);
    const explicitDefaultPort = `${parsed.host}:${transport === "http" ? "80" : "443"}`;
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.host !== candidate && explicitDefaultPort !== candidate)
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

function parseRequestOrigin(candidate: string | undefined): string | null {
  if (candidate === undefined || !isBoundedVisibleAscii(candidate, maxOriginBytes)) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.origin === "null" ||
      parsed.origin !== candidate ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): readonly string[] {
  if (rawHeaders.length % 2 !== 0) throw new HostDeckRequestTrustError("invalid_origin");
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
  }
  return values;
}

function hasForbiddenForwardingHeader(rawHeaders: readonly string[]): boolean {
  return rawHeaderNames(rawHeaders).some(
    (name) =>
      name === "forwarded" ||
      name === "x-real-ip" ||
      name === "x-original-host" ||
      name === "x-original-proto" ||
      name.startsWith("x-forwarded-")
  );
}

function hasHeaderPrefix(rawHeaders: readonly string[], prefix: string): boolean {
  return rawHeaderNames(rawHeaders).some((name) => name.startsWith(prefix));
}

function rawHeaderNames(rawHeaders: readonly string[]): readonly string[] {
  if (rawHeaders.length % 2 !== 0) throw new HostDeckRequestTrustError("invalid_origin");
  const names: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) names.push((rawHeaders[index] ?? "").toLowerCase());
  return names;
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

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === "::1") return true;
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(mapped) !== 4) return false;
  return mapped.split(".")[0] === "127";
}

function tryDerivePairClaimSourceKey(remoteAddress: unknown): string | null {
  try {
    return deriveHostDeckPairClaimSourceKey(remoteAddress);
  } catch {
    return null;
  }
}

function canonicalPairClaimPeer(
  address: string
): { readonly address: string; readonly family: "ipv4" | "ipv6" } | null {
  const family = isIP(address);
  try {
    if (family === 4) {
      const parsed = SocketAddress.parse(address);
      if (parsed === undefined || parsed.family !== "ipv4" || parsed.address === "0.0.0.0") return null;
      return { address: parsed.address, family: "ipv4" };
    }
    if (family !== 6) return null;
    const parsed = SocketAddress.parse(`[${address}]`);
    if (parsed === undefined || parsed.family !== "ipv6") return null;
    const canonical = parsed.address.toLowerCase();
    if (canonical === "::") return null;
    if (canonical.startsWith("::ffff:")) {
      const mapped = canonical.slice(7);
      const mappedAddress = SocketAddress.parse(mapped);
      if (mappedAddress === undefined || mappedAddress.family !== "ipv4" || mappedAddress.address === "0.0.0.0") {
        return null;
      }
      return { address: mappedAddress.address, family: "ipv4" };
    }
    return { address: canonical, family: "ipv6" };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const unwrapped = unwrapIpv6Hostname(hostname).toLowerCase();
  return unwrapped === "localhost" || isLoopbackAddress(unwrapped);
}

function isUnspecifiedHostname(hostname: string): boolean {
  const unwrapped = unwrapIpv6Hostname(hostname).toLowerCase();
  return unwrapped === "0.0.0.0" || unwrapped === "::";
}

function unwrapIpv6Hostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBoundedVisibleAscii(value: string, maximumBytes: number): boolean {
  if (value.length < 1 || value.length > maximumBytes) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function incrementCounter(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function assertPlainExactObject(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}
