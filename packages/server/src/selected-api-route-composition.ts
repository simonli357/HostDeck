import {
  type CreateHostDeckApprovalRouteRegistrationInput,
  createHostDeckApprovalRouteRegistration,
  hostDeckApprovalRouteRegistrationId
} from "./approval-routes.js";
import {
  type CreateHostDeckCompactRouteRegistrationInput,
  createHostDeckCompactRouteRegistration,
  hostDeckCompactRouteRegistrationId
} from "./compact-routes.js";
import {
  assertHostDeckCsrfPolicy,
  type CreateHostDeckCsrfRouteRegistrationInput,
  createHostDeckCsrfRouteRegistration,
  hostDeckCsrfRouteRegistrationId
} from "./csrf-routes.js";
import {
  assertHostDeckActiveDeviceAuthorityPolicy
} from "./device-authority-lifecycle.js";
import {
  type CreateHostDeckDeviceListRouteRegistrationInput,
  createHostDeckDeviceListRouteRegistration,
  hostDeckDeviceListRouteRegistrationId
} from "./device-list-routes.js";
import {
  type CreateHostDeckDeviceRevokeRouteRegistrationInput,
  createHostDeckDeviceRevokeRouteRegistration,
  hostDeckDeviceRevokeRouteRegistrationId
} from "./device-revoke-routes.js";
import type {
  HostDeckRoutePluginRegistration,
  HostDeckRoutePluginSurface
} from "./fastify-app.js";
import {
  assertHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy
} from "./fastify-request-authentication.js";
import {
  type CreateHostDeckGoalRouteRegistrationInput,
  createHostDeckGoalRouteRegistration,
  hostDeckGoalRouteRegistrationId
} from "./goal-routes.js";
import {
  type CreateHostDeckHealthRouteRegistrationInput,
  createHostDeckHealthRouteRegistration,
  hostDeckHealthRouteRegistrationId
} from "./health-routes.js";
import { assertHostDeckHostHealthService } from "./host-health.js";
import {
  assertHostDeckHostLockPolicy,
  type CreateHostDeckHostLockRouteRegistrationInput,
  createHostDeckHostLockRouteRegistration,
  hostDeckHostLockRouteRegistrationId
} from "./host-lock-routes.js";
import {
  type CreateHostDeckInterruptRouteRegistrationInput,
  createHostDeckInterruptRouteRegistration,
  hostDeckInterruptRouteRegistrationId
} from "./interrupt-routes.js";
import {
  type CreateHostDeckModelRouteRegistrationInput,
  createHostDeckModelRouteRegistration,
  hostDeckModelRouteRegistrationId
} from "./model-routes.js";
import {
  assertHostDeckPairingPolicy,
  type CreateHostDeckPairingRouteRegistrationInput,
  createHostDeckPairingRouteRegistration,
  hostDeckPairingRouteRegistrationId
} from "./pairing-routes.js";
import {
  type CreateHostDeckPlanRouteRegistrationInput,
  createHostDeckPlanRouteRegistration,
  hostDeckPlanRouteRegistrationId
} from "./plan-routes.js";
import {
  type CreateHostDeckProjectedEventRouteRegistrationInput,
  createHostDeckProjectedEventRouteRegistration,
  hostDeckProjectedEventRouteRegistrationId
} from "./projected-event-routes.js";
import {
  type CreateHostDeckProjectionStreamRouteRegistrationInput,
  createHostDeckProjectionStreamRouteRegistration,
  hostDeckProjectionStreamRouteRegistrationId
} from "./projection-stream-routes.js";
import {
  assertProjectionSubscriberStreamService
} from "./projection-subscriber-stream.js";
import {
  type CreateHostDeckPromptRouteRegistrationInput,
  createHostDeckPromptRouteRegistration,
  hostDeckPromptRouteRegistrationId
} from "./prompt-routes.js";
import { assertRemoteIngressControlService } from "./remote-ingress-control-service.js";
import { assertHostDeckRemoteIngressLifecycleControl } from "./remote-ingress-lifecycle.js";
import {
  type CreateHostDeckRemoteIngressRouteRegistrationInput,
  createHostDeckRemoteIngressRouteRegistration,
  hostDeckRemoteIngressRouteRegistrationId
} from "./remote-ingress-routes.js";
import {
  type CreateHostDeckResumeRouteRegistrationInput,
  createHostDeckResumeRouteRegistration,
  hostDeckResumeRouteRegistrationId
} from "./resume-routes.js";
import {
  assertHostDeckSecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import {
  assertHostDeckSelectedWriteAdmissionPolicy
} from "./selected-write-admission-policy.js";
import {
  assertHostDeckSelectedWriteAuditExecutor
} from "./selected-write-audit-executor.js";
import { readExactDataObject } from "./selected-write-gate-contracts.js";
import {
  type CreateHostDeckSessionArchiveRouteRegistrationInput,
  createHostDeckSessionArchiveRouteRegistration,
  hostDeckSessionArchiveRouteRegistrationId
} from "./session-archive-routes.js";
import {
  type CreateHostDeckSessionReadRouteRegistrationInput,
  createHostDeckSessionReadRouteRegistration,
  hostDeckSessionReadRouteRegistrationId
} from "./session-read-routes.js";
import {
  type CreateHostDeckSessionStartRouteRegistrationInput,
  createHostDeckSessionStartRouteRegistration,
  hostDeckSessionStartRouteRegistrationId
} from "./session-start-routes.js";
import {
  type CreateHostDeckSkillsRouteRegistrationInput,
  createHostDeckSkillsRouteRegistration,
  hostDeckSkillsRouteRegistrationId
} from "./skills-routes.js";
import {
  type CreateHostDeckUsageRouteRegistrationInput,
  createHostDeckUsageRouteRegistration,
  hostDeckUsageRouteRegistrationId
} from "./usage-routes.js";

type SelectedRouteSurface = Exclude<HostDeckRoutePluginSurface, "static">;
type FunctionPort<TKey extends string> = Readonly<Record<TKey, (...args: never[]) => unknown>>;

export interface HostDeckSelectedApiRouteCompositionDescriptor {
  readonly manifestIds: readonly string[];
  readonly registrationId: string;
  readonly surface: SelectedRouteSurface;
}

export interface HostDeckSelectedApiControls {
  readonly approvals: CreateHostDeckApprovalRouteRegistrationInput["approvals"];
  readonly compact: CreateHostDeckCompactRouteRegistrationInput["compact"];
  readonly goals: CreateHostDeckGoalRouteRegistrationInput["goals"];
  readonly interrupts: CreateHostDeckInterruptRouteRegistrationInput["interrupts"];
  readonly models: CreateHostDeckModelRouteRegistrationInput["models"];
  readonly plans: CreateHostDeckPlanRouteRegistrationInput["plans"];
  readonly prompts: CreateHostDeckPromptRouteRegistrationInput["prompts"];
  readonly skills: CreateHostDeckSkillsRouteRegistrationInput["skills"];
  readonly usage: CreateHostDeckUsageRouteRegistrationInput["usage"];
}

export interface HostDeckSelectedApiRuntimes {
  readonly approvals: CreateHostDeckApprovalRouteRegistrationInput["runtime"];
  readonly compact: CreateHostDeckCompactRouteRegistrationInput["runtime"];
  readonly goals: CreateHostDeckGoalRouteRegistrationInput["runtime"];
  readonly interrupts: CreateHostDeckInterruptRouteRegistrationInput["runtime"];
  readonly models: CreateHostDeckModelRouteRegistrationInput["runtime"];
  readonly plans: CreateHostDeckPlanRouteRegistrationInput["runtime"];
  readonly prompts: CreateHostDeckPromptRouteRegistrationInput["runtime"];
  readonly sessionArchive: CreateHostDeckSessionArchiveRouteRegistrationInput["runtime"];
  readonly sessionStart: CreateHostDeckSessionStartRouteRegistrationInput["runtime"];
}

export interface HostDeckSelectedApiSessions {
  readonly managed:
    & CreateHostDeckSessionStartRouteRegistrationInput["sessions"]
    & CreateHostDeckSessionArchiveRouteRegistrationInput["sessions"];
  readonly read: CreateHostDeckSessionReadRouteRegistrationInput["sessions"];
  readonly resume: CreateHostDeckResumeRouteRegistrationInput["resume"];
  readonly subscribers: CreateHostDeckProjectionStreamRouteRegistrationInput["subscribers"];
}

export interface HostDeckSelectedApiState {
  readonly get: CreateHostDeckModelRouteRegistrationInput["state"]["get"];
  readonly listEvents: CreateHostDeckProjectedEventRouteRegistrationInput["state"]["listEvents"];
  readonly require: CreateHostDeckProjectedEventRouteRegistrationInput["state"]["require"];
}

export interface HostDeckSelectedApiDevices {
  readonly list: CreateHostDeckDeviceListRouteRegistrationInput["devices"]["list"];
  readonly revoke: CreateHostDeckDeviceRevokeRouteRegistrationInput["devices"]["revoke"];
}

export interface CreateHostDeckSelectedApiRouteCompositionInput {
  readonly admission: CreateHostDeckSessionStartRouteRegistrationInput["admission"];
  readonly audit: CreateHostDeckSessionStartRouteRegistrationInput["audit"];
  readonly authentication: HostDeckRequestAuthenticationPolicy;
  readonly controls: HostDeckSelectedApiControls;
  readonly csrf: CreateHostDeckCsrfRouteRegistrationInput["csrf"];
  readonly devices: HostDeckSelectedApiDevices;
  readonly health: CreateHostDeckHealthRouteRegistrationInput["health"];
  readonly lock: CreateHostDeckHostLockRouteRegistrationInput["lock"];
  readonly now: CreateHostDeckDeviceRevokeRouteRegistrationInput["now"];
  readonly observeSseError: CreateHostDeckProjectionStreamRouteRegistrationInput["observe_error"];
  readonly pairing: CreateHostDeckPairingRouteRegistrationInput["pairing"];
  readonly remote: CreateHostDeckRemoteIngressRouteRegistrationInput["service"];
  readonly runtimes: HostDeckSelectedApiRuntimes;
  readonly securityAudit: CreateHostDeckPairingRouteRegistrationInput["audit"];
  readonly sessions: HostDeckSelectedApiSessions;
  readonly state: HostDeckSelectedApiState;
}

interface ParsedComposition {
  readonly activeDeviceAuthority: CreateHostDeckDeviceRevokeRouteRegistrationInput["activeDeviceAuthority"];
  readonly admission: CreateHostDeckSessionStartRouteRegistrationInput["admission"];
  readonly archiveSubscribers: CreateHostDeckSessionArchiveRouteRegistrationInput["subscribers"];
  readonly audit: CreateHostDeckSessionStartRouteRegistrationInput["audit"];
  readonly controls: HostDeckSelectedApiControls;
  readonly csrf: CreateHostDeckCsrfRouteRegistrationInput["csrf"];
  readonly deviceList: CreateHostDeckDeviceListRouteRegistrationInput["devices"];
  readonly deviceRevoke: CreateHostDeckDeviceRevokeRouteRegistrationInput["devices"];
  readonly eventState: CreateHostDeckProjectedEventRouteRegistrationInput["state"];
  readonly health: CreateHostDeckHealthRouteRegistrationInput["health"];
  readonly lock: CreateHostDeckHostLockRouteRegistrationInput["lock"];
  readonly managedArchive: CreateHostDeckSessionArchiveRouteRegistrationInput["sessions"];
  readonly managedRead: CreateHostDeckPromptRouteRegistrationInput["sessions"];
  readonly managedStart: CreateHostDeckSessionStartRouteRegistrationInput["sessions"];
  readonly now: CreateHostDeckDeviceRevokeRouteRegistrationInput["now"];
  readonly observeSseError: CreateHostDeckProjectionStreamRouteRegistrationInput["observe_error"];
  readonly pairing: CreateHostDeckPairingRouteRegistrationInput["pairing"];
  readonly remote: CreateHostDeckRemoteIngressRouteRegistrationInput["service"];
  readonly resume: CreateHostDeckResumeRouteRegistrationInput["resume"];
  readonly runtimes: HostDeckSelectedApiRuntimes;
  readonly securityAudit: CreateHostDeckPairingRouteRegistrationInput["audit"];
  readonly sessionRead: CreateHostDeckSessionReadRouteRegistrationInput["sessions"];
  readonly stateRead: CreateHostDeckModelRouteRegistrationInput["state"];
  readonly subscribers: CreateHostDeckProjectionStreamRouteRegistrationInput["subscribers"];
}

const inputKeys = [
  "admission",
  "audit",
  "authentication",
  "controls",
  "csrf",
  "devices",
  "health",
  "lock",
  "now",
  "observeSseError",
  "pairing",
  "remote",
  "runtimes",
  "securityAudit",
  "sessions",
  "state"
] as const;
const controlKeys = [
  "approvals",
  "compact",
  "goals",
  "interrupts",
  "models",
  "plans",
  "prompts",
  "skills",
  "usage"
] as const;
const runtimeKeys = [
  "approvals",
  "compact",
  "goals",
  "interrupts",
  "models",
  "plans",
  "prompts",
  "sessionArchive",
  "sessionStart"
] as const;
const sessionKeys = ["managed", "read", "resume", "subscribers"] as const;
const stateKeys = ["get", "listEvents", "require"] as const;
const deviceKeys = ["list", "revoke"] as const;
const registrationKeys = ["id", "register", "surface"] as const;
const composedAdmissionPolicies = new WeakSet<object>();

function descriptor(
  registrationId: string,
  surface: SelectedRouteSurface,
  manifestIds: readonly string[]
): HostDeckSelectedApiRouteCompositionDescriptor {
  return Object.freeze({
    manifestIds: Object.freeze([...manifestIds]),
    registrationId,
    surface
  });
}

export const hostDeckSelectedApiRouteCompositionDescriptor: readonly HostDeckSelectedApiRouteCompositionDescriptor[] =
  Object.freeze([
    descriptor(hostDeckHealthRouteRegistrationId, "api", [
      "health_liveness",
      "health_readiness",
      "host_status"
    ]),
    descriptor(hostDeckSessionReadRouteRegistrationId, "api", [
      "session_list",
      "session_detail"
    ]),
    descriptor(hostDeckSessionStartRouteRegistrationId, "api", ["session_start"]),
    descriptor(hostDeckProjectedEventRouteRegistrationId, "api", ["session_events"]),
    descriptor(hostDeckProjectionStreamRouteRegistrationId, "sse", ["session_event_stream"]),
    descriptor(hostDeckResumeRouteRegistrationId, "api", ["session_resume_metadata"]),
    descriptor(hostDeckSessionArchiveRouteRegistrationId, "api", ["session_archive"]),
    descriptor(hostDeckPromptRouteRegistrationId, "api", ["prompt_dispatch"]),
    descriptor(hostDeckModelRouteRegistrationId, "api", ["model_read", "model_select"]),
    descriptor(hostDeckGoalRouteRegistrationId, "api", ["goal_read", "goal_mutate"]),
    descriptor(hostDeckPlanRouteRegistrationId, "api", ["plan_read", "plan_select"]),
    descriptor(hostDeckUsageRouteRegistrationId, "api", ["usage_read"]),
    descriptor(hostDeckCompactRouteRegistrationId, "api", ["compact_read", "compact_start"]),
    descriptor(hostDeckSkillsRouteRegistrationId, "api", ["skills_read"]),
    descriptor(hostDeckApprovalRouteRegistrationId, "api", ["approval_list", "approval_respond"]),
    descriptor(hostDeckInterruptRouteRegistrationId, "api", ["turn_interrupt"]),
    descriptor(hostDeckPairingRouteRegistrationId, "api", ["pair_request", "pair_claim"]),
    descriptor(hostDeckCsrfRouteRegistrationId, "api", ["csrf_bootstrap"]),
    descriptor(hostDeckHostLockRouteRegistrationId, "api", [
      "access_state",
      "host_lock",
      "host_unlock"
    ]),
    descriptor(hostDeckDeviceListRouteRegistrationId, "api", ["device_list"]),
    descriptor(hostDeckDeviceRevokeRouteRegistrationId, "api", ["device_revoke"]),
    descriptor(hostDeckRemoteIngressRouteRegistrationId, "api", [
      "remote_status",
      "remote_enable",
      "remote_disable"
    ])
  ]);

export function createHostDeckSelectedApiRouteComposition(
  input: CreateHostDeckSelectedApiRouteCompositionInput
): readonly HostDeckRoutePluginRegistration[] {
  assertCompositionDescriptor(selectedApiRouteManifest);
  const parsed = parseCompositionInput(input);
  if (composedAdmissionPolicies.has(parsed.admission)) {
    throw new TypeError("Selected API route composition already owns this admission policy.");
  }
  composedAdmissionPolicies.add(parsed.admission);

  const registrations = [
    createHostDeckHealthRouteRegistration({ health: parsed.health }),
    createHostDeckSessionReadRouteRegistration({ sessions: parsed.sessionRead }),
    createHostDeckSessionStartRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      runtime: parsed.runtimes.sessionStart,
      sessions: parsed.managedStart
    }),
    createHostDeckProjectedEventRouteRegistration({ state: parsed.eventState }),
    createHostDeckProjectionStreamRouteRegistration({
      observe_error: parsed.observeSseError,
      subscribers: parsed.subscribers
    }),
    createHostDeckResumeRouteRegistration({ resume: parsed.resume }),
    createHostDeckSessionArchiveRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      runtime: parsed.runtimes.sessionArchive,
      sessions: parsed.managedArchive,
      subscribers: parsed.archiveSubscribers
    }),
    createHostDeckPromptRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      prompts: parsed.controls.prompts,
      runtime: parsed.runtimes.prompts,
      sessions: parsed.managedRead
    }),
    createHostDeckModelRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      models: parsed.controls.models,
      runtime: parsed.runtimes.models,
      state: parsed.stateRead
    }),
    createHostDeckGoalRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      csrf: parsed.csrf,
      goals: parsed.controls.goals,
      lock: parsed.lock,
      runtime: parsed.runtimes.goals,
      state: parsed.stateRead
    }),
    createHostDeckPlanRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      plans: parsed.controls.plans,
      runtime: parsed.runtimes.plans,
      state: parsed.stateRead
    }),
    createHostDeckUsageRouteRegistration({
      state: parsed.stateRead,
      usage: parsed.controls.usage
    }),
    createHostDeckCompactRouteRegistration({
      admission: parsed.admission,
      audit: parsed.audit,
      compact: parsed.controls.compact,
      csrf: parsed.csrf,
      lock: parsed.lock,
      runtime: parsed.runtimes.compact,
      state: parsed.stateRead
    }),
    createHostDeckSkillsRouteRegistration({
      skills: parsed.controls.skills,
      state: parsed.stateRead
    }),
    createHostDeckApprovalRouteRegistration({
      admission: parsed.admission,
      approvals: parsed.controls.approvals,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      runtime: parsed.runtimes.approvals,
      state: parsed.stateRead
    }),
    createHostDeckInterruptRouteRegistration({
      admission: parsed.admission,
      interrupts: parsed.controls.interrupts,
      audit: parsed.audit,
      csrf: parsed.csrf,
      lock: parsed.lock,
      runtime: parsed.runtimes.interrupts,
      state: parsed.stateRead
    }),
    createHostDeckPairingRouteRegistration({
      audit: parsed.securityAudit,
      pairing: parsed.pairing
    }),
    createHostDeckCsrfRouteRegistration({
      audit: parsed.securityAudit,
      csrf: parsed.csrf
    }),
    createHostDeckHostLockRouteRegistration({
      audit: parsed.securityAudit,
      csrf: parsed.csrf,
      lock: parsed.lock
    }),
    createHostDeckDeviceListRouteRegistration({ devices: parsed.deviceList }),
    createHostDeckDeviceRevokeRouteRegistration({
      activeDeviceAuthority: parsed.activeDeviceAuthority,
      admission: parsed.admission,
      audit: parsed.securityAudit,
      csrf: parsed.csrf,
      devices: parsed.deviceRevoke,
      lock: parsed.lock,
      now: parsed.now
    }),
    createHostDeckRemoteIngressRouteRegistration({ service: parsed.remote })
  ];
  assertRegistrations(registrations);
  return Object.freeze(registrations);
}

