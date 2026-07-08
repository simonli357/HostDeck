import type { AttentionLevel, SessionStatus } from "./session.js";

export type CodexOutputClassificationReason =
  | "empty_output"
  | "approval_prompt"
  | "user_question"
  | "command_running"
  | "tests_passed"
  | "tests_failed"
  | "compact_warning"
  | "unknown_output";

export interface CodexOutputClassification {
  readonly status: SessionStatus;
  readonly attention: AttentionLevel;
  readonly reason: CodexOutputClassificationReason;
}

export function classifyCodexOutput(output: string): CodexOutputClassification {
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return classify("idle", "none", "empty_output");
  }

  const normalized = trimmed.toLowerCase();

  if (hasTestFailure(normalized)) {
    return classify("tests_failed", "failed", "tests_failed");
  }

  if (hasApprovalPrompt(normalized)) {
    return classify("waiting_for_approval", "needs_approval", "approval_prompt");
  }

  if (hasUserQuestion(normalized)) {
    return classify("waiting_for_user", "needs_input", "user_question");
  }

  if (hasCompactWarning(normalized)) {
    return classify("compacting", "watch", "compact_warning");
  }

  if (hasTestSuccess(normalized)) {
    return classify("tests_passed", "none", "tests_passed");
  }

  if (hasRunningCommand(normalized)) {
    return classify("running", "watch", "command_running");
  }

  return classify("unknown", "unknown", "unknown_output");
}

function hasApprovalPrompt(value: string): boolean {
  return (
    value.includes("needs approval") ||
    value.includes("approve before continuing") ||
    value.includes("allow command") ||
    value.includes("approval required")
  );
}

function hasUserQuestion(value: string): boolean {
  return (
    value.includes("?") &&
    (value.includes("reply with") || value.includes("which direction") || value.includes("choose") || value.includes("what should"))
  );
}

function hasRunningCommand(value: string): boolean {
  return value.includes("tests are still running") || value.includes("still running") || /^\$ .+/mu.test(value);
}

function hasTestSuccess(value: string): boolean {
  return value.includes("test files") && value.includes("passed") && !value.includes("failed");
}

function hasTestFailure(value: string): boolean {
  return value.includes("fail ") || value.includes("fail\n") || value.includes("failed") || value.includes("tests failed");
}

function hasCompactWarning(value: string): boolean {
  return value.includes("context is getting low") || value.includes("/compact") || value.includes("compact soon");
}

function classify(status: SessionStatus, attention: AttentionLevel, reason: CodexOutputClassificationReason): CodexOutputClassification {
  return {
    status,
    attention,
    reason
  };
}
