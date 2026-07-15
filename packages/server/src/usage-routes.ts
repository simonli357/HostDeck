import { randomUUID } from "node:crypto";
import {
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema,
  type UsageSnapshot,
  usageOperationIntentSchema,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { SelectedStateRepository } from "@hostdeck/storage";
import { z } from "zod";
import {
  type CodexUsageControlService,
  HostDeckCodexUsageControlError
} from "./codex-usage-control-service.js";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckRequestAuthentication } from "./fastify-request-authentication.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckUsageRouteRegistrationId = "selected-usage-read";

export interface CreateHostDeckUsageRouteRegistrationInput {
  readonly state: Pick<SelectedStateRepository, "get">;
  readonly usage: Pick<CodexUsageControlService, "read">;
}

type GetStateFunction = SelectedStateRepository["get"];
type ReadUsageFunction = CodexUsageControlService["read"];
type UsageParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedUsagePorts {
  readonly getState: GetStateFunction;
  readonly readUsage: ReadUsageFunction;
}

const registrationInputKeys = ["state", "usage"] as const;
const statePortKeys = ["get"] as const;
const usagePortKeys = ["read"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

class HostDeckUsageRouteContractError extends Error {
  constructor() {
    super("Selected usage route contract failed.");
    this.name = "HostDeckUsageRouteContractError";
  }
}

export function createHostDeckUsageRouteRegistration(
  input: CreateHostDeckUsageRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const ports = parseRegistrationInput(input);
  const manifest = requireUsageManifestEntry();
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckUsageRouteRegistrationId,
    surface: "api",
    register(app) {
      app.get(
        manifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(request, reply) {
            reply.header("cache-control", "no-store");
            requireHostDeckRequestAuthentication(
              request,
              "loopback_or_device_cookie"
            );
          },
          schema: {
            params: sessionIdParamsSchema,
            querystring: noQuerySchema,
            response: { 200: usageSnapshotSchema }
          }
        },
        async (request) => {
          const params = request.params as UsageParams;
          const target = resolveManagedTarget(
            ports.getState,
            params.session_id
          );
          return await invokeUsageRead(
            ports.readUsage,
            target,
            request.signal
          );
        }
      );
    }
  };
  return Object.freeze(registration);
}

function parseRegistrationInput(input: unknown): ParsedUsagePorts {
  const values = readExactDataObject(
    input,
    registrationInputKeys,
    "HostDeck usage route input is invalid."
  );
  const state = readExactDataObject(
    values.state,
    statePortKeys,
    "HostDeck usage state port is invalid."
  );
  const usage = readExactDataObject(
    values.usage,
    usagePortKeys,
    "HostDeck usage control port is invalid."
  );
  if (typeof state.get !== "function") {
    throw new TypeError("HostDeck usage state port is invalid.");
  }
  if (typeof usage.read !== "function") {
    throw new TypeError("HostDeck usage control port is invalid.");
  }
  return Object.freeze({
    getState: state.get as GetStateFunction,
    readUsage: usage.read as ReadUsageFunction
  });
}

function requireUsageManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "usage_read"
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "controls" ||
    entry.method !== "GET" ||
    entry.path !== "/api/v1/sessions/:session_id/usage" ||
    entry.transport !== "json" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== null ||
    entry.request.body !== null ||
    entry.response.success !== "usage_snapshot_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== "usage" ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "controls.readUsage" ||
    entry.owner_task !== "IFC-V1-043"
  ) {
    throw new TypeError("Selected usage route manifest entry is invalid.");
  }
  return entry;
}