function parseCompositionInput(input: unknown): ParsedComposition {
  const values = readExactDataObject(
    input,
    inputKeys,
    "Selected API route composition input is invalid."
  );
  const controls = readExactDataObject(
    values.controls,
    controlKeys,
    "Selected API control services are invalid."
  );
  const runtimes = readExactDataObject(
    values.runtimes,
    runtimeKeys,
    "Selected API runtime ports are invalid."
  );
  const sessions = readExactDataObject(
    values.sessions,
    sessionKeys,
    "Selected API session services are invalid."
  );

  assertHostDeckSelectedWriteAdmissionPolicy(values.admission);
  assertHostDeckSelectedWriteAuditExecutor(values.audit);
  assertHostDeckRequestAuthenticationPolicy(values.authentication);
  assertHostDeckActiveDeviceAuthorityPolicy(
    values.authentication.activeDeviceAuthority
  );
  assertHostDeckCsrfPolicy(values.csrf);
  assertHostDeckHostHealthService(values.health);
  assertHostDeckHostLockPolicy(values.lock);
  assertHostDeckPairingPolicy(values.pairing);
  assertHostDeckSecurityMutationAuditExecutor(values.securityAudit);
  assertProjectionSubscriberStreamService(sessions.subscribers);
  assertRemoteService(values.remote);
  if (typeof values.now !== "function" || typeof values.observeSseError !== "function") {
    throw new TypeError("Selected API route composition callbacks are invalid.");
  }

  const parsedControls = Object.freeze({
    approvals: readFunctionPort(
      controls.approvals,
      ["list", "respond", "snapshot", "waitForTerminal"],
      "Approval control service is invalid."
    ),
    compact: readFunctionPort(controls.compact, ["compact", "snapshot"], "Compact control service is invalid."),
    goals: readFunctionPort(controls.goals, ["mutate", "snapshot"], "Goal control service is invalid."),
    interrupts: readFunctionPort(
      controls.interrupts,
      ["interrupt", "requireInterruptible", "waitForTerminal"],
      "Interrupt control service is invalid."
    ),
    models: readFunctionPort(controls.models, ["select", "snapshot"], "Model control service is invalid."),
    plans: readFunctionPort(controls.plans, ["select", "snapshot"], "Plan control service is invalid."),
    prompts: readFunctionPort(controls.prompts, ["dispatch", "snapshot"], "Prompt control service is invalid."),
    skills: readFunctionPort(controls.skills, ["list"], "Skills control service is invalid."),
    usage: readFunctionPort(controls.usage, ["read"], "Usage control service is invalid.")
  }) as HostDeckSelectedApiControls;
  const parsedRuntimes = Object.freeze({
    approvals: readFunctionPort(runtimes.approvals, ["read"], "Approval runtime port is invalid."),
    compact: readFunctionPort(runtimes.compact, ["read"], "Compact runtime port is invalid."),
    goals: readFunctionPort(runtimes.goals, ["read"], "Goal runtime port is invalid."),
    interrupts: readFunctionPort(runtimes.interrupts, ["read"], "Interrupt runtime port is invalid."),
    models: readFunctionPort(runtimes.models, ["read"], "Model runtime port is invalid."),
    plans: readFunctionPort(runtimes.plans, ["read"], "Plan runtime port is invalid."),
    prompts: readFunctionPort(runtimes.prompts, ["read"], "Prompt runtime port is invalid."),
    sessionArchive: readFunctionPort(runtimes.sessionArchive, ["read"], "Session archive runtime port is invalid."),
    sessionStart: readFunctionPort(runtimes.sessionStart, ["read"], "Session start runtime port is invalid.")
  }) as HostDeckSelectedApiRuntimes;
  const managed = readFunctionPort(
    sessions.managed,
    ["archive", "read", "start"],
    "Managed session service is invalid."
  );
  const state = readFunctionPort(values.state, stateKeys, "Selected state service is invalid.");
  const devices = readFunctionPort(values.devices, deviceKeys, "Selected device service is invalid.");

  return Object.freeze({
    activeDeviceAuthority: values.authentication.activeDeviceAuthority,
    admission: values.admission,
    archiveSubscribers: functionView(sessions.subscribers, ["archive_session"]),
    audit: values.audit,
    controls: parsedControls,
    csrf: values.csrf,
    deviceList: functionView(devices, ["list"]),
    deviceRevoke: functionView(devices, ["revoke"]),
    eventState: functionView(state, ["listEvents", "require"]),
    health: values.health,
    lock: values.lock,
    managedArchive: functionView(managed, ["archive", "read"]),
    managedRead: functionView(managed, ["read"]),
    managedStart: functionView(managed, ["start"]),
    now: values.now,
    observeSseError: values.observeSseError,
    pairing: values.pairing,
    remote: values.remote,
    resume: readFunctionPort(sessions.resume, ["read"], "Resume metadata reader is invalid."),
    runtimes: parsedRuntimes,
    securityAudit: values.securityAudit,
    sessionRead: readFunctionPort(sessions.read, ["get", "list"], "Session read service is invalid."),
    stateRead: functionView(state, ["get"]),
    subscribers: sessions.subscribers
  }) as ParsedComposition;
}

