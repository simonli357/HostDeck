import type { Page, Request, Route } from "@playwright/test";
import {
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListResponseItem,
  selectedDeviceListResponseItemSchema,
  selectedDeviceRevokeParamsSchema,
  selectedDeviceRevokeRequestSchema
} from "../../packages/contracts/src/index.js";

export type DeviceListOutcome =
  | "success"
  | "failure"
  | "authority_denied"
  | "pending";
export type DeviceRevokeOutcome = "success" | "conflict" | "uncertain" | "pending";

export interface PairedDeviceApiController {
  readonly requests: readonly Request[];
  readonly hasPendingList: () => boolean;
  readonly hasPendingRevoke: () => boolean;
  readonly listRequests: () => readonly Request[];
  readonly releasePendingList: (
    outcome?: Exclude<DeviceListOutcome, "pending">
  ) => void;
  readonly releasePendingRevoke: (
    outcome?: Exclude<DeviceRevokeOutcome, "pending">
  ) => void;
  readonly revokeRequests: () => readonly Request[];
  readonly setListOutcome: (outcome: DeviceListOutcome) => void;
  readonly setPages: (pages: readonly (readonly SelectedDeviceListResponseItem[])[]) => void;
  readonly setRevokeOutcome: (outcome: DeviceRevokeOutcome) => void;
}

export const pairedDeviceCurrentId = "device_mission_phone";
export const pairedDeviceFixtureNow = "2026-07-26T12:00:00.000Z";

export async function installPairedDeviceManagementApi(
  page: Page,
  options: Readonly<{
    pages?: readonly (readonly SelectedDeviceListResponseItem[])[];
    listOutcome?: DeviceListOutcome;
    revokeOutcome?: DeviceRevokeOutcome;
  }> = {}
): Promise<PairedDeviceApiController> {
  let pages = freezePages(options.pages ?? [[]]);
  let listOutcome = options.listOutcome ?? "success";
  let revokeOutcome = options.revokeOutcome ?? "success";
  let pendingListResolution:
    | ((outcome: Exclude<DeviceListOutcome, "pending">) => void)
    | null = null;
  let pendingRevokeResolution:
    | ((outcome: Exclude<DeviceRevokeOutcome, "pending">) => void)
    | null = null;
  const requests: Request[] = [];

  await page.route("**/api/v1/access/devices**", async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());

    if (url.pathname === "/api/v1/access/devices" && request.method() === "GET") {
      let selectedOutcome = listOutcome;
      if (selectedOutcome === "pending") {
        if (pendingListResolution !== null) {
          await fulfillError(route, 500, "duplicate_pending_device_list", false);
          return;
        }
        selectedOutcome = await new Promise<Exclude<DeviceListOutcome, "pending">>(
          (resolve) => {
            pendingListResolution = resolve;
          }
        );
        pendingListResolution = null;
      }
      await fulfillList(route, url, pages, selectedOutcome);
      return;
    }

    const match = /^\/api\/v1\/access\/devices\/([^/]+)\/revoke$/u.exec(url.pathname);
    if (match !== null && request.method() === "POST") {
      let selectedOutcome = revokeOutcome;
      if (selectedOutcome === "pending") {
        if (pendingRevokeResolution !== null) {
          await fulfillError(route, 500, "duplicate_pending_device_revoke", false);
          return;
        }
        selectedOutcome = await new Promise<Exclude<DeviceRevokeOutcome, "pending">>(
          (resolve) => {
            pendingRevokeResolution = resolve;
          }
        );
        pendingRevokeResolution = null;
      }
      await fulfillRevoke(route, request, decodeURIComponent(match[1] ?? ""), selectedOutcome);
      return;
    }

    await fulfillError(route, 404, "unexpected_device_route", false);
  });

  const controller: PairedDeviceApiController = {
    requests,
    hasPendingList: () => pendingListResolution !== null,
    hasPendingRevoke: () => pendingRevokeResolution !== null,
    listRequests: () => requests.filter((request) => request.method() === "GET"),
    releasePendingList(
      outcome: Exclude<DeviceListOutcome, "pending"> = "success"
    ) {
      const release = pendingListResolution;
      if (release === null) throw new TypeError("No device-list request is pending.");
      release(outcome);
    },
    releasePendingRevoke(
      outcome: Exclude<DeviceRevokeOutcome, "pending"> = "success"
    ) {
      const release = pendingRevokeResolution;
      if (release === null) throw new TypeError("No device-revoke request is pending.");
      release(outcome);
    },
    revokeRequests: () => requests.filter((request) => request.method() === "POST"),
    setListOutcome(outcome: DeviceListOutcome) {
      listOutcome = outcome;
    },
    setPages(nextPages: readonly (readonly SelectedDeviceListResponseItem[])[]) {
      pages = freezePages(nextPages);
    },
    setRevokeOutcome(outcome: DeviceRevokeOutcome) {
      revokeOutcome = outcome;
    }
  };
  return Object.freeze(controller);
}

