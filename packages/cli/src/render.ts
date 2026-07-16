import { Buffer } from "node:buffer";
import {
  type ApiSession,
  type CompactProgressResponse,
  compactProgressResponseSchema,
  defaultResourceBudget,
  type GoalControlSnapshot,
  type GoalMutationRequest,
  goalControlSnapshotSchema,
  goalMutationRequestSchema,
  type HostStatusResponse,
  type ModelControlSnapshot,
  type ModelSelectionRequest,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
  type PendingApprovalListResponse,
  type PendingApprovalResponse,
  type PlanControlSnapshot,
  type PlanMode,
  type PlanSelectionRequest,
  type PromptDispatchResponse,
  pairingClientLabelSchema,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
  promptDispatchResponseSchema,
  type RemoteIngressPublicState,
  type ResolvedPlanSettings,
  remoteIngressPublicStateSchema,
  type SelectedOperationDispatch,
  type SelectedSessionStartResponse,
  type SessionListResponse,
  type SkillsSnapshot,
  selectedOperationDispatchSchema,
  selectedPairingLinkSchema,
  selectedPairingPermissionSchema,
  selectedSessionStartResponseSchema,
  sessionIdParamsSchema,
  skillsSnapshotSchema,
  type UsageRateLimitWindow,
  type UsageSnapshot,
  type UsageTokenBreakdown,
  usageSnapshotSchema,
  type WriteResponse
} from "@hostdeck/contracts";
import QRCode from "qrcode";
import type { CliFailure } from "./errors.js";
import { internalFailure } from "./errors.js";
import type { LockCommandResult } from "./local-admin.js";
import type { PairingLinkCommandResult } from "./pairing-link-client.js";

export type TerminalQrRenderer = (link: string) => Promise<string>;

export function renderHelp(): string {
  return [
    "Usage:",
    "  codexdeck [--state-dir PATH] [--database PATH] [--port PORT] serve",
    "  codexdeck [--api-url URL | --host HOST --port PORT] status [--json]",
    "  codexdeck start --name NAME --cwd PATH [--json]",
    "  codexdeck archive SESSION_ID [--json]",
    "  codexdeck list [--json]",
    "  codexdeck send SESSION_ID TEXT... [--json]",
    "  codexdeck attach SESSION",
    "  codexdeck resume SESSION_ID",
    "  codexdeck model SESSION_ID [--json]",
    "  codexdeck model SESSION_ID MODEL_ID [--effort EFFORT] [--expected-revision REVISION] [--json]",
    "  codexdeck goal SESSION_ID [--json]",
    "  codexdeck goal SESSION_ID set --objective OBJECTIVE [--expected-revision REVISION] [--json]",
    "  codexdeck goal SESSION_ID pause|resume|complete|clear --expected-revision REVISION [--json]",
    "  codexdeck plan SESSION_ID [--json]",
    "  codexdeck plan SESSION_ID enter|exit [--expected-revision REVISION] [--json]",
    "  codexdeck usage SESSION_ID [--json]",
    "  codexdeck compact SESSION_ID [--json]",
    "  codexdeck compact SESSION_ID --confirm [--json]",
    "  codexdeck skills SESSION_ID [--json]",
    "  codexdeck approvals SESSION_ID [--json]",
    "  codexdeck approvals SESSION_ID REQUEST_ID approve|deny --confirm [--json]",
    "  codexdeck pair [--label LABEL] [--read-only | --write]",
    "  codexdeck lock [--reason TEXT] [--json]",
    "  codexdeck unlock [--json]",
    "  codexdeck remote status|enable|disable [--json]",
    "  codexdeck help",
    "  codexdeck version",
    "",
    "Options:",
    "  --api-url URL      HostDeck daemon base URL.",
    "  --host HOST        HostDeck daemon host. Defaults to 127.0.0.1.",
    "  --port PORT        HostDeck daemon port. Defaults to 3777.",
    "  --state-dir PATH   Local HostDeck state directory for admin commands.",
    "  --database PATH    SQLite database path for local admin commands.",
    "  --config PATH      JSON config file with api_url, host/port, or state paths.",
    "  --json             Print machine-readable output for supported commands.",
    "",
    "Global connection and state options must appear before the command.",
    ""
  ].join("\n");
}

export function renderStartSession(
  candidate: SelectedSessionStartResponse,
  json: boolean
): string {
  const parsed = selectedSessionStartResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("Session-start rendering input is invalid.");
  }
  const response = parsed.data;
  if (json) {
    return `${JSON.stringify(response, null, 2)}\n`;
  }

  return [
    `Started session: ${escapeTerminalText(response.session.name)}`,
    `ID: ${escapeTerminalText(response.session.id)}`,
    `State: ${response.session.session_state}`,
    `CWD: ${escapeTerminalText(response.session.cwd)}`,
    `Runtime: ${response.session.runtime_source} ${escapeTerminalText(response.session.runtime_version)}`,
    ""
  ].join("\n");
}

