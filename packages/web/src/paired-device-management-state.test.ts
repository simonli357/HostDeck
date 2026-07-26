import {
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListResponseItem,
  selectedAccessStateResponseSchema,
  selectedDeviceListResponseItemSchema,
  selectedDeviceRevokeResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it, vi } from "vitest";
import type { BrowserConnectionSnapshot } from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import type { BrowserHttpRouteResponse } from "./http-client.js";
import type { BrowserHttpRouteRequest } from "./http-route-contracts.js";
import {
  createPairedDeviceManagementController,
  HostDeckPairedDeviceManagementError,
  type PairedDeviceManagementController,
  type PairedDeviceManagementPort,
  pairedDeviceManagementPageSize
} from "./paired-device-management-state.js";

const origin = "https://hostdeck-devices.fixture-tailnet.ts.net";
const nowMs = Date.parse("2026-07-26T12:00:00.000Z");
const createdAt = "2026-07-01T12:00:00.000Z";
const lastUsedAt = "2026-07-25T12:00:00.000Z";
const expiresAt = "2026-08-26T12:00:00.000Z";
const expiredAt = "2026-07-20T12:00:00.000Z";
const revokedAt = "2026-07-24T12:00:00.000Z";
const currentDeviceId = "device_001";

describe("paired-device management state", () => {
  it("accepts only exact ports and begins unavailable without side effects", () => {
    const harness = createHarness(unavailableSnapshot());
    expect(harness.controller.snapshot()).toMatchObject({
      phase: "unavailable",
      rows: [],
      refreshVisible: false,
      confirmation: null
    });
    expect(Object.isFrozen(harness.controller)).toBe(true);
    expect(Object.isFrozen(harness.controller.snapshot())).toBe(true);
    expect(harness.port.listCalls).toHaveLength(0);

    expect(() =>
      createPairedDeviceManagementController({
        port: { ...harness.port.adapter, extra: true } as never,
        createOperationId: () => "op_browser_device_invalid_001"
      })
    ).toThrow(TypeError);
    let getterCalls = 0;
    const hostilePort = Object.defineProperty({}, "snapshot", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return harness.port.adapter.snapshot;
      }
    });
    expect(() =>
      createPairedDeviceManagementController({
        port: hostilePort as never,
        createOperationId: () => "op_browser_device_invalid_002"
      })
    ).toThrow(TypeError);
    expect(getterCalls).toBe(0);
    harness.controller.close();
  });

  it("dispatches zero work for denied, local-admin, and stale browser authority", async () => {
    const snapshots = [
      unavailableSnapshot(),
      deniedSnapshot("invalid_device"),
      deniedSnapshot("expired_device"),
      revokedSnapshot(),
      localAdminSnapshot(),
      staleAuthoritySnapshot()
    ];

    for (const snapshot of snapshots) {
      const harness = createHarness(snapshot);
      await expect(harness.controller.ensureLoaded()).resolves.toMatchObject({
        phase: "unavailable",
        rows: []
      });
      await expect(harness.controller.refresh()).rejects.toMatchObject({
        reason: "not_ready"
      });
      expect(() => harness.controller.beginRevoke("device-1-1")).toThrow(
        HostDeckPairedDeviceManagementError
      );
      expect(harness.port.listCalls).toHaveLength(0);
      expect(harness.port.revokeCalls).toHaveLength(0);
      harness.controller.close();
    }
  });

  it("loads one private-free reader page and sanitizes hostile or duplicate labels", async () => {
    const harness = createHarness(pairedSnapshot("read"));
    harness.port.enqueueList(
      listResponse([
        device(currentDeviceId, "  \u061cXiaomi\u200f\u202e 15\nPro  ", "read"),
        device("device_002", null, "write"),
        device("device_003", "   ", "read")
      ])
    );

    const first = harness.controller.ensureLoaded();
    const duplicate = harness.controller.ensureLoaded();
    expect(duplicate).toBe(first);
    const view = await first;

    expect(harness.port.listCalls).toHaveLength(1);
    expect(harness.port.listCalls[0]?.input).toEqual({ query: { limit: "20" } });
    expect(view).toMatchObject({
      phase: "ready",
      readOnly: true,
      pageOrdinal: 1,
      rows: [
        {
          key: "device-1-1",
          label: "Xiaomi 15 Pro",
          cue: "Device 1",
          current: true,
          revokeVisible: false
        },
        {
          key: "device-1-2",
          label: "Unlabeled device",
          cue: "Device 2",
          revokeVisible: false
        },
        {
          key: "device-1-3",
          label: "Unlabeled device",
          cue: "Device 3",
          revokeVisible: false
        }
      ]
    });
    expect(JSON.stringify(view)).not.toContain(currentDeviceId);
    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(view.rows.every(Object.isFrozen)).toBe(true);
    harness.controller.close();
  });

  it("replaces pages with constant-memory navigation and rejects malformed continuation", async () => {
    const harness = createHarness(pairedSnapshot("write"));
    const firstItems = devices(1, pairedDeviceManagementPageSize);
    const firstCursor = encodeSelectedDeviceListCursor(
      firstItems.at(-1)?.device_id ?? "missing"
    );
    harness.port.enqueueList(listResponse(firstItems, firstCursor));
    await harness.controller.ensureLoaded();
    expect(harness.controller.snapshot()).toMatchObject({
      hasNextPage: true,
      nextEnabled: true
    });
    expect(harness.controller.snapshot().rows[0]?.cue).toBe("Device 1");
    expect(harness.controller.snapshot().rows[19]?.cue).toBe("Device 20");

    const secondPage = deferred<BrowserHttpRouteResponse<"device_list">>();
    harness.port.enqueueList(() => secondPage.promise);
    const next = harness.controller.nextPage();
    const duplicate = harness.controller.nextPage();
    expect(duplicate).toBe(next);
    expect(harness.controller.snapshot()).toMatchObject({
      phase: "loading",
      busy: true
    });
    expect(harness.controller.snapshot().rows[0]?.cue).toBe("Device 1");
    const secondItems = devices(21, pairedDeviceManagementPageSize);
    secondPage.resolve(listResponse(secondItems));
    const second = await next;
    expect(second).toMatchObject({
      phase: "ready",
      pageOrdinal: 2,
      hasNextPage: false,
      startOverVisible: true
    });
    expect(second.rows[0]?.cue).toBe("Device 21");
    expect(second.rows[19]?.cue).toBe("Device 40");
    expect(second.rows).toHaveLength(pairedDeviceManagementPageSize);
    expect(second.rows.some((row) => row.cue === "Device 1")).toBe(false);
    expect(harness.port.listCalls[1]?.input).toEqual({
      query: { limit: "20", cursor: firstCursor }
    });

    harness.port.enqueueList(
      listResponse(
        devices(1, pairedDeviceManagementPageSize - 1),
        encodeSelectedDeviceListCursor("device_019")
      )
    );
    const stale = await harness.controller.startOver();
    expect(stale).toMatchObject({
      phase: "stale",
      pageOrdinal: 2,
      nextEnabled: false
    });
    expect(stale.rows[0]?.cue).toBe("Device 21");
    harness.controller.close();
  });

  it("keeps expired devices revocable, blocks revoked rows, and ignores host lock", async () => {
    const harness = createHarness(pairedSnapshot("write", { locked: true }));
    harness.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Current phone", "write"),
        device("device_002", "Expired tablet", "read", { expiresAt: expiredAt }),
        device("device_003", "Revoked browser", "write", { revokedAt })
      ])
    );
    const view = await harness.controller.ensureLoaded();

    expect(view.rows).toMatchObject([
      { status: "active", revokeEnabled: true },
      { status: "expired", revokeEnabled: true },
      {
        status: "revoked",
        revokeEnabled: false,
        revokeDisabledReason: "This device is already revoked."
      }
    ]);
    const confirmation = harness.controller.beginRevoke("device-1-2").confirmation;
    expect(confirmation).toMatchObject({
      targetLabel: "Expired tablet (Device 2)",
      detail: expect.stringContaining("already expired")
    });
    harness.controller.cancelRevoke();
    expect(() => harness.controller.beginRevoke("device-1-3")).toThrow(
      HostDeckPairedDeviceManagementError
    );
    harness.controller.close();
  });

  it("names exact duplicate targets and warns only for a proven final active device", async () => {
    const harness = createHarness(pairedSnapshot("write"));
    harness.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Same label", "write"),
        device("device_002", "Same label", "read", { expiresAt: expiredAt })
      ])
    );
    await harness.controller.ensureLoaded();

    const self = harness.controller.beginRevoke("device-1-1").confirmation;
    expect(self).toMatchObject({
      title: "Revoke this phone?",
      targetLabel: "This phone",
      confirmLabel: "Revoke this phone",
      warning: expect.stringContaining("last active paired device")
    });
    harness.controller.cancelRevoke();
    const expired = harness.controller.beginRevoke("device-1-2").confirmation;
    expect(expired).toMatchObject({
      targetLabel: "Same label (Device 2)",
      warning: null
    });
    harness.controller.close();
  });

  it("dispatches one exact revoke and patches only a correlated other-device success", async () => {
    const harness = createHarness(pairedSnapshot("write"), [
      "op_browser_device_revoke_other_001"
    ]);
    harness.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Current phone", "write"),
        device("device_002", "Work tablet", "read")
      ])
    );
    await harness.controller.ensureLoaded();
    harness.controller.beginRevoke("device-1-2");
    const response = revokeResponse(
      "op_browser_device_revoke_other_001",
      "device_002",
      false
    );
    const pendingResponse = deferred<BrowserHttpRouteResponse<"device_revoke">>();
    harness.port.enqueueRevoke(() => pendingResponse.promise);

    const pending = harness.controller.confirmRevoke();
    const duplicate = harness.controller.confirmRevoke();
    expect(duplicate).toBe(pending);
    expect(harness.controller.snapshot().confirmation).toMatchObject({
      busy: true,
      confirmEnabled: false
    });
    pendingResponse.resolve(response);
    const completed = await pending;

    expect(harness.port.revokeCalls).toHaveLength(1);
    expect(harness.port.revokeCalls[0]?.input).toEqual({
      params: { device_id: "device_002" },
      body: {
        operation_id: "op_browser_device_revoke_other_001",
        confirmed: true
      }
    });
    expect(completed).toMatchObject({
      phase: "ready",
      confirmation: null,
      result: { kind: "success", title: "Device revoked" },
      rows: [
        { status: "active" },
        { status: "revoked", revokeEnabled: false }
      ]
    });
    harness.controller.close();
  });

  it("latches conflict and unconfirmed outcomes until an explicit list proof", async () => {
    const conflict = createHarness(pairedSnapshot("write"), [
      "op_browser_device_conflict_001"
    ]);
    conflict.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Current phone", "write"),
        device("device_002", "Tablet", "read")
      ])
    );
    await conflict.controller.ensureLoaded();
    conflict.controller.beginRevoke("device-1-2");
    conflict.port.enqueueRevoke(() =>
      Promise.reject(
        new HostDeckBrowserCsrfError({
          reason: "api_error",
          operation: "mutation",
          routeId: "device_revoke",
          transport: "https",
          status: 409,
          apiError: {
            code: "operation_conflict",
            message: "Bounded conflict.",
            retryable: false
          }
        })
      )
    );
    const conflicted = await conflict.controller.confirmRevoke();
    expect(conflicted).toMatchObject({
      phase: "stale",
      result: { kind: "conflict" },
      rows: [{ revokeEnabled: false }, { revokeEnabled: false }]
    });
    expect(() => conflict.controller.beginRevoke("device-1-2")).toThrow();
    conflict.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Current phone", "write"),
        device("device_002", "Tablet", "read", { revokedAt })
      ])
    );
    const refreshed = await conflict.controller.refresh();
    expect(refreshed).toMatchObject({
      phase: "ready",
      result: null,
      rows: [{ status: "active" }, { status: "revoked" }]
    });
    conflict.controller.close();

    const uncertain = createHarness(pairedSnapshot("write"), [
      "op_browser_device_uncertain_001"
    ]);
    uncertain.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Current phone", "write"),
        device("device_002", "Tablet", "read")
      ])
    );
    await uncertain.controller.ensureLoaded();
    uncertain.controller.beginRevoke("device-1-2");
    uncertain.port.enqueueRevoke(() => Promise.reject(new Error("private transport detail")));
    const unknown = await uncertain.controller.confirmRevoke();
    expect(unknown).toMatchObject({
      phase: "stale",
      result: { kind: "uncertain" },
      refreshEnabled: true
    });
    expect(uncertain.port.revokeCalls).toHaveLength(1);
    uncertain.controller.close();
  });

  it("purges device rows after correlated self success and preserves bounded recovery truth", async () => {
    const harness = createHarness(pairedSnapshot("write"), [
      "op_browser_device_self_001"
    ]);
    harness.port.enqueueList(
      listResponse([
        device(currentDeviceId, "Current phone", "write"),
        device("device_002", "Tablet", "read")
      ])
    );
    await harness.controller.ensureLoaded();
    harness.controller.beginRevoke("device-1-1");
    harness.port.enqueueRevoke(() => {
      harness.port.current = revokedSnapshot();
      return Promise.resolve(
        revokeResponse("op_browser_device_self_001", currentDeviceId, true)
      );
    });
    const completed = await harness.controller.confirmRevoke();

    expect(completed).toMatchObject({
      phase: "unavailable",
      rows: [],
      confirmation: null,
      result: {
        kind: "self_revoked",
        title: "This phone was revoked",
        detail: expect.stringContaining("new pairing link")
      }
    });
    expect(JSON.stringify(completed)).not.toContain(currentDeviceId);
    harness.controller.close();
  });

  it("treats failed self revoke as authority-uncertain and suppresses late replaced owners", async () => {
    const harness = createHarness(pairedSnapshot("write"), [
      "op_browser_device_self_unknown_001"
    ]);
    harness.port.enqueueList(listResponse([device(currentDeviceId, "Current phone", "write")]));
    await harness.controller.ensureLoaded();
    harness.controller.beginRevoke("device-1-1");
    const pendingResponse = deferred<BrowserHttpRouteResponse<"device_revoke">>();
    harness.port.enqueueRevoke(() => pendingResponse.promise);
    const pending = harness.controller.confirmRevoke();
    harness.port.current = staleAuthoritySnapshot();
    harness.controller.synchronize();
    pendingResponse.reject(new Error("private response loss"));
    const uncertain = await pending;
    expect(uncertain).toMatchObject({
      phase: "unavailable",
      rows: [],
      result: { kind: "uncertain" }
    });

    harness.port.current = pairedSnapshot("write", { deviceId: "device_replacement" });
    harness.controller.synchronize();
    harness.port.enqueueList(listResponse([device("device_replacement", "Replacement", "write")]));
    const replacement = await harness.controller.ensureLoaded();
    expect(replacement).toMatchObject({
      phase: "ready",
      result: null,
      rows: [{ label: "Replacement", current: true }]
    });
    harness.controller.close();
  });

  it("sends nothing for invalid operation ids and closes pending work without late publication", async () => {
    const harness = createHarness(pairedSnapshot("write"), ["invalid operation id"]);
    const listPending = deferred<BrowserHttpRouteResponse<"device_list">>();
    harness.port.enqueueList(() => listPending.promise);
    const loading = harness.controller.ensureLoaded();
    const closed = harness.controller.close();
    expect(closed).toMatchObject({ phase: "closed", rows: [] });
    listPending.resolve(listResponse([device(currentDeviceId, "Late", "write")]));
    await expect(loading).resolves.toMatchObject({ phase: "closed" });
    expect(harness.controller.snapshot()).toBe(closed);

    const invalid = createHarness(pairedSnapshot("write"), ["invalid operation id"]);
    invalid.port.enqueueList(listResponse([device(currentDeviceId, "Current", "write")]));
    await invalid.controller.ensureLoaded();
    invalid.controller.beginRevoke("device-1-1");
    const result = await invalid.controller.confirmRevoke();
    expect(result).toMatchObject({
      phase: "ready",
      confirmation: null,
      result: { kind: "failure" }
    });
    expect(invalid.port.revokeCalls).toHaveLength(0);
    invalid.controller.close();
  });
});