export function pairedDevice(
  deviceId: string,
  clientLabel: string | null,
  permission: "read" | "write" = "read",
  options: Readonly<{
    lastUsedAt?: string | null;
    expiresAt?: string | null;
    revokedAt?: string | null;
  }> = {}
): SelectedDeviceListResponseItem {
  return Object.freeze(selectedDeviceListResponseItemSchema.parse({
    device_id: deviceId,
    client_label: clientLabel,
    permission,
    created_at: "2026-07-01T12:00:00.000Z",
    last_used_at: options.lastUsedAt === undefined
      ? "2026-07-25T12:00:00.000Z"
      : options.lastUsedAt,
    expires_at: options.expiresAt === undefined
      ? "2026-10-26T12:00:00.000Z"
      : options.expiresAt,
    revoked_at: options.revokedAt ?? null
  }));
}

async function fulfillList(
  route: Route,
  url: URL,
  pages: readonly (readonly SelectedDeviceListResponseItem[])[],
  outcome: Exclude<DeviceListOutcome, "pending">
): Promise<void> {
  if (outcome === "failure") {
    await fulfillError(route, 503, "runtime_unavailable", true);
    return;
  }
  if (outcome === "authority_denied") {
    await fulfillError(route, 403, "permission_denied", false);
    return;
  }
  if (url.searchParams.get("limit") !== "20") {
    await fulfillError(route, 400, "invalid_request", false);
    return;
  }
  const cursor = url.searchParams.get("cursor");
  const pageIndex = cursor === null
    ? 0
    : pages.findIndex((_, index) => index > 0 && pageCursor(pages[index - 1] ?? []) === cursor);
  const devices = pages[pageIndex];
  if (pageIndex < 0 || devices === undefined) {
    await fulfillError(route, 400, "invalid_cursor", false);
    return;
  }
  const hasMore = pageIndex < pages.length - 1;
  await fulfillJson(route, {
    devices,
    next_cursor: hasMore ? pageCursor(devices) : null,
    has_more: hasMore
  });
}

async function fulfillRevoke(
  route: Route,
  request: Request,
  deviceId: string,
  outcome: Exclude<DeviceRevokeOutcome, "pending">
): Promise<void> {
  if (outcome === "conflict") {
    await fulfillError(route, 409, "operation_conflict", false);
    return;
  }
  if (outcome === "uncertain") {
    await fulfillError(route, 503, "runtime_unavailable", true);
    return;
  }
  let body: unknown;
  try {
    body = request.postDataJSON();
  } catch {
    await fulfillError(route, 400, "invalid_request", false);
    return;
  }
  const params = selectedDeviceRevokeParamsSchema.safeParse({ device_id: deviceId });
  const parsedBody = selectedDeviceRevokeRequestSchema.safeParse(body);
  if (!params.success || !parsedBody.success) {
    await fulfillError(route, 400, "invalid_request", false);
    return;
  }
  await fulfillJson(route, {
    operation_id: parsedBody.data.operation_id,
    device_id: params.data.device_id,
    revoked_at: pairedDeviceFixtureNow,
    authority_invalidated: true,
    self_revoked: params.data.device_id === pairedDeviceCurrentId
  });
}

function pageCursor(devices: readonly SelectedDeviceListResponseItem[]): string {
  const finalId = devices.at(-1)?.device_id;
  if (finalId === undefined) throw new TypeError("A continuing device page cannot be empty.");
  return encodeSelectedDeviceListCursor(finalId);
}

function freezePages(
  candidate: readonly (readonly SelectedDeviceListResponseItem[])[]
): readonly (readonly SelectedDeviceListResponseItem[])[] {
  if (candidate.length < 1) throw new TypeError("At least one device page is required.");
  return Object.freeze(
    candidate.map((page, index) => {
      if (index < candidate.length - 1 && page.length !== 20) {
        throw new TypeError("Every continuing device fixture page must contain 20 rows.");
      }
      return Object.freeze(page.map((device) => Object.freeze({ ...device })));
    })
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
        message: "Bounded device-management fixture failure.",
        retryable
      }
    },
    status
  );
}