export function renderArchiveSession(
  candidate: SelectedOperationDispatch,
  json: boolean
): string {
  const parsed = selectedOperationDispatchSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.state !== "accepted" ||
    parsed.data.kind !== "archive" ||
    parsed.data.target.type !== "managed_session"
  ) {
    throw internalFailure("Session-archive rendering input is invalid.");
  }
  if (json) return `${JSON.stringify(parsed.data, null, 2)}\n`;
  return `Archive accepted for ${escapeTerminalText(parsed.data.target.session_id)}.\n`;
}

export function renderPromptDispatch(
  candidate: PromptDispatchResponse,
  json: boolean
): string {
  const parsed = promptDispatchResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("Prompt-dispatch rendering input is invalid.");
  }
  if (json) return `${JSON.stringify(parsed.data, null, 2)}\n`;
  const action = parsed.data.action === "start" ? "start" : "steer";
  return `Prompt ${action} accepted for ${escapeTerminalText(parsed.data.target.session_id)} (turn ${escapeTerminalText(parsed.data.turn_id)}).\n`;
}

export function renderModelSnapshot(
  candidate: ModelControlSnapshot,
  json: boolean,
  selectionCandidate?: ModelSelectionRequest
): string {
  let parsed: ReturnType<typeof modelControlSnapshotSchema.safeParse>;
  try {
    parsed = modelControlSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Model rendering input is invalid.");
  }
  if (!parsed.success) throw internalFailure("Model rendering input is invalid.");
  let selection: ModelSelectionRequest | null = null;
  if (selectionCandidate !== undefined) {
    const parsedSelection = modelSelectionRequestSchema.safeParse({
      operation_id: selectionCandidate.operation_id,
      kind: selectionCandidate.kind,
      model_id: selectionCandidate.model_id,
      reasoning_effort: selectionCandidate.reasoning_effort,
      expected_pending_revision: selectionCandidate.expected_pending_revision
    });
    if (!parsedSelection.success) throw internalFailure("Model rendering selection is invalid.");
    selection = parsedSelection.data;
  }
  const snapshot = parsed.data;
  const output = json
    ? `${JSON.stringify(snapshot, null, 2)}\n`
    : renderModelText(snapshot, selection);
  if (
    output.includes("\0") ||
    Buffer.byteLength(output, "utf8") > defaultResourceBudget.cli_response_max_bytes
  ) {
    throw internalFailure("Model rendering output exceeds its selected limit.");
  }
  return output;
}

export function renderGoalSnapshot(
  candidate: GoalControlSnapshot,
  json: boolean,
  mutationCandidate?: GoalMutationRequest
): string {
  let parsed: ReturnType<typeof goalControlSnapshotSchema.safeParse>;
  try {
    parsed = goalControlSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Goal rendering input is invalid.");
  }
  if (!parsed.success) throw internalFailure("Goal rendering input is invalid.");
  let mutation: GoalMutationRequest | null = null;
  if (mutationCandidate !== undefined) {
    const parsedMutation = goalMutationRequestSchema.safeParse({
      operation_id: mutationCandidate.operation_id,
      kind: mutationCandidate.kind,
      action: mutationCandidate.action,
      objective: mutationCandidate.objective,
      expected_goal_revision: mutationCandidate.expected_goal_revision
    });
    if (!parsedMutation.success) throw internalFailure("Goal rendering mutation is invalid.");
    mutation = parsedMutation.data;
    assertRenderedGoalMutation(parsed.data, mutation);
  }
  const output = json ? `${JSON.stringify(parsed.data, null, 2)}\n` : renderGoalText(parsed.data, mutation);
  if (output.includes("\0") || Buffer.byteLength(output, "utf8") > defaultResourceBudget.cli_response_max_bytes) {
    throw internalFailure("Goal rendering output exceeds its selected limit.");
  }
  return output;
}

