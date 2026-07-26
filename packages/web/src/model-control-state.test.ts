import {
  type ApiErrorEnvelope,
  type ModelControlSnapshot,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  selectedAccessStateResponseSchema,
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
import { HostDeckBrowserHttpError } from "./http-client.js";
import {
  createModelControlController,
  type ModelControlContext,
  type ModelControlPort
} from "./model-control-state.js";

const sessionId = "sess_model_component_001" as SessionId;
const timestamp = "2026-07-25T20:00:00.000Z";
const catalogRevision = "a".repeat(64);

describe("model-control state", () => {
  it("loads exact current and catalog state without claiming a pending value", async () => {
    const port = modelPort({ read: async () => snapshot() });
    const controller = createController(port);

    const loading = controller.open();
    expect(controller.snapshot()).toMatchObject({ phase: "loading", sheetOpen: true });
    const view = await loading;

    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls[0]?.[0]).toMatchObject({ sessionId, signal: expect.any(AbortSignal) });
    expect(view).toMatchObject({
      phase: "ready",
      targetLabel: "android-release",
      current: {
        label: "Codex Alpha",
        modelId: "model-a",
        effort: "high",
        catalogKnown: true
      },
      pending: null,
      selectedModelId: "model-a",
      selectedEffort: "high",
      submitEnabled: false
    });
    expect(view.models).toHaveLength(2);
    expect(view.models.find((model) => model.id === "model-a")?.isCurrent).toBe(true);
  });

  it("resolves the selected model's declared default and dispatches exactly once", async () => {
    const response = createDeferred<ModelControlSnapshot>();
    const port = modelPort({
      read: async () => snapshot(),
      select: async () => response.promise
    });
    const controller = createController(port, () => "op_browser_model_submit_once_001");
    await controller.open();

    const selected = controller.selectModel("model-b");
    expect(selected).toMatchObject({
      selectedModelId: "model-b",
      selectedEffort: "medium",
      submitEnabled: true,
      submitLabel: "Set for next turn"
    });
    const first = controller.submit();
    const second = controller.submit();

    expect(controller.snapshot()).toMatchObject({ phase: "submitting", closeDisabled: true });
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.select.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: {
        operation_id: "op_browser_model_submit_once_001",
        kind: "model",
        model_id: "model-b",
        reasoning_effort: "medium",
        expected_pending_revision: null
      },
      signal: expect.any(AbortSignal)
    });
    response.resolve(
      snapshot({
        pending: pending({
          operationId: "op_browser_model_submit_once_001",
          modelId: "model-b",
          effort: "medium"
        })
      })
    );
    await first;
    await second;

    expect(controller.snapshot()).toMatchObject({
      phase: "staged",
      status: "Model staged for next turn",
      pending: { modelId: "model-b", effort: "medium", phase: "pending" },
      submitEnabled: false
    });
  });

  it("clears one exact pending revision by choosing confirmed current settings", async () => {
    const initial = snapshot({
      pending: pending({ operationId: "op_pending_clear_001", modelId: "model-b", effort: "low", revision: 7 })
    });
    const port = modelPort({
      read: async () => initial,
      select: async () => snapshot()
    });
    const controller = createController(port, () => "op_browser_model_clear_pending_001");
    await controller.open();

    expect(controller.snapshot()).toMatchObject({ selectedModelId: "model-b", selectedEffort: "low" });
    const selected = controller.selectModel("model-a");
    expect(selected).toMatchObject({ submitEnabled: true, submitLabel: "Clear pending change" });
    await controller.submit();

    expect(port.select.mock.calls[0]?.[0].request).toMatchObject({
      model_id: "model-a",
      reasoning_effort: "high",
      expected_pending_revision: 7
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "cleared",
      pending: null,
      submitEnabled: false
    });
  });

  it.each(["dispatching", "awaiting_confirmation", "unknown"] as const)(
    "keeps %s pending state visible and nonreplaceable",
    async (phase) => {
      const controller = createController(
        modelPort({
          read: async () =>
            snapshot({
              pending: pending({
                operationId: `op_pending_${phase}_001`,
                modelId: "model-b",
                effort: "medium",
                phase
              })
            })
        })
      );
      await controller.open();

      expect(controller.snapshot().pending).toMatchObject({ phase });
      expect(controller.snapshot().selectionEnabled).toBe(false);
      expect(controller.snapshot().submitEnabled).toBe(false);
      expect(controller.snapshot().selectionDisabledReason).toContain("being applied or reconciled");
    }
  );

  it("keeps a conflict explicit and replaceable with its exact revision", async () => {
    const port = modelPort({
      read: async () =>
        snapshot({
          pending: pending({
            operationId: "op_pending_conflict_001",
            modelId: "model-b",
            effort: "medium",
            revision: 11,
            phase: "conflict"
          })
        }),
      select: async ({ request }) =>
        snapshot({
          pending: pending({
            operationId: request.operation_id,
            modelId: request.model_id,
            effort: request.reasoning_effort ?? "medium",
            revision: 12
          })
        })
    });
    const controller = createController(port, () => "op_browser_model_replace_conflict_001");
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase: "conflict",
      selectionEnabled: true,
      submitEnabled: true
    });
    await controller.submit();
    expect(port.select.mock.calls[0]?.[0].request.expected_pending_revision).toBe(11);
    expect(controller.snapshot().phase).toBe("staged");
  });

  it("does not invent a catalog identity for an unknown current runtime model", async () => {
    const controller = createController(
      modelPort({ read: async () => snapshot({ unknownCurrent: true }) })
    );
    await controller.open();
    const view = controller.snapshot();

    expect(view.current).toMatchObject({
      label: "retired-runtime-private",
      modelId: null,
      runtimeModel: "retired-runtime-private",
      catalogKnown: false
    });
    expect(view.models.every((model) => !model.isCurrent)).toBe(true);
    expect(view.selectedModelId).toBe("model-a");
  });

  it("preserves read truth but disables mutation for read-only access", async () => {
    const controller = createController(
      modelPort({ read: async () => snapshot() }),
      undefined,
      context({ writeCause: "read_only_access" })
    );
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      current: { label: "Codex Alpha" },
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: "Read-only access cannot change models."
    });
  });

  it.each([
    ["host_locked", "Remote writes are locked on the laptop."],
    ["csrf_not_ready", "Secure write setup is not ready."],
    ["host_not_ready", "Laptop write services are not ready."]
  ] as const)("blocks selection when write authority reports %s", async (writeCause, reason) => {
    const port = modelPort({ read: async () => snapshot() });
    const controller = createController(port, undefined, context({ writeCause }));
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      current: { label: "Codex Alpha" },
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: reason
    });
    controller.selectModel("model-b");
    await controller.submit();
    expect(port.select).not.toHaveBeenCalled();
  });

  it.each([
    [context({ freshness: "stale" }), "Session state is stale. Refresh before changing models."],
    [context({ sessionState: "incompatible" }), "Session state is stale. Refresh before changing models."]
  ] as const)("keeps non-writable session truth readable", async (initialContext, reason) => {
    const port = modelPort({ read: async () => snapshot() });
    const controller = createController(port, undefined, initialContext);
    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      visible: true,
      current: { label: "Codex Alpha" },
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: reason
    });
    await controller.submit();
    expect(port.select).not.toHaveBeenCalled();
  });

  it("closes dispatch immediately when write authority is downgraded in an open sheet", async () => {
    const port = modelPort({ read: async () => snapshot() });
    const controller = createController(port);
    await controller.open();
    expect(controller.selectModel("model-b").submitEnabled).toBe(true);

    const downgraded = controller.updateContext(context({ writeCause: "host_locked" }));
    expect(downgraded).toMatchObject({
      sheetOpen: true,
      selectedModelId: "model-b",
      selectionEnabled: false,
      submitEnabled: false,
      selectionDisabledReason: "Remote writes are locked on the laptop."
    });
    await controller.submit();
    expect(port.select).not.toHaveBeenCalled();
  });

  it("hides retained model data and suppresses a late read after authority loss", async () => {
    const response = createDeferred<ModelControlSnapshot>();
    const controller = createController(modelPort({ read: async () => response.promise }));
    const opening = controller.open();
    expect(controller.snapshot().phase).toBe("loading");

    const hidden = controller.updateContext(context({ canRead: false }));
    expect(hidden).toMatchObject({ visible: false, sheetOpen: false, current: null, models: [] });
    response.resolve(snapshot());
    await opening;
    expect(controller.snapshot()).toMatchObject({ visible: false, current: null, models: [] });
  });

  it("latches an ambiguous selection and reconciles with one safe GET", async () => {
    let reads = 0;
    const port = modelPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? snapshot()
          : snapshot({
              pending: pending({
                operationId: "op_server_recorded_after_loss_001",
                modelId: "model-b",
                effort: "medium"
              })
            });
      },
      select: async () => {
        throw new Error("private transport failure with model fixture");
      }
    });
    const controller = createController(port);
    await controller.open();
    controller.selectModel("model-b");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      submitEnabled: false,
      refreshEnabled: true
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("private transport failure");
    await controller.refresh();
    expect(port.select).toHaveBeenCalledTimes(1);
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "staged",
      pending: { modelId: "model-b", effort: "medium" }
    });
  });

  it("fails closed when a successful response does not correlate to the submitted operation", async () => {
    const port = modelPort({
      read: async () => snapshot(),
      select: async () =>
        snapshot({
          pending: pending({
            operationId: "op_different_selection_001",
            modelId: "model-b",
            effort: "medium"
          })
        })
    });
    const controller = createController(port, () => "op_browser_model_expected_001");
    await controller.open();
    controller.selectModel("model-b");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "outcome_unknown",
      pending: null,
      submitEnabled: false
    });
  });

  it("distinguishes unsupported reads from retryable or malformed catalog failure", async () => {
    for (const code of ["capability_unavailable", "incompatible_runtime"] as const) {
      const unsupported = createController(
        modelPort({
          read: async () => {
            throw httpApiError(code, false);
          }
        })
      );
      await unsupported.open();
      expect(unsupported.snapshot()).toMatchObject({
        phase: "unsupported",
        status: "Model control unsupported",
        submitEnabled: false,
        refreshEnabled: true
      });
    }

    const retryable = createController(
      modelPort({
        read: async () => {
          throw new Error("private read failure");
        }
      })
    );
    await retryable.open();
    expect(retryable.snapshot()).toMatchObject({
      phase: "read_failed",
      status: "Models could not be loaded",
      refreshEnabled: true
    });
    expect(JSON.stringify(retryable.snapshot())).not.toContain("private read failure");

    const malformed = createController(
      modelPort({ read: async () => ({ ...snapshot(), models: [] }) })
    );
    await malformed.open();
    expect(malformed.snapshot()).toMatchObject({
      phase: "read_failed",
      current: null,
      models: [],
      submitEnabled: false
    });
  });

  it("fails closed before dispatch when secure operation-id generation is invalid", async () => {
    const port = modelPort({ read: async () => snapshot() });
    const controller = createController(port, () => "invalid-operation-id");
    await controller.open();
    controller.selectModel("model-b");
    await controller.submit();

    expect(controller.snapshot()).toMatchObject({
      phase: "select_failed",
      submitEnabled: false,
      refreshEnabled: true,
      statusDetail: "Secure model selection is unavailable. Reload HostDeck."
    });
    expect(port.select).not.toHaveBeenCalled();
  });

  it("requires refresh after a typed conflict and permits bounded retry after overload", async () => {
    const conflict = createController(
      modelPort({
        read: async () => snapshot(),
        select: async () => {
          throw csrfApiError("operation_conflict", true);
        }
      })
    );
    await conflict.open();
    conflict.selectModel("model-b");
    await conflict.submit();
    expect(conflict.snapshot()).toMatchObject({
      phase: "select_failed",
      submitEnabled: false,
      refreshEnabled: true
    });

    let attempts = 0;
    const overload = createController(
      modelPort({
        read: async () => snapshot(),
        select: async ({ request }) => {
          attempts += 1;
          if (attempts === 1) throw csrfApiError("service_overloaded", true);
          return snapshot({
            pending: pending({
              operationId: request.operation_id,
              modelId: request.model_id,
              effort: request.reasoning_effort ?? "medium"
            })
          });
        }
      }),
      () => `op_browser_model_overload_${attempts + 1}`
    );
    await overload.open();
    overload.selectModel("model-b");
    await overload.submit();
    expect(overload.snapshot()).toMatchObject({ phase: "select_failed", submitEnabled: true });
    await overload.submit();
    expect(overload.snapshot().phase).toBe("staged");
  });

  it("prevents ordinary dismissal while submitting and closes the owner idempotently", async () => {
    const response = createDeferred<ModelControlSnapshot>();
    const controller = createController(
      modelPort({ read: async () => snapshot(), select: async () => response.promise })
    );
    await controller.open();
    controller.selectModel("model-b");
    const submitting = controller.submit();

    expect(controller.dismiss().sheetOpen).toBe(true);
    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, sheetOpen: false });
    expect(controller.close()).toBe(closed);
    response.resolve(snapshot());
    await submitting;
    expect(() => controller.selectModel("model-a")).not.toThrow();
    expect(controller.snapshot()).toBe(closed);
  });
});

