// @vitest-environment jsdom

import {
  type ModelControlSnapshot,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import { ModelControl, useModelControlController } from "./model-control.js";
import {
  createModelControlController,
  type ModelControlController,
  type ModelControlPort
} from "./model-control-state.js";

const sessionId = "sess_model_ui_001" as SessionId;
const timestamp = "2026-07-25T21:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ModelControl", () => {
  it("opens a labelled Focus Rail sheet, loads exact truth, and restores trigger focus", async () => {
    const user = userEvent.setup();
    const response = createDeferred<ModelControlSnapshot>();
    const controller = readyController(modelPort({ read: async () => response.promise }));
    render(<ModelControl controller={controller} />);
    const trigger = screen.getByRole("button", { name: "/model for android-release" });

    expect(screen.queryByText("/goal")).toBeNull();
    expect(screen.queryByText("/plan")).toBeNull();
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "/model" });
    expect(dialog.textContent).toContain("Target: android-release");
    expect(screen.getByText("Loading models")).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    response.resolve(modelSnapshot());
    const currentModel = await screen.findByRole("radio", {
      name: "Codex Alpha, selected"
    });
    expect(currentModel).toBeTruthy();
    const descriptionId = currentModel.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId as string)?.textContent).toBe(
      "Balanced coding model."
    );
    expect(screen.getByText("No pending change")).toBeTruthy();
    expect((currentModel as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "High" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("already confirmed", { exact: false })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("selects one catalog model/effort and protects the in-flight command", async () => {
    const user = userEvent.setup();
    const response = createDeferred<ModelControlSnapshot>();
    const port = modelPort({
      read: async () => modelSnapshot(),
      select: async () => response.promise
    });
    const controller = readyController(port, () => "op_browser_model_ui_submit_001");
    render(<ModelControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/model for android-release" }));
    await screen.findByRole("radio", { name: /Codex Alpha/ });

    await user.click(screen.getByRole("radio", { name: /Codex Beta/ }));
    expect(screen.getByRole("radio", { name: "Codex Beta, selected" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Codex Alpha" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Medium" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));

    const dialog = screen.getByRole("dialog", { name: "/model" });
    const status = screen.getByText("Saving next-turn model", { exact: true }).closest(
      ".hostdeck-model-sheet__status"
    );
    const body = dialog.querySelector(".hostdeck-model-sheet__body");
    expect(status).not.toBeNull();
    expect(body?.contains(status)).toBe(false);
    expect(status?.nextElementSibling?.classList.contains("hostdeck-model-sheet__footer")).toBe(
      true
    );
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.select.mock.calls[0]?.[0].request).toEqual({
      operation_id: "op_browser_model_ui_submit_001",
      kind: "model",
      model_id: "model-b",
      reasoning_effort: "low",
      expected_pending_revision: null
    });
    expect(JSON.stringify(port.select.mock.calls[0]?.[0].request)).not.toContain("/model");
    expect((screen.getByRole("button", { name: "Close model control" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "/model" })).toBeTruthy();

    response.resolve(
      modelSnapshot({
        pending: pending("op_browser_model_ui_submit_001", "model-b", "low")
      })
    );
    expect(await screen.findByText("Model staged for next turn", { exact: true })).toBeTruthy();
    expect(screen.getByText(/Pending next turn:/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps current truth visible and every selector disabled for read-only access", async () => {
    const user = userEvent.setup();
    const port = modelPort({ read: async () => modelSnapshot() });
    const controller = readyController(
      port,
      undefined,
      context({ writeCause: "read_only_access" })
    );
    render(<ModelControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/model for android-release" }));
    await screen.findByRole("radio", { name: /Codex Alpha/ });

    expect(screen.getAllByText("Read-only access cannot change models.")).toHaveLength(1);
    expect((screen.getByRole("radio", { name: /Codex Alpha/ }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /Codex Beta/ }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(port.select).not.toHaveBeenCalled();
  });

  it("locks an ambiguous selection behind an explicit read-only state check", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const port = modelPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? modelSnapshot()
          : modelSnapshot({
              pending: pending("op_server_after_ui_loss_001", "model-b", "medium")
            });
      },
      select: async () => {
        throw new Error("private UI transport detail");
      }
    });
    const controller = readyController(port);
    render(<ModelControl controller={controller} />);
    await user.click(screen.getByRole("button", { name: "/model for android-release" }));
    await screen.findByRole("radio", { name: /Codex Alpha/ });
    await user.click(screen.getByRole("radio", { name: /Codex Beta/ }));
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));

    expect(await screen.findByText("Selection outcome unknown")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private UI transport detail");
    expect((screen.getByRole("button", { name: "Set for next turn" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Check model state" }));
    expect(await screen.findByText(/Pending next turn:/)).toBeTruthy();
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("composes the selected production read/write routes once under StrictMode", async () => {
    const user = userEvent.setup();
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200,
      data: modelSnapshot()
    }));
    const requestProtected = vi.fn(async (_routeId, input) => ({
      status: 200,
      data: modelSnapshot({
        pending: pending(
          input.body.operation_id,
          input.body.model_id,
          input.body.reasoning_effort ?? "medium"
        )
      })
    }));
    const coordinator = coordinatorWith(requestSelectedSessionRead, requestProtected);
    const currentContext = context();
    const currentOwner: { current: ModelControlController | null } = { current: null };

    function Harness() {
      const owner = useModelControlController(
        coordinator,
        sessionId,
        currentContext.snapshot,
        { createOperationId: () => "op_browser_model_ui_production_001" }
      );
      currentOwner.current = owner;
      return <ModelControl controller={owner} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await user.click(screen.getByRole("button", { name: "/model for android-release" }));
    await screen.findByRole("radio", { name: /Codex Alpha/ });
    await user.click(screen.getByRole("radio", { name: /Codex Beta/ }));
    await user.click(screen.getByRole("button", { name: "Set for next turn" }));
    await screen.findByText("Model staged for next turn", { exact: true });

    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "model_read",
      { params: { session_id: sessionId } },
      { signal: expect.any(AbortSignal) }
    );
    expect(requestProtected).toHaveBeenCalledTimes(1);
    expect(requestProtected).toHaveBeenCalledWith(
      "model_select",
      {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_browser_model_ui_production_001",
          kind: "model",
          model_id: "model-b",
          reasoning_effort: "medium",
          expected_pending_revision: null
        }
      },
      { signal: expect.any(AbortSignal) }
    );

    rendered.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    const closedOwner = currentOwner.current;
    expect(closedOwner).not.toBeNull();
    if (closedOwner === null) throw new TypeError("Model owner was not captured.");
    expect(closedOwner.snapshot().visible).toBe(false);
  });
});

function readyController(
  port: ReturnType<typeof modelPort>,
  createOperationId: (() => string) | undefined = () => "op_browser_model_ui_default_001",
  initialContext = context()
) {
  return createModelControlController({
    sessionId,
    context: initialContext,
    port,
    createOperationId
  });
}

function modelPort(overrides: Partial<ModelControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => modelSnapshot())),
    select: vi.fn(
      overrides.select ??
        (async ({ request }) =>
          modelSnapshot({
            pending: pending(
              request.operation_id,
              request.model_id,
              request.reasoning_effort ?? "medium"
            )
          }))
    )
  };
}

function modelSnapshot(input: Readonly<{ pending?: unknown }> = {}): ModelControlSnapshot {
  return modelControlSnapshotSchema.parse({
    catalog_revision: "c".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      model_id: "model-a",
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      catalog_state: "available",
      observed_at: timestamp
    },
    pending: input.pending ?? null,
    models: [
      {
        id: "model-a",
        runtime_model: "runtime-a",
        label: "Codex Alpha",
        description: "Balanced coding model.",
        is_default: true,
        input_modalities: ["text", "image"],
        reasoning_efforts: [
          { id: "low", description: "Fast", is_default: false },
          { id: "high", description: "Thorough", is_default: true }
        ]
      },
      {
        id: "model-b",
        runtime_model: "runtime-b",
        label: "Codex Beta",
        description: "Focused implementation model.",
        is_default: false,
        input_modalities: ["text"],
        reasoning_efforts: [
          { id: "low", description: "Fast", is_default: false },
          { id: "medium", description: "Recommended", is_default: true }
        ]
      }
    ]
  });
}