type ListHandler = (
  input: BrowserHttpRouteRequest<"device_list">,
  signal: AbortSignal
) => Promise<BrowserHttpRouteResponse<"device_list">>;
type RevokeHandler = (
  input: BrowserHttpRouteRequest<"device_revoke">,
  signal: AbortSignal
) => Promise<BrowserHttpRouteResponse<"device_revoke">>;

class DevicePortHarness {
  current: BrowserConnectionSnapshot;
  readonly listCalls: Array<{
    readonly input: BrowserHttpRouteRequest<"device_list">;
    readonly signal: AbortSignal;
  }> = [];
  readonly revokeCalls: Array<{
    readonly input: BrowserHttpRouteRequest<"device_revoke">;
    readonly signal: AbortSignal;
  }> = [];
  private readonly listHandlers: ListHandler[] = [];
  private readonly revokeHandlers: RevokeHandler[] = [];
  readonly adapter: PairedDeviceManagementPort;

  constructor(snapshot: BrowserConnectionSnapshot) {
    this.current = snapshot;
    this.adapter = Object.freeze({
      snapshot: () => this.current,
      list: (
        input: BrowserHttpRouteRequest<"device_list">,
        options?: Readonly<{ readonly signal?: AbortSignal }>
      ) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Missing list signal.");
        this.listCalls.push({ input, signal });
        const handler = this.listHandlers.shift();
        if (handler === undefined) return Promise.reject(new Error("Missing list response."));
        return handler(input, signal);
      },
      revoke: (
        input: BrowserHttpRouteRequest<"device_revoke">,
        options?: Readonly<{ readonly signal?: AbortSignal }>
      ) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Missing revoke signal.");
        this.revokeCalls.push({ input, signal });
        const handler = this.revokeHandlers.shift();
        if (handler === undefined) return Promise.reject(new Error("Missing revoke response."));
        return handler(input, signal);
      }
    });
  }

  enqueueList(
    response:
      | BrowserHttpRouteResponse<"device_list">
      | (() => Promise<BrowserHttpRouteResponse<"device_list">>)
  ): void {
    this.listHandlers.push(() =>
      typeof response === "function" ? response() : Promise.resolve(response)
    );
  }

  enqueueRevoke(
    response:
      | BrowserHttpRouteResponse<"device_revoke">
      | (() => Promise<BrowserHttpRouteResponse<"device_revoke">>)
  ): void {
    this.revokeHandlers.push(() =>
      typeof response === "function" ? response() : Promise.resolve(response)
    );
  }
}