export function renderPlanSnapshot(
  candidate: PlanControlSnapshot,
  json: boolean,
  selectionCandidate?: PlanSelectionRequest
): string {
  let parsed: ReturnType<typeof planControlSnapshotSchema.safeParse>;
  try {
    parsed = planControlSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Plan rendering input is invalid.");
  }
  if (!parsed.success) throw internalFailure("Plan rendering input is invalid.");
  let selection: PlanSelectionRequest | null = null;
  if (selectionCandidate !== undefined) {
    const parsedSelection = planSelectionRequestSchema.safeParse({
      operation_id: selectionCandidate.operation_id,
      kind: selectionCandidate.kind,
      action: selectionCandidate.action,
      expected_pending_revision: selectionCandidate.expected_pending_revision
    });
    if (!parsedSelection.success) throw internalFailure("Plan rendering selection is invalid.");
    selection = parsedSelection.data;
    assertRenderedPlanSelection(parsed.data, selection);
  }
  const output = json ? `${JSON.stringify(parsed.data, null, 2)}\n` : renderPlanText(parsed.data, selection);
  if (output.includes("\0") || Buffer.byteLength(output, "utf8") > defaultResourceBudget.cli_response_max_bytes) {
    throw internalFailure("Plan rendering output exceeds its selected limit.");
  }
  return output;
}

export function renderCompactProgress(
  candidate: CompactProgressResponse,
  sessionIdCandidate: string,
  json: boolean
): string {
  const response = compactProgressResponseSchema.safeParse(candidate);
  const params = sessionIdParamsSchema.safeParse({ session_id: sessionIdCandidate });
  if (
    !response.success ||
    !params.success ||
    (response.data.progress !== null && response.data.progress.target.session_id !== params.data.session_id)
  ) {
    throw internalFailure("Compact rendering input is invalid.");
  }
  const output = json
    ? `${JSON.stringify(response.data, null, 2)}\n`
    : renderCompactText(response.data, params.data.session_id);
  if (output.includes("\0") || Buffer.byteLength(output, "utf8") > defaultResourceBudget.cli_response_max_bytes) {
    throw internalFailure("Compact rendering output exceeds its selected limit.");
  }
  return output;
}

export function renderSessionList(response: SessionListResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify(response, null, 2)}\n`;
  }

  if (response.sessions.length === 0) {
    return "No HostDeck sessions.\n";
  }

  return `${response.sessions.map(renderSessionLine).join("\n")}\n`;
}

export function renderAttachCommand(session: ApiSession): string {
  return [
    `Attach session: ${session.name}`,
    `ID: ${session.id}`,
    `Lifecycle: ${session.lifecycle_state}`,
    `Tmux command: tmux attach-session -t ${session.backend.tmux.session_name}`,
    ""
  ].join("\n");
}

export function renderWriteAccepted(response: WriteResponse): string {
  if (!response.accepted) {
    return `Rejected ${response.error.code}: ${response.error.message}\n`;
  }

  return `${response.action} accepted for ${response.session_id}. Audit required: ${response.audit_required ? "yes" : "no"}\n`;
}

export function renderServeStarted(baseUrl: URL): string {
  return `HostDeck daemon ready at ${baseUrl.toString().replace(/\/$/u, "")}\n`;
}

export function renderServeStopped(): string {
  return "HostDeck daemon stopped.\n";
}

export async function renderPairingLink(
  response: PairingLinkCommandResult,
  renderQr: TerminalQrRenderer = renderTerminalQr
): Promise<string> {
  if (
    !selectedPairingLinkSchema.safeParse(response.link).success ||
    !selectedPairingPermissionSchema.safeParse(response.permission).success ||
    !pairingClientLabelSchema.safeParse(response.client_label).success ||
    !Number.isFinite(Date.parse(response.expires_at))
  ) {
    throw internalFailure("Pairing-link rendering input is invalid.");
  }

  let qr: string;
  try {
    qr = await renderQr(response.link);
  } catch {
    throw internalFailure("Terminal QR rendering failed.");
  }
  if (
    typeof qr !== "string" ||
    qr.length === 0 ||
    qr.includes("\0") ||
    Buffer.byteLength(qr, "utf8") > defaultResourceBudget.cli_response_max_bytes
  ) {
    throw internalFailure("Terminal QR rendering produced invalid output.");
  }

  const output = [
    "Pairing link created.",
    "Scan with the phone:",
    qr.endsWith("\n") ? qr.slice(0, -1) : qr,
    "Open instead:",
    response.link,
    `Permission: ${response.permission}`,
    ...(response.client_label === null ? [] : [`Label: ${response.client_label}`]),
    `Expires: ${response.expires_at}`,
    "This link is one-time and is not saved by HostDeck.",
    ""
  ].join("\n");
  if (Buffer.byteLength(output, "utf8") > defaultResourceBudget.cli_response_max_bytes) {
    throw internalFailure("Terminal pairing output exceeds its selected limit.");
  }
  return output;
}

async function renderTerminalQr(link: string): Promise<string> {
  try {
    return await QRCode.toString(link, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M",
      margin: 1
    });
  } catch {
    throw internalFailure("Terminal QR rendering failed.");
  }
}

export function renderLockCommand(response: LockCommandResult, json: boolean): string {
  if (json) {
    return `${JSON.stringify(response, null, 2)}\n`;
  }

  return [
    `HostDeck is now ${response.locked ? "locked" : "unlocked"}.`,
    `Audit event: ${response.audit_event_id}`,
    ""
  ].join("\n");
}

export function renderVersion(version: string): string {
  return `codexdeck ${version}\n`;
}

function renderSessionLine(session: ApiSession): string {
  const branch = session.branch === null ? "" : ` branch=${session.branch}`;
  const stale = session.lifecycle_state === "stale" ? " stale" : "";

  return `${session.id}  ${session.name}  lifecycle=${session.lifecycle_state}${stale} status=${session.status} attention=${session.attention}${branch} cwd=${session.cwd}`;
}

export function renderStatus(status: HostStatusResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify(status, null, 2)}\n`;
  }

  const readiness = status.storage.state === "ok" && status.tmux.state === "ok" && status.stream.state === "ok" && status.last_error === null ? "ready" : "not ready";

  return [
    `HostDeck daemon: ${readiness}`,
    `Version: ${status.version}`,
    `Bind: ${status.bind.mode} (${status.bind.host}:${status.bind.port})`,
    `Lock: ${status.locked ? "locked" : "unlocked"}`,
    `Storage: ${status.storage.state}`,
    `Tmux: ${status.tmux.state}`,
    `Stream: ${status.stream.state}`,
    `Stale sessions: ${status.stale_session_count}`,
    ""
  ].join("\n");
}

