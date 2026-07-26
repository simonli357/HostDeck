import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type PlanControlSnapshot,
  type PlanMode,
  type PlanSelectionRequest,
  planControlSnapshotSchema,
  planSelectionRequestSchema
} from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailApiVariant,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type PlanSnapshotVariant =
  | "ready"
  | "unknown_current"
  | "pending"
  | "dispatching"
  | "awaiting_confirmation"
  | "pending_unknown"
  | "conflict"
  | "execution_awaiting"
  | "execution_active"
  | "execution_complete"
  | "execution_failed"
  | "execution_interrupted"
  | "execution_unknown"
  | "long";

export type PlanReadOutcome = "success" | "pending" | "unsupported" | "known_failure";

export type PlanSelectOutcome =
  | "staged"
  | "already_current"
  | "pending"
  | "known_failure"
  | "conflict"
  | "ambiguous"
  | "correlation_mismatch";

export interface PlanControlApiController {
  readonly session: SessionDetailApiController;
  readonly hasPendingPlanRead: () => boolean;
  readonly hasPendingPlanSelect: () => boolean;
  readonly planReadRequests: () => readonly Request[];
  readonly planSelectRequests: () => readonly Request[];
  readonly releasePlanRead: (outcome?: Exclude<PlanReadOutcome, "pending">) => void;
  readonly releasePlanSelect: (outcome?: Exclude<PlanSelectOutcome, "pending">) => void;
  readonly setReadOutcome: (outcome: PlanReadOutcome) => void;
  readonly setSelectOutcome: (outcome: PlanSelectOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setSnapshotVariant: (variant: PlanSnapshotVariant) => void;
}

const timestamp = "2026-07-26T02:00:00.000Z";
const planPath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/plan`;

export async function installPlanControlApi(
  page: Page,
  input: Readonly<{
    sessionVariant?: SessionDetailApiVariant;
    snapshotVariant?: PlanSnapshotVariant;
  }> = {}
): Promise<PlanControlApiController> {
  const session = await installSessionDetailApi(page, input.sessionVariant ?? "writable");
  let snapshot = planSnapshot(input.snapshotVariant ?? "ready");
  let readOutcome: PlanReadOutcome = "success";
  let selectOutcome: PlanSelectOutcome = "staged";
  let pendingReadResolution: (() => void) | null = null;
  let pendingSelectResolution:
    | ((outcome: Exclude<PlanSelectOutcome, "pending">) => void)
    | null = null;
  const planRequests: Request[] = [];

  await page.route(`**${planPath}`, async (route) => {
    const request = route.request();
    planRequests.push(request);
    if (request.method() === "GET") {
      if (readOutcome === "pending") {
        if (pendingReadResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending Plan read" });
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
      await route.fulfill({ status: 405, body: "unexpected Plan method" });
      return;
    }

    let selection: PlanSelectionRequest;
    try {
      selection = planSelectionRequestSchema.parse(request.postDataJSON());
    } catch {
      await fulfillApiError(route, 400, "validation_error", false);
      return;
    }
    if (!selectionMatchesSnapshot(selection, snapshot)) {
      await fulfillApiError(route, 409, "operation_conflict", true);
      return;
    }

    let selectedOutcome = selectOutcome;
    if (selectedOutcome === "pending") {
      if (pendingSelectResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending Plan selection" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<PlanSelectOutcome, "pending">>((resolve) => {
        pendingSelectResolution = resolve;
      });
      pendingSelectResolution = null;
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
      await fulfillApiError(route, 504, "operation_timeout", false);
      return;
    }
    if (selectedOutcome === "correlation_mismatch") {
      snapshot = selectionSnapshot(snapshot, selection, "op_fixture_plan_other_001");
      await fulfillJson(route, snapshot);
      return;
    }
    if (selectedOutcome === "already_current") {
      snapshot = confirmedSelectionSnapshot(snapshot, selection);
      await fulfillJson(route, snapshot);
      return;
    }

    snapshot = selectionSnapshot(snapshot, selection, selection.operation_id);
    await fulfillJson(route, snapshot);
  });

  return Object.freeze({
    session,
    hasPendingPlanRead: () => pendingReadResolution !== null,
    hasPendingPlanSelect: () => pendingSelectResolution !== null,
    planReadRequests: () => planRequests.filter((request) => request.method() === "GET"),
    planSelectRequests: () => planRequests.filter((request) => request.method() === "POST"),
    releasePlanRead(outcome: Exclude<PlanReadOutcome, "pending"> = "success") {
      if (pendingReadResolution === null) throw new TypeError("No pending Plan read exists.");
      readOutcome = outcome;
      pendingReadResolution();
    },
    releasePlanSelect(outcome: Exclude<PlanSelectOutcome, "pending"> = "staged") {
      if (pendingSelectResolution === null) throw new TypeError("No pending Plan selection exists.");
      selectOutcome = outcome;
      pendingSelectResolution(outcome);
    },
    setReadOutcome(outcome: PlanReadOutcome) {
      if (pendingReadResolution !== null) throw new TypeError("Cannot replace a pending Plan read outcome.");
      readOutcome = outcome;
    },
    setSelectOutcome(outcome: PlanSelectOutcome) {
      if (pendingSelectResolution !== null) throw new TypeError("Cannot replace a pending Plan selection outcome.");
      selectOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      session.setVariant(variant);
    },
    setSnapshotVariant(variant: PlanSnapshotVariant) {
      snapshot = planSnapshot(variant);
    }
  });
}

function planSnapshot(variant: PlanSnapshotVariant): PlanControlSnapshot {
  const long = variant === "long";
  return planControlSnapshotSchema.parse({
    catalog_revision: "e".repeat(64),
    catalog_observed_at: timestamp,
    current:
      variant === "unknown_current"
        ? {
            state: "unknown",
            mode: null,
            runtime_model: null,
            reasoning_effort: null,
            observed_at: null
          }
        : {
            state: "confirmed",
            mode: "default",
            runtime_model: long
              ? "runtime-default-with-an-extended-mobile-validation-identity"
              : "runtime-current",
            reasoning_effort: "high",
            observed_at: timestamp
          },
    pending: pendingForVariant(variant),
    execution: executionForVariant(variant),
    modes: [
      {
        name: long
          ? "Plan with extended next-turn implementation guidance"
          : "Plan",
        mode: "plan",
        preset_model: long
          ? "runtime-plan-with-extended-mobile-validation-identity"
          : "runtime-plan",
        preset_reasoning_effort: "medium"
      },
      {
        name: long
          ? "Default collaboration behavior with current runtime settings"
          : "Default",
        mode: "default",
        preset_model: null,
        preset_reasoning_effort: null
      }
    ]
  });
}

function pendingForVariant(variant: PlanSnapshotVariant) {
  if (!["pending", "dispatching", "awaiting_confirmation", "pending_unknown", "conflict"].includes(variant)) {
    return null;
  }
  const phase = variant === "pending_unknown" ? "unknown" : variant;
  const dispatched = ["dispatching", "awaiting_confirmation", "unknown"].includes(phase);
  return {
    revision: 7,
    selection_operation_id: "op_fixture_plan_pending_001",
    mode: "plan",
    catalog_state: phase === "unknown" ? "unknown" : "available",
    phase,
    selected_at: timestamp,
    turn_id: phase === "awaiting_confirmation" ? "turn-fixture-plan-001" : null,
    resolved_settings: dispatched
      ? { runtime_model: "runtime-plan", reasoning_effort: "medium" }
      : null,
    error:
      phase === "unknown" || phase === "conflict"
        ? apiError(phase === "unknown" ? "operation_timeout" : "operation_conflict", true)
        : null
  };
}

function executionForVariant(variant: PlanSnapshotVariant) {
  if (!variant.startsWith("execution_")) {
    return { turn_id: null, state: "idle", evidence: "none", summary: null, updated_at: null };
  }
  const state = variant.slice("execution_".length);
  if (state === "awaiting") {
    return {
      turn_id: "turn-fixture-plan-execution-001",
      state: "awaiting_evidence",
      evidence: "none",
      summary: null,
      updated_at: timestamp
    };
  }
  const evidence = state === "active"
    ? "plan_item"
    : state === "complete"
      ? "plan_delta"
      : state === "interrupted"
        ? "plan_update"
        : "none";
  return {
    turn_id: "turn-fixture-plan-execution-001",
    state,
    evidence,
    summary: evidence === "none"
      ? null
      : "Plan execution evidence belongs to the current turn and does not prove the selected next-turn mode.",
    updated_at: timestamp
  };
}

function selectionMatchesSnapshot(
  selection: PlanSelectionRequest,
  snapshot: PlanControlSnapshot
): boolean {
  const desiredMode = modeForSelection(selection);
  return (
    selection.kind === "plan" &&
    selection.expected_pending_revision === (snapshot.pending?.revision ?? null) &&
    snapshot.modes.some((entry) => entry.mode === desiredMode)
  );
}

function selectionSnapshot(
  snapshot: PlanControlSnapshot,
  selection: PlanSelectionRequest,
  operationId: string
): PlanControlSnapshot {
  const mode = modeForSelection(selection);
  if (snapshot.current.state === "confirmed" && snapshot.current.mode === mode) {
    return planControlSnapshotSchema.parse({ ...snapshot, pending: null });
  }
  return planControlSnapshotSchema.parse({
    ...snapshot,
    pending: {
      revision: (snapshot.pending?.revision ?? 0) + 1,
      selection_operation_id: operationId,
      mode,
      catalog_state: "available",
      phase: "pending",
      selected_at: timestamp,
      turn_id: null,
      resolved_settings: null,
      error: null
    }
  });
}

function confirmedSelectionSnapshot(
  snapshot: PlanControlSnapshot,
  selection: PlanSelectionRequest
): PlanControlSnapshot {
  const mode = modeForSelection(selection);
  const catalog = snapshot.modes.find((entry) => entry.mode === mode);
  if (catalog === undefined) throw new TypeError("Confirmed Plan fixture mode is unavailable.");
  return planControlSnapshotSchema.parse({
    ...snapshot,
    current: {
      state: "confirmed",
      mode,
      runtime_model: catalog.preset_model ?? "runtime-current",
      reasoning_effort: catalog.preset_reasoning_effort,
      observed_at: timestamp
    },
    pending: null
  });
}

function modeForSelection(selection: PlanSelectionRequest): PlanMode {
  return selection.action === "enter" ? "plan" : "default";
}

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return {
    code,
    message: "Private Plan fixture detail must not reach the UI.",
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
