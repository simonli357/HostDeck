import {
  type SelectedHostAccessMode,
  type SelectedHostStatusResponse,
  type SelectedReadinessResponse,
  type SelectedRequestAuthenticationContext,
  selectedHostStatusResponseSchema,
  selectedLivenessResponseSchema,
  selectedReadinessResponseSchema
} from "@hostdeck/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import {
  assertHostDeckRequestAuthenticationCurrent,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertHostDeckHostHealthService,
  type HostDeckHostHealthService,
  type HostDeckLocalHealthSnapshot,
  type HostDeckRemoteHealthSnapshot
} from "./host-health.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckHealthRouteRegistrationId = "selected-health-status";

export interface CreateHostDeckHealthRouteRegistrationInput {
  readonly health: HostDeckHostHealthService;
}

const inputKeys = ["health"] as const;
const noQuerySchema = z.object({}).strict();
const registeredHealthServices = new WeakSet<object>();
const livenessResponse = deepFreeze(
  selectedLivenessResponseSchema.parse({ status: "alive" })
);

class HostDeckHealthRouteContractError extends Error {
  constructor() {
    super("Selected host health route contract failed.");
    this.name = "HostDeckHealthRouteContractError";
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

export function createHostDeckHealthRouteRegistration(
  input: CreateHostDeckHealthRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(
    input,
    inputKeys,
    "HostDeck health route input is invalid."
  );
  assertHostDeckHostHealthService(values.health);
  const health = values.health;
  if (registeredHealthServices.has(health)) {
    throw new TypeError("Host health service already owns a route registration.");
  }

  const livenessManifest = requireManifestEntry("health_liveness");
  const readinessManifest = requireManifestEntry("health_readiness");
  const statusManifest = requireManifestEntry("host_status");
  const responseContexts = new WeakMap<
    FastifyRequest,
    SelectedRequestAuthenticationContext
  >();
  let registered = false;

  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckHealthRouteRegistrationId,
    surface: "api",
    register(app) {
      if (registered) {
        throw new TypeError("Host health routes are already registered.");
      }
      registered = true;

      app.get(
        livenessManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          schema: {
            querystring: noQuerySchema,
            response: { 200: selectedLivenessResponseSchema }
          }
        },
        () => livenessResponse
      );

      app.get(
        readinessManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          onSend: currentProtectedResponse(responseContexts),
          schema: {
            querystring: noQuerySchema,
            response: {
              200: selectedReadinessResponseSchema,
              503: selectedReadinessResponseSchema
            }
          }
        },
        (request, reply) =>
          handleReadiness(request, reply, health, responseContexts)
      );

      app.get(
        statusManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          onSend: currentProtectedResponse(responseContexts),
          schema: {
            querystring: noQuerySchema,
            response: { 200: selectedHostStatusResponseSchema }
          }
        },
        (request) => handleHostStatus(request, health, responseContexts)
      );
    }
  };

  registeredHealthServices.add(health);
  return Object.freeze(registration);
}

function handleReadiness(
  request: FastifyRequest,
  reply: FastifyReply,
  health: HostDeckHostHealthService,
  responseContexts: WeakMap<FastifyRequest, SelectedRequestAuthenticationContext>
): SelectedReadinessResponse | FastifyReply {
  const context = requireHostDeckRequestAuthentication(
    request,
    "loopback_or_device_cookie"
  );
  const response = readReadinessResponse(health);
  responseContexts.set(request, context);
  assertHostDeckRequestAuthenticationCurrent(request, context);
  return response.readiness === "ready"
    ? response
    : reply.code(503).send(response);
}

function handleHostStatus(
  request: FastifyRequest,
  health: HostDeckHostHealthService,
  responseContexts: WeakMap<FastifyRequest, SelectedRequestAuthenticationContext>
): SelectedHostStatusResponse {
  const context = requireHostDeckRequestAuthentication(
    request,
    "loopback_or_device_cookie"
  );
  const response = readHostStatusResponse(health, context);
  responseContexts.set(request, context);
  assertHostDeckRequestAuthenticationCurrent(request, context);
  return response;
}

function currentProtectedResponse(
  responseContexts: WeakMap<FastifyRequest, SelectedRequestAuthenticationContext>
): (
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
) => Promise<unknown> {
  return (request, reply, payload) => {
    const context = responseContexts.get(request);
    if (
      context !== undefined &&
      (reply.statusCode === 200 || reply.statusCode === 503)
    ) {
      assertHostDeckRequestAuthenticationCurrent(request, context);
    }
    return Promise.resolve(payload);
  };
}