function createHarness(
  snapshot: BrowserConnectionSnapshot,
  operationIds: readonly string[] = ["op_browser_device_default_001"]
): {
  readonly controller: PairedDeviceManagementController;
  readonly port: DevicePortHarness;
} {
  const port = new DevicePortHarness(snapshot);
  let operationIndex = 0;
  const controller = createPairedDeviceManagementController({
    port: port.adapter,
    createOperationId: vi.fn(() => operationIds[operationIndex++] ?? "missing"),
    clock: Object.freeze({ now: () => nowMs })
  });
  return { controller, port };
}

function pairedSnapshot(
  permission: "read" | "write",
  options: {
    readonly locked?: boolean;
    readonly deviceId?: string;
    readonly csrfReady?: boolean;
  } = {}
): BrowserConnectionSnapshot {
  const locked = options.locked ?? false;
  const deviceId = options.deviceId ?? currentDeviceId;
  const csrfReady = options.csrfReady ?? permission === "write";
  return connectionSnapshot({
    accessState: "current",
    accessData: selectedAccessStateResponseSchema.parse({
      authentication_state: "paired_device",
      device_id: deviceId,
      permission,
      device_expires_at: expiresAt,
      configured_origin: origin,
      network_mode: "remote",
      transport: "https",
      locked,
      can_read_sessions: true,
      can_write_sessions: permission === "write" && !locked,
      can_lock: permission === "write",
      can_unlock: false
    }),
    csrfPhase: csrfReady ? "ready" : "idle",
    csrfInvalidationReason: csrfReady ? null : "not_bootstrapped",
    hostData: Object.freeze({ current: true }),
    targetData: Object.freeze({ current: true })
  });
}

