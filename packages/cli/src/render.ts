import {
  type ApiSession,
  type HostStatusResponse,
  type RemoteIngressPublicState,
  remoteIngressPublicStateSchema,
  type SessionListResponse,
  type StartSessionResponse,
  type WriteResponse
} from "@hostdeck/contracts";
import type { CliFailure } from "./errors.js";
import type { LockCommandResult, PairingCommandResult } from "./local-admin.js";

export function renderHelp(): string {
  return [
    "Usage:",
    "  codexdeck [--state-dir PATH] [--database PATH] [--port PORT] serve",
    "  codexdeck [--api-url URL | --host HOST --port PORT] status [--json]",
    "  codexdeck start --name NAME --cwd PATH [--json]",
    "  codexdeck list [--json]",
    "  codexdeck send SESSION TEXT...",
    "  codexdeck attach SESSION",
    "  codexdeck stop SESSION",
    "  codexdeck pair [--label LABEL] [--ttl-minutes MINUTES] [--read-only] [--json]",
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

export function renderStartSession(response: StartSessionResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify(response, null, 2)}\n`;
  }

  return [
    `Started session: ${response.session.name}`,
    `ID: ${response.session.id}`,
    `CWD: ${response.session.cwd}`,
    `Tmux: ${response.session.backend.tmux.session_name}`,
    ""
  ].join("\n");
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

export function renderPairingCode(response: PairingCommandResult, json: boolean): string {
  if (json) {
    return `${JSON.stringify(response, null, 2)}\n`;
  }

  return [
    "Pairing code created.",
    `Code: ${response.code}`,
    `Permission: ${response.permission}`,
    `Expires: ${response.expires_at}`,
    `Pairing ID: ${response.pairing_id}`,
    "No device token was created or stored by this command.",
    ""
  ].join("\n");
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
