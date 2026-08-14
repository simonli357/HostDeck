import {
  type ApiErrorEnvelope,
  managedSessionProjectionSchema,
  type SkillsSnapshot,
  selectedAccessStateResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot
} from "./connection-state.js";
import { HostDeckBrowserHttpError } from "./http-client.js";
import {
  createSkillsControlController,
  type SkillsControlContext,
  type SkillsControlPort
} from "./skills-control-state.js";

const sessionId = "sess_skills_component_001" as SessionId;
const timestamp = "2026-07-27T16:00:00.000Z";
const threadId = "thread-skills-component-private";

describe("skills-control state", () => {
  it("loads one exact snapshot and projects ordered public skill metadata", async () => {
    const port = skillsPort();
    const controller = createController(port);

    const opening = controller.open();
    expect(controller.snapshot()).toMatchObject({
      phase: "loading",
      busy: true,
      sheetOpen: true
    });
    const view = await opening;

    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      signal: expect.any(AbortSignal)
    });
    expect(view).toMatchObject({
      phase: "content",
      status: "Skills capture current",
      targetLabel: "android-release",
      captureRevision: 1,
      capture: {
        observedAt: timestamp,
        runtimeVersion: "0.147.0",
        freshness: "current"
      },
      snapshotState: "content",
      summary: { total: 4, enabled: 3, disabled: 1, errorCount: 0 }
    });
    expect(view.skills).toEqual([
      {
        name: "alpha",
        description: "Alpha skill.",
        descriptionState: "content",
        scope: "repo",
        scopeLabel: "Project",
        enabled: true
      },
      {
        name: "beta",
        description: null,
        descriptionState: "not_reported",
        scope: "system",
        scopeLabel: "System",
        enabled: false
      },
      {
        name: "gamma",
        description: "",
        descriptionState: "empty",
        scope: "user",
        scopeLabel: "User",
        enabled: true
      },
      {
        name: "omega",
        description: "Admin skill.",
        descriptionState: "content",
        scope: "admin",
        scopeLabel: "Admin",
        enabled: true
      }
    ]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(threadId);
    expect(serialized).not.toContain("connection_generation");
    expect(serialized).not.toContain("/private/skills-component");
  });

  it.each([
    ["empty", [], 0, "empty", "No skills reported"],
    ["partial", defaultSkills(), 2, "partial", "Skills capture partial"],
    ["error", [], 3, "error", "Skills snapshot reported errors"]
  ] as const)(
    "keeps the authoritative %s snapshot distinct",
    async (state, skills, errorCount, phase, status) => {
      const controller = createController(
        skillsPort({ read: async () => skillsSnapshot({ skills, errorCount }) })
      );
      await controller.open();

      expect(controller.snapshot()).toMatchObject({
        phase,
        status,
        snapshotState: state,
        summary: {
          total: skills.length,
          errorCount
        }
      });
      expect(controller.snapshot().refreshEnabled).toBe(true);
    }
  );

  it("projects the complete 1,024-row contract ceiling without dropping counts", async () => {
    const scopes = ["user", "repo", "system", "admin"] as const;
    const skills = Array.from({ length: 1_024 }, (_, index) => ({
      name: `skill-${String(index).padStart(4, "0")}`,
      description: index === 0 ? "x".repeat(4_096) : `Skill ${index}`,
      scope: scopes[index % scopes.length] ?? "user",
      enabled: index % 3 !== 0
    }));
    const controller = createController(
      skillsPort({ read: async () => skillsSnapshot({ skills }) })
    );

    await controller.open();

    expect(controller.snapshot()).toMatchObject({
      phase: "content",
      summary: { total: 1_024, enabled: 682, disabled: 342, errorCount: 0 }
    });
    expect(controller.snapshot().skills).toHaveLength(1_024);
    expect(controller.snapshot().skills?.[0]?.description).toHaveLength(4_096);
    expect(controller.snapshot().skills?.[1]?.name).toBe("skill-0001");
  });

  it("coalesces duplicate open and refresh activation into one request", async () => {
    const first = deferred<SkillsSnapshot>();
    const second = deferred<SkillsSnapshot>();
    let reads = 0;
    const port = skillsPort({
      read: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      }
    });
    const controller = createController(port);

    const opening = controller.open();
    const duplicateOpen = controller.open();
    expect(port.read).toHaveBeenCalledTimes(1);
    first.resolve(skillsSnapshot());
    await opening;
    await duplicateOpen;

    const refreshing = controller.refresh();
    const duplicateRefresh = controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      phase: "stale",
      busy: true,
      capture: { freshness: "stale" }
    });
    expect(port.read).toHaveBeenCalledTimes(2);
    second.resolve(skillsSnapshot({ skills: [defaultSkills()[0]] }));
    await refreshing;
    await duplicateRefresh;

    expect(port.read).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "content",
      summary: { total: 1 },
      capture: { freshness: "current" }
    });
  });

  it("marks retained same-authority data stale across epochs until explicit refresh", async () => {
    const port = skillsPort();
    const controller = createController(port);
    await controller.open();

    const stale = controller.updateContext(context({ epoch: 2 }));
    expect(stale).toMatchObject({
      phase: "stale",
      capture: { freshness: "stale" },
      summary: { total: 4 },
      refreshEnabled: true
    });
    expect(port.read).toHaveBeenCalledTimes(1);

    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      phase: "content",
      captureRevision: 2,
      capture: { freshness: "current" }
    });
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it("keeps a previous capture stale when an explicit refresh fails", async () => {
    let reads = 0;
    const controller = createController(
      skillsPort({
        read: async () => {
          reads += 1;
          if (reads === 1) return skillsSnapshot();
          throw new Error("private refresh failure with cwd /tmp/secret");
        }
      })
    );
    await controller.open();
    await controller.refresh();

    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      status: "Skills refresh failed",
      capture: { freshness: "stale" },
      summary: { total: 4 },
      refreshEnabled: true
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("/tmp/secret");
  });

  it("closes and clears capture immediately on read-authority replacement", async () => {
    const controller = createController(skillsPort());
    await controller.open();

    const replaced = controller.updateContext(
      context({ epoch: 2, deviceId: "device-skills-replacement-private" })
    );
    expect(replaced).toMatchObject({
      sheetOpen: false,
      phase: "closed",
      capture: null,
      snapshotState: null,
      summary: null,
      skills: null
    });
  });

  it.each([
    { runtimeVersion: "0.145.0" },
    { projectedThreadId: "thread-skills-replaced-private" }
  ])("closes and clears capture when its runtime target is replaced", async (replacement) => {
    const controller = createController(skillsPort());
    await controller.open();

    expect(() =>
      controller.updateContext(context({ epoch: 2, ...replacement }))
    ).not.toThrow();
    expect(controller.snapshot()).toMatchObject({
      sheetOpen: false,
      phase: "closed",
      capture: null,
      summary: null,
      skills: null
    });
  });

  it("cancels an initial read on epoch change and suppresses its late result", async () => {
    const response = deferred<SkillsSnapshot>();
    const port = skillsPort({ read: async () => response.promise });
    const controller = createController(port);
    const opening = controller.open();
    const signal = port.read.mock.calls[0]?.[0].signal;

    const changed = controller.updateContext(context({ epoch: 2 }));
    expect(signal?.aborted).toBe(true);
    expect(changed).toMatchObject({ phase: "failure", capture: null, skills: null });
    response.resolve(skillsSnapshot());
    await opening;
    expect(controller.snapshot()).toMatchObject({ phase: "failure", capture: null });
  });

  it("hides data and suppresses late settlement after disclosure loss", async () => {
    const response = deferred<SkillsSnapshot>();
    const controller = createController(
      skillsPort({ read: async () => response.promise })
    );
    const opening = controller.open();

    const hidden = controller.updateContext(context({ canRead: false, epoch: 2 }));
    expect(hidden).toMatchObject({ visible: false, sheetOpen: false, skills: null });
    response.resolve(skillsSnapshot());
    await opening;
    expect(controller.snapshot()).toMatchObject({ visible: false, skills: null });
  });

  it.each(["idle", "in_progress", "waiting_for_input", "unknown"] as const)(
    "allows read-only and locked reads while turn state is %s",
    async (turnState) => {
      const controller = createController(
        skillsPort(),
        context({ permission: "read", locked: true, turnState })
      );
      await controller.open();
      expect(controller.snapshot()).toMatchObject({
        phase: "content",
        actionEnabled: true,
        summary: { total: 4 }
      });
    }
  );

  it("blocks a stale target without consulting write eligibility", async () => {
    const port = skillsPort();
    const controller = createController(port, context({ freshness: "stale" }));
    expect(controller.snapshot()).toMatchObject({ visible: true, actionEnabled: false });
    await controller.open();
    expect(port.read).not.toHaveBeenCalled();
  });

  it("retains a stale capture when write authority is downgraded", async () => {
    const controller = createController(
      skillsPort(),
      context({ permission: "write", locked: false })
    );
    await controller.open();

    const downgraded = controller.updateContext(
      context({ epoch: 2, permission: "read", locked: true })
    );
    expect(downgraded).toMatchObject({
      visible: true,
      sheetOpen: true,
      actionEnabled: true,
      phase: "stale",
      capture: { freshness: "stale" },
      summary: { total: 4 }
    });
  });

  it("distinguishes unsupported capability from sanitized read failure", async () => {
    for (const code of ["capability_unavailable", "incompatible_runtime"] as const) {
      const controller = createController(
        skillsPort({
          read: async () => {
            throw httpApiError(code, false);
          }
        })
      );
      await controller.open();
      expect(controller.snapshot()).toMatchObject({
        phase: "unsupported",
        status: "Skills unavailable",
        refreshEnabled: false
      });
    }

    const failed = createController(
      skillsPort({
        read: async () => {
          throw new Error("private raw Skills runtime failure");
        }
      })
    );
    await failed.open();
    expect(failed.snapshot()).toMatchObject({
      phase: "failure",
      status: "Skills could not be loaded",
      refreshEnabled: true
    });
    expect(JSON.stringify(failed.snapshot())).not.toContain("private raw Skills");
  });

  it.each([
    skillsSnapshot({ targetSessionId: "sess_skills_foreign_001" }),
    skillsSnapshot({ targetThreadId: "thread-skills-foreign-private" }),
    skillsSnapshot({ runtimeVersion: "0.145.0" }),
    { ...skillsSnapshot(), cwd: "/tmp/private-skills" },
    {
      ...skillsSnapshot(),
      state: "partial",
      error_count: 0
    }
  ])("rejects malformed, contradictory, or foreign success", async (candidate) => {
    const controller = createController(
      skillsPort({ read: async () => candidate })
    );
    await controller.open();
    expect(controller.snapshot()).toMatchObject({
      phase: "failure",
      capture: null,
      snapshotState: null,
      summary: null,
      skills: null
    });
  });

  it("dismisses and closes idempotently while suppressing late rejection", async () => {
    const response = deferred<SkillsSnapshot>();
    const controller = createController(
      skillsPort({ read: async () => response.promise })
    );
    const opening = controller.open();
    const dismissed = controller.dismiss();
    expect(dismissed).toMatchObject({ sheetOpen: false, phase: "closed", skills: null });
    response.reject(new Error("private late Skills rejection"));
    await opening;
    expect(controller.snapshot()).toBe(dismissed);

    const closed = controller.close();
    expect(closed).toMatchObject({ visible: false, sheetOpen: false });
    expect(controller.close()).toBe(closed);
    expect(() => controller.dismiss()).not.toThrow();
  });

  it("bounds listener ownership and publishes immutable private-free views", async () => {
    const controller = createController(skillsPort());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.open();

    expect(listener).toHaveBeenCalled();
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(Object.isFrozen(controller.snapshot().skills)).toBe(true);
    expect(Object.isFrozen(controller.snapshot().skills?.[0])).toBe(true);
    unsubscribe();
    expect(() => controller.subscribe(listener)).not.toThrow();
  });

  it("rejects malformed construction and enforces subscriber and closed-owner bounds", () => {
    const validContext = context();
    const validPort = skillsPort();
    expect(() =>
      createSkillsControlController({
        sessionId: "" as SessionId,
        context: validContext,
        port: validPort
      })
    ).toThrow();
    expect(() =>
      createSkillsControlController({
        sessionId,
        context: { ...validContext, extra: true } as unknown as SkillsControlContext,
        port: validPort
      })
    ).toThrow("HostDeck skills-control context is invalid.");
    expect(() =>
      createSkillsControlController({
        sessionId,
        context: validContext,
        port: { read: validPort.read, write: vi.fn() } as unknown as SkillsControlPort
      })
    ).toThrow("HostDeck skills-control port is invalid.");

    const controller = createController(validPort);
    const duplicate = vi.fn();
    const unsubscribe = controller.subscribe(duplicate);
    expect(() => controller.subscribe(duplicate)).toThrow(
      "HostDeck skills-control listener is invalid."
    );
    const unsubscribers = [unsubscribe];
    for (let index = 1; index < 32; index += 1) {
      unsubscribers.push(controller.subscribe(vi.fn()));
    }
    expect(() => controller.subscribe(vi.fn())).toThrow(
      "HostDeck skills-control listener capacity is exhausted."
    );
    for (const release of unsubscribers) release();

    controller.close();
    expect(() => controller.subscribe(vi.fn())).toThrow(
      "HostDeck skills-control listener is invalid."
    );
    expect(() => controller.updateContext(validContext)).toThrow(
      "HostDeck skills control is closed."
    );
  });
});