function unavailableSnapshot(): BrowserConnectionSnapshot {
  return deniedSnapshot("unpaired");
}

function deniedSnapshot(
  authenticationState: "unpaired" | "invalid_device" | "expired_device"
): BrowserConnectionSnapshot {
  return connectionSnapshot({
    accessState: "current",
    accessData: selectedAccessStateResponseSchema.parse({
      authentication_state: authenticationState,
      device_id: null,
      permission: null,
      device_expires_at: null,
      configured_origin: origin,
      network_mode: "remote",
      transport: "https",
      locked: false,
      can_read_sessions: false,
      can_write_sessions: false,
      can_lock: false,
      can_unlock: false
    }),
    csrfPhase: "idle",
    csrfInvalidationReason: "access_lost",
    hostData: null,
    targetData: null
  });
}

function localAdminSnapshot(): BrowserConnectionSnapshot {
  return connectionSnapshot({
    accessState: "current",
    accessData: selectedAccessStateResponseSchema.parse({
      authentication_state: "local_admin",
      device_id: null,
      permission: "local_admin",
      device_expires_at: null,
      configured_origin: "http://127.0.0.1:3777",
      network_mode: "loopback",
      transport: "http",
      locked: false,
      can_read_sessions: true,
      can_write_sessions: true,
      can_lock: true,
      can_unlock: true
    }),
    csrfPhase: "idle",
    csrfInvalidationReason: "access_lost",
    hostData: null,
    targetData: null
  });
}

