import {
  compactOperationIntentSchema,
  formatSelectedResumeLaunchCommand,
  goalControlSnapshotSchema,
  goalOperationIntentSchema,
  type ManagedSessionTarget,
  type ModelControlSnapshot,
  managedSessionTargetSchema,
  modelControlSnapshotSchema,
  modelOperationIntentSchema,
  type PendingApproval,
  type PlanControlSnapshot,
  pendingApprovalSchema,
  planControlSnapshotSchema,
  planOperationIntentSchema,
  type RuntimeCompatibility,
  type SelectedOperationProgress,
  type SkillsSnapshot,
  selectedOperationProgressSchema,
  selectedResumeMetadataResponseSchema,
  skillsSnapshotSchema,
  type UsageSnapshot,
  usageSnapshotSchema
} from "../../packages/contracts/src/index.js";
import type {
  HostDeckSelectedApiControls,
  HostDeckSelectedApiRuntimes,
  HostDeckSelectedApiSessions
} from "../../packages/server/src/index.js";
import {
  type SelectedStateRepository,
  selectedStateRevision
} from "../../packages/storage/src/index.js";

const sessionId = "sess_physical_pairing_ui";
const threadId = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";
const approvalRequestId = "request-physical-approval-001";
const timestamp = "2026-07-29T12:00:00.000Z";
const changedTimestamp = "2026-07-29T12:01:00.000Z";
const interruptTurnId = "turn-physical-interrupt-001";

type PromptControls = HostDeckSelectedApiControls["prompts"];

export interface PhysicalDashboardControlSnapshot {
  readonly approvalDecision: "approve" | "deny" | null;
  readonly archived: boolean;
  readonly calls: Readonly<Record<string, number>>;
  readonly compactState: SelectedOperationProgress["state"] | "absent";
  readonly goalStatus:
    | "active"
    | "paused"
    | "blocked"
    | "usage_limited"
    | "budget_limited"
    | "complete"
    | null;
  readonly modelApplied: boolean;
  readonly planApplied: boolean;
}

export interface PhysicalDashboardControls {
  readonly approvalRequestId: string;
  readonly controls: HostDeckSelectedApiControls;
  readonly interruptTurnId: string;
  readonly managed: HostDeckSelectedApiSessions["managed"];
  readonly resume: HostDeckSelectedApiSessions["resume"];
  readonly runtimes: HostDeckSelectedApiRuntimes;
  readonly applyModel: () => void;
  readonly applyPlan: () => void;
  readonly beginInterruptibleTurn: () => void;
  readonly completeCompact: () => void;
  readonly finishInterrupt: () => void;
  readonly hasPendingApproval: () => boolean;
  readonly hasPendingCompact: () => boolean;
  readonly hasPendingGoal: () => boolean;
  readonly hasPendingModel: () => boolean;
  readonly hasPendingPlan: () => boolean;
  readonly markSessionStale: () => void;
  readonly releaseApproval: () => void;
  readonly releaseCompact: () => void;
  readonly releaseGoal: () => void;
  readonly releaseModel: () => void;
  readonly releasePlan: () => void;
  readonly restoreSessionCurrent: () => void;
  readonly snapshot: () => PhysicalDashboardControlSnapshot;
}

