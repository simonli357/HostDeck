import type { Page, Request, Route } from "@playwright/test";
import {
  remoteIngressPublicStateSchema,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedSessionListResponseSchema
} from "../../packages/contracts/src/index.js";
import type { RemoteIngressUnavailableReason } from "../../packages/core/src/index.js";

export type RemoteRecoveryState =
  | "ready"
  | "not_observed"
  | "remote_disabled"
  | RemoteIngressUnavailableReason;

export type RemoteRecoveryBrowserMode = "loopback" | "remote";
export type RemoteStatusOutcome = "success" | "failure" | "pending";

export interface RemoteRecoveryApiController {
  readonly accessRequests: () => readonly Request[];
  readonly hostRequests: () => readonly Request[];
  readonly remoteStatusRequests: () => readonly Request[];
  readonly requests: readonly Request[];
  readonly hasPendingRemoteStatus: () => boolean;
  readonly releaseRemoteStatus: (
    outcome?: Exclude<RemoteStatusOutcome, "pending">
  ) => void;
  readonly setAvailable: (available: boolean) => void;
  readonly setDeviceId: (deviceId: string) => void;
  readonly setRemoteState: (state: RemoteRecoveryState) => void;
  readonly setRemoteStatusOutcome: (outcome: RemoteStatusOutcome) => void;
}

export interface RemoteHostOverlayController {
  readonly requests: readonly Request[];
}

export interface RemoteRecoveryApiOptions {
  readonly configuredOrigin?: string;
  readonly proxyPrivateOrigin?: boolean;
}

export const remoteRecoveryLoopbackOrigin = "http://127.0.0.1:4175";
export const remoteRecoveryPrivateOrigin =
  "https://hostdeck-recovery.fixture-tailnet.ts.net";

const timestamp = "2026-07-26T16:00:00.000Z";

export async function installRemoteRecoveryApi(
  page: Page,
  mode: RemoteRecoveryBrowserMode,
  initialState: RemoteRecoveryState = "ready",
  options: RemoteRecoveryApiOptions = {}
): Promise<RemoteRecoveryApiController> {
  if (mode === "remote" && options.proxyPrivateOrigin !== false) {
    await installPrivateOriginProxy(page);
  }
  const configuredOrigin = options.configuredOrigin ?? (
    mode === "remote" ? remoteRecoveryPrivateOrigin : remoteRecoveryLoopbackOrigin
  );

  let available = true;
  let deviceId = "device_remote_recovery_phone";
  let remoteState = initialState;
  let remoteGeneration = initialState === "not_observed" ? 0 : 7;
  let statusOutcome: RemoteStatusOutcome = "success";
  let pendingStatusResolution:
    | ((outcome: Exclude<RemoteStatusOutcome, "pending">) => void)
    | null = null;
  const requests: Request[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname;

    if (!available) {
      await fulfillError(route, 503, "daemon_unavailable", true);
      return;
    }
    if (path === "/api/v1/access" && request.method() === "GET") {
      await fulfillJson(route, accessState(mode, deviceId, configuredOrigin));
      return;
    }
    if (path === "/api/v1/host/status" && request.method() === "GET") {
      await fulfillJson(
        route,
        hostStatus(mode, remoteState, undefined, remoteGeneration, configuredOrigin)
      );
      return;
    }
    if (path === "/api/v1/sessions" && request.method() === "GET") {
      await fulfillJson(route, sessionList(mode));
      return;
    }
    if (path === "/api/v1/access/devices" && request.method() === "GET") {
      await fulfillJson(route, {
        devices: [],
        next_cursor: null,
        has_more: false
      });
      return;
    }
    if (path === "/api/v1/remote/status" && request.method() === "GET") {
      let selected = statusOutcome;
      if (selected === "pending") {
        if (pendingStatusResolution !== null) {
          await fulfillError(route, 500, "duplicate_pending_remote_status", false);
          return;
        }
        selected = await new Promise<Exclude<RemoteStatusOutcome, "pending">>(
          (resolve) => {
            pendingStatusResolution = resolve;
          }
        );
        pendingStatusResolution = null;
      }
      if (selected === "failure") {
        await fulfillError(route, 503, "runtime_unavailable", true);
        return;
      }
      await fulfillJson(
        route,
        publicRemoteState(remoteState, remoteGeneration, configuredOrigin)
      );
      return;
    }

    await fulfillError(route, 404, "unexpected_remote_recovery_route", false);
  });

  return Object.freeze({
    requests,
    accessRequests: () => matchingRequests(requests, "/api/v1/access"),
    hostRequests: () => matchingRequests(requests, "/api/v1/host/status"),
    remoteStatusRequests: () => matchingRequests(requests, "/api/v1/remote/status"),
    hasPendingRemoteStatus: () => pendingStatusResolution !== null,
    releaseRemoteStatus(
      outcome: Exclude<RemoteStatusOutcome, "pending"> = "success"
    ) {
      const release = pendingStatusResolution;
      if (release === null) throw new TypeError("No remote-status request is pending.");
      release(outcome);
    },
    setAvailable(next: boolean) {
      available = next;
    },
    setDeviceId(next: string) {
      if (!/^device_[a-z0-9_]{8,80}$/u.test(next)) {
        throw new TypeError("Remote-recovery device id is invalid.");
      }
      deviceId = next;
    },
    setRemoteState(next: RemoteRecoveryState) {
      if (next !== remoteState) {
        remoteGeneration = Math.max(remoteGeneration + 1, 1);
      }
      remoteState = next;
    },
    setRemoteStatusOutcome(next: RemoteStatusOutcome) {
      if (pendingStatusResolution !== null) {
        throw new TypeError("Cannot replace an active remote-status outcome.");
      }
      statusOutcome = next;
    }
  });
}

