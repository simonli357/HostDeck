// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  type PromptDispatchResponse,
  promptDispatchResponseSchema,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import { PromptComposer, usePromptComposerController } from "./prompt-composer.js";
import {
  createPromptComposerController,
  type PromptComposerController,
  type PromptComposerDispatchInput
} from "./prompt-composer-state.js";
import { createSessionDetailFeed } from "./session-detail-feed.js";

const sessionId = "sess_prompt_component_001" as SessionId;
const timestamp = "2026-07-25T19:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PromptComposer", () => {
  it("renders the exact target and sends one multiline prompt through the controller", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn(async ({ request }: PromptComposerDispatchInput) =>
      acceptedResponse(request.operation_id, "start")
    );
    const controller = readyController(dispatch, () => "op_prompt_component_0001");
    render(<PromptComposer controller={controller} />);

    const textarea = screen.getByRole("textbox", { name: "Prompt for android-release" });
    const send = screen.getByRole("button", { name: "Send prompt to android-release" });
    expect(screen.getByText("android-release", { exact: true })).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);

    await user.type(textarea, "Review line one.{enter}Then line two.");
    expect(dispatch).not.toHaveBeenCalled();
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await user.click(send);

    expect(await screen.findByText("New turn accepted", { exact: true })).toBeTruthy();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      request: {
        operation_id: "op_prompt_component_0001",
        kind: "prompt",
        text: "Review line one.\nThen line two."
      }
    });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
    expect(document.activeElement).toBe(textarea);
    expect(document.body.textContent).not.toContain("Review line one");
    expect(document.body.innerHTML).not.toContain(sessionId);
  });

  it("keeps Enter multiline and uses Ctrl+Enter as the same gated command", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn(async ({ request }: PromptComposerDispatchInput) =>
      acceptedResponse(request.operation_id, "steer")
    );
    const controller = readyController(dispatch, () => "op_prompt_component_keyboard");
    render(<PromptComposer controller={controller} />);
    const textarea = screen.getByRole("textbox", { name: "Prompt for android-release" });

    await user.type(textarea, "First line{enter}Second line");
    expect((textarea as HTMLTextAreaElement).value).toBe("First line\nSecond line");
    expect(dispatch).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(await screen.findByText("Follow-up accepted", { exact: true })).toBeTruthy();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves and locks an ambiguous draft behind explicit reload", async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    const privateCause = "private transport detail containing prompt fixture";
    const controller = readyController(
      vi.fn(async () => {
        throw new Error(privateCause);
      }),
      () => "op_prompt_component_unknown"
    );
    render(<PromptComposer controller={controller} onReload={reload} />);
    const textarea = screen.getByRole("textbox", { name: "Prompt for android-release" });

    await user.type(textarea, "Do not duplicate this prompt");
    await user.click(screen.getByRole("button", { name: "Send prompt to android-release" }));

    expect(await screen.findByText("Prompt outcome unknown", { exact: true })).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe("Do not duplicate this prompt");
    expect(textarea.hasAttribute("readonly")).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Send prompt to android-release"
      }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(document.body.textContent).not.toContain(privateCause);
    await user.click(screen.getByRole("button", { name: "Reload to check" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("renders current read-only truth without an active command", () => {
    const dispatch = vi.fn();
    const controller = createPromptComposerController({
      sessionId,
      context: context("read_only_access"),
      createOperationId: () => "op_prompt_component_disabled",
      dispatch: { dispatch }
    });
    render(<PromptComposer controller={controller} />);

    expect(
      (screen.getByRole("textbox", {
        name: "Prompt for android-release"
      }) as HTMLTextAreaElement).disabled
    ).toBe(true);
    expect(screen.getByText("Read-only access cannot send prompts.", { exact: true })).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Send prompt to android-release"
      }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("composes the production protected route and survives StrictMode ownership", async () => {
    const user = userEvent.setup();
    const requestProtected = vi.fn(async (_routeId, input) => ({
      status: 202,
      data: acceptedResponse(input.body.operation_id, "start")
    }));
    const coordinator = coordinatorWith(requestProtected);
    const currentContext = context();
    const currentOwner: { current: PromptComposerController | null } = { current: null };

    function Harness() {
      const owner = usePromptComposerController(
        coordinator,
        sessionId,
        currentContext.snapshot,
        currentContext.feed,
        { createOperationId: () => "op_prompt_component_production" }
      );
      currentOwner.current = owner;
      return <PromptComposer controller={owner} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    const textarea = screen.getByRole("textbox", { name: "Prompt for android-release" });
    await user.type(textarea, "Use the selected protected route");
    await user.click(screen.getByRole("button", { name: "Send prompt to android-release" }));

    expect(await screen.findByText("New turn accepted", { exact: true })).toBeTruthy();
    expect(requestProtected).toHaveBeenCalledTimes(1);
    expect(requestProtected).toHaveBeenCalledWith(
      "prompt_dispatch",
      {
        params: { session_id: sessionId },
        body: {
          operation_id: "op_prompt_component_production",
          kind: "prompt",
          text: "Use the selected protected route"
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
    if (closedOwner === null) throw new TypeError("Prompt owner was not captured.");
    expect(() => closedOwner.setDraft("late draft")).toThrow("closed");
  });
});

function readyController(
  dispatch: (input: PromptComposerDispatchInput) => Promise<unknown>,
  createOperationId: () => string
) {
  return createPromptComposerController({
    sessionId,
    context: context(),
    createOperationId,
    dispatch: { dispatch }
  });
}

function context(
  writeCause?: "read_only_access"
): Readonly<{
  snapshot: BrowserConnectionSnapshot;
  feed: ReturnType<typeof createSessionDetailFeed>;
}> {
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: "thread-private-prompt-component",
    cwd: "/private/prompt-component",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/prompt-component",
    model: "gpt-5.5-codex",
    settings: null,
    goal: null,
    recent_summary: "Validate the selected prompt composer.",
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
  const snapshot: BrowserConnectionSnapshot = Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready",
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
  });
  return Object.freeze({ snapshot, feed: createSessionDetailFeed(sessionId) });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-prompt-component-private",
    permission: "write",
    device_expires_at: "2026-10-25T19:00:00.000Z",
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

function acceptedResponse(
  operationId: string,
  action: "start" | "steer"
): PromptDispatchResponse {
  return promptDispatchResponseSchema.parse({
    operation_id: operationId,
    kind: "prompt",
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: "thread-private-prompt-component"
    },
    state: "accepted",
    accepted_at: timestamp,
    audit_record_id: "audit-prompt-component-private",
    turn_id: "turn-prompt-component-private",
    action
  });
}

function coordinatorWith(
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
    close: vi.fn(() => current)
  } as unknown as BrowserConnectionStateCoordinator;
}
