import {
  type ApiErrorEnvelope,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedOperationDispatchSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ArchiveControlContext,
  type ArchiveControlPort,
  createArchiveControlController
} from "./archive-control-state.js";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import { browserConnectionWriteBlockCauses } from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";

const sessionId = "sess_archive_component_001" as SessionId;
const threadId = "thread-archive-component-private";
const operationId = "op_browser_archive_component_001";
const timestamp = "2026-07-27T21:00:00.000Z";
const laterTimestamp = "2026-07-27T21:01:00.000Z";
const remoteOrigin = "https://hostdeck-laptop.fixture-tailnet.ts.net";

describe("archive control state", () => {
  it("derives one exact current idle target without exposing private correlation identity", () => {
    const controller = createController();

    expect(controller.snapshot()).toMatchObject({
      visible: true,
      sheetOpen: false,
      phase: "closed",
      actionEnabled: true,
      target: { sessionLabel: "android-release" }
    });
    expect(controller.open()).toMatchObject({
      sheetOpen: true,
      phase: "ready",
      status: "Idle session ready"
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(
      /thread-archive|op_browser|private\/archive|device-archive/iu
    );
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(Object.isFrozen(controller.snapshot().target)).toBe(true);
  });

  it.each([
    ["in_progress", "active turn"],
    ["waiting_for_input", "active turn"],
    ["waiting_for_approval", "active turn"],
    ["completed", "completed"],
    ["interrupted", "interrupted"],
    ["failed", "failed"],
    ["unknown", "unknown"]
  ] as const)("requires idle and rejects %s with bounded copy", (turnState, copy) => {
    const view = createController(undefined, context({ turnState })).snapshot();
    expect(view.actionEnabled).toBe(false);
    expect(view.actionDisabledReason?.toLowerCase()).toContain(copy);
  });

  it("rejects every non-current authority boundary before operation-id generation", async () => {
    const cases: readonly [ArchiveControlContext, string][] = [
      [context({ permission: "read" }), "Read-only"],
      [context({ locked: true }), "locked"],
      [context({ accessState: "stale" }), "not current"],
      [context({ hostState: "stale" }), "authority"],
      [context({ targetState: "stale" }), "not current"],
      [context({ freshness: "stale" }), "stale"],
      [context({ streamState: "reconnecting" }), "reconnecting"],
      [context({ streamState: "failed" }), "unavailable"],
      [context({ continuity: "unproven" }), "not proven"],
      [context({ csrfPhase: "failed", csrfGeneration: null }), "authority"],
      [context({ hostCompatibility: "incompatible" }), "authority"],
      [context({ hostCompatibility: "disconnected" }), "authority"]
    ];
    for (const [initialContext, copy] of cases) {
      const port = archivePort();
      const createOperationId = vi.fn(() => operationId);
      const controller = createController(port, initialContext, createOperationId);
      controller.open();
      expect(controller.snapshot().actionEnabled).toBe(false);
      expect(controller.snapshot().actionDisabledReason?.toLowerCase())
        .toContain(copy.toLowerCase());
      controller.beginConfirmation();
      await controller.confirm();
      expect(createOperationId).not.toHaveBeenCalled();
      expect(port.archive).not.toHaveBeenCalled();
    }

    for (const writeCause of browserConnectionWriteBlockCauses) {
      const port = archivePort();
      const createOperationId = vi.fn(() => operationId);
      const controller = createController(port, context({ writeCause }), createOperationId);
      controller.open();
      expect(controller.snapshot().actionEnabled).toBe(false);
      expect(controller.snapshot().actionDisabledReason).toEqual(expect.any(String));
      controller.beginConfirmation();
      await controller.confirm();
      expect(createOperationId).not.toHaveBeenCalled();
      expect(port.archive).not.toHaveBeenCalled();
    }
  });

  it("rejects archived, incompatible, non-active, missing, and foreign session projections", async () => {
    const base = context();
    const missingDetail = Object.freeze({
      snapshot: Object.freeze({
        ...base.snapshot,
        targetState: resource("current", null)
      })
    });
    const foreignRoute = Object.freeze({
      snapshot: Object.freeze({
        ...base.snapshot,
        target: Object.freeze({
          kind: "session_detail" as const,
          sessionId: "sess_archive_foreign_001"
        })
      })
    });
    const cases: readonly [ArchiveControlContext, string][] = [
      [context({ sessionState: "archived" }), "already archived"],
      [context({ sessionState: "incompatible" }), "incompatible"],
      [context({ sessionState: "stale" }), "stale"],
      [context({ sessionState: "unknown" }), "stale"],
      [missingDetail, "not available"],
      [foreignRoute, "not available"]
    ];

    for (const [initialContext, copy] of cases) {
      const port = archivePort();
      const createOperationId = vi.fn(() => operationId);
      const controller = createController(port, initialContext, createOperationId);
      controller.open();
      expect(controller.snapshot().actionEnabled).toBe(false);
      expect(controller.snapshot().actionDisabledReason?.toLowerCase()).toContain(copy);
      controller.beginConfirmation();
      await controller.confirm();
      expect(createOperationId).not.toHaveBeenCalled();
      expect(port.archive).not.toHaveBeenCalled();
    }

    expect(createController(undefined, context({ hostCompatibility: "degraded" })).snapshot())
      .toMatchObject({ actionEnabled: true });
  });

  it("freezes confirmation and invalidates target or write authority replacement", async () => {
    for (const replacement of [
      context({ projectedThreadId: "thread-archive-replaced" }),
      context({ projectedName: "renamed-session" }),
      context({ runtimeVersion: "0.145.0" }),
      context({ createdAt: "2026-07-27T20:59:00.000Z" }),
      context({ epoch: 2 }),
      context({ csrfGeneration: 2 }),
      context({ deviceId: "device-archive-component-replaced" }),
      context({ origin: "https://hostdeck-replaced.fixture-tailnet.ts.net" }),
      context({ hostGeneration: 2 }),
      context({ turnState: "in_progress" }),
      context({ freshness: "stale" }),
      context({ sessionState: "archived" }),
      context({ streamState: "reconnecting" }),
      context({ permission: "read" }),
      context({ locked: true })
    ]) {
      const port = archivePort();
      const createOperationId = vi.fn(() => operationId);
      const controller = createController(port, context(), createOperationId);
      controller.open();
      expect(controller.beginConfirmation()).toMatchObject({
        phase: "confirming",
        confirmationOpen: true,
        confirmEnabled: true
      });

      expect(controller.updateContext(replacement)).toMatchObject({
        confirmationOpen: false,
        confirmEnabled: false
      });
      await controller.confirm();
      expect(createOperationId).not.toHaveBeenCalled();
      expect(port.archive).not.toHaveBeenCalled();
    }
  });

  it("creates one operation id after confirmation and coalesces one exact target-free request", async () => {
    const pending = deferred<unknown>();
    const port = archivePort({ archive: () => pending.promise });
    const createOperationId = vi.fn(() => operationId);
    const controller = createController(port, context(), createOperationId);
    controller.open();
    controller.beginConfirmation();

    const first = controller.confirm();
    const duplicate = controller.confirm();
    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      phase: "submitting",
      busy: true,
      closeDisabled: true,
      confirmationOpen: false,
      status: "Waiting for laptop confirmation"
    });
    expect(controller.snapshot().statusDetail).not.toMatch(/accepted|archived|deleted/iu);
    expect(controller.dismiss()).toBe(controller.snapshot());
    expect(controller.cancelConfirmation()).toBe(controller.snapshot());
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(port.archive).toHaveBeenCalledTimes(1);
    expect(port.archive.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: { operation_id: operationId, kind: "archive", confirm: true }
    });
    expect(Object.keys(port.archive.mock.calls[0]?.[0].request ?? {})).toEqual([
      "operation_id",
      "kind",
      "confirm"
    ]);
    expect(JSON.stringify(port.archive.mock.calls[0]?.[0].request)).not.toContain(threadId);

    pending.resolve(archiveResponse());
    await first;
    expect(controller.snapshot()).toMatchObject({
      phase: "succeeded",
      tone: "connected",
      closeDisabled: true,
      result: {
        kind: "succeeded",
        label: "Session archived",
        returnToSessions: true
      }
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/audit-archive|accepted|thread-archive/iu);
  });

  it("accepts only one exact correlated terminal-backed receipt", async () => {
    for (const response of [
      archiveResponse({ operation: "op_archive_foreign_001" }),
      archiveResponse({ session: "sess_archive_foreign_001" }),
      archiveResponse({ thread: "thread-archive-foreign" }),
      { ...archiveResponse(), extra: true },
      {
        operation_id: operationId,
        kind: "archive",
        target: { type: "managed_session", session_id: sessionId, codex_thread_id: threadId },
        state: "rejected",
        rejected_at: laterTimestamp,
        error: { code: "operation_conflict", message: "Bounded.", retryable: false }
      }
    ]) {
      const controller = createController(archivePort({ archive: async () => response }));
      controller.open();
      controller.beginConfirmation();
      await controller.confirm();
      expect(controller.snapshot()).toMatchObject({
        phase: "outcome_unknown",
        result: { kind: "outcome_unknown", returnToSessions: false }
      });
    }
  });

  it.each([
    ["permission_denied", "blocked", "Archive blocked"],
    ["read_only", "blocked", "Archive blocked"],
    ["host_locked", "blocked", "Archive blocked"],
    ["session_not_found", "not_completed", "Archive not completed"],
    ["session_not_writable", "not_completed", "Archive not completed"],
    ["stale_session", "not_completed", "Archive not completed"],
    ["incompatible_runtime", "not_completed", "Archive not completed"],
    ["operation_timeout", "outcome_unknown", "Archive outcome not confirmed"],
    ["operation_conflict", "outcome_unknown", "Archive outcome not confirmed"],
    ["runtime_unavailable", "outcome_unknown", "Archive outcome not confirmed"],
    ["storage_error", "outcome_unknown", "Archive outcome not confirmed"],
    ["internal_error", "outcome_unknown", "Archive outcome not confirmed"]
  ] as const)("maps %s to exact %s persistence truth", async (code, kind, label) => {
    const port = archivePort({ archive: async () => {
      throw csrfApiError(code);
    } });
    const controller = createController(port);
    controller.open();
    controller.beginConfirmation();
    await controller.confirm();

    expect(controller.snapshot()).toMatchObject({
      phase: kind,
      result: { kind, label, returnToSessions: false }
    });
    expect(controller.snapshot().result?.detail).not.toContain("private archive fixture");
    expect(controller.snapshot().result?.consequence).toMatch(/remains|did not remove/iu);
    expect(port.archive).toHaveBeenCalledTimes(1);
  });

  it("keeps possible remote/local uncertainty explicit and latches no resend after dismissal", async () => {
    const port = archivePort({ archive: async () => {
      throw new Error("private remote success local persistence detail");
    } });
    const createOperationId = vi.fn(() => operationId);
    const controller = createController(port, context(), createOperationId);
    controller.open();
    controller.beginConfirmation();
    await controller.confirm();

    expect(controller.snapshot().result).toMatchObject({
      kind: "outcome_unknown",
      detail: expect.stringMatching(/may have archived|local archive state/iu),
      consequence: expect.stringMatching(/remains on screen|no retry/iu)
    });
    controller.dismiss();
    controller.open();
    expect(controller.snapshot()).toMatchObject({
      actionEnabled: false,
      actionDisabledReason: "An archive was already submitted for this session."
    });
    controller.beginConfirmation();
    await controller.confirm();
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(port.archive).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/private remote success/iu);
  });

  it("classifies failure from the bounded code, never status, retryability, or private message", async () => {
    const port = archivePort({ archive: async () => {
      throw new HostDeckBrowserCsrfError({
        reason: "api_error",
        operation: "mutation",
        routeId: "session_archive",
        transport: "https",
        status: 423,
        apiError: {
          code: "storage_error",
          message: "permission_denied read_only host_locked private archive detail",
          retryable: true
        }
      });
    } });
    const controller = createController(port);
    controller.open();
    controller.beginConfirmation();
    await controller.confirm();

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      result: { kind: "outcome_unknown", returnToSessions: false }
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/permission_denied|private archive/iu);
  });

  it("turns immutable target replacement during dispatch into explicit inconsistency", async () => {
    const pending = deferred<unknown>();
    const controller = createController(archivePort({ archive: () => pending.promise }));
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    await Promise.resolve();

    controller.updateContext(context({
      projectedName: "renamed-session",
      projectedThreadId: "thread-archive-replaced"
    }));
    expect(controller.snapshot().targetLabel).toBe("android-release");
    expect(controller.snapshot().target?.sessionLabel).toBe("android-release");
    pending.resolve(archiveResponse());
    await submitted;
    expect(controller.snapshot()).toMatchObject({
      phase: "inconsistent",
      targetLabel: "android-release",
      result: { kind: "inconsistent", returnToSessions: false }
    });
  });

  it("hides retained target disclosure if read authority is lost while preserving bounded result truth", async () => {
    const pending = deferred<unknown>();
    const controller = createController(archivePort({ archive: () => pending.promise }));
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    await Promise.resolve();

    controller.updateContext(context({ accessState: "blocked" }));
    expect(controller.snapshot()).toMatchObject({ visible: false, target: null, targetLabel: null });
    pending.resolve(archiveResponse());
    await submitted;
    expect(controller.snapshot()).toMatchObject({
      result: { kind: "succeeded" },
      target: null,
      targetLabel: null
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("android-release");
  });

  it("fails closed when secure operation-id creation fails and sends no request", async () => {
    const port = archivePort();
    const controller = createController(port, context(), () => "invalid id");
    controller.open();
    controller.beginConfirmation();
    await controller.confirm();
    expect(controller.snapshot()).toMatchObject({
      phase: "blocked",
      result: { label: "Secure archive setup unavailable" }
    });
    expect(port.archive).not.toHaveBeenCalled();
  });

  it("rejects malformed options, accessor ports, listener duplication, and subscriber overflow", () => {
    const validContext = context();
    const validPort = archivePort();
    expect(() => createArchiveControlController({
      sessionId,
      context: validContext,
      port: validPort,
      createOperationId: () => operationId,
      extra: true
    } as never)).toThrow("HostDeck archive-control options are invalid.");
    const accessorPort = {} as Record<string, unknown>;
    Object.defineProperty(accessorPort, "archive", {
      enumerable: true,
      get: () => vi.fn()
    });
    expect(() => createArchiveControlController({
      sessionId,
      context: validContext,
      port: accessorPort as never,
      createOperationId: () => operationId
    })).toThrow("HostDeck archive-control port is invalid.");

    const controller = createController(validPort);
    const listener = vi.fn();
    const releases = [controller.subscribe(listener)];
    expect(() => controller.subscribe(listener)).toThrow("listener is invalid");
    for (let index = 1; index < 32; index += 1) releases.push(controller.subscribe(vi.fn()));
    expect(() => controller.subscribe(vi.fn())).toThrow("capacity is exhausted");
    for (const release of releases) release();
  });

  it("aborts owned work, suppresses late settlement, and rejects updates after close", async () => {
    const pending = deferred<unknown>();
    const port = archivePort({ archive: () => pending.promise });
    const controller = createController(port);
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    await Promise.resolve();
    const signal = port.archive.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    expect(controller.close()).toMatchObject({ phase: "hidden", visible: false });
    expect(signal?.aborted).toBe(true);
    pending.resolve(archiveResponse());
    await expect(submitted).resolves.toBe(controller.snapshot());
    expect(controller.snapshot()).toMatchObject({ phase: "hidden", result: null });
    expect(() => controller.updateContext(context())).toThrow("HostDeck archive control is closed.");
    expect(() => controller.subscribe(vi.fn())).toThrow("listener is invalid");
  });
});