export function createPhysicalDashboardControls(input: Readonly<{
  approval: Readonly<{
    readonly createdAt: string;
    readonly expiresAt: string;
  }>;
  now: () => Date;
  prompts: PromptControls;
  runtime: RuntimeCompatibility;
  states: SelectedStateRepository;
}>): PhysicalDashboardControls {
  const calls = new Map<string, number>();
  const count = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };
  const modelGate = new PhysicalDeferredGate("model");
  const goalGate = new PhysicalDeferredGate("goal");
  const planGate = new PhysicalDeferredGate("plan");
  const compactGate = new PhysicalDeferredGate("compact");
  const approvalGate = new PhysicalDeferredGate("approval");
  let model = initialModelSnapshot();
  let modelApplied = false;
  let goal = goalControlSnapshotSchema.parse({
    goal: null,
    uncertain_mutation: null
  });
  let plan = initialPlanSnapshot();
  let planApplied = false;
  let compact: SelectedOperationProgress | null = null;
  let approval = initialApproval(input.approval);
  let interruptible = false;
  let archived = false;

  const controls: HostDeckSelectedApiControls = Object.freeze({
    approvals: Object.freeze({
      async list(target: unknown) {
        count("read_approvals");
        requireManagedTarget(target);
        return Object.freeze([approval]);
      },
      async respond(intent: unknown) {
        count("respond_approval");
        const candidate = readRecord(intent, "approval response");
        if (
          candidate.kind !== "approval_response" ||
          candidate.decision !== "approve" ||
          readRecord(candidate.target, "approval target").request_id !==
            approvalRequestId ||
          approval.state !== "pending"
        ) {
          throw new TypeError("Physical approval response intent is invalid.");
        }
        approval = pendingApprovalSchema.parse({
          ...approval,
          state: "responding"
        });
        return approval;
      },
      async snapshot(target: unknown) {
        const candidate = readRecord(target, "approval snapshot target");
        return candidate.request_id === approvalRequestId ? approval : null;
      },
      async waitForTerminal(target: unknown) {
        const candidate = readRecord(target, "approval terminal target");
        if (candidate.request_id !== approvalRequestId) {
          throw new TypeError("Physical approval terminal target is invalid.");
        }
        await approvalGate.wait();
        approval = pendingApprovalSchema.parse({
          ...approval,
          state: "approved",
          decision: "approve"
        });
        return approval;
      }
    }),
    compact: Object.freeze({
      async compact(intent: unknown) {
        count("start_compact");
        const parsed = compactOperationIntentSchema.parse(intent);
        requireManagedTarget(parsed.target);
        await compactGate.wait();
        compact = operationProgress({
          kind: "compact",
          operationId: parsed.operation_id,
          state: "accepted",
          turnId: null
        });
        return compact;
      },
      async snapshot(target: unknown) {
        count("read_compact");
        requireManagedTarget(target);
        return compact;
      }
    }),
    goals: Object.freeze({
      async mutate(intent: unknown) {
        count("mutate_goal");
        const parsed = goalOperationIntentSchema.parse(intent);
        requireManagedTarget(parsed.target);
        await goalGate.wait();
        const objective = parsed.objective;
        if (parsed.action !== "set" || objective === null) {
          throw new TypeError("Physical goal mutation must create one paused goal.");
        }
        const value = goalControlSnapshotSchema.parse({
          goal: {
            revision: "b".repeat(64),
            objective,
            status: "paused",
            token_budget: 20_000,
            tokens_used: 0,
            time_used_seconds: 0,
            created_at: timestamp,
            updated_at: changedTimestamp
          },
          uncertain_mutation: null
        }).goal;
        goal = goalControlSnapshotSchema.parse({
          goal: value,
          uncertain_mutation: null
        });
        return Object.freeze({
          action: "set" as const,
          state: "succeeded" as const,
          dispatched: true,
          goal: value
        });
      },
      async snapshot(target: unknown) {
        count("read_goal");
        requireManagedTarget(target);
        return goal;
      }
    }),
    interrupts: Object.freeze({
      async interrupt(intent: unknown) {
        count("interrupt_turn");
        const candidate = readRecord(intent, "interrupt intent");
        const target = readRecord(candidate.target, "interrupt target");
        if (
          candidate.kind !== "interrupt" ||
          target.session_id !== sessionId ||
          target.codex_thread_id !== threadId ||
          target.turn_id !== interruptTurnId ||
          !interruptible
        ) {
          throw new TypeError("Physical interrupt intent is invalid.");
        }
        return operationProgress({
          kind: "interrupt",
          operationId: String(candidate.operation_id),
          state: "interrupted",
          turnId: interruptTurnId
        });
      },
      async requireInterruptible(target: unknown) {
        const candidate = readRecord(target, "interruptible target");
        if (candidate.turn_id !== interruptTurnId || !interruptible) {
          throw new TypeError("Physical turn is not interruptible.");
        }
      },
      async waitForTerminal(target: unknown) {
        const candidate = readRecord(target, "interrupt terminal target");
        if (candidate.turn_id !== interruptTurnId) {
          throw new TypeError("Physical interrupt terminal target is invalid.");
        }
        return operationProgress({
          kind: "interrupt",
          operationId: "op_physical_interrupt_terminal_0001",
          state: "interrupted",
          turnId: interruptTurnId
        });
      }
    }),
    models: Object.freeze({
      async select(intent: unknown) {
        count("select_model");
        const parsed = modelOperationIntentSchema.parse(intent);
        requireManagedTarget(parsed.target);
        await modelGate.wait();
        const selected = model.models.find((entry) => entry.id === parsed.model_id);
        if (selected === undefined || parsed.reasoning_effort === null) {
          throw new TypeError("Physical model selection is unavailable.");
        }
        model = modelControlSnapshotSchema.parse({
          ...model,
          pending: {
            revision: 1,
            selection_operation_id: parsed.operation_id,
            model_id: selected.id,
            runtime_model: selected.runtime_model,
            reasoning_effort: parsed.reasoning_effort,
            catalog_state: "available",
            phase: "pending",
            selected_at: changedTimestamp,
            turn_id: null,
            error: null
          }
        });
        return model;
      },
      async snapshot(target: unknown) {
        count("read_model");
        requireManagedTarget(target);
        return model;
      }
    }),
    plans: Object.freeze({
      async select(intent: unknown) {
        count("select_plan");
        const parsed = planOperationIntentSchema.parse(intent);
        requireManagedTarget(parsed.target);
        if (parsed.action !== "enter") {
          throw new TypeError("Physical Plan selection must enter Plan mode.");
        }
        await planGate.wait();
        plan = planControlSnapshotSchema.parse({
          ...plan,
          pending: {
            revision: 1,
            selection_operation_id: parsed.operation_id,
            mode: "plan",
            catalog_state: "available",
            phase: "pending",
            selected_at: changedTimestamp,
            turn_id: null,
            resolved_settings: null,
            error: null
          }
        });
        return plan;
      },
      async snapshot(target: unknown) {
        count("read_plan");
        requireManagedTarget(target);
        return plan;
      }
    }),
    prompts: input.prompts,
    skills: Object.freeze({
      async list(intent: unknown) {
        count("read_skills");
        const candidate = readRecord(intent, "skills intent");
        requireManagedTarget(candidate.target);
        return physicalSkillsSnapshot();
      }
    }),
    usage: Object.freeze({
      async read(intent: unknown) {
        count("read_usage");
        const candidate = readRecord(intent, "usage intent");
        requireManagedTarget(candidate.target);
        return physicalUsageSnapshot();
      }
    })
  });

  const runtime = Object.freeze({ read: () => input.runtime });
  const runtimes: HostDeckSelectedApiRuntimes = Object.freeze({
    approvals: runtime,
    compact: runtime,
    goals: runtime,
    interrupts: runtime,
    models: runtime,
    plans: runtime,
    prompts: runtime,
    sessionArchive: runtime,
    sessionStart: runtime
  });

  const managed: HostDeckSelectedApiSessions["managed"] = Object.freeze({
    async archive(candidateSessionId) {
      count("archive_session");
      if (candidateSessionId !== sessionId || archived) {
        throw new TypeError("Physical archive target is invalid.");
      }
      const current = input.states.require(sessionId);
      const archivedAt = input.now().toISOString();
      const next = input.states.replace(
        {
          mapping: {
            ...current.mapping,
            updated_at: archivedAt,
            archived_at: archivedAt
          },
          projection: {
            ...current.projection,
            session: {
              ...current.projection.session,
              archived_at: archivedAt,
              session_state: "archived",
              turn_state: "idle",
              attention: "none",
              freshness: "current",
              freshness_reason: null,
              updated_at: archivedAt
            }
          }
        },
        selectedStateRevision(current)
      );
      archived = true;
      return next;
    },
    read(candidateSessionId) {
      return input.states.require(candidateSessionId);
    },
    async start() {
      throw new TypeError("Physical dashboard acceptance must not create a session.");
    }
  });

  const resume: HostDeckSelectedApiSessions["resume"] = Object.freeze({
    read(candidateSessionId) {
      count("read_resume_metadata");
      if (candidateSessionId !== sessionId) {
        throw new TypeError("Physical resume target is invalid.");
      }
      const launch = Object.freeze({
        executable: "codex",
        args: Object.freeze(["resume", threadId])
      });
      return selectedResumeMetadataResponseSchema.parse({
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: true,
        command: formatSelectedResumeLaunchCommand(launch),
        launch,
        unavailable_reason: null
      });
    }
  });

  return Object.freeze({
    approvalRequestId,
    controls,
    interruptTurnId,
    managed,
    resume,
    runtimes,
    applyModel() {
      const pending = model.pending;
      if (pending === null) throw new TypeError("Physical model selection is not pending.");
      model = modelControlSnapshotSchema.parse({
        ...model,
        current: {
          model_id: pending.model_id,
          runtime_model: pending.runtime_model,
          reasoning_effort: pending.reasoning_effort,
          catalog_state: "available",
          observed_at: changedTimestamp
        },
        pending: null
      });
      modelApplied = true;
    },
    applyPlan() {
      if (plan.pending === null) throw new TypeError("Physical Plan selection is not pending.");
      plan = planControlSnapshotSchema.parse({
        ...plan,
        current: {
          state: "confirmed",
          mode: "plan",
          runtime_model: "gpt-5.5-codex",
          reasoning_effort: "high",
          observed_at: changedTimestamp
        },
        pending: null
      });
      planApplied = true;
    },
    beginInterruptibleTurn() {
      replaceTurnState(input.states, input.now, "in_progress");
      interruptible = true;
    },
    completeCompact() {
      if (compact === null || compact.state !== "accepted") {
        throw new TypeError("Physical compaction was not accepted.");
      }
      compact = operationProgress({
        kind: "compact",
        operationId: compact.operation_id,
        state: "completed",
        turnId: "turn-physical-compact-001"
      });
    },
    finishInterrupt() {
      if (!interruptible) throw new TypeError("Physical interrupt was not active.");
      replaceTurnState(input.states, input.now, "interrupted");
      interruptible = false;
    },
    hasPendingApproval: () => approvalGate.pending,
    hasPendingCompact: () => compactGate.pending,
    hasPendingGoal: () => goalGate.pending,
    hasPendingModel: () => modelGate.pending,
    hasPendingPlan: () => planGate.pending,
    markSessionStale() {
      replaceFreshness(input.states, input.now, "stale");
    },
    releaseApproval: () => approvalGate.release(),
    releaseCompact: () => compactGate.release(),
    releaseGoal: () => goalGate.release(),
    releaseModel: () => modelGate.release(),
    releasePlan: () => planGate.release(),
    restoreSessionCurrent() {
      replaceFreshness(input.states, input.now, "current");
    },
    snapshot() {
      return Object.freeze({
        approvalDecision: approval.decision,
        archived,
        calls: Object.freeze(Object.fromEntries([...calls.entries()].sort())),
        compactState: compact?.state ?? "absent",
        goalStatus: goal.goal?.status ?? null,
        modelApplied,
        planApplied
      }) as PhysicalDashboardControlSnapshot;
    }
  });
}

