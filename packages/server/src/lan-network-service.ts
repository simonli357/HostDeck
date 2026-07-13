import {
  type SelectedLanConfigureRequest,
  type SelectedLanDisableRequest,
  type SelectedLanEnableRequest,
  type SelectedLanMutationResponse,
  type SelectedNetworkStateResponse,
  type SelectedRequestAuthenticationContext,
  selectedLanConfigureRequestSchema,
  selectedLanDisableRequestSchema,
  selectedLanEnableRequestSchema,
  selectedLanMutationResponseSchema,
  selectedNetworkStateResponseSchema,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import { type ErrorCode, isErrorCode } from "@hostdeck/core";
import {
  assertHostDeckLanConfigurationRepository,
  type HostDeckLanCertificateDescriptor,
  HostDeckLanConfigurationError,
  type HostDeckLanConfigurationRecord,
  type HostDeckLanConfigurationRepository,
  type HostDeckLanStateSnapshot
} from "@hostdeck/storage";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckAuthenticationContext } from "./fastify-request-authentication.js";
import {
  assertHostDeckLanCertificatePolicy,
  type HostDeckLanAddressAdmission,
  HostDeckLanCertificateError,
  type HostDeckLanCertificateInspection,
  type HostDeckLanCertificatePolicy
} from "./lan-certificate-policy.js";
import {
  assertHostDeckSecurityMutationAuditExecutor,
  type ExecuteSecurityMutationInput,
  HostDeckSecurityMutationAuditExecutorError,
  type SecurityMutationAuditExecutor, 
  type SecurityMutationExecutionResult
} from "./security-mutation-audit-executor.js";

export interface CreateHostDeckLanNetworkServiceInput {
  readonly audit: SecurityMutationAuditExecutor;
  readonly certificates: HostDeckLanCertificatePolicy;
  readonly network: HostDeckLanConfigurationRepository;
  readonly now: () => Date;
}

export interface HostDeckLanNetworkServiceSnapshot {
  readonly audit_failures: number;
  readonly certificate_failures: number;
  readonly configurations: number;
  readonly disables: number;
  readonly enables: number;
  readonly reads: number;
  readonly storage_failures: number;
}

export interface HostDeckLanNetworkService {
  readonly configure: (
    context: SelectedRequestAuthenticationContext,
    request: SelectedLanConfigureRequest
  ) => Promise<SelectedLanMutationResponse>;
  readonly disable: (
    context: SelectedRequestAuthenticationContext,
    request: SelectedLanDisableRequest
  ) => Promise<SelectedLanMutationResponse>;
  readonly enable: (
    context: SelectedRequestAuthenticationContext,
    request: SelectedLanEnableRequest
  ) => Promise<SelectedLanMutationResponse>;
  readonly read: (
    context: SelectedRequestAuthenticationContext
  ) => SelectedNetworkStateResponse;
  readonly snapshot: () => HostDeckLanNetworkServiceSnapshot;
}

interface MutableCounters {
  auditFailures: number;
  certificateFailures: number;
  configurations: number;
  disables: number;
  enables: number;
  reads: number;
  storageFailures: number;
}

interface ConfigurationTransitionResponse {
  readonly configuration_changed: boolean;
  readonly desired_mode_changed: false;
}

interface ModeTransitionResponse {
  readonly configuration_changed: false;
  readonly desired_mode_changed: boolean;
}

const inputKeys = ["audit", "certificates", "network", "now"] as const;
const acceptedServices = new WeakSet<object>();
const maxCounter = Number.MAX_SAFE_INTEGER;

