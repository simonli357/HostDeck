import type { HostStatusResponse } from "@hostdeck/contracts";
import type { CliFailure } from "./errors.js";

export function renderHelp(): string {
  return [
    "Usage:",
    "  codexdeck status [--json] [--api-url URL | --host HOST --port PORT]",
    "  codexdeck help",
    "  codexdeck version",
    "",
    "Options:",
    "  --api-url URL     HostDeck daemon base URL.",
    "  --host HOST       HostDeck daemon host. Defaults to 127.0.0.1.",
    "  --port PORT       HostDeck daemon port. Defaults to 3777.",
    "  --config PATH     JSON config file with api_url or host/port.",
    "  --json            Print machine-readable output for supported commands.",
    ""
  ].join("\n");
}

export function renderVersion(version: string): string {
  return `codexdeck ${version}\n`;
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
    `LAN: ${status.lan_enabled ? "enabled" : "disabled"}`,
    `Lock: ${status.locked ? "locked" : "unlocked"}`,
    `Storage: ${status.storage.state}`,
    `Tmux: ${status.tmux.state}`,
    `Stream: ${status.stream.state}`,
    `Stale sessions: ${status.stale_session_count}`,
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