function initialModelSnapshot(): ModelControlSnapshot {
  return modelControlSnapshotSchema.parse({
    catalog_revision: "c".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      model_id: "model-a",
      runtime_model: "gpt-5.5-codex",
      reasoning_effort: "high",
      catalog_state: "available",
      observed_at: timestamp
    },
    pending: null,
    models: [
      {
        id: "model-a",
        runtime_model: "gpt-5.5-codex",
        label: "Codex Current",
        description: "Current coding model.",
        is_default: true,
        input_modalities: ["text", "image"],
        reasoning_efforts: [
          { id: "low", description: "Fast", is_default: false },
          { id: "high", description: "Thorough", is_default: true }
        ]
      },
      {
        id: "model-b",
        runtime_model: "gpt-5.5-codex-fast",
        label: "Codex Fast",
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

function initialPlanSnapshot(): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    catalog_revision: "e".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      state: "confirmed",
      mode: "default",
      runtime_model: "gpt-5.5-codex",
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
        preset_model: "gpt-5.5-codex",
        preset_reasoning_effort: "high"
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

function initialApproval(timing: Readonly<{
  readonly createdAt: string;
  readonly expiresAt: string;
}>): PendingApproval {
  return pendingApprovalSchema.parse({
    target: {
      type: "approval",
      session_id: sessionId,
      codex_thread_id: threadId,
      request_id: approvalRequestId
    },
    action: "Install the Android validation package",
    scope: "Connected test phone",
    reason: "Continue the bounded release validation on the selected device.",
    risk: "elevated",
    grant_scope: "one_time",
    state: "pending",
    created_at: timing.createdAt,
    expires_at: timing.expiresAt,
    decision: null
  });
}

function physicalUsageSnapshot(): UsageSnapshot {
  return usageSnapshotSchema.parse({
    target: managedTarget(),
    runtime_version: "0.147.0",
    connection_generation: 4,
    measured_at: timestamp,
    account: {
      scope: "account",
      summary: {
        lifetime_tokens: 12_500,
        peak_daily_tokens: 4_000,
        longest_running_turn_seconds: 180,
        current_streak_days: 3,
        longest_streak_days: 8
      },
      daily_buckets: [
        { start_date: "2026-07-28", tokens: 1_500 },
        { start_date: "2026-07-29", tokens: 2_000 }
      ]
    },
    thread: {
      state: "observed",
      scope: "thread",
      observed_at: timestamp,
      turn_id: "turn-physical-usage-001",
      total: tokenBreakdown(2_000),
      last: tokenBreakdown(500),
      model_context_window: 128_000
    },
    rate_limits: {
      state: "observed",
      scope: "runtime",
      observed_at: timestamp,
      primary: {
        used_percent: 25,
        window_duration_minutes: 300,
        resets_at: "2026-07-29T17:00:00.000Z"
      },
      secondary: null,
      reached_type: null
    }
  });
}

function physicalSkillsSnapshot(): SkillsSnapshot {
  return skillsSnapshotSchema.parse({
    target: managedTarget(),
    runtime_version: "0.147.0",
    connection_generation: 4,
    observed_at: timestamp,
    state: "content",
    skills: [
      ...Array.from({ length: 24 }, (_, index) => ({
        name: `physical-skill-${String(index + 1).padStart(2, "0")}`,
        description: `Deterministic physical skill ${index + 1}.`,
        scope: (["repo", "user", "system", "admin"] as const)[index % 4],
        enabled: index % 3 !== 0
      })),
      {
        name: "release-readiness",
        description: "Run bounded package and device release checks.",
        scope: "repo",
        enabled: true
      }
    ],
    error_count: 0
  });
}

function operationProgress(input: Readonly<{
  kind: "compact" | "interrupt";
  operationId: string;
  state: "accepted" | "completed" | "interrupted";
  turnId: string | null;
}>): SelectedOperationProgress {
  return selectedOperationProgressSchema.parse({
    operation_id: input.operationId,
    kind: input.kind,
    target:
      input.kind === "interrupt"
        ? {
            type: "turn",
            session_id: sessionId,
            codex_thread_id: threadId,
            turn_id: interruptTurnId
          }
        : managedTarget(),
    state: input.state,
    updated_at: changedTimestamp,
    turn_id: input.turnId,
    error: null
  });
}

function managedTarget(): ManagedSessionTarget {
  return managedSessionTargetSchema.parse({
    type: "managed_session",
    session_id: sessionId,
    codex_thread_id: threadId
  });
}

function requireManagedTarget(candidate: unknown): ManagedSessionTarget {
  const record = readRecord(candidate, "managed target");
  if (
    record.type !== "managed_session" ||
    record.session_id !== sessionId ||
    record.codex_thread_id !== threadId
  ) {
    throw new TypeError("Physical managed target is invalid.");
  }
  return managedTarget();
}

function replaceTurnState(
  states: SelectedStateRepository,
  now: () => Date,
  turnState: "in_progress" | "interrupted"
): void {
  const current = states.require(sessionId);
  const updatedAt = now().toISOString();
  states.replace(
    {
      mapping: { ...current.mapping, updated_at: updatedAt },
      projection: {
        ...current.projection,
        session: {
          ...current.projection.session,
          turn_state: turnState,
          attention: "none",
          updated_at: updatedAt,
          last_activity_at: updatedAt
        }
      }
    },
    selectedStateRevision(current)
  );
}

function replaceFreshness(
  states: SelectedStateRepository,
  now: () => Date,
  freshness: "current" | "stale"
): void {
  const current = states.require(sessionId);
  const updatedAt = now().toISOString();
  states.replace(
    {
      mapping: { ...current.mapping, updated_at: updatedAt },
      projection: {
        ...current.projection,
        session: {
          ...current.projection.session,
          freshness,
          freshness_reason:
            freshness === "stale"
              ? "Runtime resubscription is required."
              : null,
          updated_at: updatedAt
        }
      }
    },
    selectedStateRevision(current)
  );
}

function tokenBreakdown(total: number) {
  return {
    total_tokens: total,
    input_tokens: Math.floor(total / 2),
    cached_input_tokens: Math.floor(total / 4),
    output_tokens: Math.floor(total / 2),
    reasoning_output_tokens: Math.floor(total / 4)
  };
}

function readRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Physical ${label} is invalid.`);
  }
  return candidate as Record<string, unknown>;
}

class PhysicalDeferredGate {
  private resolver: (() => void) | null = null;
  private waiting: Promise<void> | null = null;

  constructor(private readonly label: string) {}

  get pending(): boolean {
    return this.resolver !== null;
  }

  wait(): Promise<void> {
    if (this.waiting !== null || this.resolver !== null) {
      throw new TypeError(`Physical ${this.label} operation was duplicated.`);
    }
    this.waiting = new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
    return this.waiting.finally(() => {
      this.waiting = null;
    });
  }

  release(): void {
    const resolve = this.resolver;
    if (resolve === null) {
      throw new TypeError(`Physical ${this.label} operation is not pending.`);
    }
    this.resolver = null;
    resolve();
  }
}
