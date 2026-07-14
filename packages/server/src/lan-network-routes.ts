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

/** @deprecated Historical direct-LAN evidence. Not exported by @hostdeck/server. */
export const hostDeckLanNetworkRouteRegistrationId = "historical-lan-network";

export const historicalLanRouteInventory = Object.freeze([
  Object.freeze({ id: "network_state", method: "GET", path: "/api/v1/network" }),
  Object.freeze({
    id: "network_configure",
    method: "POST",
    path: "/api/v1/network/configure"
  }),
  Object.freeze({ id: "network_enable", method: "POST", path: "/api/v1/network/enable" }),
  Object.freeze({ id: "network_disable", method: "POST", path: "/api/v1/network/disable" })
] as const);

export interface CreateHostDeckLanNetworkRouteRegistrationInput {
  readonly service: HostDeckLanNetworkService;
}

const inputKeys = ["service"] as const;
const noQuerySchema = z.object({}).strict();
const registeredServices = new WeakSet<object>();

/** @deprecated Historical direct-LAN evidence. Not reachable from the package export surface. */
export function createHostDeckLanNetworkRouteRegistration(
  input: CreateHostDeckLanNetworkRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const values = readExactDataObject(input, inputKeys);
  assertHostDeckLanNetworkService(values.service);
  const service = values.service;
  if (registeredServices.has(service)) {
    throw new TypeError("HostDeck LAN network service already owns a route registration.");
  }
  const stateManifest = requireHistoricalLanRoute("network_state");
  const configureManifest = requireHistoricalLanRoute("network_configure");
  const enableManifest = requireHistoricalLanRoute("network_enable");
  const disableManifest = requireHistoricalLanRoute("network_disable");
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

type HistoricalLanRouteId = (typeof historicalLanRouteInventory)[number]["id"];

function requireHistoricalLanRoute(
  id: HistoricalLanRouteId
): (typeof historicalLanRouteInventory)[number] {
  const matches = historicalLanRouteInventory.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry)
  ) {
    throw new TypeError("Historical LAN route inventory is invalid.");
  }
  const expected = {
    network_state: { method: "GET", path: "/api/v1/network" },
    network_configure: {
      method: "POST",
      path: "/api/v1/network/configure",
    },
    network_enable: {
      method: "POST",
      path: "/api/v1/network/enable",
    },
    network_disable: {
      method: "POST",
      path: "/api/v1/network/disable",
    }
  } as const;
  const target = expected[id];
  if (entry.method !== target.method || entry.path !== target.path) {
    throw new TypeError("Historical LAN route inventory entry is invalid.");
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