function createController(
  port: ReturnType<typeof modelPort>,
  createOperationId: (() => string) | undefined = () => "op_browser_model_default_001",
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
    read: vi.fn(overrides.read ?? (async () => snapshot())),
    select: vi.fn(
      overrides.select ??
        (async ({ request }) =>
          snapshot({
            pending: pending({
              operationId: request.operation_id,
              modelId: request.model_id,
              effort: request.reasoning_effort ?? "medium"
            })
          }))
    )
  };
}

function snapshot(
  input: Readonly<{
    pending?: unknown;
    unknownCurrent?: boolean;
  }> = {}
): ModelControlSnapshot {
  return modelControlSnapshotSchema.parse({
    catalog_revision: catalogRevision,
    catalog_observed_at: timestamp,
    current: input.unknownCurrent
      ? {
          model_id: null,
          runtime_model: "retired-runtime-private",
          reasoning_effort: "legacy",
          catalog_state: "unknown",
          observed_at: timestamp
        }
      : {
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
          { id: "low", description: null, is_default: false },
          { id: "medium", description: "Recommended", is_default: true }
        ]
      }
    ]
  });
}

function pending(input: Readonly<{
  operationId: string;
  modelId: string;
  effort: string;
  revision?: number;
  phase?: "pending" | "dispatching" | "awaiting_confirmation" | "unknown" | "conflict";
}>): unknown {
  const phase = input.phase ?? "pending";
  const runtimeModel = input.modelId === "model-a" ? "runtime-a" : "runtime-b";
  return {
    revision: input.revision ?? 1,
    selection_operation_id: input.operationId,
    model_id: input.modelId,
    runtime_model: runtimeModel,
    reasoning_effort: input.effort,
    catalog_state: "available",
    phase,
    selected_at: timestamp,
    turn_id: phase === "awaiting_confirmation" ? "turn-model-component-001" : null,
    error:
      phase === "unknown" || phase === "conflict"
        ? apiError("operation_conflict", true)
        : null
  };
}