export function createHostDeckLanNetworkService(
  input: CreateHostDeckLanNetworkServiceInput
): HostDeckLanNetworkService {
  const values = readExactDataObject(input, inputKeys);
  assertHostDeckSecurityMutationAuditExecutor(values.audit);
  assertHostDeckLanCertificatePolicy(values.certificates);
  assertHostDeckLanConfigurationRepository(values.network);
  if (typeof values.now !== "function") {
    throw new TypeError("HostDeck LAN network clock is invalid.");
  }
  const audit = values.audit;
  const certificates = values.certificates;
  const network = values.network;
  const now = values.now as () => Date;
  const counters: MutableCounters = {
    auditFailures: 0,
    certificateFailures: 0,
    configurations: 0,
    disables: 0,
    enables: 0,
    reads: 0,
    storageFailures: 0
  };

  const service: HostDeckLanNetworkService = Object.freeze({
    async configure(
      rawContext: SelectedRequestAuthenticationContext,
      rawRequest: SelectedLanConfigureRequest
    ) {
      const context = requireLocalAdmin(rawContext);
      const request = parseRequest(selectedLanConfigureRequestSchema, rawRequest);
      let admission: HostDeckLanAddressAdmission;
      try {
        admission = certificates.admit({
          bind_host: request.bind_host,
          bind_port: request.bind_port
        });
      } catch (error) {
        counters.certificateFailures = increment(counters.certificateFailures);
        throw preflightCertificateFailure(error);
      }
      const result = await executeAudit(
        audit,
        counters,
        {
          operation_id: request.operation_id,
          actor: localAdminActor(context),
          action: "lan_configure",
          target: { type: "host", host_id: "local_host" },
          accepted_summary: {
            schema_version: 1,
            bind_address_family: admission.address_family,
            bind_port: admission.bind_port,
            certificate_change_requested:
              request.certificate_action === "issue_leaf"
          },
          emergency_lock_on_audit_unavailable: false,
          transition: async () => {
            let inspection: HostDeckLanCertificateInspection;
            try {
              inspection = await certificates.configure({
                bind_host: request.bind_host,
                bind_port: request.bind_port,
                certificate_action: request.certificate_action
              });
            } catch (error) {
              counters.certificateFailures = increment(counters.certificateFailures);
              return Object.freeze({
                outcome:
                  request.certificate_action === "issue_leaf"
                    ? ("incomplete" as const)
                    : ("failed" as const),
                error_code: mapCertificateError(error),
                payload_summary: Object.freeze({ schema_version: 1 })
              });
            }
            try {
              const receipt = network.configure({
                ...certificateDescriptor(inspection),
                now: readNow(now)
              });
              counters.configurations = increment(counters.configurations);
              return Object.freeze({
                outcome: "succeeded" as const,
                response: Object.freeze({
                  configuration_changed: receipt.changed,
                  desired_mode_changed: false as const
                }),
                payload_summary: Object.freeze({
                  schema_version: 1,
                  configuration_changed: receipt.changed
                })
              });
            } catch (error) {
              counters.storageFailures = increment(counters.storageFailures);
              return Object.freeze({
                outcome: "incomplete" as const,
                error_code: mapStorageError(error),
                payload_summary: Object.freeze({ schema_version: 1 })
              });
            }
          },
          prepare_response: (response: ConfigurationTransitionResponse) =>
            mutationResponse(context, readState(network, certificates, counters), response)
        }
      );
      return parseMutationResult(result);
    },
    async disable(
      rawContext: SelectedRequestAuthenticationContext,
      rawRequest: SelectedLanDisableRequest
    ) {
      const context = requireLocalAdmin(rawContext);
      const request = parseRequest(selectedLanDisableRequestSchema, rawRequest);
      const result = await executeAudit(
        audit,
        counters,
        {
          operation_id: request.operation_id,
          actor: localAdminActor(context),
          action: "lan_disable",
          target: { type: "host", host_id: "local_host" },
          accepted_summary: {
            schema_version: 1,
            requested_lan_enabled: false
          },
          emergency_lock_on_audit_unavailable: false,
          transition: () => {
            try {
              const receipt = network.transitionMode({
                enabled: false,
                now: readNow(now)
              });
              counters.disables = increment(counters.disables);
              return Object.freeze({
                outcome: "succeeded" as const,
                response: Object.freeze({
                  configuration_changed: false as const,
                  desired_mode_changed: receipt.changed
                }),
                payload_summary: Object.freeze({
                  schema_version: 1,
                  lan_enabled: false
                })
              });
            } catch (error) {
              counters.storageFailures = increment(counters.storageFailures);
              return Object.freeze({
                outcome: storageFailureOutcome(error),
                error_code: mapStorageError(error),
                payload_summary: Object.freeze({ schema_version: 1 })
              });
            }
          },
          prepare_response: (response: ModeTransitionResponse) =>
            mutationResponse(context, readState(network, certificates, counters), response)
        }
      );
      return parseMutationResult(result);
    },
    async enable(
      rawContext: SelectedRequestAuthenticationContext,
      rawRequest: SelectedLanEnableRequest
    ) {
      const context = requireLocalAdmin(rawContext);
      const request = parseRequest(selectedLanEnableRequestSchema, rawRequest);
      let inspection: HostDeckLanCertificateInspection;
      try {
        const state = readState(network, certificates, counters);
        if (state.configuration === null) throw invalidConfig();
        inspection = certificates.inspect({
          bind_host: state.configuration.bind_host,
          bind_port: state.configuration.bind_port
        });
        if (
          !descriptorsEqual(state.configuration, inspection) ||
          (inspection.certificate_state !== "valid" &&
            inspection.certificate_state !== "renewal_due")
        ) {
          throw invalidConfig();
        }
      } catch (error) {
        if (error instanceof HostDeckHttpError) throw error;
        counters.certificateFailures = increment(counters.certificateFailures);
        throw preflightCertificateFailure(error);
      }
      const result = await executeAudit(
        audit,
        counters,
        {
          operation_id: request.operation_id,
          actor: localAdminActor(context),
          action: "lan_enable",
          target: { type: "host", host_id: "local_host" },
          accepted_summary: {
            schema_version: 1,
            requested_lan_enabled: true
          },
          emergency_lock_on_audit_unavailable: false,
          transition: () => {
            try {
              const receipt = network.transitionMode({
                enabled: true,
                expected_configuration: certificateDescriptor(inspection),
                now: readNow(now)
              });
              counters.enables = increment(counters.enables);
              return Object.freeze({
                outcome: "succeeded" as const,
                response: Object.freeze({
                  configuration_changed: false as const,
                  desired_mode_changed: receipt.changed
                }),
                payload_summary: Object.freeze({
                  schema_version: 1,
                  lan_enabled: true
                })
              });
            } catch (error) {
              counters.storageFailures = increment(counters.storageFailures);
              return Object.freeze({
                outcome: storageFailureOutcome(error),
                error_code: mapStorageError(error),
                payload_summary: Object.freeze({ schema_version: 1 })
              });
            }
          },
          prepare_response: (response: ModeTransitionResponse) =>
            mutationResponse(context, readState(network, certificates, counters), response)
        }
      );
      return parseMutationResult(result);
    },
    read(rawContext: SelectedRequestAuthenticationContext) {
      const context = parseContext(rawContext);
      requireHostDeckAuthenticationContext(context, "loopback_or_device_cookie");
      counters.reads = increment(counters.reads);
      return networkResponse(context, readState(network, certificates, counters));
    },
    snapshot() {
      return Object.freeze({
        audit_failures: counters.auditFailures,
        certificate_failures: counters.certificateFailures,
        configurations: counters.configurations,
        disables: counters.disables,
        enables: counters.enables,
        reads: counters.reads,
        storage_failures: counters.storageFailures
      });
    }
  });
  acceptedServices.add(service);
  return service;
}