export async function installRemoteHostOverlay(
  page: Page,
  state: RemoteRecoveryState
): Promise<RemoteHostOverlayController> {
  const requests: Request[] = [];
  await page.route("**/api/v1/host/status", async (route) => {
    requests.push(route.request());
    await fulfillJson(route, hostStatus("loopback", state, "paired_read"));
  });
  return Object.freeze({ requests });
}

export async function installPrivateOriginProxy(page: Page): Promise<void> {
  await page.route(`${remoteRecoveryPrivateOrigin}/**`, async (route) => {
    const request = route.request();
    const source = new URL(request.url());
    const local = `${remoteRecoveryLoopbackOrigin}${source.pathname}${source.search}`;
    const headers = { ...request.headers() };
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    const response = await route.fetch({ url: local, headers });
    await route.fulfill({ response });
  });
}

function accessState(
  mode: RemoteRecoveryBrowserMode,
  deviceId: string,
  configuredOrigin: string
) {
  const remote = mode === "remote";
  return selectedAccessStateResponseSchema.parse({
    authentication_state: remote ? "paired_device" : "unpaired",
    device_id: remote ? deviceId : null,
    permission: remote ? "read" : null,
    device_expires_at: remote ? "2026-10-26T16:00:00.000Z" : null,
    configured_origin: configuredOrigin,
    network_mode: mode,
    transport: remote ? "https" : "http",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}

function hostStatus(
  mode: RemoteRecoveryBrowserMode,
  state: RemoteRecoveryState,
  accessMode?: "loopback_read" | "paired_read",
  remoteGeneration = state === "not_observed" ? 0 : 7,
  configuredOrigin = mode === "remote"
    ? remoteRecoveryPrivateOrigin
    : remoteRecoveryLoopbackOrigin
) {
  const remote = mode === "remote";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 7,
      state: "ready",
      readiness: "ready",
      updated_at: timestamp,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      })),
      mutation_admission: "open"
    },
    compatibility: {
      state: "supported",
      evidence: "current",
      observed_version: "0.144.0",
      supported_version: "0.144.0",
      capability_state: "verified",
      checked_at: timestamp,
      recorded_at: timestamp
    },
    remote: hostRemoteState(state, remoteGeneration, configuredOrigin),
    access: {
      mode: accessMode ?? (remote ? "paired_read" : "loopback_read"),
      network_mode: mode,
      transport: remote ? "https" : "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: false,
        causes: ["read_only_access"]
      }
    }
  });
}

function hostRemoteState(
  state: RemoteRecoveryState,
  generation = 7,
  configuredOrigin = remoteRecoveryPrivateOrigin
) {
  if (state === "not_observed") {
    return {
      generation: 0,
      state_generation: null,
      availability: "unknown",
      cause: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: timestamp
    } as const;
  }
  if (state === "ready") {
    return {
      generation,
      state_generation: generation,
      availability: "ready",
      cause: null,
      external_origin: configuredOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    } as const;
  }
  const disabled = state === "remote_disabled" || state === "cleanup_incomplete";
  return {
    generation,
    state_generation: generation,
    availability: disabled ? "disabled" : "unavailable",
    cause: state,
    external_origin: null,
    laptop_action_required: true,
    observed_at: timestamp,
    checked_at: timestamp,
    updated_at: timestamp
  } as const;
}

function publicRemoteState(
  state: RemoteRecoveryState,
  generation = 7,
  configuredOrigin = remoteRecoveryPrivateOrigin
) {
  const remote = hostRemoteState(state, generation, configuredOrigin);
  return remoteIngressPublicStateSchema.parse({
    generation: remote.state_generation ?? 0,
    availability: remote.availability,
    reason: remote.cause,
    external_origin: remote.external_origin,
    laptop_action_required: remote.laptop_action_required,
    observed_at: remote.observed_at
  });
}

function sessionList(mode: RemoteRecoveryBrowserMode) {
  const remote = mode === "remote";
  return selectedSessionListResponseSchema.parse({
    access: {
      mode: remote ? "paired_read" : "loopback_read",
      network_mode: mode,
      transport: remote ? "https" : "http"
    },
    sessions: [],
    next_cursor: null,
    has_more: false
  });
}

function matchingRequests(
  requests: readonly Request[],
  path: string
): readonly Request[] {
  return Object.freeze(
    requests.filter((request) => new URL(request.url()).pathname === path)
  );
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function fulfillError(
  route: Route,
  status: number,
  code: string,
  retryable: boolean
): Promise<void> {
  await fulfillJson(
    route,
    {
      error: {
        code,
        message: "Bounded remote-recovery fixture failure.",
        retryable
      }
    },
    status
  );
}
