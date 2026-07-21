import type { RemoteIngressUnavailableReason } from "@hostdeck/core";
import { z } from "zod";
import { exactDataArray, exactDataObject } from "./exact-data-object.js";
import {
  remoteExternalOriginSchema,
  remoteIngressPublicReasonSchema,
  remoteIngressPublicStateSchema
} from "./remote-ingress.js";
import { selectedRequestNetworkModes } from "./request-authentication.js";
import {
  isoTimestampSchema,
  nonNegativeSafeIntegerSchema
} from "./scalars.js";

export const selectedHostLocalHealthComponents = Object.freeze([
  "storage",
  "runtime",
  "compatibility",
  "projector",
  "fanout",
  "listener",
  "lease"
] as const);

export const selectedHostLocalHealthStates = Object.freeze([
  "unknown",
  "ready",
  "degraded",
  "stale",
  "failed"
] as const);

export const selectedHostLocalHealthCauses = Object.freeze([
  "not_observed",
  "source_unknown",
  "source_stale",
  "audit_reconciliation_degraded",
  "retention_degraded",
  "startup_maintenance_failed",
  "storage_unavailable",
  "runtime_starting",
  "runtime_disconnected",
  "runtime_reconciling",
  "runtime_failed",
  "compatibility_unchecked",
  "compatibility_degraded",
  "runtime_incompatible",
  "projector_not_ready",
  "projector_failed",
  "fanout_not_ready",
  "fanout_closed",
  "fanout_failed",
  "listener_not_ready",
  "listener_draining",
  "listener_closed",
  "listener_failed",
  "lease_not_held",
  "lease_lost",
  "lease_failed"
] as const);

export const selectedHostRemoteObservationFailureCauses = Object.freeze([
  "command_failed",
  "command_timeout",
  "output_oversized",
  "schema_invalid",
  "profile_changed",
  "observation_failed"
] as const satisfies readonly RemoteIngressUnavailableReason[]);

export const selectedHostAccessModes = Object.freeze([
  "local_admin",
  "loopback_read",
  "paired_read",
  "paired_write"
] as const);

export const selectedHostWriteEligibilityCauses = Object.freeze([
  "read_only_access",
  "host_not_ready"
] as const);

export type SelectedHostLocalHealthComponent =
  (typeof selectedHostLocalHealthComponents)[number];
export type SelectedHostLocalHealthState =
  (typeof selectedHostLocalHealthStates)[number];
export type SelectedHostLocalHealthCause =
  (typeof selectedHostLocalHealthCauses)[number];
export type SelectedHostRemoteObservationFailureCause =
  (typeof selectedHostRemoteObservationFailureCauses)[number];
export type SelectedHostAccessMode = (typeof selectedHostAccessModes)[number];
export type SelectedHostWriteEligibilityCause =
  (typeof selectedHostWriteEligibilityCauses)[number];

interface CauseRule {
  readonly components: readonly SelectedHostLocalHealthComponent[];
  readonly states: readonly SelectedHostLocalHealthState[];
}

const allComponents = selectedHostLocalHealthComponents;
const causeRules: Readonly<Record<SelectedHostLocalHealthCause, CauseRule>> =
  Object.freeze({
    not_observed: rule(allComponents, ["unknown"]),
    source_unknown: rule(allComponents, ["unknown"]),
    source_stale: rule(allComponents, ["stale"]),
    audit_reconciliation_degraded: rule(["storage"], ["degraded"]),
    retention_degraded: rule(["storage"], ["degraded"]),
    startup_maintenance_failed: rule(["storage"], ["failed"]),
    storage_unavailable: rule(["storage"], ["failed"]),
    runtime_starting: rule(["runtime"], ["degraded"]),
    runtime_disconnected: rule(["runtime"], ["degraded"]),
    runtime_reconciling: rule(["runtime"], ["degraded"]),
    runtime_failed: rule(["runtime"], ["failed"]),
    compatibility_unchecked: rule(["compatibility"], ["unknown"]),
    compatibility_degraded: rule(["compatibility"], ["degraded"]),
    runtime_incompatible: rule(["compatibility"], ["failed"]),
    projector_not_ready: rule(["projector"], ["degraded"]),
    projector_failed: rule(["projector"], ["failed"]),
    fanout_not_ready: rule(["fanout"], ["degraded"]),
    fanout_closed: rule(["fanout"], ["failed"]),
    fanout_failed: rule(["fanout"], ["failed"]),
    listener_not_ready: rule(["listener"], ["degraded"]),
    listener_draining: rule(["listener"], ["degraded"]),
    listener_closed: rule(["listener"], ["failed"]),
    listener_failed: rule(["listener"], ["failed"]),
    lease_not_held: rule(["lease"], ["failed"]),
    lease_lost: rule(["lease"], ["failed"]),
    lease_failed: rule(["lease"], ["failed"])
  });

