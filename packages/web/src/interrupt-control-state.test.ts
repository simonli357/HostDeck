import {
  type ApiErrorEnvelope,
  interruptResponseSchema,
  managedSessionProjectionSchema,
  type SelectedProjectionEvent,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionWriteBlockCause
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import {
  createInterruptControlController, 
  type InterruptControlContext,
  type InterruptControlPort
} from "./interrupt-control-state.js";

const sessionId = "sess_interrupt_component_001" as SessionId;
const threadId = "thread-interrupt-component-private";
const turnId = "turn-interrupt-component-001";
const operationId = "op_browser_interrupt_component_001";
const timestamp = "2026-07-27T18:00:00.000Z";
const laterTimestamp = "2026-07-27T18:01:00.000Z";
const remoteOrigin = "https://hostdeck-laptop.fixture-tailnet.ts.net";

describe("interrupt control state", () => {
  it("derives one exact active turn without exposing private target identity", () => {
    const controller = createController();

    expect(controller.snapshot()).toMatchObject({
      visible: true,
      sheetOpen: false,
      phase: "closed",
      actionEnabled: true,
      target: {
        sessionLabel: "android-release",
        turnId,
        state: "in_progress",
        stateLabel: "In progress"
      }
    });
    expect(controller.open()).toMatchObject({
      sheetOpen: true,
      phase: "ready",
      status: "Active turn ready"
    });
    const serialized = JSON.stringify(controller.snapshot());
    expect(serialized).not.toMatch(/thread-interrupt|op_browser|private\/interrupt|device-interrupt/iu);
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(Object.isFrozen(controller.snapshot().target)).toBe(true);
  });

  it("suppresses retained target and result disclosure when readable authority is lost", async () => {
    const pending = deferred<unknown>();
    const controller = createController(interruptPort({ interrupt: () => pending.promise }));
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    await Promise.resolve();

    controller.updateContext(context({ accessState: "blocked" }));
    expect(controller.snapshot()).toMatchObject({
      visible: false,
      target: null,
      result: null
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/android-release|turn-interrupt/iu);

    pending.resolve(interruptResponse());
    await submitted;
    expect(controller.snapshot()).toMatchObject({
      visible: false,
      target: null,
      result: null
    });
  });

  it("admits all and only the three event-proven active projection states", () => {
    for (const [state, label] of [
      ["in_progress", "In progress"],
      ["waiting_for_input", "Waiting for input"],
      ["waiting_for_approval", "Waiting for approval"]
    ] as const) {
      const view = createController(undefined, context({
        turnState: state,
        events: [turnEvent(1, state)]
      })).snapshot();
      expect(view).toMatchObject({
        actionEnabled: true,
        target: { state, stateLabel: label }
      });
    }

    for (const [state, reason] of [
      ["idle", "no active turn"],
      ["completed", "already completed"],
      ["interrupted", "already interrupted"],
      ["failed", "already failed"],
      ["unknown", "state is unknown"]
    ] as const) {
      const view = createController(undefined, context({ turnState: state })).snapshot();
      expect(view.actionEnabled).toBe(false);
      expect(view.actionDisabledReason?.toLowerCase()).toContain(reason);
    }
  });

  it("uses the latest state per turn and rejects missing, mismatched, ambiguous, or boundary-obscured evidence", () => {
    const latest = createController(undefined, context({
      turnState: "waiting_for_input",
      events: [
        turnEvent(1, "in_progress"),
        turnEvent(2, "waiting_for_input")
      ]
    })).snapshot();
    expect(latest).toMatchObject({ actionEnabled: true, target: { state: "waiting_for_input" } });

    const cases = [
      context({ events: [] }),
      context({ turnState: "waiting_for_input", events: [turnEvent(1, "in_progress")] }),
      context({
        events: [
          turnEvent(1, "in_progress", "turn-interrupt-first"),
          turnEvent(2, "in_progress", "turn-interrupt-second")
        ]
      }),
      context({
        events: [turnEvent(4, "in_progress")],
        boundary: { after: 4, cursor: 5, reason: "disconnect" }
      })
    ];
    for (const testContext of cases) {
      const view = createController(undefined, testContext).snapshot();
      expect(view.actionEnabled).toBe(false);
      expect(view.actionDisabledReason).not.toBeNull();
    }
  });

  it("accepts adoption boundaries and derives interrupt authority only from later turn evidence", () => {
    const boundary = { after: null, cursor: 1, reason: "adoption" } as const;
    const idle = createController(undefined, context({
      turnState: "idle",
      events: [boundaryEvent(1, null, "adoption"), turnEvent(2, "completed")],
      boundary
    })).snapshot();
    expect(idle).toMatchObject({ actionEnabled: false, target: null });

    const active = createController(undefined, context({
      events: [boundaryEvent(1, null, "adoption"), turnEvent(2, "in_progress")],
      boundary
    })).snapshot();
    expect(active).toMatchObject({
      actionEnabled: true,
      target: { turnId, state: "in_progress" }
    });
  });

  it("freezes the exact confirmation target and invalidates it before dispatch when state changes", async () => {
    const port = interruptPort();
    const createOperationId = vi.fn(() => operationId);
    const controller = createController(port, context(), createOperationId);
    controller.open();
    expect(controller.beginConfirmation()).toMatchObject({
      phase: "confirming",
      confirmationOpen: true,
      confirmEnabled: true
    });

    controller.updateContext(context({
      turnState: "completed",
      events: [turnEvent(1, "in_progress"), turnEvent(2, "completed")]
    }));
    expect(controller.snapshot()).toMatchObject({
      phase: "unavailable",
      confirmationOpen: false,
      confirmEnabled: false
    });
    await controller.confirm();
    expect(createOperationId).not.toHaveBeenCalled();
    expect(port.interrupt).not.toHaveBeenCalled();
  });

  it("invalidates confirmation when exact target or write authority is replaced", async () => {
    for (const replacement of [
      context({ projectedThreadId: "thread-interrupt-replaced" }),
      context({ epoch: 2 })
    ]) {
      const port = interruptPort();
      const createOperationId = vi.fn(() => operationId);
      const controller = createController(port, context(), createOperationId);
      controller.open();
      controller.beginConfirmation();

      expect(controller.updateContext(replacement)).toMatchObject({
        confirmationOpen: false,
        confirmEnabled: false
      });
      await controller.confirm();
      expect(createOperationId).not.toHaveBeenCalled();
      expect(port.interrupt).not.toHaveBeenCalled();
    }
  });

  it("creates one operation id after confirmation and coalesces one exact protected request", async () => {
    const pending = deferred<unknown>();
    const port = interruptPort({ interrupt: () => pending.promise });
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
      status: "Waiting for confirmed result"
    });
    expect(controller.snapshot().statusDetail).not.toMatch(/accepted|completed/iu);
    expect(controller.dismiss()).toBe(controller.snapshot());
    expect(controller.cancelConfirmation()).toBe(controller.snapshot());
    expect(createOperationId).toHaveBeenCalledTimes(1);
    expect(port.interrupt).toHaveBeenCalledTimes(1);
    expect(port.interrupt.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      turnId,
      request: { operation_id: operationId, kind: "interrupt", confirm: true }
    });
    expect(Object.keys(port.interrupt.mock.calls[0]?.[0].request ?? {})).toEqual([
      "operation_id",
      "kind",
      "confirm"
    ]);
    expect(port.interrupt.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);

    pending.resolve(interruptResponse());
    await expect(first).resolves.toMatchObject({
      phase: "confirmed_interrupted",
      resultOpen: true,
      result: {
        kind: "confirmed_interrupted",
        source: "api",
        terminalState: "interrupted"
      }
    });
    expect(port.interrupt).toHaveBeenCalledTimes(1);
  });

  it("accepts only a strict terminal response correlated to operation, session, thread, and turn", async () => {
    const candidates = [
      { ...interruptResponse(), extra: true },
      interruptResponse({ operationId: "op_browser_interrupt_foreign_001" }),
      interruptResponse({ session: "sess_interrupt_foreign" }),
      interruptResponse({ thread: "thread-interrupt-foreign" }),
      interruptResponse({ turn: "turn-interrupt-foreign" })
    ];
    for (const candidate of candidates) {
      const controller = createController(interruptPort({ interrupt: async () => candidate }));
      controller.open();
      controller.beginConfirmation();
      const view = await controller.confirm();
      expect(view).toMatchObject({
        phase: "outcome_unknown",
        result: { kind: "outcome_unknown" },
        actionEnabled: false
      });
      expect(JSON.stringify(view)).not.toMatch(/foreign|op_browser_interrupt/iu);
    }
  });

  it("maps stable authority rejection separately and never resends an attempted exact turn", async () => {
    for (const code of ["read_only", "permission_denied", "host_locked"] as const) {
      const port = interruptPort({
        interrupt: async () => { throw csrfApiError(code); }
      });
      const controller = createController(port);
      controller.open();
      controller.beginConfirmation();
      expect(await controller.confirm()).toMatchObject({
        phase: "blocked",
        result: { kind: "blocked" },
        actionEnabled: false
      });
      controller.acknowledgeResult();
      controller.beginConfirmation();
      await controller.confirm();
      expect(port.interrupt).toHaveBeenCalledTimes(1);
    }
  });

  it("makes secure operation-id failure explicit and sends no request", async () => {
    const port = interruptPort();
    const controller = createController(port, context(), () => {
      throw new TypeError("private crypto failure");
    });
    controller.open();
    controller.beginConfirmation();

    expect(await controller.confirm()).toMatchObject({
      phase: "blocked",
      resultOpen: true,
      result: {
        kind: "blocked",
        label: "Secure interrupt setup unavailable"
      },
      actionEnabled: false
    });
    expect(port.interrupt).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.snapshot())).not.toContain("private crypto failure");
  });

  it("keeps every ambiguous post-invocation error unknown and exposes no retry path", async () => {
    for (const code of [
      "operation_conflict",
      "operation_timeout",
      "unknown_error",
      "protocol_error",
      "audit_unavailable",
      "runtime_unavailable",
      "stale_session"
    ] as const) {
      const port = interruptPort({ interrupt: async () => { throw csrfApiError(code); } });
      const controller = createController(port);
      controller.open();
      controller.beginConfirmation();
      const view = await controller.confirm();
      expect(view).toMatchObject({
        phase: "outcome_unknown",
        resultOpen: true,
        result: { kind: "outcome_unknown", terminalState: null }
      });
      expect(view.result?.detail).toContain("will not resend");
      controller.acknowledgeResult();
      controller.beginConfirmation();
      await controller.confirm();
      expect(port.interrupt).toHaveBeenCalledTimes(1);
    }
  });

  it("strengthens an uncertain result only from a later exact-turn terminal event", async () => {
    for (const [terminal, kind, label] of [
      ["interrupted", "feed_interrupted", "Turn ended as interrupted"],
      ["completed", "not_interrupted", "Turn completed"],
      ["failed", "not_interrupted", "Turn failed"]
    ] as const) {
      const pending = deferred<unknown>();
      const controller = createController(interruptPort({ interrupt: () => pending.promise }));
      controller.open();
      controller.beginConfirmation();
      const submitted = controller.confirm();
      controller.updateContext(context({
        turnState: terminal,
        events: [turnEvent(1, "in_progress"), turnEvent(2, terminal)]
      }));
      expect(controller.snapshot()).toMatchObject({ phase: "submitting", busy: true });
      pending.reject(new TypeError("private transport failure"));
      const view = await submitted;
      expect(view).toMatchObject({
        phase: kind,
        result: { kind, label, terminalState: terminal }
      });
      expect(JSON.stringify(view)).not.toContain("private transport failure");
    }
  });

  it("does not use another turn, elapsed time, or a post-attempt replay boundary as terminal proof", async () => {
    const pending = deferred<unknown>();
    const controller = createController(interruptPort({ interrupt: () => pending.promise }));
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();

    controller.updateContext(context({
      events: [turnEvent(3, "in_progress", "turn-interrupt-new")],
      boundary: { after: 1, cursor: 2, reason: "disconnect" }
    }));
    pending.reject(new TypeError("unavailable"));
    expect(await submitted).toMatchObject({
      phase: "outcome_unknown",
      result: { kind: "outcome_unknown", terminalState: null }
    });
  });

  it("fails closed when target identity or feed cursor regresses after dispatch", async () => {
    for (const replacement of [
      context({ projectedThreadId: "thread-interrupt-replaced" }),
      context({ events: [] })
    ]) {
      const pending = deferred<unknown>();
      const port = interruptPort({ interrupt: () => pending.promise });
      const controller = createController(port);
      controller.open();
      controller.beginConfirmation();
      const submitted = controller.confirm();
      controller.updateContext(replacement);

      pending.resolve(interruptResponse());
      expect(await submitted).toMatchObject({
        phase: "inconsistent",
        result: { kind: "inconsistent", terminalState: null }
      });
      controller.acknowledgeResult();
      controller.beginConfirmation();
      await controller.confirm();
      expect(port.interrupt).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects duplicate exact-turn terminal evidence as inconsistent", async () => {
    const pending = deferred<unknown>();
    const controller = createController(interruptPort({ interrupt: () => pending.promise }));
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    controller.updateContext(context({
      turnState: "completed",
      events: [
        turnEvent(1, "in_progress"),
        turnEvent(2, "completed"),
        turnEvent(3, "completed")
      ]
    }));

    pending.reject(new TypeError("private duplicate-terminal failure"));
    expect(await submitted).toMatchObject({
      phase: "inconsistent",
      result: { kind: "inconsistent", terminalState: null }
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private duplicate-terminal");
  });

  it("fails closed when terminal feed truth contradicts an API success", async () => {
    const pending = deferred<unknown>();
    const controller = createController(interruptPort({ interrupt: () => pending.promise }));
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    controller.updateContext(context({
      turnState: "completed",
      events: [turnEvent(1, "in_progress"), turnEvent(2, "completed")]
    }));
    pending.resolve(interruptResponse());
    expect(await submitted).toMatchObject({
      phase: "inconsistent",
      result: { kind: "inconsistent", terminalState: null }
    });
  });

  it("keeps the attempted target latched but admits a different proven turn after acknowledgement", async () => {
    const port = interruptPort({ interrupt: () => { throw new TypeError("unknown"); } });
    const controller = createController(port);
    controller.open();
    controller.beginConfirmation();
    await controller.confirm();
    expect(controller.snapshot().actionEnabled).toBe(false);

    controller.updateContext(context({
      events: [
        turnEvent(1, "in_progress"),
        turnEvent(2, "completed"),
        turnEvent(3, "in_progress", "turn-interrupt-component-002")
      ]
    }));
    expect(controller.snapshot().actionDisabledReason).toContain("Review the prior interrupt result");
    controller.acknowledgeResult();
    expect(controller.snapshot()).toMatchObject({
      actionEnabled: true,
      target: { turnId: "turn-interrupt-component-002" }
    });
    controller.beginConfirmation();
    await controller.confirm();
    expect(port.interrupt).toHaveBeenCalledTimes(2);
  });

  it("keeps every attempted turn latched across later distinct attempts", async () => {
    const secondTurnId = "turn-interrupt-component-002";
    const port = interruptPort({ interrupt: () => { throw new TypeError("unknown"); } });
    const controller = createController(port);
    controller.open();
    controller.beginConfirmation();
    await controller.confirm();
    controller.acknowledgeResult();

    controller.updateContext(context({
      events: [
        turnEvent(1, "in_progress"),
        turnEvent(2, "completed"),
        turnEvent(3, "in_progress", secondTurnId)
      ]
    }));
    controller.beginConfirmation();
    await controller.confirm();
    controller.acknowledgeResult();

    controller.updateContext(context({
      events: [turnEvent(4, "in_progress")]
    }));
    expect(controller.snapshot()).toMatchObject({
      actionEnabled: false,
      actionDisabledReason: "An interrupt was already submitted for this exact turn."
    });
    controller.beginConfirmation();
    await controller.confirm();
    expect(port.interrupt).toHaveBeenCalledTimes(2);
  });

  it("shows explicit read-only, host-lock, reconnect, continuity, stale, and inactive reasons", () => {
    const cases: readonly [InterruptControlContext, string][] = [
      [context({ permission: "read" }), "Read-only"],
      [context({ locked: true }), "locked"],
      [context({ streamState: "connecting" }), "reconnecting"],
      [context({ continuity: "unproven" }), "not proven"],
      [context({ freshness: "stale" }), "stale"],
      [context({ turnState: "completed" }), "completed"]
    ];
    for (const [testContext, copy] of cases) {
      const view = createController(undefined, testContext).snapshot();
      expect(view.actionEnabled).toBe(false);
      expect(view.actionDisabledReason?.toLowerCase()).toContain(copy.toLowerCase());
    }
  });

  it("rejects malformed ownership, cursor gaps, accessors, extra options, and invalid listeners", () => {
    const validContext = context();
    const validPort = interruptPort();
    expect(() => createInterruptControlController({
      sessionId,
      context: validContext,
      port: validPort,
      createOperationId: () => operationId,
      extra: true
    } as never)).toThrow("HostDeck interrupt-control options are invalid.");
    expect(() => createController(validPort, {
      ...validContext,
      events: [turnEvent(1, "in_progress", turnId, "sess_interrupt_foreign")]
    })).toThrow("invalid event ownership");
    expect(() => createController(validPort, {
      ...validContext,
      events: [turnEvent(1, "in_progress"), turnEvent(3, "in_progress")]
    })).toThrow("event cursor gap");
    const accessorPort = {} as Record<string, unknown>;
    Object.defineProperty(accessorPort, "interrupt", {
      enumerable: true,
      get: () => vi.fn()
    });
    expect(() => createInterruptControlController({
      sessionId,
      context: validContext,
      port: accessorPort as never,
      createOperationId: () => operationId
    })).toThrow("HostDeck interrupt-control port is invalid.");

    const controller = createController(validPort);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    expect(() => controller.subscribe(listener)).toThrow("listener is invalid");
    const releases = [unsubscribe];
    for (let index = 1; index < 32; index += 1) releases.push(controller.subscribe(vi.fn()));
    expect(() => controller.subscribe(vi.fn())).toThrow("capacity is exhausted");
    for (const release of releases) release();
  });

  it("aborts owned work, suppresses late settlement, and rejects updates after close", async () => {
    const pending = deferred<unknown>();
    const port = interruptPort({ interrupt: () => pending.promise });
    const controller = createController(port);
    controller.open();
    controller.beginConfirmation();
    const submitted = controller.confirm();
    await Promise.resolve();
    const signal = port.interrupt.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    expect(controller.close()).toMatchObject({ phase: "hidden", visible: false });
    expect(signal?.aborted).toBe(true);
    pending.resolve(interruptResponse());
    await expect(submitted).resolves.toBe(controller.snapshot());
    expect(controller.snapshot()).toMatchObject({ phase: "hidden", result: null });
    expect(() => controller.updateContext(context())).toThrow("HostDeck interrupt control is closed.");
    expect(() => controller.subscribe(vi.fn())).toThrow("listener is invalid");
  });
});

function createController(
  port = interruptPort(),
  initialContext = context(),
  createOperationId: () => string = () => operationId
) {
  return createInterruptControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId
  });
}

