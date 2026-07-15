import {
  type SelectedResumeMetadataResponse,
  type SelectedResumeParams,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema
} from "@hostdeck/contracts";
import { z } from "zod";
import {
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import { requireHostDeckRequestAuthentication } from "./fastify-request-authentication.js";
import {
  HostDeckResumeMetadataError,
  type HostDeckResumeMetadataReader
} from "./resume-metadata.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";

export const hostDeckResumeRouteRegistrationId =
  "selected-managed-thread-resume";

export interface CreateHostDeckResumeRouteRegistrationInput {
  readonly resume: Pick<HostDeckResumeMetadataReader, "read">;
}

type ReadResumeFunction = HostDeckResumeMetadataReader["read"];

const registrationInputKeys = ["resume"] as const;
const resumePortKeys = ["read"] as const;
const noQuerySchema = z.object({}).strict();

class HostDeckResumeRouteContractError extends Error {
  constructor() {
    super("Selected managed-thread resume route contract failed.");
    this.name = "HostDeckResumeRouteContractError";
  }
}

export function createHostDeckResumeRouteRegistration(
  input: CreateHostDeckResumeRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const read = parseRegistrationInput(input);
  const manifest = requireResumeManifestEntry();
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckResumeRouteRegistrationId,
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
            params: selectedResumeParamsSchema,
            querystring: noQuerySchema,
            response: { 200: selectedResumeMetadataResponseSchema }
          }
        },
        (request) => {
          const params = request.params as SelectedResumeParams;
          return invokeResumeReader(read, params.session_id);
        }
      );
    }
  };
  return Object.freeze(registration);
}

function parseRegistrationInput(input: unknown): ReadResumeFunction {
  const values = readExactDataObject(
    input,
    registrationInputKeys,
    "HostDeck resume route input is invalid."
  );
  const resume = readExactDataObject(
    values.resume,
    resumePortKeys,
    "HostDeck resume metadata port is invalid."
  );
  if (typeof resume.read !== "function") {
    throw new TypeError("HostDeck resume metadata port is invalid.");
  }
  return resume.read as ReadResumeFunction;
}

function requireResumeManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "session_resume_metadata"
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    entry === undefined ||
    !Object.isFrozen(entry) ||
    !Object.isFrozen(entry.request) ||
    !Object.isFrozen(entry.response) ||
    entry.family !== "sessions" ||
    entry.method !== "GET" ||
    entry.path !== "/api/v1/sessions/:session_id/resume" ||
    entry.transport !== "json" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== null ||
    entry.request.body !== null ||
    entry.response.success !== "selected_resume_metadata_response_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== null ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "sessions.resumeMetadata" ||
    entry.owner_task !== "IFC-V1-060"
  ) {
    throw new TypeError("Selected resume route manifest entry is invalid.");
  }
  return entry;
}

function invokeResumeReader(
  read: ReadResumeFunction,
  sessionId: SelectedResumeParams["session_id"]
): SelectedResumeMetadataResponse {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(read, undefined, [sessionId]);
  } catch (error) {
    if (error instanceof HostDeckResumeMetadataError) {
      throw mapResumeFailure(error, sessionId);
    }
    throw error;
  }

  const parsed = selectedResumeMetadataResponseSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.session_id !== sessionId) {
    throw new HostDeckResumeRouteContractError();
  }
  return deepFreeze(parsed.data);
}

function mapResumeFailure(
  error: HostDeckResumeMetadataError,
  sessionId: SelectedResumeParams["session_id"]
): HostDeckHttpError {
  switch (error.code) {
    case "session_not_found":
      return new HostDeckHttpError({
        code: "session_not_found",
        message: "Managed session was not found.",
        retryable: false,
        sessionId,
        status: 404
      });
    case "stale_session":
      return new HostDeckHttpError({
        code: "stale_session",
        message: "Managed session is not eligible for laptop resume.",
        retryable: false,
        sessionId,
        status: 409
      });
    case "runtime_unavailable":
      return new HostDeckHttpError({
        code: "runtime_unavailable",
        message: "Laptop resume metadata is unavailable.",
        retryable: error.retryable,
        sessionId,
        status: 503
      });
    case "state_unavailable":
      return new HostDeckHttpError({
        code: "storage_error",
        message: "Managed session state is unavailable.",
        retryable: false,
        sessionId,
        status: 500
      });
    case "unstable_state":
      return new HostDeckHttpError({
        code: "runtime_unavailable",
        message: "Laptop resume metadata changed during the read.",
        retryable: true,
        sessionId,
        status: 503
      });
  }
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
