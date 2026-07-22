import { describe, expect, it, vi } from "vitest";
import {
  type BrowserAppStartupController,
  createBrowserAppStartupController
} from "./app-startup.js";
import type { BrowserConnectionStateCoordinator } from "./connection-state.js";
import type { BrowserPairingBootstrapResult } from "./pairing-bootstrap.js";

const deviceId = "client_abcdefghijklmnopqrstuvwx";
const csrfToken = "C".repeat(43);
const pairedResult = Object.freeze({
  state: "paired",
  device_id: deviceId,
  permission: "write",
  client_label: "Android phone",
  device_expires_at: "2026-10-20T12:00:00.000Z",
  csrf_token: csrfToken,
  csrf_generation: 3,
  csrf_rotated_at: "2026-07-22T12:00:00.000Z"
} as const satisfies BrowserPairingBootstrapResult);

describe("browser app startup controller", () => {
  it("opens a no-fragment page with exactly one inert production coordinator", async () => {
    const harness = createHarness(Object.freeze({ state: "no_fragment" }));

    expect(harness.startup.snapshot()).toEqual({ phase: "checking", pairing: null });
    expect(harness.createCoordinator).not.toHaveBeenCalled();

    await settle();

    expect(harness.startup.snapshot()).toEqual({ phase: "ready", pairing: null });
    expect(harness.createCoordinator).toHaveBeenCalledTimes(1);
    expect(harness.startup.coordinator()).toBe(harness.coordinator);
    expect(harness.adopt).not.toHaveBeenCalled();
  });

  it("publishes claiming while pending, adopts CSRF before explicit continuation, and sanitizes state", async () => {
    const deferred = createDeferred<BrowserPairingBootstrapResult>();
    const harness = createHarness(deferred.promise);
    const phases: string[] = [];
    harness.startup.subscribe(() => phases.push(harness.startup.snapshot().phase));

    await settle();
    expect(harness.startup.snapshot().phase).toBe("claiming");
    expect(harness.createCoordinator).not.toHaveBeenCalled();

    deferred.resolve(pairedResult);
    await settle();

    expect(harness.createCoordinator).toHaveBeenCalledTimes(1);
    expect(harness.adopt).toHaveBeenCalledTimes(1);
    expect(harness.adopt).toHaveBeenCalledWith({
      csrf_token: csrfToken,
      csrf_generation: 3,
      rotated_at: "2026-07-22T12:00:00.000Z"
    });
    expect(harness.startup.coordinator()).toBeNull();
    expect(harness.startup.snapshot()).toEqual({
      phase: "paired",
      pairing: {
        permission: "write",
        clientLabel: "Android phone",
        deviceExpiresAt: "2026-10-20T12:00:00.000Z"
      }
    });
    expect(JSON.stringify(harness.startup.snapshot())).not.toContain(deviceId);
    expect(JSON.stringify(harness.startup.snapshot())).not.toContain(csrfToken);
    expect(Object.isFrozen(harness.startup.snapshot())).toBe(true);
    expect(Object.isFrozen(harness.startup.snapshot().pairing)).toBe(true);

    const ready = harness.startup.continueToApp();

    expect(ready.phase).toBe("ready");
    expect(harness.startup.coordinator()).toBe(harness.coordinator);
    expect(phases).toEqual(["claiming", "paired", "ready"]);
    expect(() => harness.startup.continueToApp()).toThrow(TypeError);
  });

  it("maps every bounded failure without constructing a coordinator", async () => {
    const cases: ReadonlyArray<{
      readonly result: BrowserPairingBootstrapResult;
      readonly phase: string;
    }> = [
      {
        result: Object.freeze({ state: "entry_rejected", reason: "invalid_fragment" }),
        phase: "invalid_link"
      },
      {
        result: Object.freeze({ state: "entry_rejected", reason: "history_unavailable" }),
        phase: "secure_entry_failed"
      },
      {
        result: Object.freeze({ state: "claim_rejected", reason: "not_accepted" }),
        phase: "link_not_accepted"
      },
      {
        result: Object.freeze({ state: "claim_rejected", reason: "origin_rejected" }),
        phase: "origin_rejected"
      },
      { result: Object.freeze({ state: "claim_rate_limited" }), phase: "rate_limited" },
      { result: Object.freeze({ state: "claim_unavailable" }), phase: "claim_unavailable" },
      { result: Object.freeze({ state: "claim_unknown" }), phase: "claim_unknown" }
    ];
    for (const scenario of cases) {
      const harness = createHarness(scenario.result);

      await settle();

      expect(harness.startup.snapshot()).toEqual({
        phase: scenario.phase,
        pairing: null
      });
      expect(harness.createCoordinator).not.toHaveBeenCalled();
      expect(harness.startup.coordinator()).toBeNull();
    }
  });

  it("keeps a committed pairing truthful when CSRF setup fails and reloads only once", async () => {
    const reload = vi.fn();
    const harness = createHarness(
      Object.freeze({
        state: "paired_csrf_unavailable",
        reason: "bootstrap_unknown",
        device_id: deviceId,
        permission: "read",
        client_label: null,
        device_expires_at: "2026-10-20T12:00:00.000Z"
      }),
      reload
    );

    await settle();

    expect(harness.startup.snapshot()).toEqual({
      phase: "paired_csrf_unavailable",
      pairing: {
        permission: "read",
        clientLabel: null,
        deviceExpiresAt: "2026-10-20T12:00:00.000Z"
      }
    });
    expect(harness.createCoordinator).not.toHaveBeenCalled();

    expect(harness.startup.reload().phase).toBe("reloading");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(() => harness.startup.reload()).toThrow(TypeError);
  });

  it("fails closed for malformed ports, results, coordinators, and adoption", async () => {
    for (const input of [null, {}, { bootstrapPairing: vi.fn(), createCoordinator: vi.fn() }]) {
      expect(() => createBrowserAppStartupController(input as never)).toThrow(TypeError);
    }

    const malformed = createHarness(Promise.resolve({ state: "paired", csrf_token: csrfToken } as never));
    await settle();
    expect(malformed.startup.snapshot().phase).toBe("startup_failed");

    const invalidCoordinator = createBrowserAppStartupController({
      bootstrapPairing: async () => Object.freeze({ state: "no_fragment" }),
      createCoordinator: () => ({}) as never,
      reload: vi.fn()
    });
    await settle();
    expect(invalidCoordinator.snapshot().phase).toBe("startup_failed");

    const harness = createHarness(pairedResult);
    harness.adopt.mockImplementation(() => {
      throw new Error(csrfToken);
    });
    await settle();
    expect(harness.startup.snapshot()).toEqual({
      phase: "startup_failed",
      pairing: null
    });
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.startup.snapshot())).not.toContain(csrfToken);
  });

  it("closes once, ignores late pairing settlement, and bounds subscriptions", async () => {
    const deferred = createDeferred<BrowserPairingBootstrapResult>();
    const harness = createHarness(deferred.promise);
    const listener = vi.fn();
    const unsubscribe = harness.startup.subscribe(listener);

    expect(harness.startup.close().phase).toBe("closed");
    expect(harness.startup.close().phase).toBe("closed");
    expect(harness.close).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    expect(() => harness.startup.subscribe(vi.fn())).toThrow(TypeError);

    deferred.resolve(pairedResult);
    await settle();

    expect(harness.createCoordinator).not.toHaveBeenCalled();
    expect(harness.startup.snapshot()).toEqual({ phase: "closed", pairing: null });
  });

  it("closes an adopted coordinator exactly once", async () => {
    const harness = createHarness(pairedResult);
    await settle();
    harness.startup.continueToApp();

    harness.startup.close();
    harness.startup.close();

    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.startup.coordinator()).toBeNull();
  });
});

function createHarness(
  result: BrowserPairingBootstrapResult | Promise<BrowserPairingBootstrapResult>,
  reload = vi.fn()
): {
  readonly startup: BrowserAppStartupController;
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly createCoordinator: ReturnType<typeof vi.fn>;
  readonly adopt: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const adopt = vi.fn();
  const close = vi.fn();
  const coordinator = coordinatorPort(adopt, close);
  const createCoordinator = vi.fn(() => coordinator);
  const startup = createBrowserAppStartupController({
    bootstrapPairing: () => Promise.resolve(result),
    createCoordinator,
    reload
  });
  return { startup, coordinator, createCoordinator, adopt, close };
}

function coordinatorPort(
  adoptCsrfBootstrap: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>
): BrowserConnectionStateCoordinator {
  return Object.freeze({
    snapshot: vi.fn(),
    subscribe: vi.fn(),
    setTarget: vi.fn(),
    refresh: vi.fn(),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap,
    requestProtected: vi.fn(),
    close
  }) as never;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
