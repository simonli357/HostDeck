import type {
  SelectedAccessStateResponse,
  SelectedHostStatusResponse
} from "@hostdeck/contracts";
import {
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionTarget
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import {
  createHostAccessRecoveryController,
  type HostAccessRecoveryPort,
  hostAccessRecoveryPhases,
  projectHostAccessRecovery
} from "./host-access-recovery-state.js";

const timestamp = "2026-07-26T05:00:00.000Z";
const remoteOrigin = "https://hostdeck-recovery.fixture-tailnet.ts.net";
const privateDeviceId = "device_recovery_private";
const privateSessionId = "sess_recovery_private";
const rawToken = "C".repeat(43);

describe("host-access recovery state", () => {
  it("starts from an immutable, bounded, secret-free current page projection", () => {
    const harness = createHarness(snapshot());
    const controller = createHostAccessRecoveryController({ port: harness.port });
    const view = controller.snapshot();

    expect(view).toEqual({
      phase: "ready",
      tone: "connected",
      pageSecurity: "Ready",
      pageSecurityDetail: "Protection is held for this page.",
      status: "Page security ready",
      detail: "Secure write protection is ready for this page.",
      action: null,
      actionLabel: null,
      actionEnabled: false,
      busy: false,
      urgent: false
    });
    expect(Object.isFrozen(view)).toBe(true);
    const serialized = JSON.stringify(view);
    for (const secret of [rawToken, privateDeviceId, privateSessionId, remoteOrigin]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/csrf|generation|operation|cookie|token|session_id/iu);
    controller.close();
  });

  it("projects every frozen page-authority state without collapsing failures into securing", () => {
    const cases = [
      [snapshot({ access: null, accessState: "loading", hostState: "loading", targetState: "loading", phase: "loading" }), "checking", "Checking", null],
      [snapshot({ csrfPhase: "idle", invalidationReason: "not_bootstrapped" }), "automatic_bootstrap", "Securing", null],
      [snapshot({ csrfPhase: "bootstrapping" }), "automatic_bootstrap", "Securing", null],
      [snapshot(), "ready", "Ready", null],
      [snapshot({ csrfPhase: "idle", invalidationReason: "pairing_replaced" }), "setup_required", "Check required", "secure_page"],
      [snapshot({ csrfPhase: "failed" }), "bootstrap_failed", "Check required", "retry_setup"],
      [snapshot({ accessState: "stale", hostState: "stale", targetState: "stale", csrfPhase: "failed" }), "stale", "Check required", "check_access"],
      [snapshot({ permission: "read", csrfPhase: "idle", invalidationReason: "access_lost" }), "read_only", "Unavailable", null],
      [snapshot({ authenticationState: "revoked_device", csrfPhase: "idle", invalidationReason: "device_revoked" }), "pairing_required", "Unavailable", null],
      [snapshot({ access: null, accessState: "failed", hostState: "blocked", targetState: "blocked", phase: "unreachable" }), "unavailable", "Unavailable", null],
      [snapshot({ phase: "closed", csrfPhase: "closed" }), "closed", "Unavailable", null]
    ] as const;

    for (const [input, phase, pageSecurity, action] of cases) {
      const view = projectHostAccessRecovery(input);
      expect(view.phase).toBe(phase);
      expect(view.pageSecurity).toBe(pageSecurity);
      expect(view.action).toBe(action);
      expect(view.status).not.toBe("");
      expect(view.detail).not.toBe("");
    }
    expect(new Set(cases.map((entry) => entry[1])).size).toBe(10);
    expect(hostAccessRecoveryPhases).toContain("refresh_failed");
    expect(hostAccessRecoveryPhases).toContain("recovered");
  });

  it("runs one direct bootstrap for a current writer and deduplicates concurrent actions", async () => {
    const bootstrap = deferred<BrowserConnectionSnapshot>();
    const harness = createHarness(
      snapshot({ csrfPhase: "idle", invalidationReason: "pairing_replaced" }),
      {
        bootstrap() {
          harness.current = snapshot({
            epoch: harness.current.epoch,
            csrfPhase: "bootstrapping"
          });
          return bootstrap.promise;
        }
      }
    );
    const controller = createHostAccessRecoveryController({ port: harness.port });

    const first = controller.recover();
    const duplicate = controller.recover();
    expect(duplicate).toBe(first);
    expect(controller.snapshot()).toMatchObject({
      phase: "securing_page",
      action: "secure_page",
      actionEnabled: false,
      busy: true
    });
    await nextMicrotask();
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1);

    harness.current = snapshot({ epoch: 1, csrfPhase: "ready" });
    bootstrap.resolve(harness.current);
    await expect(first).resolves.toMatchObject({
      phase: "recovered",
      pageSecurity: "Ready",
      action: null,
      busy: false
    });
    expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it("suppresses refresh and bootstrap before dispatch after close or target replacement", async () => {
    const directHarness = createHarness(snapshot({ csrfPhase: "failed" }));
    const directController = createHostAccessRecoveryController({ port: directHarness.port });
    const directRecovery = directController.recover();
    const closed = directController.close();

    await expect(directRecovery).resolves.toBe(closed);
    await nextMicrotask();
    expect(directHarness.bootstrapCsrf).not.toHaveBeenCalled();

    const staleHarness = createHarness(snapshot({
      accessState: "stale",
      hostState: "stale",
      targetState: "stale",
      csrfPhase: "failed"
    }));
    const staleController = createHostAccessRecoveryController({ port: staleHarness.port });
    const staleRecovery = staleController.recover();
    staleHarness.current = snapshot({
      epoch: 2,
      target: detailTarget(),
      csrfPhase: "ready"
    });

    await nextMicrotask();
    await expect(staleRecovery).resolves.toMatchObject({ phase: "ready" });
    expect(staleHarness.refresh).not.toHaveBeenCalled();
    expect(staleHarness.bootstrapCsrf).not.toHaveBeenCalled();
    staleController.close();
  });

  it("refreshes stale authority before one bootstrap and never replays a product mutation", async () => {
    const refresh = deferred<BrowserConnectionSnapshot>();
    const bootstrap = deferred<BrowserConnectionSnapshot>();
    const harness = createHarness(
      snapshot({
        accessState: "stale",
        hostState: "stale",
        targetState: "stale",
        csrfPhase: "failed"
      }),
      {
        refresh() {
          harness.current = snapshot({
            epoch: 2,
            accessState: "loading",
            hostState: "loading",
            targetState: "loading",
            csrfPhase: "failed"
          });
          return refresh.promise;
        },
        bootstrap() {
          harness.current = snapshot({ epoch: 2, csrfPhase: "bootstrapping" });
          return bootstrap.promise;
        }
      }
    );
    const controller = createHostAccessRecoveryController({ port: harness.port });

    const recovery = controller.recover();
    await nextMicrotask();
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.bootstrapCsrf).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      phase: "checking_access",
      action: "check_access",
      busy: true
    });

    harness.current = snapshot({
      epoch: 2,
      csrfPhase: "idle",
      invalidationReason: "access_lost"
    });
    refresh.resolve(harness.current);
    await waitForCall(harness.bootstrapCsrf);
    expect(controller.snapshot()).toMatchObject({
      phase: "securing_page",
      action: "check_access",
      busy: true
    });

    harness.current = snapshot({ epoch: 2, csrfPhase: "ready" });
    bootstrap.resolve(harness.current);
    await expect(recovery).resolves.toMatchObject({ phase: "recovered" });
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1);
    expect(Object.keys(harness.port).sort()).toEqual([
      "bootstrapCsrf",
      "refresh",
      "snapshot"
    ]);
    controller.close();
  });

  it("accepts refresh-owned ready authority without issuing a second bootstrap", async () => {
    const refresh = deferred<BrowserConnectionSnapshot>();
    const harness = createHarness(
      snapshot({
        accessState: "stale",
        hostState: "stale",
        targetState: "stale",
        csrfPhase: "failed"
      }),
      {
        refresh() {
          harness.current = snapshot({
            epoch: 2,
            accessState: "loading",
            hostState: "loading",
            targetState: "loading",
            csrfPhase: "failed"
          });
          return refresh.promise;
        }
      }
    );
    const controller = createHostAccessRecoveryController({ port: harness.port });
    const recovery = controller.recover();
    await nextMicrotask();

    harness.current = snapshot({ epoch: 2, csrfPhase: "ready" });
    refresh.resolve(harness.current);

    await expect(recovery).resolves.toMatchObject({ phase: "recovered" });
    expect(harness.bootstrapCsrf).not.toHaveBeenCalled();
    controller.close();
  });

  it("suppresses follow-up and stale success after target, epoch, or authority replacement", async () => {
    for (const replacement of ["target", "epoch", "permission"] as const) {
      const refresh = deferred<BrowserConnectionSnapshot>();
      const harness = createHarness(
        snapshot({
          accessState: "stale",
          hostState: "stale",
          targetState: "stale",
          csrfPhase: "failed"
        }),
        {
          refresh() {
            harness.current = snapshot({
              epoch: 2,
              accessState: "loading",
              hostState: "loading",
              targetState: "loading",
              csrfPhase: "failed"
            });
            return refresh.promise;
          }
        }
      );
      const controller = createHostAccessRecoveryController({ port: harness.port });
      const recovery = controller.recover();
      await nextMicrotask();

      harness.current = replacement === "target"
        ? snapshot({ epoch: 3, target: detailTarget(), csrfPhase: "ready" })
        : replacement === "epoch"
          ? snapshot({ epoch: 3, csrfPhase: "ready" })
          : snapshot({ epoch: 2, permission: "read", csrfPhase: "idle", invalidationReason: "access_lost" });
      controller.synchronize();
      refresh.resolve(harness.current);

      const result = await recovery;
      expect(result.phase, replacement).not.toBe("recovered");
      expect(harness.bootstrapCsrf, replacement).not.toHaveBeenCalled();
      controller.close();
    }
  });

  it("settles a replaced owner and observes its suppressed port rejection", async () => {
    const bootstrap = deferred<BrowserConnectionSnapshot>();
    const harness = createHarness(
      snapshot({ csrfPhase: "failed" }),
      {
        bootstrap() {
          harness.current = snapshot({
            epoch: 2,
            target: detailTarget(),
            csrfPhase: "ready"
          });
          return bootstrap.promise;
        }
      }
    );
    const controller = createHostAccessRecoveryController({ port: harness.port });

    await expect(controller.recover()).resolves.toMatchObject({ phase: "ready" });
    expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1);
    bootstrap.reject(new Error("late replaced-owner rejection"));
    await nextMicrotask();
    expect(controller.snapshot()).toMatchObject({ phase: "ready" });
    controller.close();
  });

  it("maps refresh and bootstrap failures to bounded explicit retry states", async () => {
    const refreshHarness = createHarness(
      snapshot({
        accessState: "stale",
        hostState: "stale",
        targetState: "stale",
        csrfPhase: "failed"
      }),
      {
        refresh() {
          refreshHarness.current = snapshot({
            epoch: 2,
            accessState: "loading",
            hostState: "loading",
            targetState: "loading",
            csrfPhase: "failed"
          });
          return Promise.resolve().then(() => {
            refreshHarness.current = snapshot({
              epoch: 2,
              accessState: "stale",
              hostState: "stale",
              targetState: "stale",
              csrfPhase: "failed"
            });
            return refreshHarness.current;
          });
        }
      }
    );
    const refreshController = createHostAccessRecoveryController({ port: refreshHarness.port });
    const refreshFailure = await refreshController.recover();
    expect(refreshFailure).toMatchObject({
      phase: "refresh_failed",
      action: "check_access",
      urgent: true
    });
    expect(JSON.stringify(refreshFailure)).not.toContain(rawToken);
    expect(JSON.stringify(refreshFailure)).not.toContain(privateDeviceId);
    refreshController.close();

    const bootstrapHarness = createHarness(
      snapshot({ csrfPhase: "failed" }),
      {
        bootstrap() {
          bootstrapHarness.current = snapshot({ csrfPhase: "bootstrapping" });
          return Promise.resolve().then(() => {
            bootstrapHarness.current = snapshot({ csrfPhase: "failed" });
            throw new HostDeckBrowserCsrfError({
              reason: "bootstrap_unavailable",
              operation: "bootstrap",
              routeId: "csrf_bootstrap"
            });
          });
        }
      }
    );
    const bootstrapController = createHostAccessRecoveryController({ port: bootstrapHarness.port });
    const bootstrapFailure = await bootstrapController.recover();
    expect(bootstrapFailure).toMatchObject({
      phase: "bootstrap_failed",
      action: "retry_setup",
      urgent: true
    });
    expect(bootstrapHarness.bootstrapCsrf).toHaveBeenCalledTimes(1);
    bootstrapController.close();
  });

  it("closes immediately, resolves one waiter, and ignores late shared-port settlement", async () => {
    const bootstrap = deferred<BrowserConnectionSnapshot>();
    const harness = createHarness(
      snapshot({ csrfPhase: "failed" }),
      {
        bootstrap() {
          harness.current = snapshot({ csrfPhase: "bootstrapping" });
          return bootstrap.promise;
        }
      }
    );
    const controller = createHostAccessRecoveryController({ port: harness.port });
    const listener = vi.fn();
    controller.subscribe(listener);
    const recovery = controller.recover();
    await nextMicrotask();

    const closed = controller.close();
    await expect(recovery).resolves.toBe(closed);
    expect(closed).toMatchObject({ phase: "closed", action: null, busy: false });
    const callsAtClose = listener.mock.calls.length;
    harness.current = snapshot({ csrfPhase: "ready" });
    bootstrap.resolve(harness.current);
    await nextMicrotask();
    expect(listener).toHaveBeenCalledTimes(callsAtClose);
    expect(controller.snapshot()).toBe(closed);
  });

  it("rejects malformed construction and does not publish duplicate synchronized views", () => {
    const valid = snapshot();
    expect(() => createHostAccessRecoveryController({} as never)).toThrow(TypeError);
    expect(() =>
      createHostAccessRecoveryController({
        port: Object.freeze({ snapshot: () => ({ ...valid }), refresh: vi.fn(), bootstrapCsrf: vi.fn() })
      } as never)
    ).toThrow(TypeError);
    expect(() =>
      createHostAccessRecoveryController({
        port: Object.freeze({
          snapshot: () => valid,
          refresh: vi.fn(),
          bootstrapCsrf: vi.fn(),
          extra: true
        })
      } as never)
    ).toThrow(TypeError);

    const harness = createHarness(valid);
    const controller = createHostAccessRecoveryController({ port: harness.port });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    expect(controller.synchronize()).toBe(controller.snapshot());
    expect(listener).not.toHaveBeenCalled();
    expect(() => controller.subscribe(listener)).toThrow(TypeError);
    unsubscribe();
    controller.close();
  });
});