const localHealthComponentSchema = z.enum(selectedHostLocalHealthComponents);
const localHealthStateSchema = z.enum(selectedHostLocalHealthStates);
const localHealthCauseSchema = z.enum(selectedHostLocalHealthCauses);
const localHealthCauseArraySchema = exactDataArray(
  z.array(localHealthCauseSchema).max(4)
);

export const selectedHostComponentHealthSchema = exactDataObject(
  z
    .object({
      component: localHealthComponentSchema,
      state: localHealthStateSchema,
      checked_at: isoTimestampSchema.nullable(),
      causes: localHealthCauseArraySchema
    })
    .strict()
    .superRefine((value, context) => {
      const initial =
        value.state === "unknown" &&
        value.causes.length === 1 &&
        value.causes[0] === "not_observed";
      if (new Set(value.causes).size !== value.causes.length) {
        addIssue(context, ["causes"], "Host health component causes must be unique.");
      }
      if (!hostLocalHealthCausesAreCanonical(value.causes)) {
        addIssue(
          context,
          ["causes"],
          "Host health component causes must use the selected canonical order."
        );
      }
      if (value.state === "ready" ? value.causes.length !== 0 : value.causes.length === 0) {
        addIssue(
          context,
          ["causes"],
          "Host health component causes must agree with readiness."
        );
      }
      for (const [index, cause] of value.causes.entries()) {
        if (!isSelectedHostLocalHealthCauseValid(value.component, value.state, cause)) {
          addIssue(
            context,
            ["causes", index],
            "Host health component cause is invalid for its component state."
          );
        }
      }
      if (value.causes.includes("not_observed") && !initial) {
        addIssue(
          context,
          ["causes"],
          "The unobserved cause is valid only for an exact initial component."
        );
      }
      if ((value.checked_at === null) !== initial) {
        addIssue(
          context,
          ["checked_at"],
          "Only an initial unobserved component may omit its check time."
        );
      }
    })
);

export type SelectedHostComponentHealth = z.infer<
  typeof selectedHostComponentHealthSchema
>;

const localHealthComponentsSchema = exactDataArray(
  z
    .array(selectedHostComponentHealthSchema)
    .length(selectedHostLocalHealthComponents.length)
);
const localHealthShape = {
  generation: nonNegativeSafeIntegerSchema,
  state: localHealthStateSchema,
  readiness: z.enum(["not_ready", "ready"]),
  updated_at: isoTimestampSchema,
  components: localHealthComponentsSchema
} as const;

export const selectedReadinessResponseSchema = exactDataObject(
  z
    .object(localHealthShape)
    .strict()
    .superRefine((value, context) => validateLocalHealth(value, context))
);

export const selectedHostLocalStatusSchema = exactDataObject(
  z
    .object({
      ...localHealthShape,
      mutation_admission: z.enum(["closed", "open"])
    })
    .strict()
    .superRefine((value, context) => {
      validateLocalHealth(value, context);
      if (value.mutation_admission !== (value.readiness === "ready" ? "open" : "closed")) {
        addIssue(
          context,
          ["mutation_admission"],
          "Host mutation admission must match explicit local readiness."
        );
      }
    })
);

const remoteCauseSchema = z
  .union([z.literal("not_observed"), remoteIngressPublicReasonSchema])
  .nullable();

export const selectedHostRemoteStatusSchema = exactDataObject(
  z
    .object({
      generation: nonNegativeSafeIntegerSchema,
      state_generation: nonNegativeSafeIntegerSchema.nullable(),
      availability: z.enum(["unknown", "disabled", "ready", "unavailable"]),
      cause: remoteCauseSchema,
      external_origin: remoteExternalOriginSchema.nullable(),
      laptop_action_required: z.boolean(),
      observed_at: isoTimestampSchema.nullable(),
      checked_at: isoTimestampSchema.nullable(),
      updated_at: isoTimestampSchema
    })
    .strict()
    .superRefine((value, context) => validateRemoteHealth(value, context))
);

const writeEligibilityCauseArraySchema = exactDataArray(
  z.array(z.enum(selectedHostWriteEligibilityCauses)).max(2)
);

