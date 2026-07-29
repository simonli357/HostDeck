// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  type SkillsSnapshot,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
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
import {
  skillsSearchMaximumLength,
  skillsVisiblePageSize,
  useSkillsControlController
} from "./skills-control.js";
import {
  createSkillsControlController,
  type SkillsControlContext,
  type SkillsControlPort
} from "./skills-control-state.js";
import { useUsageControlController } from "./usage-control.js";
import {
  createUsageControlController,
  type UsageControlPort
} from "./usage-control-state.js";

const sessionId = "sess_skills_ui_001" as SessionId;
const threadId = "thread-skills-ui-private";
const timestamp = "2026-07-27T16:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SkillsControl", () => {
  it("opens from the exact utility menu and publishes one current ordered capture", async () => {
    const user = userEvent.setup();
    const response = deferred<SkillsSnapshot>();
    const port = skillsPort({ read: async () => response.promise });
    renderUtilities(skillsController(port));

    const trigger = screen.getByRole("button", {
      name: "More session utilities for android-skills-release"
    });
    await user.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Session utilities" });
    expect(port.read).not.toHaveBeenCalled();
    expect(
      Array.from(menu.querySelectorAll(".hostdeck-utility-menu__item strong"), (item) =>
        item.textContent
      )
    ).toEqual(["/usage", "/compact", "/skills"]);

    await user.click(screen.getByRole("button", { name: /skills/iu }));
    expect(screen.getByRole("dialog", { name: "/skills" })).toBeTruthy();
    expect(screen.getByText("Loading Skills", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to session utilities" })
    );

    response.resolve(skillsSnapshot());
    expect(await screen.findByText("Skills capture current", { exact: true })).toBeTruthy();
    expect(screen.getByLabelText("Skills summary").textContent).toContain("4");
    expect(skillNames()).toEqual(["alpha", "beta", "gamma", "omega"]);
    expect(screen.getByText("Project", { exact: true })).toBeTruthy();
    expect(screen.getByText("System", { exact: true })).toBeTruthy();
    expect(screen.getByText("User", { exact: true })).toBeTruthy();
    expect(screen.getByText("Admin", { exact: true })).toBeTruthy();
    expect(screen.getByText("Description not reported", { exact: true })).toBeTruthy();
    expect(screen.getByText("No description provided", { exact: true })).toBeTruthy();
    expect(document.querySelectorAll(".hostdeck-skill-row__state")).toHaveLength(4);
    expect(
      Array.from(document.querySelectorAll(".hostdeck-skill-row__state"), (item) => item.textContent)
    ).toEqual(["Enabled", "Disabled", "Enabled", "Enabled"]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain(threadId);
    expect(document.body.textContent).not.toContain("/private/skills-ui");
    expect(document.body.textContent).not.toContain("connection_generation");
  });

  it.each([
    ["empty", "Empty snapshot", "No skills reported"],
    ["partial", "Partial snapshot", "Skills capture partial"],
    ["error", "Snapshot error", "Skills snapshot reported errors"]
  ] as const)("keeps the authoritative %s snapshot distinct", async (kind, boundary, status) => {
    const user = userEvent.setup();
    const snapshot = kind === "empty"
      ? skillsSnapshot({ skills: [] })
      : kind === "partial"
        ? skillsSnapshot({ errorCount: 2 })
        : skillsSnapshot({ skills: [], errorCount: 2 });
    renderUtilities(skillsController(skillsPort({ read: async () => snapshot })));
    await openSkills(user);

    expect(await screen.findByText(status, { exact: true })).toBeTruthy();
    expect(screen.getByText(boundary, { exact: true })).toBeTruthy();
    if (kind === "partial") {
      expect(skillNames()).toEqual(["alpha", "beta", "gamma", "omega"]);
    } else {
      expect(document.querySelectorAll(".hostdeck-skill-row")).toHaveLength(0);
    }
  });

  it("bounds local search, progressive rendering, and long-description disclosure", async () => {
    const user = userEvent.setup();
    const longDescription = `${"Exact multiline description.\n".repeat(12)}final-line`;
    const skills = Array.from({ length: 25 }, (_, index) => ({
      name: `skill-${String(index + 1).padStart(3, "0")}`,
      description: index === 0 ? longDescription : `Description ${index + 1}`,
      scope: (["user", "repo", "system", "admin"] as const)[index % 4] ?? "user",
      enabled: index % 3 !== 0
    }));
    const port = skillsPort({ read: async () => skillsSnapshot({ skills }) });
    renderUtilities(skillsController(port));
    await openSkills(user);
    await screen.findByText("Skills capture current", { exact: true });

    expect(document.querySelectorAll(".hostdeck-skill-row")).toHaveLength(skillsVisiblePageSize);
    await user.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(document.querySelectorAll(".hostdeck-skill-row")).toHaveLength(25);

    const search = screen.getByRole("searchbox", { name: "Search skills" });
    await user.type(search, "skill-025");
    expect(skillNames()).toEqual(["skill-025"]);
    expect(screen.getByText("1 matching", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Clear Skills search" }));
    await waitFor(() =>
      expect(document.querySelectorAll(".hostdeck-skill-row")).toHaveLength(skillsVisiblePageSize)
    );
    const disclosure = screen.getByRole("button", { name: "Expand description" });
    const descriptionId = disclosure.getAttribute("aria-controls");
    const description = descriptionId === null ? null : document.getElementById(descriptionId);
    expect(description?.textContent).toBe(longDescription);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(description?.className).toContain("hostdeck-skill-row__description--collapsed");
    await user.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(description?.className).not.toContain("hostdeck-skill-row__description--collapsed");

    fireEvent.change(search, { target: { value: "x".repeat(200) } });
    expect((search as HTMLInputElement).value).toHaveLength(skillsSearchMaximumLength);
    expect(screen.getByText("No skills match this search", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Empty snapshot", { exact: true })).toBeNull();
    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it("keeps the complete 1,024-skill summary while limiting the initial DOM", async () => {
    const user = userEvent.setup();
    const skills = Array.from({ length: 1_024 }, (_, index) => ({
      name: `bounded-skill-${String(index + 1).padStart(4, "0")}`,
      description: `Bounded description ${index + 1}`,
      scope: (["user", "repo", "system", "admin"] as const)[index % 4] ?? "user",
      enabled: index % 2 === 0
    }));
    renderUtilities(
      skillsController(skillsPort({ read: async () => skillsSnapshot({ skills }) }))
    );
    await openSkills(user);
    await screen.findByText("Skills capture current", { exact: true });

    expect(screen.getByLabelText("Skills summary").textContent).toContain("1,024");
    expect(screen.getByText("1,024 reported", { exact: true })).toBeTruthy();
    expect(document.querySelectorAll(".hostdeck-skill-row")).toHaveLength(24);
    await user.click(screen.getByRole("button", { name: "Show 24 more" }));
    expect(document.querySelectorAll(".hostdeck-skill-row")).toHaveLength(48);
  });

  it("retains one stale capture while an explicit refresh replaces it", async () => {
    const user = userEvent.setup();
    const refresh = deferred<SkillsSnapshot>();
    let reads = 0;
    const port = skillsPort({
      read: async () => {
        reads += 1;
        return reads === 1
          ? skillsSnapshot()
          : refresh.promise;
      }
    });
    const controller = skillsController(port);
    renderUtilities(controller);
    await openSkills(user);
    await screen.findByText("Skills capture current", { exact: true });
    const search = screen.getByRole("searchbox", { name: "Search skills" });
    await user.type(search, "alpha");
    expect((search as HTMLInputElement).value).toBe("alpha");

    controller.updateContext(context({ epoch: 2 }));
    expect(await screen.findByText("Skills capture stale", { exact: true })).toBeTruthy();
    const refreshButton = screen.getByRole("button", { name: "Refresh Skills" });
    await user.click(refreshButton);
    expect(screen.getByText("Refreshing Skills", { exact: true })).toBeTruthy();
    expect(skillNames()).toEqual(["alpha"]);
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(refreshButton);
    expect(port.read).toHaveBeenCalledTimes(2);

    refresh.resolve(skillsSnapshot({
      skills: [{
        name: "replacement",
        description: "Replacement capture.",
        scope: "repo",
        enabled: true
      }]
    }));
    expect(await screen.findByText("replacement", { exact: true })).toBeTruthy();
    expect(screen.getByText("Skills capture current", { exact: true })).toBeTruthy();
    expect(screen.queryByText("alpha", { exact: true })).toBeNull();
    expect((search as HTMLInputElement).value).toBe("");
  });

  it.each([
    ["unsupported", "Skills unavailable", true],
    ["failure", "Skills could not be loaded", false]
  ] as const)("renders one sanitized %s read state", async (kind, status, refreshDisabled) => {
    const user = userEvent.setup();
    const controller = skillsController(skillsPort({
      read: async () => {
        if (kind === "unsupported") throw unsupportedError();
        throw new Error("private /home/user/.codex/skills failure");
      }
    }));
    renderUtilities(controller);
    await openSkills(user);

    expect(await screen.findByText(status, { exact: true })).toBeTruthy();
    expect(document.body.textContent).not.toContain("/home/user/.codex/skills");
    expect((screen.getByRole("button", { name: "Refresh Skills" }) as HTMLButtonElement).disabled)
      .toBe(refreshDisabled);
  });

  it.each([
    ["read-only", { permission: "read" as const }],
    ["locked", { locked: true }],
    ["active turn", { turnState: "in_progress" as const }],
    ["unknown turn", { turnState: "unknown" as const }]
  ])("allows a current reader to inspect Skills while %s", async (_label, input) => {
    const user = userEvent.setup();
    const current = context(input);
    const port = skillsPort();
    renderUtilities(skillsController(port, current), current);
    await user.click(screen.getByRole("button", { name: /More session utilities/ }));
    const skills = screen.getByRole("button", { name: /skills/iu });
    expect((skills as HTMLButtonElement).disabled).toBe(false);
    await user.click(skills);
    expect(await screen.findByText("Skills capture current", { exact: true })).toBeTruthy();
    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it("restores Skills-row focus on Back and More focus on dismissal", async () => {
    const user = userEvent.setup();
    renderUtilities(skillsController(skillsPort()));
    const trigger = screen.getByRole("button", { name: /More session utilities/ });
    await openSkills(user);
    await screen.findByText("Skills capture current", { exact: true });

    await user.click(screen.getByRole("button", { name: "Back to session utilities" }));
    const row = screen.getByRole("button", { name: /skills/iu });
    await waitFor(() => expect(document.activeElement).toBe(row));
    await user.click(row);
    await screen.findByText("Skills capture current", { exact: true });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("composes exactly one selected Skills route under StrictMode", async () => {
    const user = userEvent.setup();
    const current = context();
    const requestSelectedSessionRead = vi.fn(async () => ({
      status: 200,
      data: skillsSnapshot()
    }));
    const coordinator = coordinatorWith(current.snapshot, requestSelectedSessionRead);

    function Harness() {
      const compact = useCompactControlController(coordinator, sessionId, current.snapshot);
      const skills = useSkillsControlController(coordinator, sessionId, current.snapshot);
      const usage = useUsageControlController(coordinator, sessionId, current.snapshot);
      return <SessionUtilities compact={compact} skills={skills} usage={usage} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await openSkills(user);
    expect(await screen.findByText("Skills capture current", { exact: true })).toBeTruthy();
    expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1);
    expect(requestSelectedSessionRead).toHaveBeenCalledWith(
      "skills_read",
      { params: { session_id: sessionId } },
      { signal: expect.any(AbortSignal) }
    );
    expect(JSON.stringify(requestSelectedSessionRead.mock.calls)).not.toContain("/skills");

    rendered.unmount();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("aborts the hook-owned request on unmount and suppresses late rejection", async () => {
    const user = userEvent.setup();
    const current = context();
    const response = deferred<Readonly<{ status: 200; data: SkillsSnapshot }>>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const requestSelectedSessionRead = vi.fn(
      async (_routeId: string, _input: unknown, options: { readonly signal: AbortSignal }) => {
        captured.signal = options.signal;
        return response.promise;
      }
    );
    const coordinator = coordinatorWith(current.snapshot, requestSelectedSessionRead);

    function Harness() {
      const compact = useCompactControlController(coordinator, sessionId, current.snapshot);
      const skills = useSkillsControlController(coordinator, sessionId, current.snapshot);
      const usage = useUsageControlController(coordinator, sessionId, current.snapshot);
      return <SessionUtilities compact={compact} skills={skills} usage={usage} />;
    }

    const rendered = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await openSkills(user);
    await waitFor(() => expect(requestSelectedSessionRead).toHaveBeenCalledTimes(1));
    rendered.unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(captured.signal?.aborted).toBe(true);
    response.reject(new Error("private late Skills rejection"));
    await Promise.resolve();
    await Promise.resolve();
  });
});

async function openSkills(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /More session utilities/ }));
  await user.click(screen.getByRole("button", { name: /skills/iu }));
}

function skillNames(): string[] {
  return Array.from(
    document.querySelectorAll(".hostdeck-skill-row__heading > span:nth-child(2) > strong"),
    (element) => element.textContent ?? ""
  );
}

function renderUtilities(
  skills: ReturnType<typeof skillsController>,
  currentContext = context()
) {
  const compact = createCompactControlController({
    sessionId,
    context: currentContext,
    port: compactPort(),
    createOperationId: () => "op_browser_compact_skills_ui_001"
  });
  const usage = createUsageControlController({
    sessionId,
    context: currentContext,
    port: usagePort()
  });
  return render(<SessionUtilities compact={compact} skills={skills} usage={usage} />);
}

function skillsController(
  port: ReturnType<typeof skillsPort>,
  initialContext = context()
) {
  return createSkillsControlController({ sessionId, context: initialContext, port });
}

function skillsPort(overrides: Partial<SkillsControlPort> = {}) {
  return {
    read: vi.fn(overrides.read ?? (async () => skillsSnapshot()))
  };
}

function compactPort(): CompactControlPort {
  return Object.freeze({
    read: vi.fn(async () => ({ progress: null })),
    start: vi.fn(async () => ({ progress: null }))
  });
}

function usagePort(): UsageControlPort {
  return Object.freeze({ read: vi.fn(async () => ({ unused: true })) });
}

function skillsSnapshot(
  input: Readonly<{
    skills?: readonly {
      readonly name: string;
      readonly description: string | null;
      readonly scope: "user" | "repo" | "system" | "admin";
      readonly enabled: boolean;
    }[];
    errorCount?: number;
  }> = {}
): SkillsSnapshot {
  const skills = input.skills ?? defaultSkills();
  const errorCount = input.errorCount ?? 0;
  return skillsSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 4,
    observed_at: timestamp,
    state: skills.length === 0
      ? errorCount === 0 ? "empty" : "error"
      : errorCount === 0 ? "content" : "partial",
    skills,
    error_count: errorCount
  });
}

function defaultSkills() {
  return [
    { name: "alpha", description: "Alpha skill.", scope: "repo", enabled: true },
    { name: "beta", description: null, scope: "system", enabled: false },
    { name: "gamma", description: "", scope: "user", enabled: true },
    { name: "omega", description: "Admin skill.", scope: "admin", enabled: true }
  ] as const;
}

function context(
  input: Readonly<{
    epoch?: number;
    permission?: "read" | "write";
    locked?: boolean;
    freshness?: "current" | "stale";
    turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
  }> = {}
): SkillsControlContext {
  const permission = input.permission ?? "write";
  const locked = input.locked ?? false;
  const freshness = input.freshness ?? "current";
  const writeEligible = permission === "write" && !locked;
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-skills-release",
    codex_thread_id: threadId,
    cwd: "/private/skills-ui",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: null,
    session_state: freshness === "current" ? "active" : "stale",
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Private stale reason.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/skills-ui",
    model: "runtime-skills",
    settings: null,
    goal: null,
    recent_summary: "Validate Skills utility.",
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
    device_id: "device-skills-ui-private",
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
      invalidationReason: writeEligible ? null : "not_bootstrapped" as const
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
  requestSelectedSessionRead: ReturnType<typeof vi.fn>
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
    requestProtected: vi.fn(),
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
    routeId: "skills_read",
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
