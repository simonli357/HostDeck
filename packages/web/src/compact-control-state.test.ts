import {
  type ApiErrorEnvelope,
  compactProgressResponseSchema,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedOperationProgressSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CompactControlContext,
  type CompactControlPort,
  createCompactControlController,
  HostDeckCompactOutcomeUnknownError
} from "./compact-control-state.js";
import {
  type BrowserConnectionResourceState,
  type BrowserConnectionSnapshot,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import { HostDeckBrowserHttpError } from "./http-client.js";

const sessionId = "sess_compact_component_001" as SessionId;
const threadId = "thread-compact-component-private";
const timestamp = "2026-07-27T16:00:00.000Z";
const operationId = "op_browser_compact_component_001";

describe("compact control state", () => {
  it("opens with one exact abortable read and preserves explicit null progress", async () => {
    const port = compactPort();
    const controller = createController(port);

    expect(controller.snapshot()).toMatchObject({
      visible: true,
      sheetOpen: false,
      phase: "closed",
      actionEnabled: true
    });
    const opened = await controller.open();

    expect(port.read).toHaveBeenCalledTimes(1);
    const input = port.read.mock.calls[0]?.[0];
    expect(input).toMatchObject({ sessionId });
    expect(input?.signal).toBeInstanceOf(AbortSignal);
    expect(opened).toMatchObject({
      phase: "ready",
      status: "No tracked compaction",
      hasCurrentRead: true,
      progress: null,
      startActionVisible: true,
      startEnabled: true,
      checkEnabled: true
    });
    expect(JSON.stringify(opened)).not.toMatch(/thread-compact|op_browser|private/iu);
    expect(Object.isFrozen(opened)).toBe(true);
  });

  it("maps every strict process-live state without exposing operation or turn identity", async () => {
    const cases = [
      ["accepted", null, "accepted", "Compaction accepted", false],
      ["running", "turn-compact-private", "running", "Compacting context", false],
      ["completed", "turn-compact-private", "completed", "Compaction completed", true],
      ["interrupted", "turn-compact-private", "interrupted", "Compaction interrupted", true],
      ["failed", "turn-compact-private", "failed", "Compaction failed", true],
      ["incomplete", null, "incomplete", "Compaction outcome incomplete", false]
    ] as const;
    for (const [state, turnId, phase, status, restartVisible] of cases) {
      const port = compactPort({
        read: async () => compactResponse(state, { turnId, retryable: state === "failed" })
      });
      const view = await createController(port).open();
      expect(view).toMatchObject({ phase, status, startActionVisible: restartVisible });
      expect(view.progress).toMatchObject({ state, freshness: "current" });
      expect(JSON.stringify(view)).not.toMatch(/op_browser_compact|turn-compact|thread-compact|Selected public/iu);
      if (["accepted", "running", "incomplete"].includes(state)) {
        expect(view.startEnabled).toBe(false);
        expect(view.checkEnabled).toBe(true);
      }
    }
  });

  it("keeps nonretryable failed progress blocked and permits only proven terminal restart shapes", async () => {
    for (const [state, retryable, startable] of [
      ["completed", false, true],
      ["interrupted", false, true],
      ["failed", true, true],
      ["failed", false, false]
    ] as const) {
      const controller = createController(compactPort({
        read: async () => compactResponse(state, {
          turnId: "turn-compact-terminal",
          retryable
        })
      }));
      const view = await controller.open();
      expect(view.startActionVisible).toBe(startable);
      expect(view.startEnabled).toBe(startable);
      expect(view.startLabel).toBe("Compact again");
    }
  });

  it("requires a separate exact confirmation and coalesces duplicate submission", async () => {
    const pending = deferred<unknown>();
    const port = compactPort({ start: () => pending.promise });
    const createOperationId = vi.fn(() => operationId);
    const controller = createController(port, context(), createOperationId);
    await controller.open();

    expect(controller.beginConfirmation()).toMatchObject({
      phase: "confirming",
      confirmationOpen: true,
      confirmEnabled: true
    });
    expect(port.start).not.toHaveBeenCalled();
    const first = controller.confirm();
    const second = controller.confirm();
    expect(controller.snapshot()).toMatchObject({
      phase: "submitting",
      closeDisabled: true,
      confirmEnabled: false
    });
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(port.start.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: { operation_id: operationId, kind: "compact", confirm: true }
    });
    expect(Object.keys(port.start.mock.calls[0]?.[0].request ?? {})).toEqual([
      "operation_id",
      "kind",
      "confirm"
    ]);
    expect(port.start.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(second).resolves.toBe(controller.snapshot());

    pending.resolve(compactResponse("accepted", { operationId }));
    const accepted = await first;
    expect(accepted).toMatchObject({
      phase: "accepted",
      status: "Compaction accepted",
      progress: { state: "accepted" },
      startActionVisible: false,
      checkEnabled: true
    });
    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it("cancels confirmation without creating identity or dispatching", async () => {
    const createOperationId = vi.fn(() => operationId);
    const port = compactPort();
    const controller = createController(port, context(), createOperationId);
    await controller.open();
    controller.beginConfirmation();

    expect(controller.cancelConfirmation()).toMatchObject({
      phase: "ready",
      confirmationOpen: false
    });
    expect(createOperationId).not.toHaveBeenCalled();
    expect(port.start).not.toHaveBeenCalled();
  });

  it("rejects malformed, foreign, and contradictory read data as bounded failure", async () => {
    const candidates = [
      { progress: null, extra: true },
      compactResponse("accepted", { targetSessionId: "sess_compact_other" }),
      compactResponse("accepted", { targetThreadId: "thread-compact-other" })
    ];
    for (const candidate of candidates) {
      const view = await createController(compactPort({ read: async () => candidate })).open();
      expect(view).toMatchObject({
        phase: "read_failure",
        hasCurrentRead: false,
        progress: null,
        startEnabled: false
      });
      expect(JSON.stringify(view)).not.toMatch(/sess_compact_other|thread-compact-other/iu);
    }
  });

  it("treats malformed or miscorrelated accepted start data as uncertain", async () => {
    const candidates = [
      { progress: null },
      compactResponse("accepted", { operationId: "op_browser_compact_other_001" }),
      compactResponse("running", { operationId, turnId: "turn-compact-private" }),
      { ...compactResponse("accepted", { operationId }), extra: true }
    ];
    for (const candidate of candidates) {
      const controller = createController(compactPort({ start: async () => candidate }));
      await controller.open();
      controller.beginConfirmation();
      const view = await controller.confirm();
      expect(view).toMatchObject({
        phase: "outcome_unknown",
        startEnabled: false,
        checkEnabled: true
      });
      expect(view.statusDetail).toContain("will not resend");
    }
  });

  it("separates unsupported reads, known read failures, conflicts, known starts, and uncertain starts", async () => {
    const readUnsupported = await createController(compactPort({
      read: async () => { throw httpApiError("capability_unavailable", false); }
    })).open();
    expect(readUnsupported).toMatchObject({ phase: "unsupported", checkEnabled: false });

    const readFailure = await createController(compactPort({
      read: async () => { throw httpApiError("service_overloaded", true); }
    })).open();
    expect(readFailure).toMatchObject({ phase: "read_failure", checkEnabled: true });

    for (const [code, expected] of [
      ["operation_conflict", "conflict"],
      ["read_only", "start_failure"],
      ["unknown_error", "outcome_unknown"],
      ["operation_timeout", "outcome_unknown"]
    ] as const) {
      const controller = createController(compactPort({
        start: async () => { throw csrfApiError(code, code === "operation_conflict"); }
      }));
      await controller.open();
      controller.beginConfirmation();
      expect(await controller.confirm()).toMatchObject({
        phase: expected,
        startEnabled: false,
        checkEnabled: true
      });
    }
  });

  it("requires an explicit read to reconcile every post-confirm failure", async () => {
    let startCalls = 0;
    const port = compactPort({
      start: async () => {
        startCalls += 1;
        throw new HostDeckCompactOutcomeUnknownError();
      }
    });
    const controller = createController(port);
    await controller.open();
    controller.beginConfirmation();
    await controller.confirm();
    expect(controller.beginConfirmation()).toBe(controller.snapshot());
    expect(startCalls).toBe(1);

    await controller.check();
    expect(controller.snapshot()).toMatchObject({ phase: "ready", startEnabled: true });
    controller.beginConfirmation();
    await controller.confirm();
    expect(startCalls).toBe(2);
  });

  it("keeps progress readable but start-disabled for read-only, locked, or nonterminal turns", async () => {
    for (const testContext of [
      context({ permission: "read" }),
      context({ permission: "write", locked: true }),
      context({ permission: "write", turnState: "in_progress" }),
      context({ permission: "write", turnState: "waiting_for_input" }),
      context({ permission: "write", turnState: "waiting_for_approval" }),
      context({ permission: "write", turnState: "unknown" })
    ]) {
      const port = compactPort();
      const controller = createController(port, testContext);
      const view = await controller.open();
      expect(port.read).toHaveBeenCalledTimes(1);
      expect(view).toMatchObject({
        actionEnabled: true,
        hasCurrentRead: true,
        startActionVisible: true,
        startEnabled: false
      });
      expect(view.startDisabledReason).toBeTruthy();
      expect(controller.beginConfirmation()).toBe(view);
      expect(port.start).not.toHaveBeenCalled();
    }
  });

  it("retains readable progress across write downgrade and invalidates confirmation", async () => {
    const controller = createController(compactPort({
      read: async () => compactResponse("completed", { turnId: "turn-compact-private" })
    }));
    await controller.open();
    controller.beginConfirmation();

    const downgraded = controller.updateContext(context({
      epoch: 1,
      permission: "read"
    }));
    expect(downgraded).toMatchObject({
      sheetOpen: true,
      confirmationOpen: false,
      progress: { state: "completed", freshness: "current" },
      startEnabled: false
    });
  });

  it("marks same-authority epoch changes stale and clears only after an exact check", async () => {
    const controller = createController(compactPort({
      read: async () => compactResponse("running", { turnId: "turn-compact-private" })
    }));
    await controller.open();
    const stale = controller.updateContext(context({ epoch: 2 }));
    expect(stale).toMatchObject({
      phase: "stale",
      progress: { state: "running", freshness: "stale" },
      startEnabled: false,
      checkEnabled: true
    });
    await controller.check();
    expect(controller.snapshot()).toMatchObject({
      phase: "running",
      progress: { freshness: "current" }
    });
  });

  it("closes and clears on disclosure, principal, or target replacement", async () => {
    for (const replacement of [
      context({ canRead: false }),
      context({ deviceId: "device-compact-replacement" }),
      context({ projectedThreadId: "thread-compact-replacement" })
    ]) {
      const controller = createController(compactPort({
        read: async () => compactResponse("running", { turnId: "turn-compact-private" })
      }));
      await controller.open();
      const view = controller.updateContext(replacement);
      expect(view).toMatchObject({ sheetOpen: false, progress: null, hasCurrentRead: false });
      expect(JSON.stringify(view)).not.toMatch(/thread-compact-replacement|device-compact-replacement/iu);
    }
  });

  it("aborts in-flight reads and suppresses late settlement on dismiss", async () => {
    const pending = deferred<unknown>();
    const signal = { current: null as AbortSignal | null };
    const controller = createController(compactPort({
      read: async (input) => {
        signal.current = input.signal;
        return pending.promise;
      }
    }));
    const opening = controller.open();
    await vi.waitFor(() => expect(signal.current).not.toBeNull());
    const dismissed = controller.dismiss();
    expect(signal.current?.aborted).toBe(true);
    pending.resolve(compactResponse("completed", { turnId: "turn-compact-private" }));
    await opening;
    expect(controller.snapshot()).toBe(dismissed);
    expect(dismissed).toMatchObject({ sheetOpen: false, progress: null });
  });

  it("turns an in-flight write authority change into uncertainty and suppresses late success", async () => {
    const pending = deferred<unknown>();
    const signal = { current: null as AbortSignal | null };
    const controller = createController(compactPort({
      start: async (input) => {
        signal.current = input.signal;
        return pending.promise;
      }
    }));
    await controller.open();
    controller.beginConfirmation();
    const submitting = controller.confirm();
    await vi.waitFor(() => expect(signal.current).not.toBeNull());

    const uncertain = controller.updateContext(context({ epoch: 2, permission: "read" }));
    expect(signal.current?.aborted).toBe(true);
    expect(uncertain).toMatchObject({
      phase: "outcome_unknown",
      sheetOpen: true,
      checkEnabled: true,
      startEnabled: false
    });
    pending.resolve(compactResponse("accepted", { operationId }));
    await submitting;
    expect(controller.snapshot()).toBe(uncertain);
  });

  it("blocks dismissal only during submitted POST and closes idempotently", async () => {
    const pending = deferred<unknown>();
    const controller = createController(compactPort({ start: () => pending.promise }));
    await controller.open();
    controller.beginConfirmation();
    const submitting = controller.confirm();
    const submittedView = controller.snapshot();
    expect(controller.dismiss()).toBe(submittedView);
    pending.resolve(compactResponse("accepted", { operationId }));
    await submitting;
    expect(controller.dismiss()).toMatchObject({ sheetOpen: false, progress: null });

    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, sheetOpen: false });
    expect(controller.close()).toBe(closed);
  });

  it("fails invalid operation-id generation before a protected request", async () => {
    const port = compactPort();
    const controller = createController(port, context(), () => "invalid");
    await controller.open();
    controller.beginConfirmation();
    expect(await controller.confirm()).toMatchObject({ phase: "start_failure" });
    expect(port.start).not.toHaveBeenCalled();
  });

  it("rejects malformed construction and enforces subscriber and closed-owner bounds", () => {
    const validContext = context();
    const validPort = compactPort();
    expect(() => createCompactControlController({
      sessionId: "" as SessionId,
      context: validContext,
      port: validPort,
      createOperationId: () => operationId
    })).toThrow();
    expect(() => createCompactControlController({
      sessionId,
      context: { ...validContext, extra: true } as unknown as CompactControlContext,
      port: validPort,
      createOperationId: () => operationId
    })).toThrow("HostDeck compact-control context is invalid.");
    expect(() => createCompactControlController({
      sessionId,
      context: validContext,
      port: { read: validPort.read, start: validPort.start, extra: true } as unknown as CompactControlPort,
      createOperationId: () => operationId
    })).toThrow("HostDeck compact-control port is invalid.");

    const controller = createController(validPort);
    const duplicate = vi.fn();
    const unsubscribe = controller.subscribe(duplicate);
    expect(() => controller.subscribe(duplicate)).toThrow("HostDeck compact-control listener is invalid.");
    const unsubscribers = [unsubscribe];
    for (let index = 1; index < 32; index += 1) unsubscribers.push(controller.subscribe(vi.fn()));
    expect(() => controller.subscribe(vi.fn())).toThrow("HostDeck compact-control listener capacity is exhausted.");
    for (const release of unsubscribers) release();
    controller.close();
    expect(() => controller.subscribe(vi.fn())).toThrow("HostDeck compact-control listener is invalid.");
    expect(() => controller.updateContext(validContext)).toThrow("HostDeck compact control is closed.");
  });

  it("maps explicit connection failures without leaking raw causes", async () => {
    const view = await createController(compactPort({
      read: async () => { throw new HostDeckBrowserConnectionError("not_ready"); }
    })).open();
    expect(view).toMatchObject({ phase: "read_failure" });
    expect(JSON.stringify(view)).not.toContain("not_ready");
  });
});

function createController(
  port: ReturnType<typeof compactPort>,
  initialContext = context(),
  createOperationId: () => string = () => operationId
) {
  return createCompactControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId
  });
}

