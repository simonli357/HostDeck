import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { HostDeckCodexAdapterError } from "./errors.js";

export const codexRemoteAuthEnvironmentVariable =
  "HOSTDECK_CODEX_REMOTE_AUTH" as const;

export interface CodexUnixSocketEndpoint {
  readonly schema_version: 1;
  readonly target: "linux-x64";
  readonly kind: "unix_socket";
  readonly address: string;
  readonly credential_source: "none";
}

export interface CodexAuthenticatedLoopbackWebSocketEndpoint {
  readonly schema_version: 1;
  readonly target: "windows-x64";
  readonly kind: "authenticated_loopback_websocket";
  readonly address: string;
  readonly port_allocation: "ephemeral_random";
  readonly credential_source: "protected_environment";
}

export type CodexLocalEndpoint =
  | CodexUnixSocketEndpoint
  | CodexAuthenticatedLoopbackWebSocketEndpoint;

export interface CodexProtectedEnvironmentCredentialSource {
  readonly kind: "protected_environment";
  readonly environment_variable: typeof codexRemoteAuthEnvironmentVariable;
  readonly read: (environmentVariable: string) => string | undefined;
}

export type ResolvedCodexEndpointConnection = Readonly<
  | {
      readonly endpoint: CodexUnixSocketEndpoint;
      readonly web_socket_address: string;
      readonly authorization_header: null;
    }
  | {
      readonly endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
      readonly web_socket_address: string;
      readonly authorization_header: string;
    }
>;

const unixEndpointKeys = Object.freeze([
  "address",
  "credential_source",
  "kind",
  "schema_version",
  "target"
] as const);
const windowsEndpointKeys = Object.freeze([
  "address",
  "credential_source",
  "kind",
  "port_allocation",
  "schema_version",
  "target"
] as const);
const credentialSourceKeys = Object.freeze([
  "environment_variable",
  "kind",
  "read"
] as const);
const windowsAddressPattern = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/u;
const environmentVariablePattern = /^[A-Z][A-Z0-9_]{2,127}$/u;
const bearerTokenPattern = /^[A-Za-z0-9_-]{43,512}$/u;

export function parseCodexLocalEndpoint(candidate: unknown): CodexLocalEndpoint {
  try {
    return parseCodexLocalEndpointValue(candidate);
  } catch {
    throw invalidEndpoint();
  }
}

function parseCodexLocalEndpointValue(candidate: unknown): CodexLocalEndpoint {
  const value = exactRecord(candidate, "endpoint");
  if (value.kind === "unix_socket") {
    requireExactKeys(value, unixEndpointKeys, "endpoint");
    if (
      value.schema_version !== 1 ||
      value.target !== "linux-x64" ||
      value.credential_source !== "none" ||
      typeof value.address !== "string" ||
      !value.address.startsWith("unix://")
    ) {
      throw invalidEndpoint();
    }
    const socketPath = parseCodexUnixSocketPath(value.address.slice("unix://".length));
    return Object.freeze({
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: `unix://${socketPath}`,
      credential_source: "none"
    });
  }
  if (value.kind === "authenticated_loopback_websocket") {
    requireExactKeys(value, windowsEndpointKeys, "endpoint");
    if (
      value.schema_version !== 1 ||
      value.target !== "windows-x64" ||
      value.port_allocation !== "ephemeral_random" ||
      value.credential_source !== "protected_environment" ||
      typeof value.address !== "string"
    ) {
      throw invalidEndpoint();
    }
    parseWindowsLoopbackAddress(value.address);
    return Object.freeze({
      schema_version: 1,
      target: "windows-x64",
      kind: "authenticated_loopback_websocket",
      address: value.address,
      port_allocation: "ephemeral_random",
      credential_source: "protected_environment"
    });
  }
  throw invalidEndpoint();
}

export function createCodexUnixSocketEndpoint(socketPath: string): CodexUnixSocketEndpoint {
  const parsedSocketPath = parseCodexUnixSocketPath(socketPath);
  return Object.freeze({
    schema_version: 1,
    target: "linux-x64",
    kind: "unix_socket",
    address: `unix://${parsedSocketPath}`,
    credential_source: "none"
  });
}

export function formatCodexLocalRemoteAddress(endpoint: unknown): string {
  return parseCodexLocalEndpoint(endpoint).address;
}