export function assertHostDeckLanNetworkService(
  candidate: unknown
): asserts candidate is HostDeckLanNetworkService {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedServices.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck LAN network service must be created by createHostDeckLanNetworkService."
    );
  }
}

interface ParsedLanState {
  readonly settings: HostDeckLanStateSnapshot["settings"];
  readonly configuration: HostDeckLanConfigurationRecord | null;
  readonly certificate: HostDeckLanCertificateInspection | null;
  readonly certificateUnavailable: boolean;
}

function readState(
  network: HostDeckLanConfigurationRepository,
  certificates: HostDeckLanCertificatePolicy,
  counters: MutableCounters
): ParsedLanState {
  let state: HostDeckLanStateSnapshot;
  try {
    state = network.read();
  } catch {
    counters.storageFailures = increment(counters.storageFailures);
    throw storageError();
  }
  if (state.configuration === null) {
    return Object.freeze({
      settings: state.settings,
      configuration: null,
      certificate: null,
      certificateUnavailable: false
    });
  }
  try {
    const inspection = certificates.inspect({
      bind_host: state.configuration.bind_host,
      bind_port: state.configuration.bind_port
    });
    const exact = descriptorsEqual(state.configuration, inspection);
    return Object.freeze({
      settings: state.settings,
      configuration: state.configuration,
      certificate: exact ? inspection : null,
      certificateUnavailable: !exact
    });
  } catch {
    counters.certificateFailures = increment(counters.certificateFailures);
    return Object.freeze({
      settings: state.settings,
      configuration: state.configuration,
      certificate: null,
      certificateUnavailable: true
    });
  }
}