export const selectedHostAccessStatusSchema = exactDataObject(
  z
    .object({
      mode: z.enum(selectedHostAccessModes),
      network_mode: z.enum(selectedRequestNetworkModes),
      transport: z.enum(["http", "https"]),
      write_eligibility: exactDataObject(
        z
          .object({
            scope: z.literal("host_health_and_authority"),
            eligible: z.boolean(),
            causes: writeEligibilityCauseArraySchema
          })
          .strict()
      )
    })
    .strict()
    .superRefine((value, context) => {
      const causes = value.write_eligibility.causes;
      const canonicalCauses = selectedHostWriteEligibilityCauses.filter((cause) =>
        causes.includes(cause)
      );
      if (
        causes.length !== canonicalCauses.length ||
        causes.some((cause, index) => cause !== canonicalCauses[index])
      ) {
        addIssue(
          context,
          ["write_eligibility", "causes"],
          "Host write eligibility causes must be unique and canonically ordered."
        );
      }
      const readOnly = value.mode === "loopback_read" || value.mode === "paired_read";
      if (causes.includes("read_only_access") !== readOnly) {
        addIssue(
          context,
          ["write_eligibility", "causes"],
          "Host write eligibility must reflect read-only request authority."
        );
      }
      if (value.write_eligibility.eligible !== (causes.length === 0)) {
        addIssue(
          context,
          ["write_eligibility", "eligible"],
          "Host write eligibility is open only when no preflight cause applies."
        );
      }
      if (
        (value.mode === "local_admin" || value.mode === "loopback_read") &&
        value.network_mode !== "loopback"
      ) {
        addIssue(
          context,
          ["network_mode"],
          "Local host access modes require loopback request provenance."
        );
      }
      if (
        (value.network_mode === "loopback" && value.transport !== "http") ||
        (value.network_mode === "remote" && value.transport !== "https")
      ) {
        addIssue(
          context,
          ["transport"],
          "Host access transport must match selected loopback or remote provenance."
        );
      }
    })
);

export const selectedHostStatusResponseSchema = exactDataObject(
  z
    .object({
      local: selectedHostLocalStatusSchema,
      remote: selectedHostRemoteStatusSchema,
      access: selectedHostAccessStatusSchema
    })
    .strict()
    .superRefine((value, context) => {
      const causes: SelectedHostWriteEligibilityCause[] = [];
      if (value.access.mode === "loopback_read" || value.access.mode === "paired_read") {
        causes.push("read_only_access");
      }
      if (value.local.mutation_admission !== "open") causes.push("host_not_ready");
      if (
        value.access.write_eligibility.eligible !== (causes.length === 0) ||
        value.access.write_eligibility.causes.length !== causes.length ||
        value.access.write_eligibility.causes.some(
          (cause, index) => cause !== causes[index]
        )
      ) {
        addIssue(
          context,
          ["access", "write_eligibility"],
          "Host write eligibility must match request authority and local health."
        );
      }
    })
);

export const selectedLivenessResponseSchema = exactDataObject(
  z.object({ status: z.literal("alive") }).strict()
);

export type SelectedLivenessResponse = z.infer<
  typeof selectedLivenessResponseSchema
>;
export type SelectedReadinessResponse = z.infer<
  typeof selectedReadinessResponseSchema
>;
export type SelectedHostLocalStatus = z.infer<
  typeof selectedHostLocalStatusSchema
>;
export type SelectedHostRemoteStatus = z.infer<
  typeof selectedHostRemoteStatusSchema
>;
export type SelectedHostAccessStatus = z.infer<
  typeof selectedHostAccessStatusSchema
>;
export type SelectedHostStatusResponse = z.infer<
  typeof selectedHostStatusResponseSchema
>;

export function isSelectedHostLocalHealthCauseValid(
  component: SelectedHostLocalHealthComponent,
  state: SelectedHostLocalHealthState,
  cause: SelectedHostLocalHealthCause
): boolean {
  const causeRule: CauseRule | undefined = Object.hasOwn(causeRules, cause)
    ? causeRules[cause]
    : undefined;
  if (causeRule === undefined) return false;
  return causeRule.components.includes(component) && causeRule.states.includes(state);
}

export function selectedHostAggregateLocalHealthState(
  states: readonly SelectedHostLocalHealthState[]
): SelectedHostLocalHealthState {
  if (
    states.length === 0 ||
    states.some(
      (state) => !(selectedHostLocalHealthStates as readonly unknown[]).includes(state)
    )
  ) {
    throw new TypeError("Host local health aggregation requires known component states.");
  }
  for (const state of ["failed", "degraded", "stale", "unknown"] as const) {
    if (states.includes(state)) return state;
  }
  return "ready";
}

