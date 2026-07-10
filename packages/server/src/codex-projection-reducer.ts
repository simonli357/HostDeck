import type { NormalizedCodexEvent, NormalizedCodexItem, NormalizedCodexThreadStatus } from "@hostdeck/codex-adapter";
import type { ManagedSessionProjection } from "@hostdeck/contracts";
import type {
  SelectedSessionState,
  UncommittedManagedSessionProjection,
  UncommittedSelectedProjectionEvent
} from "@hostdeck/storage";

export interface CodexProjectionReduction {
  readonly event: UncommittedSelectedProjectionEvent;
  readonly next_session: UncommittedManagedSessionProjection;
}

export function reduceCodexProjectionEvent(current: SelectedSessionState, event: Exclude<NormalizedCodexEvent, { readonly scope: "runtime" }>): CodexProjectionReduction {
  const base = eventBase(event);
  const session = current.projection.session;
  switch (event.method) {
    case "thread/started": {
      const status = threadStatusPatch(session, event.status, event.active_flags, true);
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "thread",
          state: "started",
          item_id: null,
          title: "Codex thread started",
          detail: `Runtime status: ${event.status}.`
        },
        status
      );
    }
    case "thread/status/changed": {
      const status = threadStatusPatch(session, event.status, event.active_flags, false);
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "thread",
          state: "updated",
          item_id: null,
          title: "Codex thread status updated",
          detail: `Runtime status: ${event.status}.`
        },
        status,
        false
      );
    }
    case "thread/name/updated":
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "thread",
          state: "updated",
          item_id: null,
          title: "Codex thread name updated",
          detail: event.name === null ? "Codex cleared its thread title." : `Codex title: ${event.name}`
        },
        {},
        false
      );
    case "thread/archived":
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "thread",
          state: "completed",
          item_id: null,
          title: "Codex thread archived",
          detail: "HostDeck lifecycle reconciliation must confirm durable archive identity."
        },
        {
          session_state: session.session_state === "archived" ? "archived" : "unknown",
          turn_state: session.session_state === "archived" ? session.turn_state : "unknown",
          attention: session.session_state === "archived" ? session.attention : "unknown",
          freshness: session.session_state === "archived" ? session.freshness : "stale",
          freshness_reason:
            session.session_state === "archived"
              ? session.freshness_reason
              : "Codex archived the thread before HostDeck lifecycle reconciliation.",
          recent_summary:
            session.session_state === "archived"
              ? session.recent_summary
              : "Codex archived the thread; HostDeck lifecycle reconciliation is required."
        }
      );
    case "thread/settings/updated":
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "settings",
          state: "updated",
          item_id: null,
          title: "Codex settings updated",
          detail: `Model ${event.model}; collaboration mode ${event.collaboration_mode}; effort ${event.effort ?? "default"}.`
        },
        { model: event.model },
        false
      );
    case "thread/goal/updated": {
      const controlState =
        event.status === "active"
          ? "active"
          : event.status === "paused"
            ? "paused"
            : event.status === "complete"
              ? "complete"
              : "failed";
      return {
        event: {
          ...base,
          content_state: event.content_state,
          content_notice: event.content_notice,
          type: "control",
          control: "goal",
          state: controlState,
          value_summary: event.objective
        },
        next_session: nextSession(session, event, {
          goal: { objective: event.objective, state: event.status },
          last_activity_at: event.captured_at,
          recent_summary: event.status === "active" ? "Goal is active." : `Goal is ${event.status.replaceAll("_", " ")}.`
        })
      };
    }
    case "thread/goal/cleared":
      return {
        event: {
          ...base,
          type: "control",
          control: "goal",
          state: "available",
          value_summary: null
        },
        next_session: nextSession(session, event, {
          goal: null,
          last_activity_at: event.captured_at,
          recent_summary: "Goal cleared."
        })
      };
    case "thread/tokenUsage/updated":
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "usage",
          state: "updated",
          item_id: null,
          title: "Token usage updated",
          detail: `Total ${event.total.total_tokens}; last turn ${event.last.total_tokens}; context ${event.model_context_window ?? "unknown"}.`
        },
        {},
        false
      );
    case "turn/started":
      return {
        event: {
          ...base,
          type: "turn",
          turn_id: event.turn_id,
          state: "in_progress",
          error: null
        },
        next_session: nextSession(session, event, {
          session_state: session.session_state === "archived" ? "archived" : "active",
          turn_state: session.session_state === "archived" ? session.turn_state : "in_progress",
          attention: session.session_state === "archived" ? session.attention : "watch",
          last_activity_at: event.captured_at,
          recent_summary: session.session_state === "archived" ? session.recent_summary : "Codex turn started."
        })
      };
    case "turn/completed": {
      const attention = event.status === "failed" ? "failed" : event.status === "interrupted" ? "stuck" : "none";
      return {
        event: {
          ...base,
          type: "turn",
          turn_id: event.turn_id,
          state: event.status,
          error:
            event.status === "failed"
              ? { code: "unknown_error", message: event.error_message ?? "Codex turn failed without a bounded reason." }
              : null
        },
        next_session: nextSession(session, event, {
          turn_state: session.session_state === "archived" ? session.turn_state : event.status,
          attention: session.session_state === "archived" ? session.attention : attention,
          last_activity_at: event.captured_at,
          recent_summary:
            session.session_state === "archived"
              ? session.recent_summary
              : event.status === "failed"
                ? event.error_message ?? "Codex turn failed."
                : `Codex turn ${event.status}.`
        })
      };
    }
    case "turn/plan/updated":
      return {
        event: {
          ...base,
          type: "control",
          control: "plan",
          state: "updating",
          value_summary: boundedSummary(event.explanation ?? `${event.plan.length} plan steps updated.`)
        },
        next_session: nextSession(session, event, {
          last_activity_at: event.captured_at,
          recent_summary: "Codex plan updated."
        })
      };
    case "item/started":
    case "item/completed":
      return reduceItem(current, event, base);
    case "item/agentMessage/delta":
    case "item/plan/delta":
      return {
        event: {
          ...base,
          content_state: event.content_state,
          content_notice: event.content_notice,
          type: "message",
          role: "agent",
          phase: "delta",
          item_id: event.item_id,
          text: event.delta
        },
        next_session: nextSession(session, event, {
          last_activity_at: event.captured_at,
          recent_summary: boundedSummary(event.delta) || session.recent_summary
        })
      };
    case "serverRequest/resolved":
      return activityReduction(
        current,
        event,
        {
          ...base,
          type: "activity",
          activity: "approval",
          state: "completed",
          item_id: null,
          title: "Approval request resolved",
          detail: "Resolution notification carries no decision or command outcome."
        },
        {},
        false
      );
  }
}

