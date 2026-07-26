// @vitest-environment jsdom

import {
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListResponseItem,
  selectedAccessStateResponseSchema,
  selectedDeviceListResponseItemSchema,
  selectedDeviceRevokeResponseSchema
} from "@hostdeck/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useEffect, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserConnectionSnapshot } from "./connection-state.js";
import type { BrowserHttpRouteResponse } from "./http-client.js";
import type { BrowserHttpRouteRequest } from "./http-route-contracts.js";
import { PairedDeviceManagementPanel } from "./paired-device-management.js";
import {
  createPairedDeviceManagementController,
  type PairedDeviceManagementController,
  type PairedDeviceManagementPort
} from "./paired-device-management-state.js";

const origin = "https://hostdeck-device-ui.fixture-tailnet.ts.net";
const currentDeviceId = "device_ui_current";
const createdAt = "2026-07-01T12:00:00.000Z";
const expiresAt = "2026-08-26T12:00:00.000Z";
const revokedAt = "2026-07-26T12:00:00.000Z";
const nowMs = Date.parse("2026-07-26T12:00:00.000Z");

afterEach(() => cleanup());

describe("paired-device management UI", () => {
  it("renders a flat private-free device rail with exact reader semantics", async () => {
    const harness = createUiHarness("read", [
      device(currentDeviceId, "Xiaomi 15 Pro", "read"),
      device("device_ui_other", "Office browser", "write")
    ]);
    render(<DeviceOwner controller={harness.controller} />);

    const region = await screen.findByRole("region", { name: "Paired devices" });
    expect(within(region).getByRole("list", { name: "Paired devices" })).toBeTruthy();
    expect(within(region).getByText("Xiaomi 15 Pro")).toBeTruthy();
    expect(within(region).getByText("Device 1 · This phone")).toBeTruthy();
    expect(within(region).getByText("Read-only access can inspect devices but cannot revoke them.")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: /Revoke/u })).toBeNull();
    expect(region.textContent).not.toContain(currentDeviceId);
    expect(region.querySelector("[data-device-id]")).toBeNull();
    expect(harness.port.revokeCalls).toHaveLength(0);
    harness.controller.close();
  });

  it("opens one exact confirmation, locks dismissal while busy, and restores focus", async () => {
    const user = userEvent.setup();
    const harness = createUiHarness("write", [
      device(currentDeviceId, "Current phone", "write"),
      device("device_ui_other", "Office browser", "read")
    ]);
    const pending = deferred<BrowserHttpRouteResponse<"device_revoke">>();
    harness.port.enqueueRevoke(() => pending.promise);
    render(<DeviceOwner controller={harness.controller} />);

    const revoke = await screen.findByRole("button", {
      name: "Revoke Office browser, Device 2"
    });
    await user.click(revoke);
    const dialog = screen.getByRole("dialog", { name: "Revoke paired device?" });
    expect(within(dialog).getByText("Office browser (Device 2)")).toBeTruthy();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);

    await user.click(within(dialog).getByRole("button", { name: "Revoke device" }));
    expect(harness.port.revokeCalls).toHaveLength(1);
    expect((within(dialog).getByRole("button", { name: "Revoking" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Close device revocation" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Revoke paired device?" })).toBeTruthy();

    await act(async () => {
      pending.resolve(revokeResponse("op_browser_device_ui_001", "device_ui_other", false));
      await pending.promise;
    });
    expect(await screen.findByText("Device revoked")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Revoke paired device?" })).toBeNull();
    expect(document.activeElement).toBe(revoke.closest(".hostdeck-device-row"));
    expect(harness.port.revokeCalls[0]?.input).toEqual({
      params: { device_id: "device_ui_other" },
      body: { operation_id: "op_browser_device_ui_001", confirmed: true }
    });
    harness.controller.close();
  });

  it("shows self and final-device consequences then removes authorized rows", async () => {
    const user = userEvent.setup();
    const harness = createUiHarness("write", [
      device(currentDeviceId, "Current phone", "write")
    ]);
    harness.port.enqueueRevoke(() => {
      harness.port.current = revokedSnapshot();
      return Promise.resolve(
        revokeResponse("op_browser_device_ui_001", currentDeviceId, true)
      );
    });
    render(<DeviceOwner controller={harness.controller} />);

    await user.click(await screen.findByRole("button", {
      name: "Revoke Current phone, Device 1"
    }));
    const dialog = screen.getByRole("dialog", { name: "Revoke this phone?" });
    expect(within(dialog).getByText("This phone")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "last active paired device"
    );
    await user.click(within(dialog).getByRole("button", { name: "Revoke this phone" }));

    expect(await screen.findByText("This phone was revoked")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Paired devices" });
    expect(within(region).queryByRole("list")).toBeNull();
    expect(region.textContent).not.toContain(currentDeviceId);
    expect(within(region).getByText(/new pairing link on the laptop/u)).toBeTruthy();
    harness.controller.close();
  });

  it("keeps expired targets actionable and explains page-security gating", async () => {
    const gated = createUiHarness(
      "write",
      [
        device(currentDeviceId, "Current phone", "write"),
        device("device_ui_expired", "Expired tablet", "read", "2026-07-20T12:00:00.000Z")
      ],
      false
    );
    render(<DeviceOwner controller={gated.controller} />);
    expect(await screen.findByText(
      "Secure this page before revoking a device.",
      { selector: ".hostdeck-devices__notice span" }
    )).toBeTruthy();
    expect((screen.getByRole("button", {
      name: "Revoke Expired tablet, Device 2"
    }) as HTMLButtonElement).disabled).toBe(true);
    gated.controller.close();

    cleanup();
    const active = createUiHarness("write", [
      device(currentDeviceId, "Current phone", "write"),
      device("device_ui_expired", "Expired tablet", "read", "2026-07-20T12:00:00.000Z")
    ]);
    render(<DeviceOwner controller={active.controller} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", {
      name: "Revoke Expired tablet, Device 2"
    }));
    expect(screen.getByRole("dialog").textContent).toContain("already expired");
    active.controller.close();
  });

  it("exposes stable page controls without retaining the prior page", async () => {
    const user = userEvent.setup();
    const first = Array.from({ length: 20 }, (_, index) => {
      const number = index + 1;
      return device(
        `device_ui_${String(number).padStart(3, "0")}`,
        `Phone ${String(number)}`,
        number % 2 === 0 ? "read" : "write"
      );
    });
    const second = [device("device_ui_021", "Phone 21", "read")];
    const harness = createUiHarness("write", first, true, true);
    harness.port.enqueueList(listResponse(second));
    render(<DeviceOwner controller={harness.controller} />);

    const next = await screen.findByRole("button", { name: "Next" });
    expect(screen.getByText("Page 1").getAttribute("aria-current")).toBe("page");
    await user.click(next);
    expect(await screen.findByText("Phone 21")).toBeTruthy();
    expect(screen.queryByText("Phone 1")).toBeNull();
    expect(screen.getByText("Page 2").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Start over" })).toBeTruthy();
    harness.controller.close();
  });
});

