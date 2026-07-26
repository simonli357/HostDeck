import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type GoalControlSnapshot,
  type GoalMutationRequest,
  goalControlSnapshotSchema,
  goalMutationRequestSchema
} from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailApiVariant,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type GoalSnapshotVariant =
  | "no_goal"
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "uncertain_unknown"
  | "uncertain_conflict"
  | "long";

export type GoalReadOutcome = "success" | "pending" | "unsupported" | "known_failure";

export type GoalMutateOutcome =
  | "verified"
  | "pending"
  | "known_failure"
  | "conflict"
  | "ambiguous"
  | "correlation_mismatch";

export interface GoalControlApiController {
  readonly session: SessionDetailApiController;
  readonly goalReadRequests: () => readonly Request[];
  readonly goalMutateRequests: () => readonly Request[];
  readonly hasPendingGoalRead: () => boolean;
  readonly hasPendingGoalMutate: () => boolean;
  readonly releaseGoalRead: (outcome?: Exclude<GoalReadOutcome, "pending">) => void;
  readonly releaseGoalMutate: (outcome?: Exclude<GoalMutateOutcome, "pending">) => void;
  readonly setReadOutcome: (outcome: GoalReadOutcome) => void;
  readonly setMutateOutcome: (outcome: GoalMutateOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setSnapshotVariant: (variant: GoalSnapshotVariant) => void;
}

const timestamp = "2026-07-25T20:00:00.000Z";
const updatedTimestamp = "2026-07-25T20:01:00.000Z";
const initialRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);
const goalPath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/goal`;
const defaultObjective = "Finish the Android release-readiness validation.";

export async function installGoalControlApi(
  page: Page,
  input: Readonly<{
    sessionVariant?: SessionDetailApiVariant;
    snapshotVariant?: GoalSnapshotVariant;
  }> = {}
): Promise<GoalControlApiController> {
  const session = await installSessionDetailApi(page, input.sessionVariant ?? "writable");
  let snapshot = goalSnapshot(input.snapshotVariant ?? "paused");
  let readOutcome: GoalReadOutcome = "success";
  let mutateOutcome: GoalMutateOutcome = "verified";
  let pendingReadResolution: (() => void) | null = null;
  let pendingMutateResolution:
    | ((outcome: Exclude<GoalMutateOutcome, "pending">) => void)
    | null = null;
  const goalRequests: Request[] = [];

  await page.route(`**${goalPath}`, async (route) => {
    const request = route.request();
    goalRequests.push(request);

    if (request.method() === "GET") {
      if (readOutcome === "pending") {
        if (pendingReadResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending goal read" });
          return;
        }
        await new Promise<void>((resolve) => {
          pendingReadResolution = resolve;
        });
        pendingReadResolution = null;
      }
      if (readOutcome === "unsupported") {
        await fulfillApiError(route, 409, "capability_unavailable", false);
        return;
      }
      if (readOutcome === "known_failure") {
        await fulfillApiError(route, 503, "service_overloaded", true);
        return;
      }
      await fulfillJson(route, snapshot);
      return;
    }

    if (request.method() !== "POST") {
      await route.fulfill({ status: 405, body: "unexpected goal method" });
      return;
    }

    let mutation: GoalMutationRequest;
    try {
      mutation = goalMutationRequestSchema.parse(request.postDataJSON());
    } catch {
      await fulfillApiError(route, 400, "validation_error", false);
      return;
    }
    if (!mutationMatchesSnapshot(mutation, snapshot)) {
      await fulfillApiError(route, 409, "operation_conflict", true);
      return;
    }

    let selectedOutcome = mutateOutcome;
    if (selectedOutcome === "pending") {
      if (pendingMutateResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending goal mutation" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<GoalMutateOutcome, "pending">>((resolve) => {
        pendingMutateResolution = resolve;
      });
      pendingMutateResolution = null;
    }
    if (selectedOutcome === "known_failure") {
      await fulfillApiError(route, 503, "service_overloaded", true);
      return;
    }
    if (selectedOutcome === "conflict") {
      await fulfillApiError(route, 409, "operation_conflict", true);
      return;
    }
    if (selectedOutcome === "ambiguous") {
      await fulfillApiError(route, 504, "operation_timeout", true);
      return;
    }
    if (selectedOutcome === "correlation_mismatch") {
      await fulfillJson(route, snapshot);
      return;
    }

    snapshot = mutationSnapshot(snapshot, mutation);
    await fulfillJson(route, snapshot);
  });

  return Object.freeze({
    session,
    goalReadRequests: () => goalRequests.filter((request) => request.method() === "GET"),
    goalMutateRequests: () => goalRequests.filter((request) => request.method() === "POST"),
    hasPendingGoalRead: () => pendingReadResolution !== null,
    hasPendingGoalMutate: () => pendingMutateResolution !== null,
    releaseGoalRead(outcome: Exclude<GoalReadOutcome, "pending"> = "success") {
      if (pendingReadResolution === null) {
        throw new TypeError("No pending goal read exists.");
      }
      readOutcome = outcome;
      pendingReadResolution();
    },
    releaseGoalMutate(outcome: Exclude<GoalMutateOutcome, "pending"> = "verified") {
      if (pendingMutateResolution === null) {
        throw new TypeError("No pending goal mutation exists.");
      }
      mutateOutcome = outcome;
      pendingMutateResolution(outcome);
    },
    setReadOutcome(outcome: GoalReadOutcome) {
      if (pendingReadResolution !== null) {
        throw new TypeError("Cannot replace a pending goal read outcome.");
      }
      readOutcome = outcome;
    },
    setMutateOutcome(outcome: GoalMutateOutcome) {
      if (pendingMutateResolution !== null) {
        throw new TypeError("Cannot replace a pending goal mutation outcome.");
      }
      mutateOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      session.setVariant(variant);
    },
    setSnapshotVariant(variant: GoalSnapshotVariant) {
      snapshot = goalSnapshot(variant);
    }
  });
}

function goalSnapshot(variant: GoalSnapshotVariant): GoalControlSnapshot {
  if (variant === "no_goal") {
    return goalControlSnapshotSchema.parse({ goal: null, uncertain_mutation: null });
  }
  const status = goalStatusForVariant(variant);
  const objective = variant === "long" ? longObjective() : defaultObjective;
  const uncertainMutation = variant === "uncertain_unknown"
    ? {
        action: "resume",
        phase: "unknown",
        requested_at: timestamp,
        baseline_revision: initialRevision,
        requested_objective: null,
        requested_status: "active",
        error: apiError("operation_timeout", true)
      }
    : variant === "uncertain_conflict"
      ? {
          action: "set",
          phase: "conflict",
          requested_at: timestamp,
          baseline_revision: initialRevision,
          requested_objective: "Replace the current release objective.",
          requested_status: "paused",
          error: apiError("operation_conflict", false)
        }
      : null;
  return goalControlSnapshotSchema.parse({
    goal: {
      revision: initialRevision,
      objective,
      status,
      token_budget: variant === "blocked" ? null : 20_000,
      tokens_used: 1_200,
      time_used_seconds: 75.5,
      created_at: timestamp,
      updated_at: timestamp
    },
    uncertain_mutation: uncertainMutation
  });
}

function goalStatusForVariant(
  variant: Exclude<GoalSnapshotVariant, "no_goal">
): "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" {
  if (variant === "active") return "active";
  if (variant === "blocked") return "blocked";
  if (variant === "usage_limited") return "usage_limited";
  if (variant === "budget_limited") return "budget_limited";
  if (variant === "complete") return "complete";
  return "paused";
}

function longObjective(): string {
  return "Validate every Android remote-control state without clipping private runtime truth. "
    .repeat(52)
    .slice(0, 3_500)
    .trimEnd();
}

function mutationMatchesSnapshot(
  mutation: GoalMutationRequest,
  snapshot: GoalControlSnapshot
): boolean {
  if (mutation.kind !== "goal" || snapshot.uncertain_mutation !== null) return false;
  const expectedRevision = snapshot.goal?.revision ?? null;
  if (mutation.expected_goal_revision !== expectedRevision) return false;
  if (mutation.action === "set") return mutation.objective !== null;
  return snapshot.goal !== null && mutation.objective === null;
}

function mutationSnapshot(
  snapshot: GoalControlSnapshot,
  mutation: GoalMutationRequest
): GoalControlSnapshot {
  if (mutation.action === "clear") {
    return goalControlSnapshotSchema.parse({ goal: null, uncertain_mutation: null });
  }
  const baseline = snapshot.goal;
  const objective = mutation.action === "set" ? mutation.objective : baseline?.objective;
  if (objective === null || objective === undefined) {
    throw new TypeError("Goal mutation fixture objective is unavailable.");
  }
  const status = mutation.action === "resume"
    ? "active"
    : mutation.action === "complete"
      ? "complete"
      : "paused";
  return goalControlSnapshotSchema.parse({
    goal: {
      revision: baseline?.revision === changedRevision ? "c".repeat(64) : changedRevision,
      objective,
      status,
      token_budget: baseline?.token_budget ?? 20_000,
      tokens_used: baseline?.tokens_used ?? 0,
      time_used_seconds: baseline?.time_used_seconds ?? 0,
      created_at: baseline?.created_at ?? timestamp,
      updated_at: updatedTimestamp
    },
    uncertain_mutation: null
  });
}

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return {
    code,
    message: "Private goal fixture detail must not reach the UI.",
    retryable
  };
}

async function fulfillApiError(
  route: Route,
  status: number,
  code: ApiErrorEnvelope["code"],
  retryable: boolean
): Promise<void> {
  await fulfillJson(route, { error: apiError(code, retryable) }, status);
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}