function reduceItem(
  current: SelectedSessionState,
  event: Extract<NormalizedCodexEvent, { readonly method: "item/started" | "item/completed" }>,
  base: ReturnType<typeof eventBase>
): CodexProjectionReduction {
  const session = current.projection.session;
  const item = event.item;
  if (["agent_message", "plan", "user_message"].includes(item.category) && item.text !== null && item.text.length > 0) {
    if (item.category !== "user_message" || item.state !== "started") {
      return {
        event: {
          ...base,
          content_state: item.content_state,
          content_notice: item.content_notice,
          type: "message",
          role: item.category === "user_message" ? "user" : "agent",
          phase: item.state === "started" ? "delta" : "completed",
          item_id: item.id,
          text: item.text
        },
        next_session: nextSession(session, event, {
          last_activity_at: event.captured_at,
          recent_summary: boundedSummary(item.text) || item.title
        })
      };
    }
  }

  const activity = itemActivity(item);
  return activityReduction(
    current,
    event,
    {
      ...base,
      content_state: item.content_state,
      content_notice: item.content_notice,
      type: "activity",
      activity,
      state: item.state,
      item_id: item.id,
      title: item.title,
      detail: null
    },
    {
      last_activity_at: event.captured_at,
      recent_summary: item.title
    }
  );
}

