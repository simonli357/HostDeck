import {
  type SelectedAccessStateResponse,
  selectedAccessStateResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it, vi } from "vitest";
import type { BrowserConnectionSnapshot } from "./connection-state.js";
import { HostDeckBrowserConnectionError } from "./connection-state.js";
import {
  createHostLockController,
  type HostLockControllerView,
  type HostLockPort,
  projectHostLockState
} from "./host-lock-state.js";
import type { BrowserHttpRouteResponse } from "./http-client.js";

const origin = "https://hostdeck-lock.fixture-tailnet.ts.net";
const timestamp = "2026-07-26T13:00:00.000Z";

describe("host-lock state", () => {
  it("projects only exact current, last-known, pending, and unconfirmed truth", () => {
    expect(projectHostLockState(snapshot())).toEqual({
      phase: "none",
      visible: false,
      current: false,
      tone: "muted",
      title: null,
      reason: null,
      source: null,
      recoveryCommand: null
    });
    expect(
      projectHostLockState(snapshot({ causes: ["host_lock_pending"] }))
    ).toMatchObject({
      phase: "pending",
      current: false,
      title: "Locking remote writes",
      source: "This phone's explicit lock request",
      recoveryCommand: null
    });
    expect(
      projectHostLockState(snapshot({ causes: ["host_lock_unconfirmed"] }))
    ).toMatchObject({
      phase: "unconfirmed",
      tone: "danger",
      source: "The last lock attempt from this phone",
      recoveryCommand: "codexdeck unlock"
    });
    expect(projectHostLockState(snapshot({ locked: true }))).toMatchObject({
      phase: "locked",
      current: true,
      title: "Remote writes locked",
      source: "Current HostDeck access state from the laptop"
    });
    expect(
      projectHostLockState(snapshot({ accessState: "stale", locked: true }))
    ).toMatchObject({
      phase: "locked",
      current: false,
      tone: "attention",
      title: "Remote writes last known locked",
      source: "Last known HostDeck access state from the laptop"
    });
    expect(() =>
      projectHostLockState(
        snapshot({ causes: ["host_lock_pending", "host_lock_unconfirmed"] })
      )
    ).toThrow(expect.objectContaining({ reason: "client_contract" }));
  });

  it("creates one operation only after confirmation and adopts correlated lock truth", async () => {
    let current = snapshot();
    const response = deferred<void>();
    const request = vi.fn(async (input) => {
      await response.promise;
      current = snapshot({ locked: true });
      return lockResponse(input.body.operation_id);
    });
    const createOperationId = vi.fn(() => "op_browser_host_lock_exact_001");
    const controller = createHostLockController({
      port: port(() => current, request),
      createOperationId
    });

    expect(controller.snapshot()).toMatchObject({
      phase: "unlocked",
      lockVisible: true,
      lockEnabled: true
    });
    expect(controller.begin()).toMatchObject({
      phase: "confirming",
      confirmation: {
        target: "This laptop",
        consequence: "New remote session writes will be blocked.",
        continuity: "Session reads and live updates remain available.",
        nonCancellation: "Requests already sent and Codex work already running will not be stopped.",
        recovery: "Unlock requires running codexdeck unlock locally on the laptop.",
        busy: false,
        cancelEnabled: true,
        confirmEnabled: true
      }
    });
    expect(createOperationId).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const pending = controller.confirm();
    expect(controller.confirm()).toBe(pending);
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      body: {
        operation_id: "op_browser_host_lock_exact_001",
        confirmed: true
      }
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "dispatching",
      busy: true,
      lockEnabled: false,
      confirmation: {
        busy: true,
        cancelEnabled: false,
        confirmEnabled: false
      }
    });
    expect(() => controller.cancel()).toThrow(
      expect.objectContaining({ reason: "not_ready" })
    );

    current = snapshot({ causes: ["host_lock_pending"] });
    controller.synchronize();
    response.resolve();
    await expect(pending).resolves.toMatchObject({
      phase: "locked",
      recoveryCommand: "codexdeck unlock",
      confirmation: null
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "locked",
      source: "Current HostDeck access state from the laptop"
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain(
      "op_browser_host_lock_exact_001"
    );
    expect(JSON.stringify(controller.snapshot())).not.toContain("device_lock_phone");
    expect(JSON.stringify(controller.snapshot())).not.toContain(origin);
    controller.close();
  });

  it("invalidates confirmation before dispatch when the authority epoch changes", async () => {
    let current = snapshot();
    const request = vi.fn();
    const controller = createHostLockController({
      port: port(() => current, request),
      createOperationId: () => {
        current = snapshot({ epoch: 2 });
        return "op_browser_host_lock_stale_selection";
      }
    });

    controller.begin();
    await expect(controller.confirm()).rejects.toMatchObject({ reason: "not_ready" });
    expect(request).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe("unlocked");
    controller.close();
  });

  it("keeps operation-id failures local and retryable without dispatch", async () => {
    let current = snapshot();
    const request = vi.fn();
    let attempt = 0;
    const controller = createHostLockController({
      port: port(() => current, request),
      createOperationId: () => {
        attempt += 1;
        return attempt === 1 ? "invalid" : "op_browser_host_lock_retry_001";
      }
    });

    controller.begin();
    await expect(controller.confirm()).resolves.toMatchObject({
      phase: "failure",
      title: "Lock request not sent",
      lockEnabled: true
    });
    expect(request).not.toHaveBeenCalled();

    controller.begin();
    request.mockImplementation(async (input) => {
      current = snapshot({ locked: true });
      return lockResponse(input.body.operation_id);
    });
    await expect(controller.confirm()).resolves.toMatchObject({ phase: "locked" });
    expect(request).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it("persists an unconfirmed dispatched outcome until a later current access proof", async () => {
    let current = snapshot();
    const request = vi.fn(async () => {
      current = snapshot({ causes: ["host_lock_unconfirmed"] });
      throw new Error("private transport failure");
    });
    const controller = createHostLockController({
      port: port(() => current, request),
      createOperationId: () => "op_browser_host_lock_uncertain_001"
    });

    controller.begin();
    await expect(controller.confirm()).resolves.toMatchObject({
      phase: "unconfirmed",
      urgent: true,
      recoveryCommand: "codexdeck unlock"
    });
    expect(() => controller.begin()).toThrow(
      expect.objectContaining({ reason: "not_ready" })
    );
    expect(request).toHaveBeenCalledTimes(1);

    current = snapshot({
      epoch: 2,
      causes: ["host_lock_unconfirmed"],
      accessState: "stale"
    });
    expect(controller.synchronize().phase).toBe("unconfirmed");
    current = snapshot({ epoch: 3, locked: false });
    expect(controller.synchronize()).toMatchObject({
      phase: "unlocked",
      lockEnabled: true,
      recoveryCommand: null
    });
    controller.close();
  });

  it("suppresses changed-authority and closed owners without publishing late settlement", async () => {
    for (const close of [false, true]) {
      let current = snapshot();
      const response = deferred<BrowserHttpRouteResponse<"host_lock">>();
      const request = vi.fn(async () => await response.promise);
      const controller = createHostLockController({
        port: port(() => current, request),
        createOperationId: () => `op_browser_host_lock_suppressed_${close ? "close" : "authority"}`
      });
      const listener = vi.fn();
      controller.subscribe(listener);
      controller.begin();
      const pending = controller.confirm();

      let terminal: HostLockControllerView;
      if (close) {
        terminal = controller.close();
      } else {
        current = snapshot({ epoch: 2, deviceId: "device_lock_replacement" });
        terminal = controller.synchronize();
      }
      await expect(pending).resolves.toBe(terminal);
      const callsBeforeLateResponse = listener.mock.calls.length;
      response.resolve(lockResponse(`op_browser_host_lock_suppressed_${close ? "close" : "authority"}`));
      await settle();
      expect(controller.snapshot()).toBe(terminal);
      expect(listener).toHaveBeenCalledTimes(callsBeforeLateResponse);
      if (!close) controller.close();
    }
  });

  it("fails closed for malformed options, ports, snapshots, and pre-dispatch rejection", async () => {
    for (const input of [null, {}, { port: {}, createOperationId: vi.fn() }]) {
      expect(() => createHostLockController(input as never)).toThrow(TypeError);
    }
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "port", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return port(() => snapshot(), vi.fn());
      }
    });
    expect(() => createHostLockController(hostile as never)).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    expect(() =>
      createHostLockController({
        port: port(() => ({}) as never, vi.fn()),
        createOperationId: () => "op_browser_host_lock_malformed"
      })
    ).toThrow(expect.objectContaining({ reason: "client_contract" }));

    const current = snapshot();
    const request = vi.fn(async () => {
      throw new HostDeckBrowserConnectionError("not_ready");
    });
    const controller = createHostLockController({
      port: port(() => current, request),
      createOperationId: () => "op_browser_host_lock_rejected_001"
    });
    controller.begin();
    await expect(controller.confirm()).resolves.toMatchObject({
      phase: "failure",
      title: "Lock request not sent"
    });
    expect(request).toHaveBeenCalledTimes(1);
    controller.close();
    expect(() => controller.subscribe(vi.fn())).toThrow(
      expect.objectContaining({ reason: "closed" })
    );

    const synchronousRequest = vi.fn(() => {
      throw new Error("private synchronous admission failure");
    });
    const synchronous = createHostLockController({
      port: port(() => current, synchronousRequest),
      createOperationId: () => "op_browser_host_lock_sync_rejected"
    });
    synchronous.begin();
    await expect(synchronous.confirm()).resolves.toMatchObject({
      phase: "failure",
      title: "Lock request not sent",
      recoveryCommand: null
    });
    expect(synchronousRequest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(synchronous.snapshot())).not.toContain("private synchronous");
    synchronous.close();
  });
});