function revokedSnapshot(): BrowserConnectionSnapshot {
  return connectionSnapshot({
    accessState: "current",
    accessData: selectedAccessStateResponseSchema.parse({
      authentication_state: "revoked_device",
      device_id: null,
      permission: null,
      device_expires_at: null,
      configured_origin: origin,
      network_mode: "remote",
      transport: "https",
      locked: false,
      can_read_sessions: false,
      can_write_sessions: false,
      can_lock: false,
      can_unlock: false
    }),
    csrfPhase: "idle",
    csrfInvalidationReason: "device_revoked",
    hostData: null,
    targetData: null
  });
}

function staleAuthoritySnapshot(): BrowserConnectionSnapshot {
  const paired = pairedSnapshot("write");
  return Object.freeze({
    ...paired,
    access: Object.freeze({ ...paired.access, state: "stale" }),
    host: Object.freeze({ ...paired.host, state: "blocked", data: null }),
    targetState: Object.freeze({ ...paired.targetState, state: "blocked", data: null }),
    csrf: Object.freeze({
      ...paired.csrf,
      phase: "idle",
      invalidationReason: "device_revoked"
    })
  }) as BrowserConnectionSnapshot;
}

function connectionSnapshot(input: {
  readonly accessState: "current" | "stale";
  readonly accessData: BrowserConnectionSnapshot["access"]["data"];
  readonly csrfPhase: BrowserConnectionSnapshot["csrf"]["phase"];
  readonly csrfInvalidationReason: BrowserConnectionSnapshot["csrf"]["invalidationReason"];
  readonly hostData: unknown;
  readonly targetData: unknown;
}): BrowserConnectionSnapshot {
  return Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "mission_control" }),
    phase: "ready",
    access: Object.freeze({
      state: input.accessState,
      data: input.accessData === null ? null : Object.freeze(input.accessData),
      failure: null,
      observedAt: createdAt
    }),
    host: Object.freeze({
      state: input.hostData === null ? "blocked" : "current",
      data: input.hostData,
      failure: null,
      observedAt: input.hostData === null ? null : createdAt
    }),
    targetState: Object.freeze({
      state: input.targetData === null ? "blocked" : "current",
      data: input.targetData,
      failure: null,
      observedAt: input.targetData === null ? null : createdAt
    }),
    stream: Object.freeze({
      state: "not_applicable",
      snapshot: null,
      continuity: "not_applicable",
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: input.csrfPhase,
      generation: input.csrfPhase === "ready" ? 1 : null,
      rotatedAt: input.csrfPhase === "ready" ? createdAt : null,
      invalidationReason: input.csrfInvalidationReason,
      failure: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell",
      eligible: false,
      causes: Object.freeze([])
    }),
    lastFailure: null
  }) as BrowserConnectionSnapshot;
}