function createController(
  port = archivePort(),
  initialContext = context(),
  createOperationId: () => string = () => operationId
) {
  return createArchiveControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId
  });
}

function archivePort(overrides: Partial<ArchiveControlPort> = {}) {
  return {
    archive: vi.fn(overrides.archive ?? (async (input) =>
      archiveResponse({ operation: input.request.operation_id })
    ))
  };
}

function archiveResponse(input: Readonly<{
  operation?: string;
  session?: string;
  thread?: string;
}> = {}) {
  return selectedOperationDispatchSchema.parse({
    operation_id: input.operation ?? operationId,
    kind: "archive",
    target: {
      type: "managed_session",
      session_id: input.session ?? sessionId,
      codex_thread_id: input.thread ?? threadId
    },
    state: "accepted",
    accepted_at: laterTimestamp,
    audit_record_id: "audit-archive-component-private"
  });
}

function context(input: Readonly<{
  epoch?: number;
  permission?: "read" | "write";
  locked?: boolean;
  deviceId?: string;
  origin?: string;
  accessState?: BrowserConnectionResourceState;
  hostState?: BrowserConnectionResourceState;
  targetState?: BrowserConnectionResourceState;
  freshness?: "current" | "stale";
  sessionState?: "active" | "archived" | "incompatible" | "stale" | "unknown";
  turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
  projectedName?: string;
  projectedThreadId?: string;
  runtimeVersion?: string;
  createdAt?: string;
  streamState?: BrowserConnectionSnapshot["stream"]["state"];
  continuity?: BrowserConnectionSnapshot["stream"]["continuity"];
  writeCause?: BrowserConnectionWriteBlockCause;
  csrfPhase?: BrowserConnectionSnapshot["csrf"]["phase"];
  csrfGeneration?: number | null;
  hostCompatibility?: HostCompatibilityFixture;
  hostGeneration?: number;
}> = {}): ArchiveControlContext {
  const permission = input.permission ?? "write";
  const locked = input.locked ?? false;
  const freshness = input.freshness ?? "current";
  const sessionState = input.sessionState ?? "active";
  const turnState = input.turnState ?? "idle";
  const accessData = access(
    permission,
    locked,
    input.deviceId ?? "device-archive-component-private",
    input.origin ?? remoteOrigin
  );
  const writeCause = input.writeCause ?? (
    permission === "read" ? "read_only_access" : locked ? "host_locked" : null
  );
  const writeEligible = writeCause === null;
  const archived = sessionState === "archived";
  const projection = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: input.projectedName ?? "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/archive-component",
    runtime_source: "codex_app_server",
    runtime_version: input.runtimeVersion ?? "0.144.0",
    created_at: input.createdAt ?? timestamp,
    archived_at: archived ? laterTimestamp : null,
    session_state: sessionState,
    turn_state: archived ? "idle" : turnState,
    attention: turnState === "waiting_for_input"
      ? "needs_input"
      : turnState === "waiting_for_approval"
        ? "needs_approval"
        : "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/archive-component",
    model: "runtime-archive",
    settings: null,
    goal: null,
    recent_summary: "Validate exact managed-thread archive control.",
    last_event_cursor: null
  });
  const item = selectedSessionReadItemSchema.parse({
    session: projection,
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  });
  const responseCandidate = {
    access: {
      mode: permission === "write" ? "paired_write" as const : "paired_read" as const,
      network_mode: "remote" as const,
      transport: "https" as const
    },
    session: item
  };
  const response = archived
    ? Object.freeze(responseCandidate) as ReturnType<
        typeof selectedSessionDetailResponseSchema.parse
      >
    : selectedSessionDetailResponseSchema.parse(responseCandidate);
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready" as const,
    access: resource(input.accessState ?? "current", accessData),
    host: resource(
      input.hostState ?? "current",
      hostStatus(
        accessData,
        input.hostCompatibility ?? "supported",
        input.hostGeneration ?? 1
      )
    ),
    targetState: resource(
      input.targetState ?? "current",
      Object.freeze({ kind: "session_detail" as const, response })
    ),
    stream: Object.freeze({
      state: input.streamState ?? "connected",
      snapshot: null,
      continuity: input.continuity ?? "contiguous",
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: input.csrfPhase ?? (
        writeEligible || permission === "write" ? "ready" as const : "idle" as const
      ),
      generation: input.csrfGeneration === undefined
        ? writeEligible || permission === "write" ? 1 : null
        : input.csrfGeneration,
      rotatedAt: input.csrfGeneration === null || input.csrfPhase === "failed"
        ? null
        : writeEligible || permission === "write" ? timestamp : null,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: writeEligible,
      causes: Object.freeze(writeCause === null ? [] : [writeCause])
    }),
    lastFailure: null
  });
  return Object.freeze({ snapshot });
}

