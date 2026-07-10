import { isAbsolute } from "node:path";
import { codexThreadIdSchema } from "@hostdeck/contracts";
import { HostDeckCodexAdapterError } from "./errors.js";
import { formatCodexUnixRemoteAddress } from "./transport.js";

export interface CodexTuiResumeCommandInput {
  readonly socket_path: string;
  readonly thread_id: string;
  readonly codex_bin?: string;
}

export interface CodexTuiResumeCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export function buildCodexTuiResumeCommand(input: CodexTuiResumeCommandInput): CodexTuiResumeCommand {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidResumeCommand("Codex TUI resume command input must be an object.");
  }
  const threadId = codexThreadIdSchema.safeParse(input.thread_id);
  if (!threadId.success) throw invalidResumeCommand("Codex TUI resume thread id is invalid.", threadId.error);
  const executable = parseExecutable(input.codex_bin ?? "codex");
  const args = Object.freeze(["resume", "--remote", formatCodexUnixRemoteAddress(input.socket_path), threadId.data]);
  return Object.freeze({ executable, args });
}

function parseExecutable(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 4_096 || containsControlCharacter(candidate)) {
    throw invalidResumeCommand("Codex executable must be a bounded path or command name.");
  }
  if (isAbsolute(candidate)) return candidate;
  if (candidate === "." || candidate === ".." || !/^[A-Za-z0-9._+-]+$/u.test(candidate)) {
    throw invalidResumeCommand("Relative Codex executable must be a bare command name.");
  }
  return candidate;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function invalidResumeCommand(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_transport_config", message, {
    cause,
    outcome: "not_sent",
    retry_safe: true
  });
}