function DeviceOwner({ controller }: Readonly<{ controller: PairedDeviceManagementController }>) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  useEffect(() => {
    void controller.ensureLoaded();
  }, [controller]);
  return <PairedDeviceManagementPanel controller={controller} view={view} />;
}

class UiPort {
  current: BrowserConnectionSnapshot;
  readonly listCalls: Array<{ readonly input: BrowserHttpRouteRequest<"device_list"> }> = [];
  readonly revokeCalls: Array<{ readonly input: BrowserHttpRouteRequest<"device_revoke"> }> = [];
  private readonly listHandlers: Array<() => Promise<BrowserHttpRouteResponse<"device_list">>> = [];
  private readonly revokeHandlers: Array<() => Promise<BrowserHttpRouteResponse<"device_revoke">>> = [];
  readonly adapter: PairedDeviceManagementPort;

  constructor(snapshot: BrowserConnectionSnapshot) {
    this.current = snapshot;
    this.adapter = Object.freeze({
      snapshot: () => this.current,
      list: (input: BrowserHttpRouteRequest<"device_list">) => {
        this.listCalls.push({ input });
        const handler = this.listHandlers.shift();
        return handler === undefined
          ? Promise.reject(new Error("Missing device-list response."))
          : handler();
      },
      revoke: (input: BrowserHttpRouteRequest<"device_revoke">) => {
        this.revokeCalls.push({ input });
        const handler = this.revokeHandlers.shift();
        return handler === undefined
          ? Promise.reject(new Error("Missing device-revoke response."))
          : handler();
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
    response: () => Promise<BrowserHttpRouteResponse<"device_revoke">>
  ): void {
    this.revokeHandlers.push(response);
  }
}

function createUiHarness(
  permission: "read" | "write",
  items: readonly SelectedDeviceListResponseItem[],
  csrfReady = true,
  hasMore = false
): {
  readonly controller: PairedDeviceManagementController;
  readonly port: UiPort;
} {
  const port = new UiPort(pairedSnapshot(permission, csrfReady));
  port.enqueueList(
    listResponse(
      items,
      hasMore
        ? encodeSelectedDeviceListCursor(items.at(-1)?.device_id ?? "missing")
        : null
    )
  );
  const controller = createPairedDeviceManagementController({
    port: port.adapter,
    createOperationId: () => "op_browser_device_ui_001",
    clock: Object.freeze({ now: () => nowMs })
  });
  return { controller, port };
}

function pairedSnapshot(
  permission: "read" | "write",
  csrfReady: boolean
): BrowserConnectionSnapshot {
  return snapshot({
    accessState: "current",
    accessData: selectedAccessStateResponseSchema.parse({
      authentication_state: "paired_device",
      device_id: currentDeviceId,
      permission,
      device_expires_at: expiresAt,
      configured_origin: origin,
      network_mode: "remote",
      transport: "https",
      locked: false,
      can_read_sessions: true,
      can_write_sessions: permission === "write",
      can_lock: permission === "write",
      can_unlock: false
    }),
    csrfPhase: csrfReady && permission === "write" ? "ready" : "idle",
    csrfInvalidationReason: csrfReady && permission === "write" ? null : "not_bootstrapped",
    hostData: Object.freeze({ ready: true }),
    targetData: Object.freeze({ ready: true })
  });
}

function revokedSnapshot(): BrowserConnectionSnapshot {
  return snapshot({
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

function snapshot(input: {
  readonly accessState: "current";
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
      data: input.accessData,
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
  label: string,
  permission: "read" | "write",
  expiry: string | null = expiresAt
): SelectedDeviceListResponseItem {
  return selectedDeviceListResponseItemSchema.parse({
    device_id: deviceId,
    client_label: label,
    permission,
    created_at: createdAt,
    last_used_at: createdAt,
    expires_at: expiry,
    revoked_at: null
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
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
