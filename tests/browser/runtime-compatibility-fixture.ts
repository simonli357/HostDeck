import type { Page, Request, Route } from "@playwright/test";
import {
  type SelectedHostCompatibilityState,
  type SelectedHostLocalHealthCause,
  type SelectedHostLocalHealthState,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "../../packages/contracts/src/index.js";

export const runtimeCompatibilityFixtureVariants = Object.freeze([
  "supported",
  "degraded_current",
  "degraded_last_known",
  "incompatible",
  "unknown_unobserved",
  "unknown_last_known",
  "disconnected",
  "version_drift"
] as const);

export type RuntimeCompatibilityFixtureVariant =
  (typeof runtimeCompatibilityFixtureVariants)[number];
export type RuntimeCompatibilityHostOutcome = "success" | "failure" | "pending";
export type RuntimeCompatibilityAccessMode = "paired_read" | "paired_write";

export interface RuntimeCompatibilityHostController {
  readonly requests: readonly Request[];
  readonly hasPendingHost: () => boolean;
  readonly releaseHost: (
    outcome?: Exclude<RuntimeCompatibilityHostOutcome, "pending">
  ) => void;
  readonly setAccessMode: (mode: RuntimeCompatibilityAccessMode) => void;
  readonly setOutcome: (outcome: RuntimeCompatibilityHostOutcome) => void;
  readonly setRecordedAt: (recordedAt: string) => void;
  readonly setVariant: (variant: RuntimeCompatibilityFixtureVariant) => void;
  readonly setVersions: (observed: string, supported: string) => void;
}

const defaultRecordedAt = "2026-07-27T04:00:00.000Z";

export async function installRuntimeCompatibilityHost(
  page: Page,
  initialVariant: RuntimeCompatibilityFixtureVariant = "supported",
  initialAccessMode: RuntimeCompatibilityAccessMode = "paired_read"
): Promise<RuntimeCompatibilityHostController> {
  let variant = initialVariant;
  let accessMode = initialAccessMode;
  let outcome: RuntimeCompatibilityHostOutcome = "success";
  let recordedAt = defaultRecordedAt;
  let observedVersion = "0.143.1";
  let supportedVersion = "0.147.0";
  let pendingResolution:
    | ((result: Exclude<RuntimeCompatibilityHostOutcome, "pending">) => void)
    | null = null;
  const requests: Request[] = [];

  await page.route("**/api/v1/host/status", async (route) => {
    requests.push(route.request());
    let selected = outcome;
    if (selected === "pending") {
      if (pendingResolution !== null) {
        await fulfillError(route, 500, "duplicate_pending_host_status");
        return;
      }
      selected = await new Promise<Exclude<RuntimeCompatibilityHostOutcome, "pending">>(
        (resolve) => {
          pendingResolution = resolve;
        }
      );
      pendingResolution = null;
    }
    if (selected === "failure") {
      await fulfillError(route, 503, "runtime_unavailable");
      return;
    }
    await fulfillJson(
      route,
      compatibilityHostStatus({
        accessMode,
        observedVersion,
        recordedAt,
        supportedVersion,
        variant
      })
    );
  });

  return Object.freeze({
    requests,
    hasPendingHost: () => pendingResolution !== null,
    releaseHost(
      selected: Exclude<RuntimeCompatibilityHostOutcome, "pending"> = "success"
    ) {
      const release = pendingResolution;
      if (release === null) throw new TypeError("No compatibility host request is pending.");
      release(selected);
    },
    setAccessMode(next: RuntimeCompatibilityAccessMode) {
      accessMode = next;
    },
    setOutcome(next: RuntimeCompatibilityHostOutcome) {
      if (pendingResolution !== null) {
        throw new TypeError("Cannot replace an active compatibility host outcome.");
      }
      outcome = next;
    },
    setRecordedAt(next: string) {
      if (!Number.isFinite(Date.parse(next))) {
        throw new TypeError("Compatibility record time is invalid.");
      }
      recordedAt = next;
    },
    setVariant(next: RuntimeCompatibilityFixtureVariant) {
      variant = next;
    },
    setVersions(nextObserved: string, nextSupported: string) {
      observedVersion = nextObserved;
      supportedVersion = nextSupported;
    }
  });
}

function compatibilityHostStatus(input: Readonly<{
  accessMode: RuntimeCompatibilityAccessMode;
  observedVersion: string;
  recordedAt: string;
  supportedVersion: string;
  variant: RuntimeCompatibilityFixtureVariant;
}>) {
  const local = localState(input.variant);
  const readOnly = input.accessMode === "paired_read";
  const writeCauses = [
    ...(readOnly ? ["read_only_access" as const] : []),
    ...(local.ready ? [] : ["host_not_ready" as const])
  ];
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 9,
      state: local.aggregate,
      readiness: local.ready ? "ready" : "not_ready",
      updated_at: input.recordedAt,
      components: selectedHostLocalHealthComponents.map((component) => {
        const selected = componentState(input.variant, component);
        return {
          component,
          state: selected.state,
          checked_at: input.recordedAt,
          causes: selected.causes
        };
      }),
      mutation_admission: local.ready ? "open" : "closed"
    },
    compatibility: compatibilityState(input),
    remote: {
      generation: 0,
      state_generation: null,
      availability: "unknown",
      cause: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: input.recordedAt
    },
    access: {
      mode: input.accessMode,
      network_mode: "loopback",
      transport: "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: writeCauses.length === 0,
        causes: writeCauses
      }
    }
  });
}