function context(
  input: Readonly<{
    writeCause?: BrowserConnectionWriteBlockCause;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    sessionState?: "active" | "incompatible";
    freshness?: "current" | "stale";
  }> = {}
): ModelControlContext {
  const sessionState = input.sessionState ?? "active";
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: "thread-private-model-component",
    cwd: "/private/model-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: sessionState,
    turn_state: "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/model-component",
    model: "runtime-a",
    settings: null,
    goal: null,
    recent_summary: "Validate structured model control.",
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
  const snapshotValue: BrowserConnectionSnapshot = Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: input.canRead === false ? "access_limited" : "ready",
    access: resource(
      input.accessState ?? "current",
      pairedAccess(input.canRead ?? true)
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
  });
  return Object.freeze({ snapshot: snapshotValue });
}

function pairedAccess(canRead: boolean) {
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
    device_id: "device-model-component-private",
    permission: "write",
    device_expires_at: "2026-10-25T20:00:00.000Z",
    configured_origin: "https://hostdeck-laptop.fixture-tailnet.ts.net",
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: canRead,
    can_write_sessions: canRead,
    can_lock: canRead,
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

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return {
    code,
    message: "Bounded model fixture error.",
    retryable
  };
}

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "model_read",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
}

function csrfApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserCsrfError({
    reason: "api_error",
    operation: "mutation",
    routeId: "model_select",
    transport: "https",
    status: 409,
    apiError: apiError(code, retryable)
  });
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