function device(
  deviceId: string,
  label: string | null,
  permission: "read" | "write",
  options: {
    readonly expiresAt?: string | null;
    readonly revokedAt?: string | null;
  } = {}
): SelectedDeviceListResponseItem {
  return selectedDeviceListResponseItemSchema.parse({
    device_id: deviceId,
    client_label: label,
    permission,
    created_at: createdAt,
    last_used_at: lastUsedAt,
    expires_at: options.expiresAt === undefined ? expiresAt : options.expiresAt,
    revoked_at: options.revokedAt === undefined ? null : options.revokedAt
  });
}

function devices(start: number, count: number): SelectedDeviceListResponseItem[] {
  return Array.from({ length: count }, (_, index) => {
    const position = start + index;
    const id = `device_${String(position).padStart(3, "0")}`;
    return device(id, `Device label ${String(position)}`, position % 2 === 0 ? "read" : "write");
  });
}

function listResponse(
  items: readonly SelectedDeviceListResponseItem[],
  nextCursor: string | null = null
): BrowserHttpRouteResponse<"device_list"> {
  return {
    status: 200,
    data: {
      devices: [...items],
      next_cursor: nextCursor,
      has_more: nextCursor !== null
    }
  };
}

function revokeResponse(
  operationId: string,
  deviceId: string,
  selfRevoked: boolean
): BrowserHttpRouteResponse<"device_revoke"> {
  return {
    status: 200,
    data: selectedDeviceRevokeResponseSchema.parse({
      operation_id: operationId,
      device_id: deviceId,
      revoked_at: revokedAt,
      authority_invalidated: true,
      self_revoked: selfRevoked
    })
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