function compatibilityState(input: Readonly<{
  observedVersion: string;
  recordedAt: string;
  supportedVersion: string;
  variant: RuntimeCompatibilityFixtureVariant;
}>) {
  const common = {
    supported_version: input.supportedVersion,
    checked_at: input.recordedAt,
    recorded_at: input.recordedAt
  };
  switch (input.variant) {
    case "supported":
      return {
        state: "supported",
        evidence: "current",
        observed_version: input.supportedVersion,
        capability_state: "verified",
        ...common
      };
    case "version_drift":
      return {
        state: "version_drift",
        evidence: "current",
        observed_version: input.observedVersion,
        capability_state: "blocked",
        ...common
      };
    case "incompatible":
      return {
        state: "incompatible",
        evidence: "current",
        observed_version: input.supportedVersion,
        capability_state: "blocked",
        ...common
      };
    case "degraded_current":
      return {
        state: "degraded",
        evidence: "current",
        observed_version: input.supportedVersion,
        capability_state: "limited",
        ...common
      };
    case "degraded_last_known":
      return {
        state: "degraded",
        evidence: "last_known",
        observed_version: input.supportedVersion,
        capability_state: "unverified",
        ...common
      };
    case "unknown_unobserved":
      return {
        state: "unknown",
        evidence: "unobserved",
        observed_version: null,
        supported_version: input.supportedVersion,
        capability_state: "unverified",
        checked_at: null,
        recorded_at: null
      };
    case "unknown_last_known":
      return {
        state: "unknown",
        evidence: "last_known",
        observed_version: input.supportedVersion,
        capability_state: "unverified",
        ...common
      };
    case "disconnected":
      return {
        state: "disconnected",
        evidence: "last_known",
        observed_version: input.supportedVersion,
        capability_state: "unverified",
        ...common
      };
  }
}

function localState(variant: RuntimeCompatibilityFixtureVariant): Readonly<{
  aggregate: SelectedHostLocalHealthState;
  ready: boolean;
}> {
  switch (variant) {
    case "supported":
      return { aggregate: "ready", ready: true };
    case "version_drift":
    case "incompatible":
      return { aggregate: "failed", ready: false };
    case "degraded_current":
    case "degraded_last_known":
    case "disconnected":
      return { aggregate: "degraded", ready: false };
    case "unknown_unobserved":
      return { aggregate: "unknown", ready: false };
    case "unknown_last_known":
      return { aggregate: "stale", ready: false };
  }
}

function componentState(
  variant: RuntimeCompatibilityFixtureVariant,
  component: (typeof selectedHostLocalHealthComponents)[number]
): Readonly<{
  state: SelectedHostLocalHealthState;
  causes: readonly SelectedHostLocalHealthCause[];
}> {
  if (component !== "runtime" && component !== "compatibility") {
    return { state: "ready", causes: [] };
  }
  if (variant === "supported") return { state: "ready", causes: [] };
  if (variant === "version_drift" || variant === "incompatible") {
    return component === "runtime"
      ? { state: "failed", causes: ["runtime_failed"] }
      : { state: "failed", causes: ["runtime_incompatible"] };
  }
  if (variant === "disconnected") {
    return component === "runtime"
      ? { state: "degraded", causes: ["runtime_disconnected"] }
      : { state: "degraded", causes: ["compatibility_degraded"] };
  }
  if (variant === "degraded_current" || variant === "degraded_last_known") {
    return component === "runtime"
      ? { state: "degraded", causes: ["runtime_starting"] }
      : { state: "degraded", causes: ["compatibility_degraded"] };
  }
  return variant === "unknown_unobserved"
    ? { state: "unknown", causes: ["source_unknown"] }
    : { state: "stale", causes: ["source_stale"] };
}

export function compatibilityServerState(
  variant: RuntimeCompatibilityFixtureVariant
): SelectedHostCompatibilityState {
  switch (variant) {
    case "degraded_current":
    case "degraded_last_known":
      return "degraded";
    case "unknown_unobserved":
    case "unknown_last_known":
      return "unknown";
    default:
      return variant;
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function fulfillError(route: Route, status: number, code: string): Promise<void> {
  await fulfillJson(
    route,
    {
      error: {
        code,
        message: "Bounded compatibility fixture failure.",
        retryable: true
      }
    },
    status
  );
}