function resolveManagedTarget(
  getState: GetStateFunction,
  sessionId: UsageParams["session_id"]
): ManagedSessionTarget {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw usageHttpError(
      500,
      "storage_error",
      "Managed session state is unavailable.",
      sessionId,
      false
    );
  }
  if (candidate === null) {
    throw usageHttpError(
      404,
      "session_not_found",
      "Managed session was not found.",
      sessionId,
      false
    );
  }

  try {
    const state = readExactDataObject(
      candidate,
      selectedStateKeys,
      "Selected usage state is invalid."
    );
    const mapping = selectedSessionMappingRecordSchema.parse(state.mapping);
    const projection = selectedSessionProjectionRecordSchema.parse(
      state.projection
    );
    if (
      mapping.id !== sessionId ||
      projection.session.id !== sessionId ||
      mapping.codex_thread_id !== projection.session.codex_thread_id ||
      mapping.name !== projection.session.name ||
      mapping.cwd !== projection.session.cwd ||
      mapping.runtime_source !== projection.session.runtime_source ||
      mapping.runtime_version !== projection.session.runtime_version ||
      mapping.created_at !== projection.session.created_at ||
      mapping.archived_at !== projection.session.archived_at
    ) {
      throw new TypeError();
    }
    return deepFreeze(
      managedSessionTargetSchema.parse({
        type: "managed_session",
        session_id: sessionId,
        codex_thread_id: mapping.codex_thread_id
      })
    );
  } catch {
    throw usageHttpError(
      500,
      "storage_error",
      "Managed session state is invalid.",
      sessionId,
      false
    );
  }
}

async function invokeUsageRead(
  readUsage: ReadUsageFunction,
  target: ManagedSessionTarget,
  signal: AbortSignal
): Promise<UsageSnapshot> {
  const intent = usageOperationIntentSchema.parse({
    operation_id: `op_usage_read_${randomUUID().replaceAll("-", "")}`,
    target,
    kind: "usage"
  });
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(readUsage, undefined, [intent, signal]);
  } catch (error) {
    if (error instanceof HostDeckCodexUsageControlError) {
      throw mapUsageFailure(error, target.session_id);
    }
    throw error;
  }

  const parsed = usageSnapshotSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.target.session_id !== target.session_id ||
    parsed.data.target.codex_thread_id !== target.codex_thread_id
  ) {
    throw new HostDeckUsageRouteContractError();
  }
  return deepFreeze(parsed.data);
}

function mapUsageFailure(
  error: HostDeckCodexUsageControlError,
  sessionId: UsageParams["session_id"]
): HostDeckHttpError {
  switch (error.code) {
    case "capability_unsupported":
      return usageHttpError(
        409,
        "capability_unavailable",
        "Structured usage is unavailable for the selected runtime.",
        sessionId,
        false
      );
    case "invalid_request":
      return usageHttpError(
        500,
        "internal_error",
        "Usage request construction failed.",
        sessionId,
        false
      );
    case "observation_conflict":
    case "runtime_protocol_error":
      return usageHttpError(
        502,
        "protocol_error",
        "Codex usage data failed protocol validation.",
        sessionId,
        false
      );
    case "runtime_unavailable":
      return usageHttpError(
        503,
        "runtime_unavailable",
        "Codex usage is unavailable.",
        sessionId,
        error.retry_safe
      );
    case "service_overloaded":
      return usageHttpError(
        503,
        "service_overloaded",
        "Usage read capacity is exhausted.",
        sessionId,
        error.retry_safe
      );
    case "state_unavailable":
      return usageHttpError(
        500,
        "storage_error",
        "Managed session state is unavailable.",
        sessionId,
        error.retry_safe
      );
    case "target_mismatch":
      return usageHttpError(
        409,
        "invalid_session_id",
        "Managed session identity changed during the usage read.",
        sessionId,
        false
      );
    case "target_not_found":
      return usageHttpError(
        404,
        "session_not_found",
        "Managed session was not found.",
        sessionId,
        false
      );
    case "target_not_readable":
      return usageHttpError(
        409,
        "session_not_writable",
        "Managed session is not readable for usage.",
        sessionId,
        false
      );
    case "target_stale":
      return usageHttpError(
        409,
        "stale_session",
        "Managed session usage state is stale.",
        sessionId,
        error.retry_safe
      );
  }
}

function usageHttpError(
  status: number,
  code: ConstructorParameters<typeof HostDeckHttpError>[0]["code"],
  message: string,
  sessionId: UsageParams["session_id"],
  retryable: boolean
): HostDeckHttpError {
  return new HostDeckHttpError({
    code,
    message,
    retryable,
    sessionId,
    status
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactDataObject<const Key extends string>(
  candidate: unknown,
  expectedKeys: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !(expectedKeys as readonly string[]).includes(key)
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
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
    return Object.freeze(values) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}