function port(
  read: () => BrowserConnectionSnapshot,
  request: HostLockPort["request"]
): HostLockPort {
  return Object.freeze({ snapshot: read, request });
}

function snapshot(
  options: Readonly<{
    epoch?: number;
    accessState?: "current" | "stale";
    locked?: boolean;
    permission?: "read" | "write";
    deviceId?: string;
    causes?: readonly (
      | "connection_not_current"
      | "read_only_access"
      | "host_lock_pending"
      | "host_lock_unconfirmed"
      | "host_locked"
    )[];
  }> = {}
): BrowserConnectionSnapshot {
  const accessState = options.accessState ?? "current";
  const permission = options.permission ?? "write";
  const locked = options.locked ?? false;
  const causes = options.causes ??
    (permission === "read"
      ? ["read_only_access" as const]
      : locked
        ? ["host_locked" as const]
        : []);
  const access = pairedAccess(
    permission,
    locked,
    options.deviceId ?? "device_lock_phone"
  );
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target: Object.freeze({ kind: "mission_control" as const }),
    phase: "ready",
    access: Object.freeze({
      state: accessState,
      data: access,
      failure: null,
      observedAt: timestamp
    }),
    host: Object.freeze({ state: "current", data: null, failure: null, observedAt: timestamp }),
    targetState: Object.freeze({
      state: "current",
      data: null,
      failure: null,
      observedAt: timestamp
    }),
    stream: Object.freeze({
      state: "not_applicable",
      snapshot: null,
      continuity: "not_applicable",
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "ready",
      generation: 3,
      rotatedAt: timestamp,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell",
      eligible: causes.length === 0,
      causes: Object.freeze([...causes])
    }),
    lastFailure: null
  }) as BrowserConnectionSnapshot;
}

function pairedAccess(
  permission: "read" | "write",
  locked: boolean,
  deviceId: string
): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: deviceId,
    permission,
    device_expires_at: "2026-10-26T13:00:00.000Z",
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

function lockResponse(operationId: string): BrowserHttpRouteResponse<"host_lock"> {
  void operationId;
  return Object.freeze({ status: 200, data: pairedAccess("write", true, "device_lock_phone") });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settlePromise) => {
    resolve = settlePromise;
  });
  return Object.freeze({ promise, resolve });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