function access(
  permission: "read" | "write",
  locked: boolean,
  deviceId: string,
  origin: string
) {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: deviceId,
    permission,
    device_expires_at: "2026-10-27T21:00:00.000Z",
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

type HostCompatibilityFixture = "supported" | "degraded" | "incompatible" | "disconnected";

function hostStatus(
  accessData: ReturnType<typeof access>,
  compatibility: HostCompatibilityFixture,
  generation: number
) {
  const readOnly = accessData.permission === "read";
  const compatibilityFixture = compatibility === "supported"
    ? {
        state: "supported" as const,
        evidence: "current" as const,
        observed_version: "0.144.0",
        capability_state: "verified" as const
      }
    : compatibility === "degraded"
      ? {
          state: "degraded" as const,
          evidence: "current" as const,
          observed_version: "0.144.0",
          capability_state: "limited" as const
        }
      : compatibility === "incompatible"
        ? {
            state: "incompatible" as const,
            evidence: "current" as const,
            observed_version: null,
            capability_state: "blocked" as const
          }
        : {
            state: "disconnected" as const,
            evidence: "last_known" as const,
            observed_version: "0.144.0",
            capability_state: "unverified" as const
          };
  const parsed = selectedHostStatusResponseSchema.parse({
    local: {
      generation,
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
    remote: {
      generation: 1,
      state_generation: 1,
      availability: "ready",
      cause: null,
      external_origin: remoteOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode: readOnly ? "paired_read" : "paired_write",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: !readOnly,
        causes: readOnly ? ["read_only_access"] : []
      }
    }
  });
  if (compatibility === "supported") return parsed;
  return Object.freeze({
    ...parsed,
    compatibility: Object.freeze({
      ...compatibilityFixture,
      supported_version: parsed.compatibility.supported_version,
      checked_at: parsed.compatibility.checked_at,
      recorded_at: parsed.compatibility.recorded_at
    })
  });
}

function resource<Data>(state: BrowserConnectionResourceState, data: Data | null) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function csrfApiError(code: ApiErrorEnvelope["code"]) {
  return new HostDeckBrowserCsrfError({
    reason: ["read_only", "permission_denied", "host_locked"].includes(code)
      ? "authority_rejected"
      : "api_error",
    operation: "mutation",
    routeId: "session_archive",
    transport: "https",
    status: code === "session_not_found" ? 404 : code === "operation_timeout" ? 504 : 409,
    apiError: {
      code,
      message: "Selected private archive fixture detail.",
      retryable: false
    }
  });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