function networkResponse(
  context: SelectedRequestAuthenticationContext,
  state: ParsedLanState
): SelectedNetworkStateResponse {
  const configuration = state.configuration;
  const certificate = state.certificate;
  const desiredMode = state.settings.lan_enabled ? "lan" : "loopback";
  const configuredOrigin = configuration?.configured_origin ?? null;
  const candidate = {
    active_network_mode: context.network_mode,
    active_transport: context.transport,
    active_origin: context.configured_origin,
    desired_mode: desiredMode,
    lan_enabled: state.settings.lan_enabled,
    configured: configuration !== null,
    bind_host: configuration?.bind_host ?? null,
    bind_port: configuration?.bind_port ?? null,
    configured_origin: configuredOrigin,
    address_family: configuration?.address_family ?? null,
    certificate_state:
      configuration === null
        ? ("not_configured" as const)
        : state.certificateUnavailable
          ? ("unavailable" as const)
          : (certificate as HostDeckLanCertificateInspection).certificate_state,
    root_fingerprint_sha256: configuration?.root_fingerprint_sha256 ?? null,
    leaf_fingerprint_sha256: configuration?.leaf_fingerprint_sha256 ?? null,
    leaf_valid_from: configuration?.leaf_valid_from ?? null,
    leaf_expires_at: configuration?.leaf_expires_at ?? null,
    enrollment_available: configuration !== null && !state.certificateUnavailable,
    can_manage_lan: context.state === "local_admin",
    restart_required:
      context.network_mode !== desiredMode ||
      (desiredMode === "lan" &&
        (context.transport !== "https" ||
          context.configured_origin !== configuredOrigin))
  };
  const parsed = selectedNetworkStateResponseSchema.safeParse(candidate);
  if (!parsed.success) throw contractError();
  return Object.freeze({ ...parsed.data });
}

function mutationResponse(
  context: SelectedRequestAuthenticationContext,
  state: ParsedLanState,
  result: ConfigurationTransitionResponse | ModeTransitionResponse
): SelectedLanMutationResponse {
  const candidate = { ...networkResponse(context, state), ...result };
  const parsed = selectedLanMutationResponseSchema.safeParse(candidate);
  if (!parsed.success) throw contractError();
  return Object.freeze({ ...parsed.data });
}

async function executeAudit<TResponse, TPreparedResponse>(
  audit: SecurityMutationAuditExecutor,
  counters: MutableCounters,
  input: ExecuteSecurityMutationInput<TResponse, TPreparedResponse>
): Promise<SecurityMutationExecutionResult<TPreparedResponse>> {
  try {
    return await audit.execute(input);
  } catch (error) {
    counters.auditFailures = increment(counters.auditFailures);
    if (error instanceof HostDeckSecurityMutationAuditExecutorError) {
      throw publicFailure(error.api_code, error.retry_safe);
    }
    throw contractError();
  }
}

function parseMutationResult(candidate: unknown): SelectedLanMutationResponse {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw contractError();
  }
  const value = candidate as Record<string, unknown>;
  if (value.outcome === "succeeded") {
    const parsed = selectedLanMutationResponseSchema.safeParse(value.response);
    if (!parsed.success) throw contractError();
    return Object.freeze({ ...parsed.data });
  }
  if (
    (value.outcome === "failed" || value.outcome === "incomplete") &&
    typeof value.error_code === "string" &&
    isErrorCode(value.error_code)
  ) {
    throw publicFailure(value.error_code, false);
  }
  throw contractError();
}

function requireLocalAdmin(
  context: SelectedRequestAuthenticationContext
): SelectedRequestAuthenticationContext {
  return requireHostDeckAuthenticationContext(parseContext(context), "local_admin");
}

function parseContext(
  candidate: unknown
): SelectedRequestAuthenticationContext {
  const parsed = selectedRequestAuthenticationContextSchema.safeParse(candidate);
  if (!parsed.success) throw contractError();
  return Object.freeze({ ...parsed.data });
}

function parseRequest<T>(
  schema: { readonly safeParse: (candidate: unknown) => { success: boolean; data?: T } },
  candidate: unknown
): T {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success || parsed.data === undefined) {
    throw new HostDeckHttpError({
      code: "validation_error",
      message: "LAN network request is invalid.",
      retryable: false,
      status: 400
    });
  }
  return parsed.data;
}

function localAdminActor(context: SelectedRequestAuthenticationContext) {
  if (context.state !== "local_admin") throw contractError();
  return Object.freeze({
    type: "cli" as const,
    device_id: null,
    permission: "local_admin" as const,
    origin: null
  });
}

