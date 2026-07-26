import type { Page, Request, Route } from "@playwright/test";
import {
  selectedHostLockRequestSchema,
  selectedHostLockStateResponseSchema
} from "../../packages/contracts/src/index.js";

export type HostLockOutcome = "success" | "conflict" | "uncertain" | "pending";

export interface HostLockApiController {
  readonly hasPendingLock: () => boolean;
  readonly lockRequests: () => readonly Request[];
  readonly releasePendingLock: (
    outcome?: Exclude<HostLockOutcome, "pending">
  ) => void;
  readonly requests: readonly Request[];
  readonly setOutcome: (outcome: HostLockOutcome) => void;
}

const origin = "http://127.0.0.1:4175";

export async function installHostLockApi(
  page: Page,
  initialOutcome: HostLockOutcome = "success"
): Promise<HostLockApiController> {
  let outcome = initialOutcome;
  let pendingResolution:
    | ((selected: Exclude<HostLockOutcome, "pending">) => void)
    | null = null;
  const requests: Request[] = [];

  await page.route("**/api/v1/access/lock", async (route) => {
    const request = route.request();
    requests.push(request);
    if (request.method() !== "POST") {
      await fulfillError(route, 405, "method_not_allowed", false);
      return;
    }

    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      await fulfillError(route, 400, "invalid_request", false);
      return;
    }
    if (!selectedHostLockRequestSchema.safeParse(body).success) {
      await fulfillError(route, 400, "invalid_request", false);
      return;
    }

    let selected = outcome;
    if (selected === "pending") {
      if (pendingResolution !== null) {
        await fulfillError(route, 500, "duplicate_pending_host_lock", false);
        return;
      }
      selected = await new Promise<Exclude<HostLockOutcome, "pending">>((resolve) => {
        pendingResolution = resolve;
      });
      pendingResolution = null;
    }

    if (selected === "conflict") {
      await fulfillError(route, 409, "operation_conflict", false);
      return;
    }
    if (selected === "uncertain") {
      await fulfillError(route, 503, "runtime_unavailable", true);
      return;
    }
    await fulfillJson(route, lockedAccess());
  });

  return Object.freeze({
    hasPendingLock: () => pendingResolution !== null,
    lockRequests: () => Object.freeze([...requests]),
    releasePendingLock(
      selected: Exclude<HostLockOutcome, "pending"> = "success"
    ) {
      const release = pendingResolution;
      if (release === null) throw new TypeError("No host-lock request is pending.");
      release(selected);
    },
    requests,
    setOutcome(next: HostLockOutcome) {
      outcome = next;
    }
  });
}

function lockedAccess() {
  return selectedHostLockStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_mission_phone",
    permission: "write",
    device_expires_at: "2026-10-22T18:00:00.000Z",
    configured_origin: origin,
    network_mode: "loopback",
    transport: "http",
    locked: true,
    can_read_sessions: true,
    can_write_sessions: false,
    can_lock: true,
    can_unlock: false
  });
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
        message: "Bounded host-lock fixture failure.",
        retryable
      }
    },
    status
  );
}
