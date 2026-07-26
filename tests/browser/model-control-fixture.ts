import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type ModelControlSnapshot,
  type ModelSelectionRequest,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema
} from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailApiVariant,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type ModelSnapshotVariant =
  | "ready"
  | "pending"
  | "dispatching"
  | "awaiting_confirmation"
  | "unknown"
  | "conflict"
  | "unknown_current"
  | "long";

export type ModelReadOutcome = "success" | "pending" | "unsupported" | "known_failure";

export type ModelSelectOutcome =
  | "staged"
  | "pending"
  | "known_failure"
  | "conflict"
  | "correlation_mismatch";

export interface ModelControlApiController {
  readonly session: SessionDetailApiController;
  readonly hasPendingModelRead: () => boolean;
  readonly hasPendingModelSelect: () => boolean;
  readonly modelReadRequests: () => readonly Request[];
  readonly modelSelectRequests: () => readonly Request[];
  readonly releaseModelRead: (outcome?: Exclude<ModelReadOutcome, "pending">) => void;
  readonly releaseModelSelect: (outcome?: Exclude<ModelSelectOutcome, "pending">) => void;
  readonly setReadOutcome: (outcome: ModelReadOutcome) => void;
  readonly setSelectOutcome: (outcome: ModelSelectOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setSnapshotVariant: (variant: ModelSnapshotVariant) => void;
}

const timestamp = "2026-07-25T20:00:00.000Z";
const modelPath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/model`;

export async function installModelControlApi(
  page: Page,
  input: Readonly<{
    sessionVariant?: SessionDetailApiVariant;
    snapshotVariant?: ModelSnapshotVariant;
  }> = {}
): Promise<ModelControlApiController> {
  const session = await installSessionDetailApi(page, input.sessionVariant ?? "writable");
  let snapshot = modelSnapshot(input.snapshotVariant ?? "ready");
  let readOutcome: ModelReadOutcome = "success";
  let selectOutcome: ModelSelectOutcome = "staged";
  let pendingReadResolution: (() => void) | null = null;
  let pendingSelectResolution:
    | ((outcome: Exclude<ModelSelectOutcome, "pending">) => void)
    | null = null;
  const modelRequests: Request[] = [];

  await page.route(`**${modelPath}`, async (route) => {
    const request = route.request();
    modelRequests.push(request);
    if (request.method() === "GET") {
      if (readOutcome === "pending") {
        if (pendingReadResolution !== null) {
          await route.fulfill({ status: 500, body: "duplicate pending model read" });
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
      await route.fulfill({ status: 405, body: "unexpected model method" });
      return;
    }

    let selection: ModelSelectionRequest;
    try {
      selection = modelSelectionRequestSchema.parse(request.postDataJSON());
    } catch {
      await fulfillApiError(route, 400, "validation_error", false);
      return;
    }
    if (!selectionMatchesSnapshot(selection, snapshot)) {
      await fulfillApiError(route, 409, "operation_conflict", false);
      return;
    }

    let selectedOutcome = selectOutcome;
    if (selectedOutcome === "pending") {
      if (pendingSelectResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending model selection" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<ModelSelectOutcome, "pending">>((resolve) => {
        pendingSelectResolution = resolve;
      });
      pendingSelectResolution = null;
    }
    if (selectedOutcome === "known_failure") {
      await fulfillApiError(route, 503, "service_overloaded", true);
      return;
    }
    if (selectedOutcome === "conflict") {
      await fulfillApiError(route, 409, "operation_conflict", false);
      return;
    }
    if (selectedOutcome === "correlation_mismatch") {
      snapshot = selectionSnapshot(
        snapshot,
        selection,
        "op_fixture_model_other_001"
      );
      await fulfillJson(route, snapshot);
      return;
    }

    snapshot = selectionSnapshot(snapshot, selection, selection.operation_id);
    await fulfillJson(route, snapshot);
  });

  return Object.freeze({
    session,
    hasPendingModelRead: () => pendingReadResolution !== null,
    hasPendingModelSelect: () => pendingSelectResolution !== null,
    modelReadRequests: () =>
      modelRequests.filter((request) => request.method() === "GET"),
    modelSelectRequests: () =>
      modelRequests.filter((request) => request.method() === "POST"),
    releaseModelRead(outcome: Exclude<ModelReadOutcome, "pending"> = "success") {
      if (pendingReadResolution === null) {
        throw new TypeError("No pending model read exists.");
      }
      readOutcome = outcome;
      pendingReadResolution();
    },
    releaseModelSelect(outcome: Exclude<ModelSelectOutcome, "pending"> = "staged") {
      if (pendingSelectResolution === null) {
        throw new TypeError("No pending model selection exists.");
      }
      selectOutcome = outcome;
      pendingSelectResolution(outcome);
    },
    setReadOutcome(outcome: ModelReadOutcome) {
      if (pendingReadResolution !== null) {
        throw new TypeError("Cannot replace a pending model read outcome.");
      }
      readOutcome = outcome;
    },
    setSelectOutcome(outcome: ModelSelectOutcome) {
      if (pendingSelectResolution !== null) {
        throw new TypeError("Cannot replace a pending model selection outcome.");
      }
      selectOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      session.setVariant(variant);
    },
    setSnapshotVariant(variant: ModelSnapshotVariant) {
      snapshot = modelSnapshot(variant);
    }
  });
}

function modelSnapshot(variant: ModelSnapshotVariant): ModelControlSnapshot {
  const long = variant === "long";
  const models = [
    {
      id: "model-a",
      runtime_model: "runtime-a",
      label: long
        ? "Codex Alpha extended validation model for constrained mobile control surfaces"
        : "Codex Alpha",
      description: long
        ? "A deliberately long catalog description that must wrap without moving controls beyond the visible mobile sheet or obscuring the final command."
        : "Balanced coding model.",
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
      label: long
        ? "Codex Beta implementation and verification model with extended identity"
        : "Codex Beta",
      description: long
        ? "Focused implementation behavior with enough detail to exercise multi-line labels, metadata, and selection geometry at the narrowest supported width."
        : "Focused implementation model.",
      is_default: false,
      input_modalities: ["text"],
      reasoning_efforts: [
        { id: "low", description: "Fast", is_default: false },
        { id: "medium", description: "Recommended", is_default: true }
      ]
    }
  ];
  return modelControlSnapshotSchema.parse({
    catalog_revision: "c".repeat(64),
    catalog_observed_at: timestamp,
    current:
      variant === "unknown_current"
        ? {
            model_id: null,
            runtime_model: "runtime-observed-outside-current-catalog",
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
    pending: pendingForVariant(variant),
    models
  });
}

function pendingForVariant(variant: ModelSnapshotVariant) {
  if (["ready", "unknown_current", "long"].includes(variant)) return null;
  const phase = variant;
  return {
    revision: 7,
    selection_operation_id: "op_fixture_model_pending_001",
    model_id: "model-b",
    runtime_model: "runtime-b",
    reasoning_effort: "medium",
    catalog_state: "available",
    phase,
    selected_at: timestamp,
    turn_id: phase === "awaiting_confirmation" ? "turn-fixture-model-001" : null,
    error:
      phase === "unknown" || phase === "conflict"
        ? apiError(phase === "unknown" ? "operation_timeout" : "operation_conflict", true)
        : null
  };
}

function selectionMatchesSnapshot(
  selection: ModelSelectionRequest,
  snapshot: ModelControlSnapshot
): boolean {
  const model = snapshot.models.find((candidate) => candidate.id === selection.model_id);
  const expectedRevision = snapshot.pending?.revision ?? null;
  return (
    selection.kind === "model" &&
    selection.expected_pending_revision === expectedRevision &&
    model !== undefined &&
    selection.reasoning_effort !== null &&
    model.reasoning_efforts.some((effort) => effort.id === selection.reasoning_effort)
  );
}

function selectionSnapshot(
  snapshot: ModelControlSnapshot,
  selection: ModelSelectionRequest,
  operationId: string
): ModelControlSnapshot {
  if (
    snapshot.pending !== null &&
    snapshot.current.model_id === selection.model_id &&
    snapshot.current.reasoning_effort === selection.reasoning_effort
  ) {
    return modelControlSnapshotSchema.parse({ ...snapshot, pending: null });
  }
  const model = snapshot.models.find((candidate) => candidate.id === selection.model_id);
  if (model === undefined || selection.reasoning_effort === null) {
    throw new TypeError("Selected model fixture identity is unavailable.");
  }
  return modelControlSnapshotSchema.parse({
    ...snapshot,
    pending: {
      revision: (snapshot.pending?.revision ?? 0) + 1,
      selection_operation_id: operationId,
      model_id: model.id,
      runtime_model: model.runtime_model,
      reasoning_effort: selection.reasoning_effort,
      catalog_state: "available",
      phase: "pending",
      selected_at: timestamp,
      turn_id: null,
      error: null
    }
  });
}

function apiError(code: ApiErrorEnvelope["code"], retryable: boolean): ApiErrorEnvelope {
  return {
    code,
    message: "Private model fixture detail must not reach the UI.",
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