function readFunctionPort<const TKey extends string>(
  candidate: unknown,
  expectedKeys: readonly TKey[],
  message: string
): FunctionPort<TKey> {
  const values = readExactDataObject(candidate, expectedKeys, message);
  for (const key of expectedKeys) {
    if (typeof values[key] !== "function") throw new TypeError(message);
  }
  return Object.freeze(values) as FunctionPort<TKey>;
}

function functionView<
  const TSourceKey extends string,
  const TViewKey extends TSourceKey
>(
  source: FunctionPort<TSourceKey>,
  keys: readonly TViewKey[]
): FunctionPort<TViewKey> {
  const view: Partial<Record<TViewKey, (...args: never[]) => unknown>> = Object.create(null);
  for (const key of keys) view[key] = source[key];
  return Object.freeze(view) as FunctionPort<TViewKey>;
}

function assertRemoteService(
  candidate: unknown
): asserts candidate is CreateHostDeckRemoteIngressRouteRegistrationInput["service"] {
  try {
    assertRemoteIngressControlService(candidate);
  } catch {
    assertHostDeckRemoteIngressLifecycleControl(candidate);
  }
}

function assertCompositionDescriptor(
  manifest: readonly SelectedApiRouteManifestEntry[]
): void {
  if (
    manifest.length !== 35 ||
    !Object.isFrozen(manifest) ||
    hostDeckSelectedApiRouteCompositionDescriptor.length !== 22 ||
    !Object.isFrozen(hostDeckSelectedApiRouteCompositionDescriptor)
  ) {
    throw new TypeError("Selected API route composition descriptor is invalid.");
  }
  const manifestIds = manifest.map((entry) => {
    if (!Object.isFrozen(entry)) {
      throw new TypeError("Selected API route composition descriptor is invalid.");
    }
    return entry.id;
  });
  const describedIds: string[] = [];
  const registrationIds = new Set<string>();
  let apiCount = 0;
  let sseCount = 0;
  for (const entry of hostDeckSelectedApiRouteCompositionDescriptor) {
    if (
      !Object.isFrozen(entry) ||
      !Object.isFrozen(entry.manifestIds) ||
      entry.manifestIds.length < 1 ||
      registrationIds.has(entry.registrationId)
    ) {
      throw new TypeError("Selected API route composition descriptor is invalid.");
    }
    registrationIds.add(entry.registrationId);
    describedIds.push(...entry.manifestIds);
    if (entry.surface === "api") apiCount += 1;
    else if (entry.surface === "sse") sseCount += 1;
    else throw new TypeError("Selected API route composition descriptor is invalid.");
  }
  if (
    apiCount !== 21 ||
    sseCount !== 1 ||
    new Set(manifestIds).size !== 35 ||
    new Set(describedIds).size !== 35 ||
    describedIds.length !== manifestIds.length ||
    describedIds.some((id) => !manifestIds.includes(id))
  ) {
    throw new TypeError("Selected API route composition descriptor is invalid.");
  }
}

function assertRegistrations(registrations: readonly HostDeckRoutePluginRegistration[]): void {
  if (registrations.length !== hostDeckSelectedApiRouteCompositionDescriptor.length) {
    throw new TypeError("Selected API route registrations are invalid.");
  }
  const ids = new Set<string>();
  for (const [index, registration] of registrations.entries()) {
    const expected = hostDeckSelectedApiRouteCompositionDescriptor[index];
    const values = readExactDataObject(
      registration,
      registrationKeys,
      "Selected API route registration is invalid."
    );
    if (
      expected === undefined ||
      !Object.isFrozen(registration) ||
      values.id !== expected.registrationId ||
      values.surface !== expected.surface ||
      typeof values.register !== "function" ||
      ids.has(expected.registrationId)
    ) {
      throw new TypeError("Selected API route registration is invalid.");
    }
    ids.add(expected.registrationId);
  }
}
