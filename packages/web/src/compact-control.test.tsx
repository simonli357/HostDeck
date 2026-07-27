// @vitest-environment jsdom

import {
  compactProgressResponseSchema,
  managedSessionProjectionSchema,
  selectedAccessStateResponseSchema,
  selectedOperationProgressSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompactControlController } from "./compact-control.js";
import {
  type CompactControlPort,
  createCompactControlController
} from "./compact-control-state.js";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";
import { SessionUtilities } from "./session-utilities.js";
import { createUsageControlController, type UsageControlPort } from "./usage-control-state.js";

const sessionId = "sess_compact_ui_001" as SessionId;
const threadId = "thread-compact-ui-private";
const timestamp = "2026-07-27T16:00:00.000Z";
const operationId = "op_browser_compact_ui_001";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CompactControl", () => {
  it("opens from the exact utility menu and performs one deliberate progress read", async () => {
    const user = userEvent.setup();
    const response = deferred<unknown>();
    const port = compactPort({ read: async () => response.promise });
    const compact = compactController(port);
    renderUtilities(compact);

    const trigger = screen.getByRole("button", {
      name: "More session utilities for android-compact-release"
    });
    await user.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Session utilities" });
    expect(port.read).not.toHaveBeenCalled();
    expect(
      Array.from(menu.querySelectorAll(".hostdeck-utility-menu__item strong"), (item) =>
        item.textContent
      )
    ).toEqual(["/usage", "/compact"]);

    await user.click(screen.getByRole("button", { name: /compact/iu }));
    const dialog = screen.getByRole("dialog", { name: "/compact" });
    expect(dialog.textContent).toContain("Target: android-compact-release");
    expect(screen.getByText("Loading Compact progress", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.start).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to session utilities" })
    );

    response.resolve(compactResponse(null));
    expect(await screen.findAllByText("No tracked compaction", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Confirmation required", { exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compact context" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(threadId);
    expect(document.body.textContent).not.toContain(operationId);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("requires final confirmation, locks submitted dismissal, and reports acceptance only", async () => {
    const user = userEvent.setup();
    const response = deferred<unknown>();
    const port = compactPort({ start: async () => response.promise });
    renderUtilities(compactController(port));
    const trigger = await openCompact(user);

    await user.click(await screen.findByRole("button", { name: "Compact context" }));
    const heading = screen.getByRole("heading", { name: "Confirm context compaction" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(port.start).not.toHaveBeenCalled();
    expect(screen.getByText(/Acceptance does not prove completion/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Confirm compact" }));
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(port.start.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: { operation_id: operationId, kind: "compact", confirm: true }
    });
    expect(screen.getByText("Submitting compaction", { exact: true })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Back to session utilities" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Close Compact utility" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "/compact" })).toBeTruthy();

    response.resolve(compactResponse("accepted", { operationId }));
    expect(await screen.findByText("Compaction accepted", { exact: true })).toBeTruthy();
    expect(screen.getByText("Acceptance only", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Compaction completed", { exact: true })).toBeNull();
    expect(port.read).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("reconciles accepted work only through Check progress", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const port = compactPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? compactResponse(null)
          : compactResponse("running", { operationId, turnId: "turn-compact-ui-private" });
      }
    });
    renderUtilities(compactController(port));
    await openCompact(user);
    await screen.findByRole("button", { name: "Compact context" });
    await user.click(screen.getByRole("button", { name: "Compact context" }));
    await user.click(screen.getByRole("button", { name: "Confirm compact" }));
    expect(await screen.findByText("Compaction accepted", { exact: true })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Check Compact progress" }));
    expect(await screen.findByText("Compacting context", { exact: true })).toBeTruthy();
    expect(screen.getByText("Compaction evidence active", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("turn-compact-ui-private");
  });

  it("keeps progress readable while disabling writes for read-only authority", async () => {
    const user = userEvent.setup();
    const currentContext = context({ permission: "read" });
    const port = compactPort();
    renderUtilities(compactController(port, currentContext), currentContext);
    await openCompact(user);

    const start = await screen.findByRole("button", { name: "Compact context" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Read-only access can inspect progress but cannot start compaction.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check Compact progress" })).toBeTruthy();
    expect(port.start).not.toHaveBeenCalled();
  });

  it("renders sanitized unsupported reads and restores Compact row focus on Back", async () => {
    const user = userEvent.setup();
    const port = compactPort({
      read: async () => {
        throw unsupportedError();
      }
    });
    renderUtilities(compactController(port));
    await openCompact(user);

    expect(await screen.findByText("Structured Compact unsupported", { exact: true })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private runtime capability detail");
    expect(
      (screen.getByRole("button", { name: "Check Compact progress" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Back to session utilities" }));
    const compactItem = screen.getByRole("button", { name: /compact/iu });
    await waitFor(() => expect(document.activeElement).toBe(compactItem));
  });

  it("composes exact selected read and protected start routes once under StrictMode", async () => {
    const user = userEvent.setup();
    const currentContext = context();
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200,
      data: compactResponse(null)
    }));
    const requestProtected = vi.fn(async (_routeId: string, input: { readonly body: { readonly operation_id: string } }) => ({
      status: 202,
      data: compactResponse("accepted", { operationId: input.body.operation_id })
    }));
    const coordinator = coordinatorWith(
      currentContext.snapshot,
      requestSelectedSessionRead,
      requestProtected
    );

    function Harness() {
      const compact = useCompactControlController(
        coordinator,
        sessionId,
        currentContext.snapshot,
        { createOperationId: () => operationId }
      );
      const usage = createUsageControlController({
        sessionId,
        context: currentContext,
        port: usagePort()
      });
      return <SessionUtilities compact={compact} usage={usage} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await openCompact(user);
    await screen.findByRole("button", { name: "Compact context" });
    await user.click(screen.getByRole("button", { name: "Compact context" }));
    await user.click(screen.getByRole("button", { name: "Confirm compact" }));
    expect(await screen.findByText("Compaction accepted", { exact: true })).toBeTruthy();

    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "compact_read",
      { params: { session_id: sessionId } },
      { signal: expect.any(AbortSignal) }
    );
    expect(requestProtected).toHaveBeenCalledTimes(1);
    expect(requestProtected).toHaveBeenCalledWith(
      "compact_start",
      {
        params: { session_id: sessionId },
        body: { operation_id: operationId, kind: "compact", confirm: true }
      },
      { signal: expect.any(AbortSignal) }
    );

    rendered.unmount();
    await act(async () => {
      await Promise.resolve();
    });
  });
});

async function openCompact(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: /More session utilities/ });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: /compact/iu }));
  return trigger;
}

function renderUtilities(
  compact: ReturnType<typeof compactController>,
  currentContext = context()
) {
  const usage = createUsageControlController({
    sessionId,
    context: currentContext,
    port: usagePort()
  });
  return render(<SessionUtilities compact={compact} usage={usage} />);
}

function compactController(
  port: ReturnType<typeof compactPort>,
  initialContext = context()
) {
  return createCompactControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId: () => operationId
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

function usagePort(): UsageControlPort {
  return Object.freeze({ read: vi.fn(async () => ({ unused: true })) });
}

function compactResponse(
  state: "accepted" | "running" | "completed" | "interrupted" | "failed" | "incomplete" | null,
  input: Readonly<{
    operationId?: string;
    turnId?: string | null;
  }> = {}
) {
  if (state === null) return compactProgressResponseSchema.parse({ progress: null });
  const terminalWithTurn = ["running", "completed", "interrupted", "failed"].includes(state);
  return compactProgressResponseSchema.parse({
    progress: selectedOperationProgressSchema.parse({
      operation_id: input.operationId ?? operationId,
      kind: "compact",
      target: {
        type: "managed_session",
        session_id: sessionId,
        codex_thread_id: threadId
      },
      state,
      updated_at: timestamp,
      turn_id: input.turnId === undefined
        ? terminalWithTurn ? "turn-compact-ui-private" : null
        : input.turnId,
      error: state === "failed" || state === "incomplete"
        ? { code: "runtime_unavailable", message: "Private progress detail.", retryable: false }
        : null
    })
  });
}

function context(input: Readonly<{
  epoch?: number;
  permission?: "read" | "write";
  locked?: boolean;
  turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
}> = {}) {
  const permission = input.permission ?? "write";
  const locked = input.locked ?? false;
  const writeEligible = permission === "write" && !locked;
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-compact-release",
    codex_thread_id: threadId,
    cwd: "/private/compact-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/compact-ui",
    model: "runtime-compact",
    settings: null,
    goal: null,
    recent_summary: "Validate Compact utility.",
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
  const response = selectedSessionDetailResponseSchema.parse({
    access: {
      mode: permission === "write" ? "paired_write" : "paired_read",
      network_mode: "remote",
      transport: "https"
    },
    session: item
  });
  const access = selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-compact-ui-private",
    permission,
    device_expires_at: "2026-10-27T16:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: true,
    can_write_sessions: writeEligible,
    can_lock: permission === "write",
    can_unlock: false
  });
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: input.epoch ?? 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready",
    access: resource("current", access),
    host: resource("current", null),
    targetState: resource(
      "current",
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

function coordinatorWith(
  snapshot: BrowserConnectionSnapshot,
  requestSelectedSessionRead: ReturnType<typeof vi.fn>,
  requestProtected: ReturnType<typeof vi.fn>
): BrowserConnectionStateCoordinator {
  return {
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    setTarget: vi.fn(),
    refresh: vi.fn(),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected,
    requestDeviceList: vi.fn(),
    requestRemoteStatus: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock: vi.fn(),
    requestSelectedSessionRead,
    close: vi.fn()
  } as unknown as BrowserConnectionStateCoordinator;
}

function resource<Data>(state: BrowserConnectionResourceState, data: Data | null) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function unsupportedError() {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "compact_read",
    transport: "https",
    status: 409,
    apiError: {
      code: "capability_unavailable",
      message: "Private runtime capability detail.",
      retryable: false
    }
  });
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