function createController(
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

function skillsSnapshot(
  input: Readonly<{
    skills?: readonly {
      readonly name: string;
      readonly description: string | null;
      readonly scope: "user" | "repo" | "system" | "admin";
      readonly enabled: boolean;
    }[];
    errorCount?: number;
    targetSessionId?: string;
    targetThreadId?: string;
    runtimeVersion?: string;
  }> = {}
): SkillsSnapshot {
  const skills = input.skills ?? defaultSkills();
  const errorCount = input.errorCount ?? 0;
  const state = skills.length === 0
    ? errorCount === 0 ? "empty" : "error"
    : errorCount === 0 ? "content" : "partial";
  return skillsSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: input.targetSessionId ?? sessionId,
      codex_thread_id: input.targetThreadId ?? threadId
    },
    runtime_version: input.runtimeVersion ?? "0.147.0",
    connection_generation: 4,
    observed_at: timestamp,
    state,
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
    deviceId?: string;
    permission?: "read" | "write";
    locked?: boolean;
    canRead?: boolean;
    accessState?: BrowserConnectionResourceState;
    targetState?: BrowserConnectionResourceState;
    freshness?: "current" | "stale";
    projectedThreadId?: string;
    runtimeVersion?: string;
    turnState?: "idle" | "in_progress" | "waiting_for_input" | "unknown";
  }> = {}
): SkillsControlContext {
  const freshness = input.freshness ?? "current";
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "android-release",
    codex_thread_id: input.projectedThreadId ?? threadId,
    cwd: "/private/skills-component",
    runtime_source: "codex_app_server",
    runtime_version: input.runtimeVersion ?? "0.147.0",
    created_at: timestamp,
    archived_at: null,
    session_state: freshness === "current" ? "active" : "stale",
    turn_state: input.turnState ?? "idle",
    attention: "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection fixture is stale.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/skills-component",
    model: "runtime-skills",
    settings: null,
    goal: null,
    recent_summary: "Validate structured Skills.",
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
      state: "connected" as const,
      snapshot: null,
      continuity: "contiguous" as const,
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
    device_id: input.deviceId ?? "device-skills-component-private",
    permission,
    device_expires_at: "2026-10-27T16:00:00.000Z",
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

function httpApiError(code: ApiErrorEnvelope["code"], retryable: boolean) {
  return new HostDeckBrowserHttpError({
    reason: "api_error",
    routeId: "skills_read",
    transport: "https",
    status: 409,
    apiError: {
      code,
      message: "Private Skills fixture detail.",
      retryable
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