export function renderRemoteState(
  candidate: RemoteIngressPublicState,
  json: boolean
): string {
  const parsed = remoteIngressPublicStateSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError("Remote ingress state rendering failed.");
  }
  const state = parsed.data;
  const output = Object.freeze({
    generation: state.generation,
    availability: state.availability,
    reason: state.reason,
    laptop_action_required: state.laptop_action_required,
    observed_at: state.observed_at
  });
  if (json) return `${JSON.stringify(output, null, 2)}\n`;

  return [
    `Remote access: ${state.availability}`,
    `Reason: ${state.reason ?? "none"}`,
    `Laptop action required: ${state.laptop_action_required ? "yes" : "no"}`,
    `Generation: ${state.generation}`,
    `Observed: ${state.observed_at ?? "not observed"}`,
    ""
  ].join("\n");
}

export function renderUsageSnapshot(
  candidate: UsageSnapshot,
  json: boolean
): string {
  let parsed: ReturnType<typeof usageSnapshotSchema.safeParse>;
  try {
    parsed = usageSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Usage rendering input is invalid.");
  }
  if (!parsed.success) {
    throw internalFailure("Usage rendering input is invalid.");
  }
  const snapshot = parsed.data;
  const output = json
    ? `${JSON.stringify(snapshot, null, 2)}\n`
    : renderUsageText(snapshot);
  if (
    output.includes("\0") ||
    Buffer.byteLength(output, "utf8") >
      defaultResourceBudget.cli_response_max_bytes
  ) {
    throw internalFailure("Usage rendering output exceeds its selected limit.");
  }
  return output;
}

export function renderSkillsSnapshot(
  candidate: SkillsSnapshot,
  json: boolean
): string {
  let parsed: ReturnType<typeof skillsSnapshotSchema.safeParse>;
  try {
    parsed = skillsSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Skills rendering input is invalid.");
  }
  if (!parsed.success) {
    throw internalFailure("Skills rendering input is invalid.");
  }
  const snapshot = parsed.data;
  const output = json
    ? `${JSON.stringify(snapshot, null, 2)}\n`
    : renderSkillsText(snapshot);
  if (
    output.includes("\0") ||
    Buffer.byteLength(output, "utf8") >
      defaultResourceBudget.cli_response_max_bytes
  ) {
    throw internalFailure("Skills rendering output exceeds its selected limit.");
  }
  return output;
}

export function renderApprovalList(candidate: PendingApprovalListResponse, json: boolean): string {
  let parsed: ReturnType<typeof pendingApprovalListResponseSchema.safeParse>;
  try {
    parsed = pendingApprovalListResponseSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Approval-list rendering input is invalid.");
  }
  if (!parsed.success) throw internalFailure("Approval-list rendering input is invalid.");
  const output = json
    ? `${JSON.stringify(parsed.data, null, 2)}\n`
    : renderApprovalListText(parsed.data);
  requireBoundedRender(output, "Approval-list");
  return output;
}

