import {
  approvalProjectionEventSchema,
  compactProgressResponseSchema,
  goalControlSnapshotSchema,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  pendingApprovalListResponseSchema,
  planControlSnapshotSchema,
  selectedAccessStateResponseSchema,
  selectedEventPageResponseSchema,
  selectedHostCompatibilityCapabilityStates,
  selectedHostCompatibilityEvidenceStates,
  selectedHostCompatibilityStates,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import {
  managedSessionStates,
  projectionFreshnessStates,
  runtimeConnectionStates,
  type SessionId,
  turnStates
} from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import { createApprovalDecisionController } from "./approval-decision-state.js";
import { createArchiveControlController } from "./archive-control-state.js";
import { createCompactControlController } from "./compact-control-state.js";
import {
  type BrowserConnectionResource,
  type BrowserConnectionResourceState,
  type BrowserConnectionSnapshot,
  type BrowserConnectionWriteBlockCause,
  browserConnectionPhases,
  browserConnectionResourceStates,
  browserConnectionWriteBlockCauses
} from "./connection-state.js";
import { createEventDiagnosticsController } from "./event-diagnostics-state.js";
import { projectGoalControl } from "./goal-control-state.js";
import { createInterruptControlController } from "./interrupt-control-state.js";
import { createLaptopResumeControlController } from "./laptop-resume-control-state.js";
import { projectModelControl } from "./model-control-state.js";
import { projectPlanControl } from "./plan-control-state.js";
import { projectPromptComposer } from "./prompt-composer-state.js";
import { projectRemoteConnectionRecovery } from "./remote-connection-recovery-state.js";
import { projectRuntimeCompatibility } from "./runtime-compatibility-state.js";
import { createSessionDetailFeed } from "./session-detail-feed.js";
import { createSkillsControlController } from "./skills-control-state.js";
import { projectUsageControl } from "./usage-control-state.js";

const sessionId = "sess_cross_screen_controls_001" as SessionId;
const threadId = "thread-cross-screen-controls-private";
const turnId = "turn-cross-screen-controls-001";
const approvalRequestId = "request-cross-screen-controls-001";
const timestamp = "2026-07-27T18:00:00.000Z";
const expiry = "2026-07-27T19:00:00.000Z";
const remoteOrigin = "https://hostdeck-laptop.fixture-tailnet.ts.net";

const mutationControlNames = Object.freeze([
  "prompt",
  "model",
  "goal",
  "plan",
  "compact",
  "approval",
  "interrupt",
  "archive"
] as const);

const selectedReadControlNames = Object.freeze([
  "model",
  "goal",
  "plan",
  "usage",
  "compact",
  "skills",
  "event_diagnostics",
  "laptop_resume"
] as const);

const reviewedIndependentControls = Object.freeze([
  "compatibility_check",
  "remote_check",
  "device_list",
  "device_revoke",
  "host_lock"
] as const);

describe("cross-screen route and control admission matrix", () => {
  it("enumerates the complete coordinated state and owner axes", () => {
    expect(browserConnectionPhases).toEqual([
      "idle",
      "loading",
      "ready",
      "access_limited",
      "remote_unavailable",
      "offline",
      "incompatible",
      "not_found",
      "unreachable",
      "degraded",
      "fatal",
      "closed"
    ]);
    expect(browserConnectionResourceStates).toEqual([
      "idle",
      "loading",
      "current",
      "stale",
      "blocked",
      "not_found",
      "failed"
    ]);
    expect(managedSessionStates).toEqual([
      "starting",
      "active",
      "archived",
      "stale",
      "incompatible",
      "unknown"
    ]);
    expect(turnStates).toEqual([
      "idle",
      "in_progress",
      "waiting_for_input",
      "waiting_for_approval",
      "completed",
      "interrupted",
      "failed",
      "unknown"
    ]);
    expect(projectionFreshnessStates).toEqual([
      "current",
      "stale",
      "disconnected",
      "incompatible"
    ]);
    expect(runtimeConnectionStates).toEqual([
      "ready",
      "degraded",
      "incompatible",
      "disconnected"
    ]);
    expect(selectedHostCompatibilityStates).toEqual([
      "supported",
      "degraded",
      "incompatible",
      "unknown",
      "disconnected",
      "version_drift"
    ]);
    expect(selectedHostCompatibilityEvidenceStates).toEqual([
      "current",
      "last_known",
      "unobserved"
    ]);
    expect(selectedHostCompatibilityCapabilityStates).toEqual([
      "verified",
      "limited",
      "blocked",
      "unverified"
    ]);
    expect(new Set([
      ...mutationControlNames,
      ...selectedReadControlNames,
      ...reviewedIndependentControls
    ])).toEqual(new Set([
      "prompt",
      "model",
      "goal",
      "plan",
      "usage",
      "compact",
      "skills",
      "approval",
      "event_diagnostics",
      "interrupt",
      "archive",
      "laptop_resume",
      "compatibility_check",
      "remote_check",
      "device_list",
      "device_revoke",
      "host_lock"
    ]));
  });

  it("admits every mutation surface only under the fully current baseline", async () => {
    expect(await mutationAdmissions()).toEqual(enabledMutationAdmissions());
  });

  it.each(browserConnectionWriteBlockCauses)(
    "blocks every ordinary mutation surface for canonical cause %s",
    async (cause) => {
      expect(await mutationAdmissions(cause)).toEqual(disabledMutationAdmissions());
    }
  );

  it.each([
    "read_only_access",
    "host_lock_pending",
    "host_lock_unconfirmed",
    "host_locked",
    "host_status_unavailable",
    "host_not_ready",
    "csrf_not_ready"
  ] as const)(
    "keeps exact selected-session reads independent from ordinary write cause %s",
    async (cause) => {
      expect(await selectedReadAdmissions(detailSnapshot({ writeCause: cause }))).toEqual(
        enabledSelectedReadAdmissions()
      );
    }
  );

  it.each([
    ["stale access", detailSnapshot({ accessState: "stale" })],
    ["stale target", detailSnapshot({ targetState: "stale" })]
  ] as const)("blocks every selected-session read for %s", async (_label, snapshot) => {
    expect(await selectedReadAdmissions(snapshot)).toEqual(disabledSelectedReadAdmissions());
  });

  it.each([
    ["stale", detailSnapshot({ freshness: "stale" })],
    ["disconnected", detailSnapshot({ freshness: "disconnected" })],
    ["incompatible", detailSnapshot({ freshness: "incompatible" })]
  ] as const)(
    "allows structured control recovery reads but blocks retained-capture reads for %s session projection",
    async (_label, snapshot) => {
      expect(await selectedReadAdmissions(snapshot)).toEqual(
        staleProjectionReadAdmissions()
      );
    }
  );

  it("keeps a retained boundary compatible with exact current reads", async () => {
    expect(
      await selectedReadAdmissions(
        detailSnapshot({ streamContinuity: "boundary" })
      )
    ).toEqual(enabledSelectedReadAdmissions());
  });

  it("purges every protected selected-session control after authority loss", async () => {
    const admissions = await selectedReadAdmissions(authorityLostSnapshot());
    expect(admissions).toEqual(disabledSelectedReadAdmissions());
    expect(projectPromptComposer({
      sessionId,
      snapshot: authorityLostSnapshot(),
      feed: createSessionDetailFeed(sessionId),
      draft: "Private draft must not survive.",
      operation: Object.freeze({ phase: "idle" as const })
    })).toMatchObject({
      visible: false,
      targetLabel: null,
      draft: "Private draft must not survive.",
      sendEnabled: false
    });
    expect(projectRuntimeCompatibility(authorityLostSnapshot()).actionEnabled).toBe(false);
    expect(projectRemoteConnectionRecovery(authorityLostSnapshot()).actionEnabled).toBe(false);
  });
});

async function mutationAdmissions(
  writeCause?: BrowserConnectionWriteBlockCause
): Promise<Record<(typeof mutationControlNames)[number], boolean>> {
  const writeOptions = writeCause === undefined
    ? Object.freeze({})
    : Object.freeze({ writeCause });
  const idle = detailSnapshot({ turnState: "idle", ...writeOptions });
  const active = detailSnapshot({ turnState: "in_progress", ...writeOptions });
  const waitingApproval = detailSnapshot({
    turnState: "waiting_for_approval",
    ...writeOptions
  });
  const promptFeed = createSessionDetailFeed(sessionId);
  const prompt = projectPromptComposer({
    sessionId,
    snapshot: idle,
    feed: promptFeed,
    draft: "Run the bounded release check.",
    operation: Object.freeze({ phase: "idle" as const })
  });
  const model = projectModelControl({
    sessionId,
    context: Object.freeze({ snapshot: idle }),
    open: true,
    data: modelSnapshot(),
    selectedModelId: "model-b",
    selectedEffort: "medium",
    operation: Object.freeze({ phase: "idle" as const })
  });
  const goal = projectGoalControl({
    sessionId,
    context: Object.freeze({ snapshot: idle }),
    open: true,
    data: goalSnapshot(),
    draft: "Complete the bounded release verification.",
    confirmation: null,
    operation: Object.freeze({ phase: "idle" as const })
  });
  const plan = projectPlanControl({
    sessionId,
    context: Object.freeze({ snapshot: idle }),
    open: true,
    data: planSnapshot(),
    selectedMode: "plan",
    operation: Object.freeze({ phase: "idle" as const })
  });

  const compactController = createCompactControlController({
    sessionId,
    context: Object.freeze({ snapshot: idle }),
    port: Object.freeze({
      read: async () => compactProgressResponseSchema.parse({ progress: null }),
      start: async () => {
        throw new Error("Compact mutation must not run while projecting admission.");
      }
    }),
    createOperationId: () => "op_cross_screen_compact_001"
  });
  const compact = await compactController.open();

  const approvalEventValue = approvalEvent();
  const approvalController = createApprovalDecisionController({
    sessionId,
    context: Object.freeze({
      snapshot: waitingApproval,
      events: Object.freeze([approvalEventValue])
    }),
    port: Object.freeze({
      read: async () => approvalList(),
      respond: async () => {
        throw new Error("Approval mutation must not run while projecting admission.");
      }
    }),
    createOperationId: () => "op_cross_screen_approval_001",
    clock: frozenApprovalClock()
  });
  const approval = await approvalController.synchronize();

  const interruptController = createInterruptControlController({
    sessionId,
    context: Object.freeze({
      snapshot: active,
      events: Object.freeze([turnEvent("in_progress")]),
      boundary: null
    }),
    port: Object.freeze({
      interrupt: async () => {
        throw new Error("Interrupt mutation must not run while projecting admission.");
      }
    }),
    createOperationId: () => "op_cross_screen_interrupt_001"
  });
  const archiveController = createArchiveControlController({
    sessionId,
    context: Object.freeze({ snapshot: idle }),
    port: Object.freeze({
      archive: async () => {
        throw new Error("Archive mutation must not run while projecting admission.");
      }
    }),
    createOperationId: () => "op_cross_screen_archive_001"
  });

  const result = {
    prompt: prompt.sendEnabled,
    model: model.submitEnabled,
    goal: goal.saveEnabled,
    plan: plan.submitEnabled,
    compact: compact.startEnabled,
    approval:
      approval.items[0]?.approveEnabled === true &&
      approval.items[0]?.denyEnabled === true,
    interrupt: interruptController.snapshot().actionEnabled,
    archive: archiveController.snapshot().actionEnabled
  };
  compactController.close();
  approvalController.close();
  interruptController.close();
  archiveController.close();
  return result;
}

async function selectedReadAdmissions(
  snapshot: BrowserConnectionSnapshot
): Promise<Record<(typeof selectedReadControlNames)[number], boolean>> {
  const model = projectModelControl({
    sessionId,
    context: Object.freeze({ snapshot }),
    open: false,
    data: null,
    selectedModelId: null,
    selectedEffort: null,
    operation: Object.freeze({ phase: "idle" as const })
  });
  const goal = projectGoalControl({
    sessionId,
    context: Object.freeze({ snapshot }),
    open: false,
    data: null,
    draft: "",
    confirmation: null,
    operation: Object.freeze({ phase: "idle" as const })
  });
  const plan = projectPlanControl({
    sessionId,
    context: Object.freeze({ snapshot }),
    open: false,
    data: null,
    selectedMode: null,
    operation: Object.freeze({ phase: "idle" as const })
  });
  const usage = projectUsageControl({
    sessionId,
    context: Object.freeze({ snapshot }),
    open: false,
    data: null,
    captureEpoch: null,
    captureAuthorityKey: null,
    operation: Object.freeze({ phase: "idle" as const })
  });
  const compactController = createCompactControlController({
    sessionId,
    context: Object.freeze({ snapshot }),
    port: Object.freeze({
      read: async () => compactProgressResponseSchema.parse({ progress: null }),
      start: async () => {
        throw new Error("Compact mutation is outside read admission.");
      }
    }),
    createOperationId: () => "op_cross_screen_compact_read_001"
  });
  const skillsController = createSkillsControlController({
    sessionId,
    context: Object.freeze({ snapshot }),
    port: Object.freeze({
      read: async () => {
        throw new Error("Skills read is not dispatched while projecting its action.");
      }
    })
  });
  const laptopController = createLaptopResumeControlController({
    sessionId,
    context: Object.freeze({ snapshot }),
    port: Object.freeze({
      read: async () => {
        throw new Error("Laptop resume read is not dispatched while projecting its action.");
      },
      writeClipboard: async () => {
        throw new Error("Clipboard write is outside read admission.");
      }
    })
  });

  const event = diagnosticEvent();
  const eventRead = vi.fn(async () => selectedEventPageResponseSchema.parse({
    session_id: sessionId,
    events: [event],
    next_cursor: 1,
    truncated: false
  }));
  const eventController = createEventDiagnosticsController({
    sessionId,
    context: Object.freeze({
      snapshot,
      events: Object.freeze([event]),
      boundary: null
    }),
    port: Object.freeze({ read: eventRead })
  });
  if (eventController.snapshot().visible) {
    await eventController.open(1);
  }

  const result = {
    model: model.actionEnabled,
    goal: goal.actionEnabled,
    plan: plan.actionEnabled,
    usage: usage.actionEnabled,
    compact: compactController.snapshot().actionEnabled,
    skills: skillsController.snapshot().actionEnabled,
    event_diagnostics: eventRead.mock.calls.length === 1,
    laptop_resume: laptopController.snapshot().actionEnabled
  };
  compactController.close();
  skillsController.close();
  eventController.close();
  laptopController.close();
  return result;
}

function enabledMutationAdmissions(): Record<(typeof mutationControlNames)[number], boolean> {
  return Object.fromEntries(mutationControlNames.map((name) => [name, true])) as Record<
    (typeof mutationControlNames)[number],
    boolean
  >;
}

function disabledMutationAdmissions(): Record<(typeof mutationControlNames)[number], boolean> {
  return Object.fromEntries(mutationControlNames.map((name) => [name, false])) as Record<
    (typeof mutationControlNames)[number],
    boolean
  >;
}

function enabledSelectedReadAdmissions(): Record<
  (typeof selectedReadControlNames)[number],
  boolean
> {
  return Object.fromEntries(selectedReadControlNames.map((name) => [name, true])) as Record<
    (typeof selectedReadControlNames)[number],
    boolean
  >;
}

function disabledSelectedReadAdmissions(): Record<
  (typeof selectedReadControlNames)[number],
  boolean
> {
  return Object.fromEntries(selectedReadControlNames.map((name) => [name, false])) as Record<
    (typeof selectedReadControlNames)[number],
    boolean
  >;
}

function staleProjectionReadAdmissions(): Record<
  (typeof selectedReadControlNames)[number],
  boolean
> {
  return {
    model: true,
    goal: true,
    plan: true,
    usage: false,
    compact: false,
    skills: false,
    event_diagnostics: false,
    laptop_resume: false
  };
}

function detailSnapshot(
  options: Readonly<{
    accessState?: BrowserConnectionResourceState;
    freshness?: "current" | "stale" | "disconnected" | "incompatible";
    streamContinuity?: "contiguous" | "boundary" | "unproven";
    streamState?: "connected" | "reconnecting" | "failed" | "closed";
    targetState?: BrowserConnectionResourceState;
    turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
    writeCause?: BrowserConnectionWriteBlockCause;
  }> = {}
): BrowserConnectionSnapshot {
  const access = pairedAccess();
  const session = managedSessionProjectionSchema.parse({
    id: sessionId,
    name: "cross-screen-controls",
    codex_thread_id: threadId,
    cwd: "/private/cross-screen-controls",
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: options.turnState ?? "idle",
    attention:
      options.turnState === "waiting_for_input"
        ? "needs_input"
        : options.turnState === "waiting_for_approval"
          ? "needs_approval"
          : options.turnState === "failed"
            ? "failed"
            : options.turnState === "unknown"
              ? "unknown"
              : options.turnState === "in_progress"
                ? "watch"
                : "none",
    freshness: options.freshness ?? "current",
    freshness_reason:
      options.freshness === undefined || options.freshness === "current"
        ? null
        : "Projection is not current.",
    updated_at: timestamp,
    last_activity_at: timestamp,
    branch: "feat/cross-screen-controls",
    model: "runtime-a",
    settings: null,
    goal: null,
    recent_summary: "Cross-screen admission fixture.",
    last_event_cursor: 1
  });
  const item = selectedSessionReadItemSchema.parse({
    session,
    event_window: {
      state: options.streamContinuity === "boundary" ? "bounded" : "contiguous",
      retained_event_count: 1,
      earliest_retained_cursor: 1,
      boundary_cursor: options.streamContinuity === "boundary" ? 0 : null
    }
  });
  const response = selectedSessionDetailResponseSchema.parse({
    access: {
      mode: "paired_write",
      network_mode: "remote",
      transport: "https"
    },
    session: item
  });
  const continuity = options.streamContinuity ?? "contiguous";
  const streamState = options.streamState ?? "connected";
  const boundary = continuity === "boundary"
    ? Object.freeze({
        after: 0,
        cursor: 1,
        reason: "retention" as const
      })
    : null;
  const writeCause = options.writeCause;
  return Object.freeze({
    epoch: 2,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "ready" as const,
    access: resource(options.accessState ?? "current", access),
    host: resource("current", hostStatus(access)),
    targetState: resource(
      options.targetState ?? "current",
      Object.freeze({ kind: "session_detail" as const, response })
    ),
    stream: Object.freeze({
      state: streamState,
      snapshot: Object.freeze({
        sessionId,
        transport: "https" as const,
        phase: streamState,
        cursor: 1,
        continuity,
        boundary,
        retryCount: streamState === "reconnecting" ? 1 : 0,
        retryAt: null,
        lastHeartbeatAt: null,
        lastEventAt: null,
        failure: null,
        closeReason: streamState === "closed" ? "client_closed" as const : null
      }),
      continuity,
      boundary,
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
}

function authorityLostSnapshot(): BrowserConnectionSnapshot {
  return Object.freeze({
    epoch: 3,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: "access_limited" as const,
    access: resource("current", deniedAccess()),
    host: resource<ReturnType<typeof hostStatus>>("blocked", null),
    targetState: resource<
      NonNullable<BrowserConnectionSnapshot["targetState"]["data"]>
    >("blocked", null),
    stream: Object.freeze({
      state: "idle" as const,
      snapshot: null,
      continuity: "unproven" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "idle" as const,
      generation: null,
      rotatedAt: null,
      failure: null,
      invalidationReason: "device_revoked" as const
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: false,
      causes: Object.freeze(["revoked_device" as const])
    }),
    lastFailure: null
  });
}

function modelSnapshot() {
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
    pending: null,
    models: [
      {
        id: "model-a",
        runtime_model: "runtime-a",
        label: "Codex Alpha",
        description: "Current model.",
        is_default: true,
        input_modalities: ["text"],
        reasoning_efforts: [
          { id: "high", description: "Current effort.", is_default: true }
        ]
      },
      {
        id: "model-b",
        runtime_model: "runtime-b",
        label: "Codex Beta",
        description: "Next-turn candidate.",
        is_default: false,
        input_modalities: ["text"],
        reasoning_efforts: [
          { id: "medium", description: "Candidate effort.", is_default: true }
        ]
      }
    ]
  });
}

function goalSnapshot() {
  return goalControlSnapshotSchema.parse({
    goal: {
      revision: "a".repeat(64),
      objective: "Complete the current implementation.",
      status: "paused",
      token_budget: 20_000,
      tokens_used: 1_200,
      time_used_seconds: 75.5,
      created_at: timestamp,
      updated_at: timestamp
    },
    uncertain_mutation: null
  });
}

function planSnapshot() {
  return planControlSnapshotSchema.parse({
    catalog_revision: "d".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      state: "confirmed",
      mode: "default",
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      observed_at: timestamp
    },
    pending: null,
    execution: {
      turn_id: null,
      state: "idle",
      evidence: "none",
      summary: null,
      updated_at: null
    },
    modes: [
      {
        name: "Plan",
        mode: "plan",
        preset_model: "runtime-plan",
        preset_reasoning_effort: "medium"
      },
      {
        name: "Default",
        mode: "default",
        preset_model: null,
        preset_reasoning_effort: null
      }
    ]
  });
}

function approvalEvent() {
  return approvalProjectionEventSchema.parse({
    session_id: sessionId,
    cursor: 1,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: "codex-cross-screen-approval",
    codex_event_type: "item/approval",
    content_state: "complete",
    content_notice: null,
    type: "approval",
    request_id: approvalRequestId,
    state: "pending",
    action: "Run selected validation",
    scope: "Current workspace",
    reason: "Verify the bounded implementation.",
    risk: "normal",
    expires_at: expiry,
    decision: null
  });
}

function approvalList() {
  return pendingApprovalListResponseSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    approvals: [
      {
        target: {
          type: "approval",
          session_id: sessionId,
          codex_thread_id: threadId,
          request_id: approvalRequestId
        },
        action: "Run selected validation",
        scope: "Current workspace",
        reason: "Verify the bounded implementation.",
        risk: "normal",
        grant_scope: "one_time",
        state: "pending",
        created_at: timestamp,
        expires_at: expiry,
        decision: null
      }
    ]
  });
}

function turnEvent(state: "in_progress") {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor: 1,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: "codex-cross-screen-turn",
    codex_event_type: "turn/status",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: turnId,
    state,
    error: null
  });
}

function diagnosticEvent() {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor: 1,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: "codex-cross-screen-message",
    codex_event_type: "item/message",
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: "item-cross-screen-message",
    text: "Bounded diagnostic fixture."
  });
}

function pairedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device-cross-screen-controls",
    permission: "write",
    device_expires_at: "2026-10-27T18:00:00.000Z",
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: false
  });
}

function deniedAccess() {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "revoked_device",
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}

function hostStatus(access: ReturnType<typeof pairedAccess>) {
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
      mode: access.permission === "read" ? "paired_read" : "paired_write",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: access.permission === "write",
        causes: access.permission === "write" ? [] : ["read_only_access"]
      }
    }
  });
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null
): BrowserConnectionResource<Data> {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function frozenApprovalClock() {
  return Object.freeze({
    now: () => Date.parse("2026-07-27T18:30:00.000Z"),
    setTimeout: () => Object.freeze({ kind: "approval-expiry" as const }),
    clearTimeout: () => undefined
  });
}