function readReadinessResponse(
  health: HostDeckHostHealthService
): SelectedReadinessResponse {
  try {
    const local = Reflect.apply(health.localSnapshot, undefined, []);
    return deepFreeze(
      selectedReadinessResponseSchema.parse(publicLocalHealth(local, false))
    );
  } catch {
    throw contractFailure();
  }
}

function readHostStatusResponse(
  health: HostDeckHostHealthService,
  context: SelectedRequestAuthenticationContext
): SelectedHostStatusResponse {
  try {
    const local = Reflect.apply(health.localSnapshot, undefined, []);
    const remote = Reflect.apply(health.remoteSnapshot, undefined, []);
    const mode = accessMode(context);
    const causes: Array<"read_only_access" | "host_not_ready"> = [];
    if (mode === "loopback_read" || mode === "paired_read") {
      causes.push("read_only_access");
    }
    if (local.mutation_admission !== "open") causes.push("host_not_ready");

    return deepFreeze(
      selectedHostStatusResponseSchema.parse({
        local: publicLocalHealth(local, true),
        remote: publicRemoteHealth(remote),
        access: {
          mode,
          network_mode: context.network_mode,
          transport: context.transport,
          write_eligibility: {
            scope: "host_health_and_authority",
            eligible: causes.length === 0,
            causes
          }
        }
      })
    );
  } catch {
    throw contractFailure();
  }
}

function publicLocalHealth(
  snapshot: HostDeckLocalHealthSnapshot,
  includeMutationAdmission: boolean
): Record<string, unknown> {
  return {
    generation: snapshot.generation,
    state: snapshot.state,
    readiness: snapshot.readiness,
    updated_at: snapshot.updated_at,
    components: snapshot.components.map((component) => ({
      component: component.component,
      state: component.state,
      checked_at: component.checked_at,
      causes: [...component.reasons]
    })),
    ...(includeMutationAdmission
      ? { mutation_admission: snapshot.mutation_admission }
      : {})
  };
}

function publicRemoteHealth(
  snapshot: HostDeckRemoteHealthSnapshot
): Record<string, unknown> {
  return {
    generation: snapshot.generation,
    state_generation: snapshot.state_generation,
    availability: snapshot.availability,
    cause: snapshot.reason,
    external_origin: snapshot.external_origin,
    laptop_action_required: snapshot.laptop_action_required,
    observed_at: snapshot.observed_at,
    checked_at: snapshot.checked_at,
    updated_at: snapshot.updated_at
  };
}

function accessMode(
  context: SelectedRequestAuthenticationContext
): SelectedHostAccessMode {
  if (context.state === "local_admin") return "local_admin";
  if (context.state === "unpaired" && context.network_mode === "loopback") {
    return "loopback_read";
  }
  if (context.state === "paired_device" && context.permission === "read") {
    return "paired_read";
  }
  if (context.state === "paired_device" && context.permission === "write") {
    return "paired_write";
  }
  throw contractFailure();
}

function requireManifestEntry(
  id: "health_liveness" | "health_readiness" | "host_status"
): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "health" ||
    entry.method !== "GET" ||
    entry.transport !== "json" ||
    entry.request.params !== null ||
    entry.request.query !== null ||
    entry.request.body !== null ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.owner_task !== "IFC-V1-039"
  ) {
    throw new TypeError("Selected health route manifest entry is invalid.");
  }

  if (id === "health_liveness") {
    if (
      entry.path !== "/api/v1/health/live" ||
      entry.response.success !== "liveness_response_v1" ||
      entry.auth !== "none" ||
      entry.authority !== "public" ||
      entry.target !== "none" ||
      entry.handler !== "health.liveness"
    ) {
      throw new TypeError("Selected liveness route manifest entry is invalid.");
    }
  } else if (id === "health_readiness") {
    if (
      entry.path !== "/api/v1/health/ready" ||
      entry.response.success !== "readiness_response_v1" ||
      entry.auth !== "loopback_or_device_cookie" ||
      entry.authority !== "host_read" ||
      entry.target !== "host" ||
      entry.handler !== "health.readiness"
    ) {
      throw new TypeError("Selected readiness route manifest entry is invalid.");
    }
  } else if (
    entry.path !== "/api/v1/host/status" ||
    entry.response.success !== "host_status_response_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "host_read" ||
    entry.target !== "host" ||
    entry.handler !== "health.hostStatus"
  ) {
    throw new TypeError("Selected host-status route manifest entry is invalid.");
  }
  return entry;
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
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
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
    const values = Object.create(null) as Record<Key, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        throw new TypeError();
      }
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    throw new TypeError(message);
  }
}

function contractFailure(): HostDeckHealthRouteContractError {
  return new HostDeckHealthRouteContractError();
}

function deepFreeze<T>(candidate: T): T {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
