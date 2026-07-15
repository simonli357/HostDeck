import { randomUUID } from "node:crypto";
import {
  type ManagedSessionTarget,
  managedSessionTargetSchema,
  type SkillsSnapshot,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sessionIdParamsSchema,
  skillsOperationIntentSchema,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import type { SelectedStateRepository } from "@hostdeck/storage";
import { z } from "zod";
import {
  type CodexSkillsControlService,
  HostDeckCodexSkillsControlError
} from "./codex-skills-control-service.js";
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

export const hostDeckSkillsRouteRegistrationId = "selected-skills-read";

export interface CreateHostDeckSkillsRouteRegistrationInput {
  readonly state: Pick<SelectedStateRepository, "get">;
  readonly skills: Pick<CodexSkillsControlService, "list">;
}

type GetStateFunction = SelectedStateRepository["get"];
type ListSkillsFunction = CodexSkillsControlService["list"];
type SkillsParams = z.infer<typeof sessionIdParamsSchema>;

interface ParsedSkillsPorts {
  readonly getState: GetStateFunction;
  readonly listSkills: ListSkillsFunction;
}

const registrationInputKeys = ["skills", "state"] as const;
const statePortKeys = ["get"] as const;
const skillsPortKeys = ["list"] as const;
const selectedStateKeys = ["mapping", "projection"] as const;
const noQuerySchema = z.object({}).strict();

class HostDeckSkillsRouteContractError extends Error {
  constructor() {
    super("Selected skills route contract failed.");
    this.name = "HostDeckSkillsRouteContractError";
  }
}

export function createHostDeckSkillsRouteRegistration(
  input: CreateHostDeckSkillsRouteRegistrationInput
): HostDeckRoutePluginRegistration {
  const ports = parseRegistrationInput(input);
  const manifest = requireSkillsManifestEntry();
  const registration: HostDeckRoutePluginRegistration = {
    id: hostDeckSkillsRouteRegistrationId,
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
            response: { 200: skillsSnapshotSchema }
          }
        },
        async (request) => {
          const params = request.params as SkillsParams;
          const target = resolveManagedTarget(
            ports.getState,
            params.session_id
          );
          return await invokeSkillsList(
            ports.listSkills,
            target,
            request.signal
          );
        }
      );
    }
  };
  return Object.freeze(registration);
}

function parseRegistrationInput(input: unknown): ParsedSkillsPorts {
  const values = readExactDataObject(
    input,
    registrationInputKeys,
    "HostDeck skills route input is invalid."
  );
  const skills = readExactDataObject(
    values.skills,
    skillsPortKeys,
    "HostDeck skills control port is invalid."
  );
  const state = readExactDataObject(
    values.state,
    statePortKeys,
    "HostDeck skills state port is invalid."
  );
  if (typeof skills.list !== "function") {
    throw new TypeError("HostDeck skills control port is invalid.");
  }
  if (typeof state.get !== "function") {
    throw new TypeError("HostDeck skills state port is invalid.");
  }
  return Object.freeze({
    getState: state.get as GetStateFunction,
    listSkills: skills.list as ListSkillsFunction
  });
}

function requireSkillsManifestEntry(): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter(
    (entry) => entry.id === "skills_read"
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
    entry.path !== "/api/v1/sessions/:session_id/skills" ||
    entry.transport !== "json" ||
    entry.request.params !== "session_id_params_v1" ||
    entry.request.query !== null ||
    entry.request.body !== null ||
    entry.response.success !== "skills_snapshot_v1" ||
    entry.response.error !== "selected_api_error_v1" ||
    entry.auth !== "loopback_or_device_cookie" ||
    entry.authority !== "session_read" ||
    entry.csrf !== "none" ||
    entry.lock !== "not_applicable" ||
    entry.target !== "managed_session" ||
    entry.operation_kind !== "skills" ||
    entry.audit !== null ||
    entry.credential_effect !== "none" ||
    entry.handler !== "controls.readSkills" ||
    entry.owner_task !== "IFC-V1-065"
  ) {
    throw new TypeError("Selected skills route manifest entry is invalid.");
  }
  return entry;
}

function resolveManagedTarget(
  getState: GetStateFunction,
  sessionId: SkillsParams["session_id"]
): ManagedSessionTarget {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(getState, undefined, [sessionId]);
  } catch {
    throw skillsHttpError(
      500,
      "storage_error",
      "Managed session state is unavailable.",
      sessionId,
      false
    );
  }
  if (candidate === null) {
    throw skillsHttpError(
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
      "Selected skills state is invalid."
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
    throw skillsHttpError(
      500,
      "storage_error",
      "Managed session state is invalid.",
      sessionId,
      false
    );
  }
}

async function invokeSkillsList(
  listSkills: ListSkillsFunction,
  target: ManagedSessionTarget,
  signal: AbortSignal
): Promise<SkillsSnapshot> {
  const intent = skillsOperationIntentSchema.parse({
    operation_id: `op_skills_read_${randomUUID().replaceAll("-", "")}`,
    target,
    kind: "skills"
  });
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(listSkills, undefined, [intent, signal]);
  } catch (error) {
    if (error instanceof HostDeckCodexSkillsControlError) {
      throw mapSkillsFailure(error, target.session_id);
    }
    throw error;
  }

  const parsed = skillsSnapshotSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.target.session_id !== target.session_id ||
    parsed.data.target.codex_thread_id !== target.codex_thread_id
  ) {
    throw new HostDeckSkillsRouteContractError();
  }
  return deepFreeze(parsed.data);
}

function mapSkillsFailure(
  error: HostDeckCodexSkillsControlError,
  sessionId: SkillsParams["session_id"]
): HostDeckHttpError {
  switch (error.code) {
    case "capability_unsupported":
      return skillsHttpError(
        409,
        "capability_unavailable",
        "Structured skills are unavailable for the selected runtime.",
        sessionId,
        false
      );
    case "invalid_request":
      return skillsHttpError(
        500,
        "internal_error",
        "Skills request construction failed.",
        sessionId,
        false
      );
    case "runtime_protocol_error":
      return skillsHttpError(
        502,
        "protocol_error",
        "Codex skills data failed protocol validation.",
        sessionId,
        false
      );
    case "runtime_unavailable":
      return skillsHttpError(
        503,
        "runtime_unavailable",
        "Codex skills are unavailable.",
        sessionId,
        error.retry_safe
      );
    case "service_overloaded":
      return skillsHttpError(
        503,
        "service_overloaded",
        "Skills read capacity is exhausted.",
        sessionId,
        error.retry_safe
      );
    case "state_unavailable":
      return skillsHttpError(
        500,
        "storage_error",
        "Managed session state is unavailable.",
        sessionId,
        error.retry_safe
      );
    case "target_mismatch":
      return skillsHttpError(
        409,
        "invalid_session_id",
        "Managed session identity changed during the skills read.",
        sessionId,
        false
      );
    case "target_not_found":
      return skillsHttpError(
        404,
        "session_not_found",
        "Managed session was not found.",
        sessionId,
        false
      );
    case "target_not_readable":
      return skillsHttpError(
        409,
        "session_not_writable",
        "Managed session is not readable for skills.",
        sessionId,
        false
      );
    case "target_stale":
      return skillsHttpError(
        409,
        "stale_session",
        "Managed session skills state is stale.",
        sessionId,
        error.retry_safe
      );
  }
}

function skillsHttpError(
  status: number,
  code: ConstructorParameters<typeof HostDeckHttpError>[0]["code"],
  message: string,
  sessionId: SkillsParams["session_id"],
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