function validateLocalHealth(
  value: Readonly<{
    generation: number;
    state: SelectedHostLocalHealthState;
    readiness: "not_ready" | "ready";
    updated_at: string;
    components: readonly SelectedHostComponentHealth[];
  }>,
  context: z.RefinementCtx
): void {
  for (const [index, expected] of selectedHostLocalHealthComponents.entries()) {
    if (value.components[index]?.component !== expected) {
      addIssue(
        context,
        ["components", index, "component"],
        "Host health components must use the exact selected order."
      );
    }
  }
  const expectedState = selectedHostAggregateLocalHealthState(
    value.components.map((component) => component.state)
  );
  if (value.state !== expectedState) {
    addIssue(context, ["state"], "Host aggregate state must match component truth.");
  }
  if (value.readiness !== (expectedState === "ready" ? "ready" : "not_ready")) {
    addIssue(
      context,
      ["readiness"],
      "Host readiness must match the aggregate component state."
    );
  }
  const initial = value.components.every(
    (component) =>
      component.state === "unknown" &&
      component.checked_at === null &&
      component.causes.length === 1 &&
      component.causes[0] === "not_observed"
  );
  if ((value.generation === 0) !== initial) {
    addIssue(
      context,
      ["generation"],
      "Only the exact initial host snapshot may use generation zero."
    );
  }
  const updatedAt = Date.parse(value.updated_at);
  if (
    value.components.some(
      (component) =>
        component.checked_at !== null && Date.parse(component.checked_at) > updatedAt
    )
  ) {
    addIssue(
      context,
      ["updated_at"],
      "Host health cannot predate a component observation."
    );
  }
  if (
    value.generation > 0 &&
    !value.components.some((component) => component.checked_at === value.updated_at)
  ) {
    addIssue(
      context,
      ["updated_at"],
      "A noninitial host snapshot must identify its latest component observation."
    );
  }
}

function validateRemoteHealth(
  value: Readonly<{
    generation: number;
    state_generation: number | null;
    availability: "unknown" | "disabled" | "ready" | "unavailable";
    cause: "not_observed" | z.infer<typeof remoteIngressPublicReasonSchema> | null;
    external_origin: string | null;
    laptop_action_required: boolean;
    observed_at: string | null;
    checked_at: string | null;
    updated_at: string;
  }>,
  context: z.RefinementCtx
): void {
  if (value.availability === "unknown") {
    if (
      value.generation !== 0 ||
      value.state_generation !== null ||
      value.cause !== "not_observed" ||
      value.external_origin !== null ||
      !value.laptop_action_required ||
      value.observed_at !== null ||
      value.checked_at !== null
    ) {
      addIssue(context, [], "Unknown remote health must be the exact unobserved state.");
    }
    return;
  }

  if (
    value.generation < 1 ||
    value.checked_at === null ||
    value.updated_at !== value.checked_at ||
    value.cause === "not_observed"
  ) {
    addIssue(context, [], "Observed remote health requires a current health generation.");
  }
  if (
    value.observed_at !== null &&
    value.checked_at !== null &&
    Date.parse(value.observed_at) > Date.parse(value.checked_at)
  ) {
    addIssue(context, ["observed_at"], "Remote observation cannot postdate its check.");
  }

  if (value.state_generation === null) {
    if (
      value.availability !== "unavailable" ||
      value.cause === null ||
      !selectedHostRemoteObservationFailureCauses.includes(
        value.cause as SelectedHostRemoteObservationFailureCause
      ) ||
      value.external_origin !== null ||
      !value.laptop_action_required ||
      value.observed_at !== null
    ) {
      addIssue(
        context,
        ["state_generation"],
        "Remote observer failure must clear durable ready-state claims."
      );
    }
    return;
  }

  const parsedPublicState = remoteIngressPublicStateSchema.safeParse({
    generation: value.state_generation,
    availability: value.availability,
    reason: value.cause,
    external_origin: value.external_origin,
    laptop_action_required: value.laptop_action_required,
    observed_at: value.observed_at
  });
  if (!parsedPublicState.success) {
    addIssue(context, [], "Remote health durable state is contradictory.");
  }
  if (value.availability === "ready") {
    if (
      value.cause !== null ||
      value.external_origin === null ||
      value.laptop_action_required ||
      value.observed_at === null
    ) {
      addIssue(context, [], "Ready remote health requires current origin truth.");
    }
  } else if (
    value.cause === null ||
    value.external_origin !== null ||
    !value.laptop_action_required
  ) {
    addIssue(context, [], "Non-ready remote health requires one bounded cause.");
  }
}

function rule(
  components: readonly SelectedHostLocalHealthComponent[],
  states: readonly SelectedHostLocalHealthState[]
): CauseRule {
  return Object.freeze({
    components: Object.freeze([...components]),
    states: Object.freeze([...states])
  });
}

function hostLocalHealthCausesAreCanonical(
  causes: readonly SelectedHostLocalHealthCause[]
): boolean {
  let previousIndex = -1;
  for (const cause of causes) {
    const currentIndex = selectedHostLocalHealthCauses.indexOf(cause);
    if (currentIndex <= previousIndex) return false;
    previousIndex = currentIndex;
  }
  return true;
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string
): void {
  context.addIssue({ code: "custom", message, path });
}