function compactPort(overrides: Partial<CompactControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => compactResponse(null))),
    start: vi.fn(overrides.start ?? (async (input) =>
      compactResponse("accepted", { operationId: input.request.operation_id })
    ))
  };
}

function compactResponse(
  state: "accepted" | "running" | "completed" | "interrupted" | "failed" | "incomplete" | null,
  input: Readonly<{
    operationId?: string;
    retryable?: boolean;
    targetSessionId?: string;
    targetThreadId?: string;
    turnId?: string | null;
  }> = {}
) {
  if (state === null) return compactProgressResponseSchema.parse({ progress: null });
  const error = state === "failed" || state === "incomplete"
    ? {
        code: state === "incomplete" ? "unknown_error" as const : "runtime_unavailable" as const,
        message: "Selected public Compact fixture detail.",
        retryable: input.retryable ?? false
      }
    : null;
  const defaultTurnId = ["running", "completed", "interrupted", "failed"].includes(state)
    ? "turn-compact-component-private"
    : null;
  return compactProgressResponseSchema.parse({
    progress: selectedOperationProgressSchema.parse({
      operation_id: input.operationId ?? operationId,
      kind: "compact",
      target: {
        type: "managed_session",
        session_id: input.targetSessionId ?? sessionId,
        codex_thread_id: input.targetThreadId ?? threadId
      },
      state,
      updated_at: timestamp,
      turn_id: input.turnId === undefined ? defaultTurnId : input.turnId,
      error
    })
  });
}