export function formatCodexUnixRemoteAddress(socketPath: string): string {
  return createCodexUnixSocketEndpoint(socketPath).address;
}

export function describeCodexLocalEndpoint(endpoint: unknown): string {
  const parsed = parseCodexLocalEndpoint(endpoint);
  return parsed.kind === "unix_socket"
    ? "unix://<private>"
    : "ws://127.0.0.1:<ephemeral>";
}

export function resolveCodexEndpointConnection(
  endpointCandidate: unknown,
  hostTarget: unknown,
  credentialCandidate: unknown
): ResolvedCodexEndpointConnection {
  const endpoint = parseCodexLocalEndpoint(endpointCandidate);
  if (
    (hostTarget !== "linux-x64" && hostTarget !== "windows-x64") ||
    endpoint.target !== hostTarget
  ) {
    throw invalidEndpoint();
  }
  if (endpoint.kind === "unix_socket") {
    if (credentialCandidate !== undefined) throw invalidCredentialSource();
    return Object.freeze({
      endpoint,
      web_socket_address: `ws+unix:${endpoint.address.slice("unix://".length)}`,
      authorization_header: null
    });
  }
  const token = readProtectedEnvironmentCredential(credentialCandidate);
  return Object.freeze({
    endpoint,
    web_socket_address: endpoint.address,
    authorization_header: `Bearer ${token}`
  });
}

export function parseCodexUnixSocketPath(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    !posix.isAbsolute(candidate) ||
    candidate === "/" ||
    candidate.endsWith("/") ||
    posix.normalize(candidate) !== candidate ||
    Buffer.byteLength(candidate, "utf8") > 107 ||
    [":", "?", "#", "%", "\\"].some((character) => candidate.includes(character)) ||
    containsControlCharacter(candidate)
  ) {
    throw invalidEndpoint();
  }
  return candidate;
}

function parseWindowsLoopbackAddress(candidate: string): number {
  const match = windowsAddressPattern.exec(candidate);
  if (match === null) throw invalidEndpoint();
  const port = Number(match[1]);
  if (
    !Number.isSafeInteger(port) ||
    port < 1_024 ||
    port > 65_535 ||
    String(port) !== match[1]
  ) {
    throw invalidEndpoint();
  }
  return port;
}

function readProtectedEnvironmentCredential(candidate: unknown): string {
  try {
    const source = exactRecord(candidate, "credential source");
    requireExactKeys(source, credentialSourceKeys, "credential source");
    if (
      source.kind !== "protected_environment" ||
      source.environment_variable !== codexRemoteAuthEnvironmentVariable ||
      !environmentVariablePattern.test(source.environment_variable) ||
      typeof source.read !== "function"
    ) {
      throw invalidCredentialSource();
    }
    const token = source.read(source.environment_variable);
    if (
      typeof token !== "string" ||
      !bearerTokenPattern.test(token) ||
      Buffer.byteLength(token, "utf8") > 512
    ) {
      throw invalidCredentialSource();
    }
    return token;
  } catch {
    throw invalidCredentialSource();
  }
}

function exactRecord(candidate: unknown, kind: "credential source" | "endpoint"): Record<string, unknown> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw invalidRecord(kind);
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidRecord(kind);
    }
    const value: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") throw invalidRecord(kind);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw invalidRecord(kind);
      }
      value[key] = descriptor.value;
    }
    return value;
  } catch {
    throw invalidRecord(kind);
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  kind: "credential source" | "endpoint"
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw kind === "endpoint" ? invalidEndpoint() : invalidCredentialSource();
  }
  const actual = (ownKeys as string[]).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw kind === "endpoint" ? invalidEndpoint() : invalidCredentialSource();
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function invalidEndpoint(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "invalid_transport_config",
    "Invalid Codex local endpoint configuration.",
    { outcome: "not_sent", retry_safe: true }
  );
}

function invalidCredentialSource(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "invalid_transport_config",
    "Invalid Codex endpoint credential source.",
    { outcome: "not_sent", retry_safe: true }
  );
}

function invalidRecord(
  kind: "credential source" | "endpoint"
): HostDeckCodexAdapterError {
  return kind === "endpoint" ? invalidEndpoint() : invalidCredentialSource();
}