export function renderApprovalResponse(candidate: PendingApprovalResponse, json: boolean): string {
  let parsed: ReturnType<typeof pendingApprovalResponseSchema.safeParse>;
  try {
    parsed = pendingApprovalResponseSchema.safeParse(candidate);
  } catch {
    throw internalFailure("Approval-response rendering input is invalid.");
  }
  if (!parsed.success) throw internalFailure("Approval-response rendering input is invalid.");
  const output = json
    ? `${JSON.stringify(parsed.data, null, 2)}\n`
    : `Approval ${parsed.data.requested_decision} finalized for ${escapeTerminalText(parsed.data.approval.target.session_id)} (request ${escapeTerminalText(parsed.data.approval.target.request_id)}).\n`;
  requireBoundedRender(output, "Approval-response");
  return output;
}

function renderApprovalListText(response: PendingApprovalListResponse): string {
  const lines = [
    `Approvals: ${escapeTerminalText(response.target.session_id)}`,
    `Thread: ${escapeTerminalText(response.target.codex_thread_id)}`,
    `Count: ${response.approvals.length}`
  ];
  if (response.approvals.length === 0) {
    lines.push("", "No approval requests.", "");
    return lines.join("\n");
  }
  for (const approval of response.approvals) {
    lines.push(
      "",
      `[${approval.state}] ${escapeTerminalText(approval.target.request_id)}`,
      `Action: ${escapeTerminalText(approval.action)}`,
      `Scope: ${escapeTerminalText(approval.scope)}`,
      `Reason: ${approval.reason === null || approval.reason.length === 0 ? "not provided" : escapeTerminalText(approval.reason)}`,
      `Risk: ${approval.risk}`,
      `Grant: ${approval.grant_scope}`,
      `Created: ${approval.created_at}`,
      `Expires: ${approval.expires_at ?? "none"}`,
      `Decision: ${approval.decision ?? "none"}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function requireBoundedRender(output: string, label: string): void {
  if (output.includes("\0") || Buffer.byteLength(output, "utf8") > defaultResourceBudget.cli_response_max_bytes) {
    throw internalFailure(`${label} rendering output exceeds its selected limit.`);
  }
}

function renderSkillsText(snapshot: SkillsSnapshot): string {
  const lines = [
    `Skills: ${snapshot.target.session_id}`,
    `Runtime: ${snapshot.runtime_version} (generation ${snapshot.connection_generation})`,
    `Observed: ${snapshot.observed_at}`,
    `State: ${snapshot.state}`,
    `Skill count: ${snapshot.skills.length}`,
    `Skill errors: ${snapshot.error_count}${snapshot.error_count === 0 ? "" : " (details redacted)"}`
  ];
  if (snapshot.skills.length === 0) {
    lines.push("", "No skills reported.", "");
    return lines.join("\n");
  }

  lines.push("");
  for (const skill of snapshot.skills) {
    lines.push(
      `[${skill.enabled ? "enabled" : "disabled"}] ${escapeTerminalText(skill.name)} (${skill.scope})`,
      `Description: ${skill.description === null || skill.description.length === 0 ? "not provided" : escapeTerminalText(skill.description)}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderModelText(snapshot: ModelControlSnapshot, selection: ModelSelectionRequest | null): string {
  const lines: string[] = [];
  if (selection !== null) {
    const selectedModel = snapshot.models.find((model) => model.id === selection.model_id);
    const resolvedEffort =
      selection.reasoning_effort ?? selectedModel?.reasoning_efforts.find((effort) => effort.is_default)?.id;
    if (selectedModel === undefined || resolvedEffort === undefined) {
      throw internalFailure("Model rendering selection is absent from the catalog.");
    }
    if (snapshot.pending?.selection_operation_id === selection.operation_id) {
      lines.push(
        `Model selection pending: ${escapeTerminalText(selectedModel.label)} [${escapeTerminalText(selectedModel.id)}], effort ${escapeTerminalText(resolvedEffort)}, revision ${snapshot.pending.revision}.`
      );
    } else if (selection.expected_pending_revision !== null) {
      lines.push("Pending model selection cleared; confirmed current state is unchanged.");
    } else {
      lines.push("Requested model and effort are already confirmed current.");
    }
    lines.push("");
  }

  const currentModel =
    snapshot.current.model_id === null
      ? null
      : snapshot.models.find((model) => model.id === snapshot.current.model_id) ?? null;
  lines.push(
    currentModel === null
      ? `Current: ${escapeTerminalText(snapshot.current.runtime_model)} [not in current catalog], effort ${formatModelEffort(snapshot.current.reasoning_effort)}.`
      : `Current: ${escapeTerminalText(currentModel.label)} [${escapeTerminalText(currentModel.id)}], effort ${formatModelEffort(snapshot.current.reasoning_effort)}.`
  );
  if (snapshot.pending === null) {
    lines.push("Pending: none.");
  } else {
    const pendingModel = snapshot.models.find((model) => model.id === snapshot.pending?.model_id);
    const pendingLabel = pendingModel?.label ?? snapshot.pending.runtime_model;
    const errorCode = snapshot.pending.error === null ? "" : `, error ${snapshot.pending.error.code}`;
    lines.push(
      `Pending: ${escapeTerminalText(pendingLabel)} [${escapeTerminalText(snapshot.pending.model_id)}], effort ${escapeTerminalText(snapshot.pending.reasoning_effort)}, revision ${snapshot.pending.revision}, ${snapshot.pending.phase}${errorCode}.`
    );
  }
  lines.push(`Catalog revision: ${snapshot.catalog_revision}`, `Observed: ${snapshot.catalog_observed_at}`, "", "Models:");
  for (const model of snapshot.models) {
    const efforts = model.reasoning_efforts
      .map((effort) => `${escapeTerminalText(effort.id)}${effort.is_default ? " (default)" : ""}`)
      .join(", ");
    lines.push(
      `- ${escapeTerminalText(model.label)} [${escapeTerminalText(model.id)}]${model.is_default ? " (default model)" : ""}; efforts: ${efforts}; input: ${model.input_modalities.join(", ")}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function assertRenderedGoalMutation(snapshot: GoalControlSnapshot, mutation: GoalMutationRequest): void {
  if (snapshot.uncertain_mutation !== null) throw internalFailure("Goal rendering mutation is contradictory.");
  if (mutation.action === "clear") {
    if (snapshot.goal !== null) throw internalFailure("Goal rendering mutation is contradictory.");
    return;
  }
  const goal = snapshot.goal;
  const expectedStatus =
    mutation.action === "resume" ? "active" : mutation.action === "complete" ? "complete" : "paused";
  if (
    goal === null ||
    goal.status !== expectedStatus ||
    (mutation.action === "set" && goal.objective !== mutation.objective) ||
    (mutation.action === "resume" &&
      mutation.expected_goal_revision !== null &&
      goal.revision === mutation.expected_goal_revision)
  ) {
    throw internalFailure("Goal rendering mutation is contradictory.");
  }
}

function renderGoalText(snapshot: GoalControlSnapshot, mutation: GoalMutationRequest | null): string {
  const lines: string[] = [];
  if (mutation !== null) {
    if (mutation.action === "clear") {
      lines.push("Goal clear verified.");
    } else if (mutation.action === "resume") {
      lines.push("Goal resume accepted.");
    } else {
      const noOp = snapshot.goal?.revision === mutation.expected_goal_revision;
      if (mutation.action === "set") {
        lines.push(noOp ? "Goal already matches the requested paused objective." : "Goal set in paused state.");
      } else if (mutation.action === "pause") {
        lines.push(noOp ? "Goal already paused." : "Goal pause verified.");
      } else {
        lines.push(noOp ? "Goal already complete." : "Goal completion verified.");
      }
    }
    lines.push("");
  }

  if (snapshot.goal === null) {
    lines.push("Goal: none.");
  } else {
    const goal = snapshot.goal;
    lines.push(
      `Goal: ${goal.status}.`,
      `Objective: ${escapeTerminalText(goal.objective)}`,
      `Revision: ${goal.revision}`,
      `Token budget: ${goal.token_budget === null ? "none" : goal.token_budget}`,
      `Tokens used: ${goal.tokens_used}`,
      `Time used: ${goal.time_used_seconds} seconds`,
      `Created: ${goal.created_at}`,
      `Updated: ${goal.updated_at}`
    );
  }

  const uncertain = snapshot.uncertain_mutation;
  if (uncertain === null) {
    lines.push("Uncertain mutation: none.");
  } else {
    lines.push(
      `Uncertain mutation: ${uncertain.action} (${uncertain.phase}).`,
      `Requested at: ${uncertain.requested_at}`,
      `Baseline revision: ${uncertain.baseline_revision ?? "none"}`,
      `Requested status: ${uncertain.requested_status ?? "none"}`,
      ...(uncertain.requested_objective === null
        ? []
        : [`Requested objective: ${escapeTerminalText(uncertain.requested_objective)}`]),
      `Error: ${uncertain.error.code}.`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function assertRenderedPlanSelection(snapshot: PlanControlSnapshot, selection: PlanSelectionRequest): void {
  const desiredMode = selection.action === "enter" ? "plan" : "default";
  if (!snapshot.modes.some((entry) => entry.mode === desiredMode)) {
    throw internalFailure("Plan rendering selection is absent from the catalog.");
  }
  if (snapshot.pending !== null) {
    if (
      snapshot.pending.selection_operation_id !== selection.operation_id ||
      snapshot.pending.mode !== desiredMode ||
      snapshot.pending.catalog_state !== "available" ||
      snapshot.pending.phase !== "pending" ||
      snapshot.pending.turn_id !== null ||
      snapshot.pending.resolved_settings !== null ||
      snapshot.pending.error !== null ||
      (selection.expected_pending_revision !== null &&
        snapshot.pending.revision <= selection.expected_pending_revision)
    ) {
      throw internalFailure("Plan rendering selection is contradictory.");
    }
    return;
  }
  if (snapshot.current.state !== "confirmed" || snapshot.current.mode !== desiredMode) {
    throw internalFailure("Plan rendering selection is contradictory.");
  }
}

function renderPlanText(snapshot: PlanControlSnapshot, selection: PlanSelectionRequest | null): string {
  const lines: string[] = [];
  if (selection !== null) {
    const desiredMode = selection.action === "enter" ? "plan" : "default";
    if (snapshot.pending?.selection_operation_id === selection.operation_id) {
      lines.push(
        `Plan selection pending: ${selection.action} ${formatPlanMode(desiredMode)} mode, revision ${snapshot.pending.revision}. No turn was started.`
      );
    } else if (selection.expected_pending_revision !== null) {
      lines.push(`Pending Plan selection cleared; ${formatPlanMode(desiredMode)} mode is confirmed.`);
    } else {
      lines.push(`Requested ${formatPlanMode(desiredMode)} mode is already confirmed.`);
    }
    lines.push("");
  }

  if (snapshot.current.state === "unknown") {
    lines.push("Current mode: unknown.");
  } else {
    const runtimeModel = snapshot.current.runtime_model;
    const observedAt = snapshot.current.observed_at;
    if (runtimeModel === null || observedAt === null) {
      throw internalFailure("Plan rendering current state is contradictory.");
    }
    lines.push(
      `Current mode: ${formatPlanMode(snapshot.current.mode)} (confirmed).`,
      `Current model: ${escapeTerminalText(runtimeModel)}.`,
      `Current effort: ${formatPlanEffort(snapshot.current.reasoning_effort)}.`,
      `Current observed: ${observedAt}.`
    );
  }

  if (snapshot.pending === null) {
    lines.push("Pending selection: none.");
  } else {
    const pending = snapshot.pending;
    lines.push(
      `Pending selection: ${formatPlanMode(pending.mode)} mode, revision ${pending.revision}, ${pending.phase}.`,
      `Pending catalog state: ${pending.catalog_state}.`,
      `Pending selected: ${pending.selected_at}.`,
      `Pending turn: ${pending.turn_id === null ? "none" : escapeTerminalText(pending.turn_id)}.`,
      `Pending resolved settings: ${formatResolvedPlanSettings(pending.resolved_settings)}.`,
      `Pending error: ${pending.error === null ? "none" : pending.error.code}.`
    );
  }

  const execution = snapshot.execution;
  lines.push(
    `Execution: ${execution.state}.`,
    `Execution turn: ${execution.turn_id === null ? "none" : escapeTerminalText(execution.turn_id)}.`,
    `Execution evidence: ${execution.evidence}.`,
    `Execution summary: ${execution.summary === null ? "none" : escapeTerminalText(execution.summary)}.`,
    `Execution updated: ${execution.updated_at ?? "none"}.`,
    `Catalog revision: ${snapshot.catalog_revision}.`,
    `Catalog observed: ${snapshot.catalog_observed_at}.`,
    "",
    "Modes:"
  );
  for (const mode of snapshot.modes) {
    lines.push(
      `- ${escapeTerminalText(mode.name)} [${formatPlanMode(mode.mode)}]; model ${mode.preset_model === null ? "unchanged" : escapeTerminalText(mode.preset_model)}; effort ${mode.preset_reasoning_effort === null ? "unchanged" : escapeTerminalText(mode.preset_reasoning_effort)}.`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatPlanMode(mode: PlanMode | null): string {
  if (mode === "plan") return "Plan";
  if (mode === "default") return "Default";
  return "unknown";
}

function formatPlanEffort(effort: string | null): string {
  return effort === null ? "not reported" : escapeTerminalText(effort);
}

function formatResolvedPlanSettings(settings: ResolvedPlanSettings | null): string {
  if (settings === null) return "none";
  return `model ${escapeTerminalText(settings.runtime_model)}, effort ${formatPlanEffort(settings.reasoning_effort)}`;
}

function formatModelEffort(effort: string | null): string {
  return effort === null ? "not reported" : escapeTerminalText(effort);
}

function escapeTerminalText(value: string): string {
  const escaped = JSON.stringify(value);
  return escaped
    .slice(1, -1)
    .replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
}

function renderCompactText(response: CompactProgressResponse, sessionId: string): string {
  const progress = response.progress;
  const session = escapeTerminalText(sessionId);
  if (progress === null) return `Compact: no tracked operation for ${session}.\n`;
  switch (progress.state) {
    case "accepted":
      return `Compact accepted for ${session}. Completion is not yet proven.\n`;
    case "running":
      return `Compact running for ${session} (turn ${renderCompactTurnId(progress.turn_id)}). Completion is not yet proven.\n`;
    case "completed":
      return `Compact completed for ${session} (turn ${renderCompactTurnId(progress.turn_id)}).\n`;
    case "interrupted":
      return `Compact interrupted for ${session} (turn ${renderCompactTurnId(progress.turn_id)}).\n`;
    case "failed":
      return `Compact failed for ${session} (error: ${renderCompactErrorCode(progress.error)}).\n`;
    case "incomplete":
      return `Compact outcome incomplete for ${session} (error: ${renderCompactErrorCode(progress.error)}).\n`;
  }
}

function renderCompactTurnId(turnId: string | null): string {
  if (turnId === null) throw internalFailure("Compact rendering lost event-proven turn identity.");
  return escapeTerminalText(turnId);
}

function renderCompactErrorCode(error: { readonly code: string } | null): string {
  if (error === null) throw internalFailure("Compact rendering lost terminal error identity.");
  return escapeTerminalText(error.code);
}

function renderUsageText(snapshot: UsageSnapshot): string {
  const summary = snapshot.account.summary;
  const lines = [
    `Usage: ${snapshot.target.session_id}`,
    `Runtime: ${snapshot.runtime_version} (generation ${snapshot.connection_generation})`,
    `Measured: ${snapshot.measured_at}`,
    "",
    "Account usage",
    `Lifetime tokens: ${formatNullableNumber(summary.lifetime_tokens)}`,
    `Peak daily tokens: ${formatNullableNumber(summary.peak_daily_tokens)}`,
    `Longest running turn seconds: ${formatNullableNumber(summary.longest_running_turn_seconds)}`,
    `Current streak days: ${formatNullableNumber(summary.current_streak_days)}`,
    `Longest streak days: ${formatNullableNumber(summary.longest_streak_days)}`
  ];
  if (snapshot.account.daily_buckets === null) {
    lines.push("Daily usage: not reported");
  } else if (snapshot.account.daily_buckets.length === 0) {
    lines.push("Daily usage: no buckets reported");
  } else {
    lines.push(`Daily usage: ${snapshot.account.daily_buckets.length} buckets`);
    for (const bucket of snapshot.account.daily_buckets) {
      lines.push(`  ${bucket.start_date}: ${bucket.tokens} tokens`);
    }
  }

  lines.push("", "Thread usage");
  if (snapshot.thread.state === "not_observed") {
    lines.push("Observation: not observed");
  } else {
    lines.push(
      `Observation: ${snapshot.thread.observed_at}`,
      `Turn: ${snapshot.thread.turn_id}`,
      formatTokenBreakdown("Total", snapshot.thread.total),
      formatTokenBreakdown("Last", snapshot.thread.last),
      `Context window: ${formatNullableNumber(snapshot.thread.model_context_window)}`
    );
  }

  lines.push("", "Runtime rate limits");
  if (snapshot.rate_limits.state === "not_observed") {
    lines.push("Observation: not observed");
  } else {
    lines.push(
      `Observation: ${snapshot.rate_limits.observed_at}`,
      formatRateLimitWindow("Primary window", snapshot.rate_limits.primary),
      formatRateLimitWindow("Secondary window", snapshot.rate_limits.secondary),
      `Reached type: ${snapshot.rate_limits.reached_type ?? "not reported"}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "not reported" : String(value);
}

function formatTokenBreakdown(
  label: string,
  value: UsageTokenBreakdown
): string {
  return `${label}: total=${value.total_tokens} input=${value.input_tokens} cached_input=${value.cached_input_tokens} output=${value.output_tokens} reasoning_output=${value.reasoning_output_tokens}`;
}

function formatRateLimitWindow(
  label: string,
  value: UsageRateLimitWindow | null
): string {
  if (value === null) return `${label}: not reported`;
  return `${label}: used=${value.used_percent}% duration_minutes=${formatNullableNumber(value.window_duration_minutes)} resets=${value.resets_at ?? "not reported"}`;
}

export function renderFailure(error: CliFailure): string {
  const lines = [`HostDeck CLI error (${error.code}): ${error.message}`];

  if (error.status !== undefined) {
    lines.push(`HTTP status: ${error.status}`);
  }

  if (error.field !== undefined) {
    lines.push(`Field: ${error.field}`);
  }

  if (error.kind === "daemon_unavailable") {
    lines.push("Start the daemon with `codexdeck serve`, then retry.");
  }

  if (error.kind === "usage") {
    lines.push("Run `codexdeck help` for usage.");
  }

  return `${lines.join("\n")}\n`;
}