interface Harness {
  current: BrowserConnectionSnapshot;
  readonly snapshot: ReturnType<typeof vi.fn>;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly bootstrapCsrf: ReturnType<typeof vi.fn>;
  readonly port: HostAccessRecoveryPort;
}

function createHarness(
  initial: BrowserConnectionSnapshot,
  behavior: Readonly<{
    refresh?: () => Promise<BrowserConnectionSnapshot>;
    bootstrap?: () => Promise<BrowserConnectionSnapshot>;
  }> = {}
): Harness {
  const harness = {} as Harness;
  harness.current = initial;
  const snapshotPort = vi.fn(() => harness.current);
  const refresh = vi.fn(
    behavior.refresh ?? (() => Promise.reject(new Error("Unexpected refresh")))
  );
  const bootstrapCsrf = vi.fn(
    behavior.bootstrap ?? (() => Promise.reject(new Error("Unexpected bootstrap")))
  );
  Object.assign(harness, {
    snapshot: snapshotPort,
    refresh,
    bootstrapCsrf,
    port: Object.freeze({ snapshot: snapshotPort, refresh, bootstrapCsrf })
  });
  return harness;
}

function snapshot(
  options: Readonly<{
    epoch?: number;
    target?: BrowserConnectionTarget;
    phase?: BrowserConnectionSnapshot["phase"];
    authenticationState?: SelectedAccessStateResponse["authentication_state"];
    permission?: "read" | "write";
    access?: SelectedAccessStateResponse | null;
    accessState?: BrowserConnectionResourceState;
    hostState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    csrfPhase?: BrowserConnectionSnapshot["csrf"]["phase"];
    invalidationReason?: BrowserConnectionSnapshot["csrf"]["invalidationReason"];
  }> = {}
): BrowserConnectionSnapshot {
  const target = options.target ?? Object.freeze({ kind: "mission_control" as const });
  const access = options.access === undefined
    ? accessState(options.authenticationState ?? "paired_device", options.permission ?? "write")
    : options.access;
  const readable = access?.can_read_sessions === true;
  const host = readable ? hostStatus(access) : null;
  const accessStateValue = options.accessState ?? (access === null ? "loading" : "current");
  const hostStateValue = options.hostState ?? (host === null ? "blocked" : "current");
  const targetStateValue = options.targetState ?? (readable ? "current" : "blocked");
  const csrfPhase = options.csrfPhase ?? "ready";
  const currentTargetData = target.kind === "mission_control"
    ? Object.freeze({ kind: "mission_control" as const })
    : Object.freeze({
        kind: "session_detail" as const,
        response: Object.freeze({
          session: Object.freeze({
            session: Object.freeze({ id: target.sessionId })
          })
        })
      });
  const csrfFailure = csrfPhase === "failed"
    ? new HostDeckBrowserCsrfError({
        reason: "bootstrap_unavailable",
        operation: "bootstrap",
        routeId: "csrf_bootstrap"
      })
    : null;
  const writeEligible =
    accessStateValue === "current" &&
    hostStateValue === "current" &&
    targetStateValue === "current" &&
    access?.authentication_state === "paired_device" &&
    access.permission === "write" &&
    !access.locked &&
    csrfPhase === "ready";
  return Object.freeze({
    epoch: options.epoch ?? 1,
    target,
    phase: options.phase ?? (readable ? (writeEligible ? "ready" : "degraded") : "access_limited"),
    access: resource(accessStateValue, access),
    host: resource(hostStateValue, host),
    targetState: resource(targetStateValue, readable ? currentTargetData : null) as BrowserConnectionSnapshot["targetState"],
    stream: Object.freeze({
      state: target.kind === "mission_control" ? "not_applicable" as const : "idle" as const,
      snapshot: null,
      continuity: target.kind === "mission_control" ? "not_applicable" as const : "unproven" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: csrfPhase,
      generation: csrfPhase === "ready" ? 9 : null,
      rotatedAt: csrfPhase === "ready" ? timestamp : null,
      failure: csrfFailure,
      invalidationReason:
        csrfPhase === "idle"
          ? options.invalidationReason ?? "not_bootstrapped"
          : null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: writeEligible,
      causes: Object.freeze(writeEligible ? [] : ["csrf_not_ready" as const])
    }),
    lastFailure: null
  });
}

