import {
  type ApiErrorEnvelope,
  formatSelectedResumeLaunchCommand,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedResumeMetadataResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";
import {
  createLaptopResumeControlController,
  type LaptopResumeControlContext,
  type LaptopResumeControlPort
} from "./laptop-resume-control-state.js";

const sessionId = "sess_laptop_resume_component_001" as SessionId;
const threadId = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";
const foreignThreadId = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a5";
const timestamp = "2026-07-27T22:00:00.000Z";
const command = formatSelectedResumeLaunchCommand({
  executable: "codex",
  args: ["resume", threadId]
});

describe("laptop-resume control state", () => {
  it("loads one exact current command and projects no separate launch fields", async () => {
    const port = resumePort();
    const controller = createController(port);

    const opening = controller.open();
    expect(controller.snapshot()).toMatchObject({
      phase: "loading",
      busy: true,
      sheetOpen: true,
      command: null,
      copyEnabled: false
    });
    const view = await opening;

    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      signal: expect.any(AbortSignal)
    });
    expect(view).toMatchObject({
      phase: "available",
      tone: "connected",
      status: "Exact laptop command ready",
      targetLabel: "android-release",
      available: true,
      command,
      commandFreshness: "current",
      copyEnabled: true,
      copyPhase: "idle"
    });
    expect(Object.keys(view)).not.toEqual(
      expect.arrayContaining(["launch", "executable", "args", "socket", "threadId"])
    );
    expect(Object.isFrozen(view)).toBe(true);
    expect(port.writeClipboard).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", "read", true, "connected", "contiguous"],
    ["in_progress", "read", true, "failed", "unproven"],
    ["waiting_for_input", "write", true, "reconnecting", "boundary"],
    ["waiting_for_approval", "write", false, "connected", "contiguous"],
    ["unknown", "read", false, "idle", "unproven"]
  ] as const)(
    "allows read-only laptop handoff for %s regardless of write/lock/stream state",
    async (turnState, permission, locked, streamState, continuity) => {
      const port = resumePort();
      const controller = createController(
        port,
        context({ permission, locked, turnState, streamState, continuity })
      );

      expect(controller.snapshot()).toMatchObject({
        visible: true,
        actionEnabled: true
      });
      await controller.open();
      expect(controller.snapshot()).toMatchObject({
        phase: "available",
        copyEnabled: true
      });
      expect(port.read).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects non-current or ineligible detail before reading or copying", async () => {
    const base = context();
    const cases: readonly [LaptopResumeControlContext, string][] = [
      [context({ freshness: "stale" }), "stale"],
      [context({ sessionState: "archived" }), "archived"],
      [context({ sessionState: "incompatible" }), "incompatible"],
      [context({ accessState: "stale" }), "not current"],
      [context({ targetState: "stale" }), "not current"],
      [Object.freeze({
        snapshot: Object.freeze({
          ...base.snapshot,
          targetState: resource("current", null)
        })
      }), "not available"],
      [Object.freeze({
        snapshot: Object.freeze({
          ...base.snapshot,
          target: Object.freeze({
            kind: "session_detail" as const,
            sessionId: "sess_laptop_resume_foreign_001"
          })
        })
      }), "not available"]
    ];

    for (const [initialContext, reason] of cases) {
      const port = resumePort();
      const controller = createController(port, initialContext);
      expect(controller.snapshot()).toMatchObject({ actionEnabled: false });
      expect(controller.snapshot().actionDisabledReason?.toLowerCase())
        .toContain(reason.toLowerCase());
      await controller.open();
      await controller.copy();
      expect(port.read).not.toHaveBeenCalled();
      expect(port.writeClipboard).not.toHaveBeenCalled();
    }
  });

  it("coalesces open and explicit refresh while keeping the prior command stale", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let reads = 0;
    const port = resumePort({
      read: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      }
    });
    const controller = createController(port);

    const opening = controller.open();
    expect(controller.open()).toBe(opening);
    await Promise.resolve();
    expect(port.read).toHaveBeenCalledTimes(1);
    first.resolve(availableResponse());
    await opening;

    const refreshing = controller.refresh();
    expect(controller.refresh()).toBe(refreshing);
    expect(controller.snapshot()).toMatchObject({
      phase: "stale",
      command,
      commandFreshness: "stale",
      copyEnabled: false
    });
    await Promise.resolve();
    expect(port.read).toHaveBeenCalledTimes(2);
    second.resolve(availableResponse());
    await refreshing;
    expect(controller.snapshot()).toMatchObject({
      phase: "available",
      commandFreshness: "current",
      copyEnabled: true
    });
  });

  it("accepts exact unavailable metadata without inventing a command or launch result", async () => {
    const reason = "The selected Codex runtime is not available for laptop resume.";
    const port = resumePort({ read: async () => unavailableResponse(reason) });
    const controller = createController(port);

    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase: "unavailable",
      status: "Laptop resume unavailable",
      available: false,
      unavailableReason: reason,
      command: null,
      copyEnabled: false,
      refreshEnabled: true
    });
    await controller.copy();
    expect(port.writeClipboard).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/started|attached|resumed work/iu);
  });

  it("rejects malformed, extra, cross-session, wrong-thread, and contradictory responses", async () => {
    const launch = {
      executable: "codex",
      args: ["resume", threadId]
    } as const;
    const responses = [
      availableResponse({ session: "sess_laptop_resume_foreign_001" }),
      availableResponse({ thread: foreignThreadId }),
      { ...availableResponse(), extra: true },
      { ...availableResponse(), command: "codex resume contradictory" },
      {
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: true,
        command,
        launch: null,
        unavailable_reason: null
      },
      {
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: false,
        available: true,
        command,
        launch,
        unavailable_reason: null
      }
    ];

    for (const response of responses) {
      const controller = createController(resumePort({ read: async () => response }));
      await controller.open();
      expect(controller.snapshot()).toMatchObject({
        phase: "failure",
        status: "Laptop command could not be loaded",
        command: null,
        copyEnabled: false
      });
    }
  });

  it.each([
    ["session_not_found", "not_found", "Managed session not found"],
    ["stale_session", "stale_session", "Session not eligible"],
    ["session_not_writable", "stale_session", "Session not eligible"],
    ["permission_denied", "access_denied", "Laptop command access blocked"],
    ["invalid_origin", "access_denied", "Laptop command access blocked"],
    ["runtime_unavailable", "runtime_unavailable", "Laptop runtime unavailable"],
    ["incompatible_runtime", "runtime_unavailable", "Laptop runtime unavailable"],
    ["storage_error", "failure", "Laptop command could not be loaded"],
    ["operation_timeout", "failure", "Laptop command could not be loaded"],
    ["rate_limited", "failure", "Laptop command could not be loaded"],
    ["protocol_error", "failure", "Laptop command could not be loaded"],
    ["internal_error", "failure", "Laptop command could not be loaded"]
  ] as const)("maps %s to bounded %s read truth", async (code, phase, status) => {
    const controller = createController(resumePort({
      read: async () => {
        throw httpApiError(code);
      }
    }));

    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase,
      status,
      command: null,
      copyEnabled: false,
      refreshEnabled: true
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/private api detail|\/private\/cwd/iu);
  });

  it("classifies failures from bounded code rather than status, retryability, or private message", async () => {
    const controller = createController(resumePort({
      read: async () => {
        throw new HostDeckBrowserHttpError({
          reason: "api_error",
          routeId: "session_resume_metadata",
          transport: "https",
          status: 404,
          apiError: {
            code: "storage_error",
            message: "session_not_found stale_session permission_denied /private/cwd",
            retryable: true
          }
        });
      }
    }));

    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      statusDetail: "Managed session state is unavailable on the laptop."
    });
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/session_not_found|\/private\/cwd/iu);
  });

  it.each([
    ["invalid_response", "Laptop resume metadata failed strict validation."],
    ["response_too_large", "Laptop resume metadata failed strict validation."],
    ["deadline_exceeded", "The laptop resume metadata read timed out."],
    ["capacity_exhausted", "HostDeck is temporarily unable to read laptop resume metadata."],
    ["caller_aborted", "The laptop resume metadata read was cancelled."],
    [
      "transport_unavailable",
      "Laptop resume metadata could not be loaded. Check the connection and try again."
    ]
  ] as const)("maps browser HTTP %s without leaking transport internals", async (reason, detail) => {
    const controller = createController(resumePort({
      read: async () => {
        throw new HostDeckBrowserHttpError({
          reason,
          routeId: "session_resume_metadata",
          transport: "https",
          status: null,
          apiError: null
        });
      }
    }));

    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      status: "Laptop command could not be loaded",
      statusDetail: detail,
      command: null,
      refreshEnabled: true
    });
  });

  it("marks a same-target capture stale across epochs until one explicit refresh", async () => {
    const port = resumePort();
    const controller = createController(port);
    await controller.open();

    expect(controller.updateContext(context({ epoch: 2 }))).toMatchObject({
      sheetOpen: true,
      phase: "stale",
      command,
      commandFreshness: "stale",
      copyEnabled: false,
      refreshEnabled: true
    });
    await controller.copy();
    expect(port.writeClipboard).not.toHaveBeenCalled();
    expect(port.read).toHaveBeenCalledTimes(1);

    await controller.refresh();
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "available",
      commandFreshness: "current",
      copyEnabled: true
    });
  });

  it("purges and closes on target or read-authority replacement", async () => {
    for (const replacement of [
      context({ epoch: 2, projectedThreadId: "thread-laptop-resume-replaced-private" }),
      context({ epoch: 2, projectedName: "renamed-session" }),
      context({ epoch: 2, runtimeVersion: "0.145.0" }),
      context({ epoch: 2, createdAt: "2026-07-27T21:59:00.000Z" }),
      context({ epoch: 2, deviceId: "device-laptop-resume-replaced-private" }),
      context({ epoch: 2, canRead: false })
    ]) {
      const controller = createController(resumePort());
      await controller.open();
      expect(controller.updateContext(replacement)).toMatchObject({
        sheetOpen: false,
        command: null,
        available: null,
        copyEnabled: false
      });
    }
  });

  it("aborts an active read on epoch drift and suppresses late private settlement", async () => {
    const response = deferred<unknown>();
    const port = resumePort({ read: async () => response.promise });
    const controller = createController(port);
    const opening = controller.open();
    await Promise.resolve();
    const signal = port.read.mock.calls[0]?.[0].signal;

    expect(signal?.aborted).toBe(false);
    expect(controller.updateContext(context({ epoch: 2 }))).toMatchObject({
      phase: "failure",
      command: null
    });
    expect(signal?.aborted).toBe(true);
    response.resolve(availableResponse());
    await opening;
    expect(controller.snapshot()).toMatchObject({ phase: "failure", command: null });
  });

  it("copies the exact current command once and never performs another read or side effect", async () => {
    const clipboard = deferred<void>();
    const port = resumePort({ writeClipboard: async () => clipboard.promise });
    const controller = createController(port);
    await controller.open();

    const copying = controller.copy();
    expect(controller.copy()).toBe(copying);
    expect(controller.snapshot()).toMatchObject({
      copyPhase: "copying",
      copyEnabled: false,
      copyStatus: "Copying command"
    });
    await Promise.resolve();
    expect(port.writeClipboard).toHaveBeenCalledTimes(1);
    expect(port.writeClipboard.mock.calls[0]?.[0]).toEqual({ text: command });
    expect(port.read).toHaveBeenCalledTimes(1);

    clipboard.resolve();
    await copying;
    expect(controller.snapshot()).toMatchObject({
      copyPhase: "copied",
      copyStatus: "Command copied",
      copyStatusDetail: expect.stringMatching(/nothing ran|HostDeck laptop/iu),
      copyEnabled: true
    });
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("keeps a current command selectable after copy failure and retries only explicitly", async () => {
    let attempts = 0;
    const port = resumePort({
      writeClipboard: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("private clipboard rejection");
      }
    });
    const controller = createController(port);
    await controller.open();

    await controller.copy();
    expect(controller.snapshot()).toMatchObject({
      phase: "available",
      command,
      copyPhase: "failed",
      copyStatus: "Copy failed",
      copyEnabled: true
    });
    expect(port.writeClipboard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.snapshot())).not.toContain("private clipboard rejection");

    await controller.copy();
    expect(port.writeClipboard).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({ copyPhase: "copied" });
  });

  it("suppresses copied success after epoch drift or close without claiming cancellation", async () => {
    for (const close of [false, true]) {
      const clipboard = deferred<void>();
      const port = resumePort({ writeClipboard: async () => clipboard.promise });
      const controller = createController(port);
      await controller.open();
      const copying = controller.copy();

      if (close) {
        controller.close();
      } else {
        controller.updateContext(context({ epoch: 2 }));
      }
      clipboard.resolve();
      await copying;
      expect(controller.snapshot().copyPhase).toBe("idle");
      expect(controller.snapshot().copyStatus).toBeNull();
      expect(port.writeClipboard).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed options and ports, bounds listeners, and clears owned state on close", async () => {
    const validContext = context();
    const validPort = resumePort();
    expect(() => createLaptopResumeControlController({
      sessionId,
      context: validContext,
      port: validPort,
      extra: true
    } as never)).toThrow("HostDeck laptop-resume options are invalid.");

    const accessorPort = { writeClipboard: vi.fn() } as Record<string, unknown>;
    Object.defineProperty(accessorPort, "read", {
      enumerable: true,
      get: () => vi.fn()
    });
    expect(() => createLaptopResumeControlController({
      sessionId,
      context: validContext,
      port: accessorPort as never
    })).toThrow("HostDeck laptop-resume port is invalid.");

    const controller = createController(validPort);
    const listener = vi.fn();
    const releases = [controller.subscribe(listener)];
    expect(() => controller.subscribe(listener)).toThrow("listener is invalid");
    for (let index = 1; index < 32; index += 1) releases.push(controller.subscribe(vi.fn()));
    expect(() => controller.subscribe(vi.fn())).toThrow("capacity is exhausted");
    for (const release of releases) release();

    await controller.open();
    expect(controller.close()).toMatchObject({ phase: "hidden", command: null });
    expect(() => controller.updateContext(validContext)).toThrow("control is closed");
    expect(() => controller.subscribe(vi.fn())).toThrow("listener is invalid");
  });
});