function activityReduction(
  current: SelectedSessionState,
  event: Exclude<NormalizedCodexEvent, { readonly scope: "runtime" }>,
  projectedEvent: UncommittedSelectedProjectionEvent,
  patch: Partial<UncommittedManagedSessionProjection>,
  updateSummary = true
): CodexProjectionReduction {
  const summary = projectedEvent.type === "activity" ? projectedEvent.title : current.projection.session.recent_summary;
  return {
    event: projectedEvent,
    next_session: nextSession(current.projection.session, event, {
      last_activity_at: event.captured_at,
      ...(updateSummary ? { recent_summary: boundedSummary(summary) } : {}),
      ...patch
    })
  };
}

function eventBase(event: Exclude<NormalizedCodexEvent, { readonly scope: "runtime" }>) {
  return {
    captured_at: event.captured_at,
    upstream_at: event.upstream_at,
    codex_event_id: event.codex_event_id,
    codex_event_type: event.method,
    content_state: "complete" as const,
    content_notice: null
  };
}

function threadStatusPatch(
  session: ManagedSessionProjection,
  status: NormalizedCodexThreadStatus,
  flags: readonly ("waiting_on_approval" | "waiting_on_user_input")[],
  initial: boolean
): Partial<UncommittedManagedSessionProjection> {
  if (session.session_state === "archived") return {};
  if (status === "system_error") {
    return {
      session_state: "unknown",
      turn_state: "unknown",
      attention: "failed",
      freshness: "stale",
      freshness_reason: "Codex reported a thread system error.",
      recent_summary: "Codex reported a thread system error."
    };
  }
  if (status === "not_loaded") {
    return {
      session_state: "unknown",
      turn_state: "unknown",
      attention: "unknown",
      freshness: "stale",
      freshness_reason: "Codex thread is not loaded; reconciliation is required.",
      recent_summary: "Codex thread is not loaded; reconciliation is required."
    };
  }
  if (status === "active") {
    if (flags.includes("waiting_on_approval")) {
      return { session_state: "active", turn_state: "waiting_for_approval", attention: "needs_approval" };
    }
    if (flags.includes("waiting_on_user_input")) {
      return { session_state: "active", turn_state: "waiting_for_input", attention: "needs_input" };
    }
    return {
      session_state: "active",
      turn_state: activeTurnState(session.turn_state) ? "in_progress" : "unknown",
      attention: "watch"
    };
  }
  if (activeTurnState(session.turn_state)) {
    return { session_state: "active" };
  }
  return {
    session_state: "active",
    turn_state: "idle",
    attention: "none",
    ...(initial ? { recent_summary: "Codex thread is ready." } : {})
  };
}

function activeTurnState(state: ManagedSessionProjection["turn_state"]): boolean {
  return ["in_progress", "waiting_for_approval", "waiting_for_input"].includes(state);
}

function itemActivity(item: NormalizedCodexItem) {
  switch (item.category) {
    case "command":
      return "command" as const;
    case "file_change":
      return "file_change" as const;
    case "compaction":
      return "compaction" as const;
    case "reasoning":
      return "reasoning" as const;
    case "agent_message":
    case "plan":
    case "user_message":
      return "thread" as const;
    case "other":
    case "tool":
      return "tool" as const;
  }
}

function nextSession(
  session: ManagedSessionProjection,
  event: Exclude<NormalizedCodexEvent, { readonly scope: "runtime" }>,
  patch: Partial<UncommittedManagedSessionProjection>
): UncommittedManagedSessionProjection {
  return {
    id: session.id,
    name: session.name,
    codex_thread_id: session.codex_thread_id,
    cwd: session.cwd,
    runtime_source: session.runtime_source,
    runtime_version: session.runtime_version,
    created_at: session.created_at,
    archived_at: session.archived_at,
    session_state: session.session_state,
    turn_state: session.turn_state,
    attention: session.attention,
    freshness: session.freshness,
    freshness_reason: session.freshness_reason,
    updated_at: event.captured_at,
    last_activity_at: session.last_activity_at,
    branch: session.branch,
    model: session.model,
    goal: session.goal,
    recent_summary: session.recent_summary,
    ...patch
  };
}

function boundedSummary(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}