function accessState(
  authenticationState: SelectedAccessStateResponse["authentication_state"],
  permission: "read" | "write"
): SelectedAccessStateResponse {
  const paired = authenticationState === "paired_device";
  return selectedAccessStateResponseSchema.parse({
    authentication_state: authenticationState,
    device_id: paired ? privateDeviceId : null,
    permission: paired ? permission : null,
    device_expires_at: paired ? "2026-10-26T05:00:00.000Z" : null,
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: paired,
    can_write_sessions: paired && permission === "write",
    can_lock: paired && permission === "write",
    can_unlock: false
  });
}

function hostStatus(access: SelectedAccessStateResponse): SelectedHostStatusResponse {
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 4,
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
      observed_version: "0.148.0",
      supported_version: "0.148.0",
      capability_state: "verified",
      checked_at: timestamp,
      recorded_at: timestamp
    },
    remote: {
      generation: 5,
      state_generation: 5,
      availability: "ready",
      cause: null,
      external_origin: remoteOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode: access.permission === "write" ? "paired_write" : "paired_read",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: access.permission === "write",
        causes: access.permission === "write" ? [] : ["read_only_access" as const]
      }
    }
  });
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null
) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function detailTarget(): BrowserConnectionTarget {
  return Object.freeze({ kind: "session_detail", sessionId: privateSessionId });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let index = 0; index < 10 && mock.mock.calls.length === 0; index += 1) {
    await nextMicrotask();
  }
  expect(mock).toHaveBeenCalledTimes(1);
}
