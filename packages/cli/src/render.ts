import { Buffer } from "node:buffer";
import {
  type ApiSession,
  defaultResourceBudget,
  type HostStatusResponse,
  type PromptDispatchResponse,
  pairingClientLabelSchema,
  promptDispatchResponseSchema,
  type RemoteIngressPublicState,
  remoteIngressPublicStateSchema,
  type SelectedOperationDispatch,
  type SelectedSessionStartResponse,
  type SessionListResponse,
  type SkillsSnapshot,
  selectedOperationDispatchSchema,
  selectedPairingLinkSchema,
  selectedPairingPermissionSchema,
  selectedSessionStartResponseSchema,
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
    "  codexdeck usage SESSION_ID [--json]",
    "  codexdeck skills SESSION_ID [--json]",
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

function escapeTerminalText(value: string): string {
  const escaped = JSON.stringify(value);
  return escaped
    .slice(1, -1)
    .replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
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