function interruptPort(overrides: Partial<InterruptControlPort> = {}) {
  return {
    interrupt: vi.fn(overrides.interrupt ?? (async (input) =>
      interruptResponse({ operationId: input.request.operation_id, turn: input.turnId })
    ))
  };
}

function interruptResponse(input: Readonly<{
  operationId?: string;
  session?: string;
  thread?: string;
  turn?: string;
}> = {}) {
  const exactTurn = input.turn ?? turnId;
  return interruptResponseSchema.parse({
    operation_id: input.operationId ?? operationId,
    kind: "interrupt",
    target: {
      type: "turn",
      session_id: input.session ?? sessionId,
      codex_thread_id: input.thread ?? threadId,
      turn_id: exactTurn
    },
    state: "interrupted",
    updated_at: laterTimestamp,
    turn_id: exactTurn,
    error: null
  });
}

function context(input: Readonly<{
  epoch?: number;
  permission?: "read" | "write";
  locked?: boolean;
  accessState?: BrowserConnectionResourceState;
  targetState?: BrowserConnectionResourceState;
  freshness?: "current" | "stale";
  sessionState?: "active" | "archived";
  turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
  projectedThreadId?: string;
  events?: readonly SelectedProjectionEvent[];
  boundary?: InterruptControlContext["boundary"];
  streamState?: BrowserConnectionSnapshot["stream"]["state"];
  continuity?: BrowserConnectionSnapshot["stream"]["continuity"];
  writeCause?: BrowserConnectionWriteBlockCause;
}> = {}): InterruptControlContext {
  const permission = input.permission ?? "write";
  const locked = input.locked ?? false;
  const freshness = input.freshness ?? "current";
  const sessionState = input.sessionState ?? (freshness === "current" ? "active" : "active");
  const turnState = input.turnState ?? "in_progress";
  const events = input.events ?? (activeTurnState(turnState) ? [turnEvent(1, turnState)] : []);
  const accessData = access(permission, locked);
  const writeCause = input.writeCause ?? (
    permission === "read" ? "read_only_access" : locked ? "host_locked" : null
  );
  const writeEligible = writeCause === null;
  const archived = sessionState === "archived";
  const projection = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/interrupt-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    created_at: timestamp,
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
    branch: "feat/interrupt-component",
    model: "runtime-interrupt",
    settings: null,
    goal: null,
    recent_summary: "Validate exact active-turn interrupt control.",
    last_event_cursor: events.at(-1)?.cursor ?? null
  });
  const item = selectedSessionReadItemSchema.parse({
    session: projection,
    event_window: events.length === 0
      ? {
          state: "empty",
          retained_event_count: 0,
          earliest_retained_cursor: null,
          boundary_cursor: null
        }
      : {
          state: "contiguous",
          retained_event_count: events.length,
          earliest_retained_cursor: events[0]?.cursor,
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
  const boundary = input.boundary ?? null;
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready" as const,
    access: resource(input.accessState ?? "current", accessData),
    host: resource("current", hostStatus(accessData)),
    targetState: resource(
      input.targetState ?? "current",
      Object.freeze({ kind: "session_detail" as const, response })
    ),
    stream: Object.freeze({
      state: input.streamState ?? "connected",
      snapshot: null,
      continuity: input.continuity ?? (boundary === null ? "contiguous" : "boundary"),
      boundary,
      failure: null
    }),
    csrf: Object.freeze({
      phase: writeEligible ? "ready" as const : permission === "write" ? "ready" as const : "idle" as const,
      generation: writeEligible || permission === "write" ? 1 : null,
      rotatedAt: writeEligible || permission === "write" ? timestamp : null,
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
  return Object.freeze({ snapshot, events: Object.freeze([...events]), boundary });
}

function turnEvent(
  cursor: number,
  state: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown",
  exactTurnId = turnId,
  exactSessionId: string = sessionId
) {
  return selectedProjectionEventSchema.parse({
    session_id: exactSessionId,
    cursor,
    captured_at: cursor === 1 ? timestamp : laterTimestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: exactTurnId,
    state,
    error: state === "failed"
      ? { code: "runtime_unavailable", message: "Bounded selected failure." }
      : null
  });
}

function boundaryEvent(
  cursor: number,
  after: number | null,
  reason: "retention" | "disconnect" | "restart" | "schema_change" | "adoption"
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason
  });
}

function activeTurnState(state: string): state is "in_progress" | "waiting_for_input" | "waiting_for_approval" {
  return ["in_progress", "waiting_for_input", "waiting_for_approval"].includes(state);
}

function access(permission: "read" | "write", locked: boolean) {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-interrupt-component-private",
    permission,
    device_expires_at: "2026-10-27T18:00:00.000Z",
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: true,
    can_write_sessions: permission === "write" && !locked,
    can_lock: permission === "write",
    can_unlock: false
  });
}

function hostStatus(accessData: ReturnType<typeof access>) {
  const readOnly = accessData.permission === "read";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
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
    reason: code === "read_only" || code === "permission_denied" || code === "host_locked"
      ? "authority_rejected"
      : "api_error",
    operation: "mutation",
    routeId: "turn_interrupt",
    transport: "https",
    status: code === "operation_timeout" ? 504 : 409,
    apiError: {
      code,
      message: "Selected private interrupt fixture detail.",
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