function certificateDescriptor(
  input: HostDeckLanCertificateInspection
): HostDeckLanCertificateDescriptor {
  return Object.freeze({
    bind_host: input.bind_host,
    address_family: input.address_family,
    bind_port: input.bind_port,
    configured_origin: input.configured_origin,
    root_fingerprint_sha256: input.root_fingerprint_sha256,
    leaf_fingerprint_sha256: input.leaf_fingerprint_sha256,
    leaf_valid_from: input.leaf_valid_from,
    leaf_expires_at: input.leaf_expires_at
  });
}

function descriptorsEqual(
  left: HostDeckLanCertificateDescriptor,
  right: HostDeckLanCertificateDescriptor
): boolean {
  return (
    left.bind_host === right.bind_host &&
    left.address_family === right.address_family &&
    left.bind_port === right.bind_port &&
    left.configured_origin === right.configured_origin &&
    left.root_fingerprint_sha256 === right.root_fingerprint_sha256 &&
    left.leaf_fingerprint_sha256 === right.leaf_fingerprint_sha256 &&
    left.leaf_valid_from === right.leaf_valid_from &&
    left.leaf_expires_at === right.leaf_expires_at
  );
}

function preflightCertificateFailure(error: unknown): HostDeckHttpError {
  if (error instanceof HostDeckLanCertificateError) {
    if (
      error.code === "address_unavailable" ||
      error.code === "invalid_certificate_input"
    ) {
      return new HostDeckHttpError({
        code: "validation_error",
        message: "LAN host configuration is invalid.",
        retryable: false,
        status: 400
      });
    }
  }
  return invalidConfig();
}

function mapCertificateError(error: unknown): ErrorCode {
  if (error instanceof HostDeckLanCertificateError) {
    if (
      error.code === "certificate_missing" ||
      error.code === "certificate_partial" ||
      error.code === "certificate_invalid" ||
      error.code === "certificate_not_valid"
    ) {
      return "invalid_config";
    }
  }
  return "internal_error";
}

function mapStorageError(error: unknown): ErrorCode {
  if (error instanceof HostDeckLanConfigurationError) {
    if (
      error.code === "lan_configuration_conflict" ||
      error.code === "lan_configuration_time_conflict"
    ) {
      return "operation_conflict";
    }
    if (error.code === "lan_configuration_missing") return "invalid_config";
    return "storage_error";
  }
  return "internal_error";
}

function storageFailureOutcome(
  error: unknown
): "failed" | "incomplete" {
  return error instanceof HostDeckLanConfigurationError ? "failed" : "incomplete";
}

function readNow(now: () => Date): Date {
  let value: unknown;
  try {
    value = now();
  } catch {
    throw contractError();
  }
  if (!(value instanceof Date)) throw contractError();
  const time = Date.prototype.getTime.call(value);
  if (!Number.isFinite(time)) throw contractError();
  return new Date(time);
}

function publicFailure(code: ErrorCode, retryable: boolean): HostDeckHttpError {
  const status =
    code === "validation_error"
      ? 400
      : code === "invalid_config" || code === "operation_conflict"
        ? 409
        : code === "audit_unavailable" || code === "runtime_unavailable"
          ? 503
          : 500;
  const message =
    code === "invalid_config"
      ? "LAN configuration or certificate state is invalid."
      : code === "operation_conflict"
        ? "LAN configuration conflicts with newer durable state."
        : code === "audit_unavailable"
          ? "LAN security audit is unavailable."
          : code === "storage_error"
            ? "LAN configuration storage is unavailable."
            : "LAN network mutation could not be completed.";
  return new HostDeckHttpError({ code, message, retryable, status });
}

function invalidConfig(): HostDeckHttpError {
  return publicFailure("invalid_config", false);
}

function storageError(): HostDeckHttpError {
  return publicFailure("storage_error", false);
}

function contractError(): HostDeckHttpError {
  return publicFailure("internal_error", false);
}

function readExactDataObject(
  input: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("HostDeck LAN network service input is invalid.");
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("HostDeck LAN network service input is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => {
      if (typeof key !== "string" || !expectedKeys.includes(key)) return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError("HostDeck LAN network service input is invalid.");
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key as string]?.value]))
  );
}

function increment(value: number): number {
  return value >= maxCounter ? maxCounter : value + 1;
}