function pending(operationId: string, modelId: string, effort: string) {
  return {
    revision: 1,
    selection_operation_id: operationId,
    model_id: modelId,
    runtime_model: modelId === "model-a" ? "runtime-a" : "runtime-b",
    reasoning_effort: effort,
    catalog_state: "available",
    phase: "pending",
    selected_at: timestamp,
    turn_id: null,
    error: null
  };
}

function context(
  input: Readonly<{ writeCause?: "read_only_access" }> = {}
): Readonly<{ snapshot: BrowserConnectionSnapshot }> {
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: "thread-private-model-ui",
    cwd: "/private/model-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/model-ui",
    model: "runtime-a",
    settings: null,
    goal: null,
    recent_summary: "Validate structured model UI.",
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
    access: { mode: "paired_write", network_mode: "remote", transport: "https" },
    session: item
  });
  const writeCause = input.writeCause;
  return Object.freeze({
    snapshot: Object.freeze({
      epoch: 1,
      target: Object.freeze({ kind: "session_detail" as const, sessionId }),
      phase: "ready" as const,
      access: resource("current", pairedAccess()),
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
        phase: "ready" as const,
        generation: 1,
        rotatedAt: timestamp,
        failure: null,
        invalidationReason: null
      }),
      writeEligibility: Object.freeze({
        scope: "browser_shell" as const,
        eligible: writeCause === undefined,
        causes: Object.freeze(writeCause === undefined ? [] : [writeCause])
      }),
      lastFailure: null
    })
  });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-model-ui-private",
    permission: "write",
    device_expires_at: "2026-10-25T21:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
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

function coordinatorWith(
  requestSelectedSessionRead: ReturnType<typeof vi.fn>,
  requestProtected: ReturnType<typeof vi.fn>
): BrowserConnectionStateCoordinator {
  const current = context().snapshot;
  return {
    snapshot: () => current,
    subscribe: () => () => undefined,
    setTarget: vi.fn(async () => current),
    refresh: vi.fn(async () => current),
    loadMoreSessions: vi.fn(async () => current),
    connectSessionStream: vi.fn(() => current),
    disconnectSessionStream: vi.fn(() => current),
    bootstrapCsrf: vi.fn(async () => current),
    adoptCsrfBootstrap: vi.fn(() => current),
    requestProtected,
    requestSelectedSessionRead,
    close: vi.fn(() => current)
  } as unknown as BrowserConnectionStateCoordinator;
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
