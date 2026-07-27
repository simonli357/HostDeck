import type { Page, Request } from "@playwright/test";
import { selectedHostStatusResponseSchema } from "../../packages/contracts/src/index.js";

export type MissionApiVariant =
  | "mixed"
  | "long"
  | "read_only"
  | "locked"
  | "host_unavailable"
  | "denied"
  | "unavailable";

export interface MissionApiController {
  readonly requests: readonly Request[];
  readonly setVariant: (variant: MissionApiVariant) => void;
}

const origin = "http://127.0.0.1:4175";
const timestamp = "2026-07-22T18:00:00.000Z";
const components = [
  "storage",
  "runtime",
  "compatibility",
  "projector",
  "fanout",
  "listener",
  "lease"
] as const;

export async function installMissionControlApi(
  page: Page,
  initialVariant: MissionApiVariant = "mixed"
): Promise<MissionApiController> {
  let variant = initialVariant;
  const requests: Request[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());

    if (variant === "unavailable") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          error: {
            code: "daemon_unavailable",
            message: "HostDeck is temporarily unavailable.",
            retryable: true
          }
        })
      });
      return;
    }

    if (url.pathname === "/api/v1/access" && request.method() === "GET") {
      await fulfillJson(
        route,
        variant === "denied" ? deniedAccess() : pairedAccess(variant)
      );
      return;
    }
    if (variant === "denied") {
      await route.fulfill({ status: 500, body: "unexpected protected request" });
      return;
    }
    if (url.pathname === "/api/v1/access/devices" && request.method() === "GET") {
      await fulfillJson(route, {
        devices: [],
        next_cursor: null,
        has_more: false
      });
      return;
    }
    if (url.pathname === "/api/v1/host/status" && request.method() === "GET") {
      if (variant === "host_unavailable") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: { "cache-control": "no-store" },
          body: JSON.stringify({
            error: {
              code: "runtime_unavailable",
              message: "The laptop runtime is unavailable.",
              retryable: true
            }
          })
        });
        return;
      }
      await fulfillJson(route, readyHostStatus(variant));
      return;
    }
    if (url.pathname === "/api/v1/sessions" && request.method() === "GET") {
      await fulfillJson(route, sessionList(variant));
      return;
    }
    if (url.pathname === "/api/v1/access/csrf" && request.method() === "POST") {
      await fulfillJson(route, {
        csrf_token: "C".repeat(43),
        csrf_generation: 1,
        rotated_at: timestamp
      });
      return;
    }

    await route.fulfill({ status: 404, body: "unexpected route" });
  });

  return Object.freeze({
    requests,
    setVariant(nextVariant: MissionApiVariant) {
      variant = nextVariant;
    }
  });
}

export function missionRequestPaths(controller: MissionApiController): string[] {
  return controller.requests.map((request) => new URL(request.url()).pathname);
}

async function fulfillJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function pairedAccess(variant: MissionApiVariant) {
  const readOnly = variant === "read_only";
  const locked = variant === "locked";
  return {
    authentication_state: "paired_device",
    device_id: "device_mission_phone",
    permission: readOnly ? "read" : "write",
    device_expires_at: "2026-10-22T18:00:00.000Z",
    configured_origin: origin,
    network_mode: "loopback",
    transport: "http",
    locked,
    can_read_sessions: true,
    can_write_sessions: !readOnly && !locked,
    can_lock: !readOnly,
    can_unlock: false
  };
}

function deniedAccess() {
  return {
    authentication_state: "invalid_device",
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: origin,
    network_mode: "loopback",
    transport: "http",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  };
}

function readyHostStatus(variant: MissionApiVariant) {
  const readOnly = variant === "read_only";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: "ready",
      readiness: "ready",
      updated_at: timestamp,
      components: components.map((component) => ({
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
    remote: {
      generation: 0,
      state_generation: null,
      availability: "unknown",
      cause: "not_observed",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null,
      checked_at: null,
      updated_at: timestamp
    },
    access: {
      mode: readOnly ? "paired_read" : "paired_write",
      network_mode: "loopback",
      transport: "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: !readOnly,
        causes: readOnly ? ["read_only_access"] : []
      }
    }
  });
}

function sessionList(variant: MissionApiVariant) {
  const sessions = variant === "long"
    ? [
        session(
          "sess_mission_long_approval",
          "release-approval-with-a-long-but-valid-session-name-2026",
          "needs_approval",
          "waiting_for_approval",
          {
            cwd: `/workspace/${"deep-project-segment-".repeat(8)}mobile`,
            branch: `feature/${"responsive-accessibility-".repeat(8)}phone`,
            summary: `Approval is required before ${"the bounded mobile release validation continues. ".repeat(8)}`
          }
        ),
        session("sess_mission_long_running", "running-mobile-validation", "watch", "in_progress")
      ]
    : [
        session(
          "sess_mission_browser_approval",
          "release-approval",
          "needs_approval",
          "waiting_for_approval",
          { summary: "Approval is required before installing the release package." }
        ),
        session(
          "sess_mission_browser_input",
          "android-check",
          "needs_input",
          "waiting_for_input",
          { summary: "Confirm which phone should run the next validation." }
        ),
        session(
          "sess_mission_browser_failed",
          "package-smoke",
          "failed",
          "failed",
          { summary: "The last package smoke failed before deployment." }
        ),
        session(
          "sess_mission_browser_interrupted",
          "runtime-recovery",
          "stuck",
          "interrupted",
          { summary: "The previous runtime recovery was interrupted." }
        ),
        session(
          "sess_mission_browser_running",
          "interface-build",
          "watch",
          "in_progress",
          { summary: "Building the selected mobile interface." }
        ),
        session(
          "sess_mission_browser_quiet",
          "contract-baseline",
          "none",
          "completed",
          { summary: "Contract validation completed." }
        )
      ];
  return {
    access: {
      mode: variant === "read_only" ? "paired_read" : "paired_write",
      network_mode: "loopback",
      transport: "http"
    },
    sessions,
    next_cursor: null,
    has_more: false
  };
}

function session(
  id: string,
  name: string,
  attention: "none" | "watch" | "needs_input" | "needs_approval" | "failed" | "stuck",
  turnState:
    | "idle"
    | "in_progress"
    | "waiting_for_input"
    | "waiting_for_approval"
    | "completed"
    | "interrupted"
    | "failed",
  options: {
    readonly cwd?: string;
    readonly branch?: string;
    readonly summary?: string;
  } = {}
) {
  return {
    session: {
      id,
      name,
      codex_thread_id: `thread-${id}`,
      cwd: options.cwd ?? `/workspace/${name}`,
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      created_at: timestamp,
      archived_at: null,
      session_state: "active",
      turn_state: turnState,
      attention,
      freshness: "current",
      freshness_reason: null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: options.branch ?? "main",
      model: "gpt-5.5-codex",
      settings: null,
      goal: null,
      recent_summary: options.summary ?? `Current work for ${name}.`,
      last_event_cursor: null
    },
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  };
}
