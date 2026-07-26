// @vitest-environment jsdom

import {
  type SelectedAccessStateResponse,
  selectedAccessStateResponseSchema
} from "@hostdeck/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import {
  ConnectedHostLock,
  HostLockPanel,
  HostLockRouteRail
} from "./host-lock.js";
import { projectHostLockState } from "./host-lock-state.js";

const origin = "https://hostdeck-lock-ui.fixture-tailnet.ts.net";
const timestamp = "2026-07-26T14:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("host-lock UI", () => {
  it("confirms one exact lock, prevents busy dismissal, and exposes local-only recovery", async () => {
    const user = userEvent.setup();
    const response = deferred<void>();
    const harness = coordinatorHarness(snapshot(), async () => {
      harness.publish(snapshot({ causes: ["host_lock_pending"] }));
      await response.promise;
      harness.publish(snapshot({ locked: true }));
      return Object.freeze({
        status: 200,
        data: pairedAccess("write", true)
      });
    });
    const createOperationId = vi.fn(() => "op_browser_host_lock_ui_001");

    render(
      <ConnectedHostLock
        coordinator={harness.coordinator}
        createOperationId={createOperationId}
      >
        {(binding) => <HostLockPanel binding={binding} />}
      </ConnectedHostLock>
    );

    const originButton = screen.getByRole("button", { name: "Lock writes" });
    await user.click(originButton);
    const dialog = screen.getByRole("dialog", { name: "Lock remote writes?" });
    expect(within(dialog).getByText("This laptop")).toBeTruthy();
    expect(within(dialog).getByText("New remote session writes will be blocked.")).toBeTruthy();
    expect(within(dialog).getByText("Session reads and live updates remain available.")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Requests already sent and Codex work already running will not be stopped."
      )
    ).toBeTruthy();
    expect(within(dialog).getByText(/codexdeck unlock locally on the laptop/)).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Cancel" })
    );
    expect(createOperationId).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Lock writes" }));
    await waitFor(() => expect(harness.requestHostLock).toHaveBeenCalledTimes(1));
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(harness.requestHostLock).toHaveBeenCalledWith({
      body: { operation_id: "op_browser_host_lock_ui_001", confirmed: true }
    });
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Locking" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      within(dialog).getByRole("button", {
        name: "Close remote write lock confirmation"
      })
    ).toHaveProperty("disabled", true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Lock remote writes?" })).toBeTruthy();

    response.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Lock remote writes?" })).toBeNull()
    );
    expect(screen.getByRole("heading", { name: "Remote writes locked" })).toBeTruthy();
    expect(screen.getByText("codexdeck unlock")).toBeTruthy();
    expect(screen.getByText("Then refresh HostDeck to read the current lock state.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
    expect(harness.requestHostLock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(origin);
  });

  it("shows an unconfirmed alert until a later current access proof", async () => {
    const user = userEvent.setup();
    const harness = coordinatorHarness(snapshot(), async () => {
      harness.publish(snapshot({ causes: ["host_lock_pending"] }));
      await Promise.resolve();
      harness.publish(snapshot({ causes: ["host_lock_unconfirmed"] }));
      throw new Error("private host-lock transport detail");
    });

    render(
      <ConnectedHostLock
        coordinator={harness.coordinator}
        createOperationId={() => "op_browser_host_lock_ui_uncertain"}
      >
        {(binding) => <HostLockPanel binding={binding} />}
      </ConnectedHostLock>
    );

    await user.click(screen.getByRole("button", { name: "Lock writes" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Lock remote writes?" })).getByRole(
        "button",
        { name: "Lock writes" }
      )
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Then refresh HostDeck to read the current lock state."
    );
    expect(screen.getByText("Lock outcome unconfirmed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock writes" })).toBeNull();
    expect(document.body.textContent).not.toContain("private host-lock transport detail");

    harness.publish(snapshot({ epoch: 2 }));
    expect(
      (await screen.findByRole("button", { name: "Lock writes" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(screen.queryByText("codexdeck unlock")).toBeNull();
    expect(harness.requestHostLock).toHaveBeenCalledTimes(1);
  });

  it("keeps readers informed without exposing a lock or unlock command", () => {
    const harness = coordinatorHarness(
      snapshot({ permission: "read", causes: ["read_only_access"] }),
      vi.fn()
    );
    render(
      <ConnectedHostLock coordinator={harness.coordinator}>
        {(binding) => <HostLockPanel binding={binding} />}
      </ConnectedHostLock>
    );

    expect(
      screen.getByText("This phone has read-only access and cannot lock remote writes.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock writes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
    expect(harness.requestHostLock).not.toHaveBeenCalled();
  });

  it("uses status semantics for stable phases and alert semantics only for uncertainty", () => {
    const { rerender } = render(
      <HostLockRouteRail
        projection={projectHostLockState(snapshot({ causes: ["host_lock_pending"] }))}
      />
    );
    expect(screen.getByRole("status").textContent).toContain("Locking remote writes");
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <HostLockRouteRail
        projection={projectHostLockState(snapshot({ locked: true }))}
      />
    );
    expect(screen.getByRole("status").textContent).toContain("Remote writes locked");

    rerender(
      <HostLockRouteRail
        projection={projectHostLockState(
          snapshot({ causes: ["host_lock_unconfirmed"] })
        )}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("Lock outcome unconfirmed");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

function coordinatorHarness(
  initial: BrowserConnectionSnapshot,
  request: BrowserConnectionStateCoordinator["requestHostLock"]
): {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly requestHostLock: ReturnType<typeof vi.fn>;
  readonly publish: (next: BrowserConnectionSnapshot) => void;
} {
  let current = initial;
  const listeners = new Set<() => void>();
  const requestHostLock = vi.fn(request);
  const publish = (next: BrowserConnectionSnapshot): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const coordinator = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTarget: vi.fn(),
    refresh: vi.fn(),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock,
    requestSelectedSessionRead: vi.fn(),
    close: vi.fn()
  }) as unknown as BrowserConnectionStateCoordinator;
  return { coordinator, requestHostLock, publish };
}

function snapshot(
  options: Readonly<{
    epoch?: number;
    locked?: boolean;
    permission?: "read" | "write";
    causes?: readonly BrowserConnectionWriteBlockCause[];
  }> = {}
): BrowserConnectionSnapshot {
  const locked = options.locked ?? false;
  const permission = options.permission ?? "write";
  const causes = options.causes ??
    (locked
      ? ["host_locked" as const]
      : permission === "read"
        ? ["read_only_access" as const]
        : []);
  const access = pairedAccess(permission, locked);
  const resource = <Data,>(data: Data) =>
    Object.freeze({ state: "current" as const, data, failure: null, observedAt: timestamp });
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target: Object.freeze({ kind: "mission_control" as const }),
    phase: "ready" as const,
    access: resource(access),
    host: resource(null),
    targetState: resource(null) as BrowserConnectionSnapshot["targetState"],
    stream: Object.freeze({
      state: "not_applicable" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "ready" as const,
      generation: 2,
      rotatedAt: timestamp,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: causes.length === 0,
      causes: Object.freeze([...causes])
    }),
    lastFailure: null
  });
}

function pairedAccess(
  permission: "read" | "write",
  locked: boolean
): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_lock_ui_phone",
    permission,
    device_expires_at: "2026-10-26T14:00:00.000Z",
    configured_origin: origin,
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: true,
    can_write_sessions: permission === "write" && !locked,
    can_lock: permission === "write",
    can_unlock: false
  });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}