function createController(
  port = resumePort(),
  initialContext = context()
) {
  return createLaptopResumeControlController({ sessionId, context: initialContext, port });
}

function resumePort(overrides: Partial<LaptopResumeControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => availableResponse())),
    writeClipboard: vi.fn(overrides.writeClipboard ?? (async () => undefined))
  };
}

function availableResponse(input: Readonly<{
  session?: string;
  thread?: string;
}> = {}) {
  const targetThread = input.thread ?? threadId;
  const launch = {
    executable: "codex",
    args: ["resume", targetThread]
  } as const;
  return selectedResumeMetadataResponseSchema.parse({
    session_id: input.session ?? sessionId,
    codex_thread_id: targetThread,
    local_only: true,
    available: true,
    command: formatSelectedResumeLaunchCommand(launch),
    launch,
    unavailable_reason: null
  });
}

function unavailableResponse(reason: string) {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    codex_thread_id: threadId,
    local_only: true,
    available: false,
    command: null,
    launch: null,
    unavailable_reason: reason
  });
}

function context(
  input: Readonly<{
    epoch?: number;
    deviceId?: string;
    permission?: "read" | "write";
    locked?: boolean;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    freshness?: "current" | "stale";
    sessionState?: "active" | "archived" | "stale" | "incompatible" | "unknown";
    projectedThreadId?: string;
    projectedName?: string;
    runtimeVersion?: string;
    createdAt?: string;
    turnState?:
      | "idle"
      | "in_progress"
      | "waiting_for_input"
      | "waiting_for_approval"
      | "unknown";
    streamState?: "idle" | "connected" | "reconnecting" | "failed";
    continuity?: "unproven" | "contiguous" | "boundary";
  }> = {}
): LaptopResumeControlContext {
  const freshness = input.freshness ?? "current";
  const sessionState = input.sessionState ?? (freshness === "current" ? "active" : "stale");
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: input.projectedName ?? "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/laptop-resume-component",
    runtime_source: "codex_app_server",
    runtime_version: input.runtimeVersion ?? "0.147.0",
    created_at: input.createdAt ?? timestamp,
    archived_at: sessionState === "archived" ? timestamp : null,
    session_state: sessionState,
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/laptop-resume-component",
    model: "runtime-resume",
    settings: null,
    goal: null,
    recent_summary: "Validate exact laptop resume.",
    last_event_cursor: null
  });
  const item = selectedSessionReadItemSchema.parse({
    session,
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  });
  const response = sessionState === "archived"
    ? Object.freeze({
        access: Object.freeze({
          mode: "paired_read" as const,
          network_mode: "remote" as const,
          transport: "https" as const
        }),
        session: item
      })
    : selectedSessionDetailResponseSchema.parse({
        access: { mode: "paired_read", network_mode: "remote", transport: "https" },
        session: item
      });
  const canRead = input.canRead ?? true;
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: canRead ? "ready" : "access_limited",
    access: resource(input.accessState ?? "current", access(canRead, input)),
    host: resource("current", null),
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
      phase: "idle" as const,
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: false,
      causes: Object.freeze(["read_only_access" as const])
    }),
    lastFailure: null
  });
  return Object.freeze({ snapshot });
}

function access(
  canRead: boolean,
  input: Readonly<{
    deviceId?: string;
    permission?: "read" | "write";
    locked?: boolean;
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
  const permission = input.permission ?? "read";
  const locked = input.locked ?? false;
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: input.deviceId ?? "device-laptop-resume-component-private",
    permission,
    device_expires_at: "2026-10-27T22:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: true,
    can_write_sessions: permission === "write" && !locked,
    can_lock: permission === "write",
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

function httpApiError(code: ApiErrorEnvelope["code"]) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "session_resume_metadata",
    transport: "https",
    status: code === "session_not_found" ? 404 : code === "operation_timeout" ? 504 : 409,
    apiError: {
      code,
      message: "Private API detail with cwd /private/cwd.",
      retryable: true
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
  return { promise, reject, resolve };
}
