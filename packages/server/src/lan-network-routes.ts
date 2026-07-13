import {
  type SelectedLanConfigureRequest,
  type SelectedLanDisableRequest,
  type SelectedLanEnableRequest,
  selectedLanConfigureRequestSchema,
  selectedLanDisableRequestSchema,
  selectedLanEnableRequestSchema,
  selectedLanMutationResponseSchema,
  selectedNetworkStateResponseSchema
} from "@hostdeck/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import {
  requireHostDeckRequestAuthentication,
  resolveHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertHostDeckLanNetworkService,
  type HostDeckLanNetworkService
} from "./lan-network-service.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckLanNetworkRouteRegistrationId = "selected-lan-network";

export interface CreateHostDeckLanNetworkRouteRegistrationInput {
  readonly service: HostDeckLanNetworkService;
}

const inputKeys = ["service"] as const;
const noQuerySchema = z.object({}).strict();
const registeredServices = new WeakSet<object>();

export function createHostDeckLanNetworkRouteRegistration(
  input: CreateHostDeckLanNetworkRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, inputKeys);
  assertHostDeckLanNetworkService(values.service);
  const service = values.service;
  if (registeredServices.has(service)) {
    throw new TypeError("HostDeck LAN network service already owns a route registration.");
  }
  const stateManifest = requireManifestEntry("network_state");
  const configureManifest = requireManifestEntry("network_configure");
  const enableManifest = requireManifestEntry("network_enable");
  const disableManifest = requireManifestEntry("network_disable");
  let registered = false;
  const registration: HostDeckRoutePluginRegistration = Object.freeze({
    id: hostDeckLanNetworkRouteRegistrationId,
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      if (registered) {
        throw new TypeError("HostDeck LAN network routes are already registered.");
      }
      registered = true;
      app.get(
        stateManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async onRequest(_request: FastifyRequest, reply: FastifyReply) {
            setNoStore(reply);
          },
          schema: {
            querystring: noQuerySchema,
            response: { 200: selectedNetworkStateResponseSchema }
          }
        },
        async (request: FastifyRequest) =>
          service.read(resolveHostDeckRequestAuthentication(request))
      );

      app.post(
        configureManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request: FastifyRequest, reply: FastifyReply) {
            setNoStore(reply);
          },
          schema: {
            body: selectedLanConfigureRequestSchema,
            querystring: noQuerySchema,
            response: { 200: selectedLanMutationResponseSchema }
          }
        },
        async (request: FastifyRequest) =>
          service.configure(
            requireHostDeckRequestAuthentication(request, "local_admin"),
            request.body as SelectedLanConfigureRequest
          )
      );

      app.post(
        enableManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request: FastifyRequest, reply: FastifyReply) {
            setNoStore(reply);
          },
          schema: {
            body: selectedLanEnableRequestSchema,
            querystring: noQuerySchema,
            response: { 200: selectedLanMutationResponseSchema }
          }
        },
        async (request: FastifyRequest) =>
          service.enable(
            requireHostDeckRequestAuthentication(request, "local_admin"),
            request.body as SelectedLanEnableRequest
          )
      );

      app.post(
        disableManifest.path,
        {
          config: hostDeckNoStoreRouteConfig,
          async onRequest(_request: FastifyRequest, reply: FastifyReply) {
            setNoStore(reply);
          },
          schema: {
            body: selectedLanDisableRequestSchema,
            querystring: noQuerySchema,
            response: { 200: selectedLanMutationResponseSchema }
          }
        },
        async (request: FastifyRequest) =>
          service.disable(
            requireHostDeckRequestAuthentication(request, "local_admin"),
            request.body as SelectedLanDisableRequest
          )
      );
    }
  });
  registeredServices.add(service);
  return registration;
}

type NetworkManifestId =
  | "network_state"
  | "network_configure"
  | "network_enable"
  | "network_disable";

function requireManifestEntry(id: NetworkManifestId): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.owner_task !== "IFC-V1-031" ||
    entry.family !== "network" ||
    entry.transport !== "json" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.operation_kind !== null ||
    entry.credential_effect !== "none" ||
    entry.target !== "host" ||
    entry.request.params !== null ||
    entry.request.query !== null
  ) {
    throw new TypeError("Selected LAN network manifest entry is invalid.");
  }
  if (id === "network_state") {
    if (
      entry.method !== "GET" ||
      entry.path !== "/api/v1/network" ||
      entry.request.body !== null ||
      entry.response.success !== "network_state_response_v1" ||
      entry.auth !== "optional_device_cookie" ||
      entry.authority !== "access_read" ||
      entry.csrf !== "none" ||
      entry.lock !== "not_applicable" ||
      entry.audit !== null ||
      entry.handler !== "network.readState"
    ) {
      throw new TypeError("Selected LAN network read manifest entry is invalid.");
    }
    return entry;
  }

  const expected = {
    network_configure: {
      path: "/api/v1/network/configure",
      body: "lan_configure_request_v1",
      action: "lan_configure",
      handler: "network.configure"
    },
    network_enable: {
      path: "/api/v1/network/enable",
      body: "lan_enable_request_v1",
      action: "lan_enable",
      handler: "network.enable"
    },
    network_disable: {
      path: "/api/v1/network/disable",
      body: "lan_disable_request_v1",
      action: "lan_disable",
      handler: "network.disable"
    }
  } as const;
  const target = expected[id];
  if (
    entry.method !== "POST" ||
    entry.path !== target.path ||
    entry.request.body !== target.body ||
    entry.response.success !== "lan_mutation_response_v1" ||
    entry.auth !== "local_admin" ||
    entry.authority !== "local_admin" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.handler !== target.handler ||
    entry.audit === null ||
    !Object.isFrozen(entry.audit) ||
    entry.audit.executor !== "security_executor" ||
    entry.audit.action !== target.action ||
    entry.audit.catalog_state !== "selected" ||
    entry.audit.catalog_owner_task !== null
  ) {
    throw new TypeError("Selected LAN network mutation manifest entry is invalid.");
  }
  return entry;
}

function setNoStore(reply: {
  header: (name: string, value: string) => unknown;
}): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function readExactDataObject(
  input: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("HostDeck LAN network route input is invalid.");
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("HostDeck LAN network route input is invalid.");
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
    throw new TypeError("HostDeck LAN network route input is invalid.");
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key as string]?.value]))
  );
}