function context(input: Readonly<{
  epoch?: number;
  deviceId?: string;
  permission?: "read" | "write";
  locked?: boolean;
  canRead?: boolean;
  accessState?: BrowserConnectionResourceState;
  targetState?: BrowserConnectionResourceState;
  freshness?: "current" | "stale";
  projectedThreadId?: string;
  turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
}> = {}): CompactControlContext {
  const freshness = input.freshness ?? "current";
  const permission = input.permission ?? "write";
  const locked = input.locked ?? false;
  const canRead = input.canRead ?? true;
  const writeEligible = canRead && permission === "write" && !locked;
  const projection = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/compact-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    created_at: timestamp,
    archived_at: null,
    session_state: freshness === "current" ? "active" : "stale",
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/compact-component",
    model: "runtime-compact",
    settings: null,
    goal: null,
    recent_summary: "Validate structured Compact control.",
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
  const response = selectedSessionDetailResponseSchema.parse({
    access: {
      mode: permission === "write" ? "paired_write" : "paired_read",
      network_mode: "remote",
      transport: "https"
    },
    session: item
  });
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: canRead ? "ready" : "access_limited",
    access: resource(
      input.accessState ?? "current",
      access(canRead, {
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        permission,
        locked
      })
    ),
    host: resource("current", null),
    targetState: resource(
      input.targetState ?? "current",
      Object.freeze({ kind: "session_detail" as const, response })
    ),
    stream: Object.freeze({
      state: "connected" as const,
      snapshot: null,
      continuity: "contiguous" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: writeEligible ? "ready" as const : "idle" as const,
      generation: writeEligible ? 1 : null,
      rotatedAt: writeEligible ? timestamp : null,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: writeEligible,
      causes: Object.freeze(
        writeEligible
          ? []
          : [locked ? "host_locked" as const : "read_only_access" as const]
      )
    }),
    lastFailure: null
  });
  return Object.freeze({ snapshot });
}

function access(
  canRead: boolean,
  input: Readonly<{
    deviceId?: string;
    permission: "read" | "write";
    locked: boolean;
  }>
) {
  if (!canRead) {
    return selectedAccessStateResponseSchema.parse({
      authentication_state: "unpaired",
      device_id: null,
      permission: null,
      device_expires_at: null,
      configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
      network_mode: "remote",
      transport: "https",
      locked: false,
      can_read_sessions: false,
      can_write_sessions: false,
      can_lock: false,
      can_unlock: false
    });
  }
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: input.deviceId ?? "device-compact-component-private",
    permission: input.permission,
    device_expires_at: "2026-10-27T16:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked: input.locked,
    can_read_sessions: true,
    can_write_sessions: input.permission === "write" && !input.locked,
    can_lock: input.permission === "write",
    can_unlock: false
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

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "compact_read",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function csrfApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserCsrfError({
    reason: "api_error",
    operation: "mutation",
    routeId: "compact_start",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return { code, message: "Selected public Compact fixture detail.", retryable };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
