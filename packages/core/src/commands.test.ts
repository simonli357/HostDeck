import { describe, expect, it } from "vitest";
import {
  allowedSlashCommands,
  checkWriteEligibility,
  isAllowedSlashCommand,
  isCommandIntent,
  isWriteAction,
  primarySlashCommands,
  slashCommandKind,
  utilitySlashCommands
} from "./commands.js";
import { type LifecycleState, parseSessionId } from "./session.js";

const sessionId = parseSessionId("sess_write_01");

if (!sessionId.ok) {
  throw new Error(sessionId.message);
}

const selectedSessionId = sessionId.value;

function writableContext(overrides: Partial<Parameters<typeof checkWriteEligibility>[0]> = {}) {
  return {
    action: "prompt",
    sessionId: selectedSessionId,
    targetSessionIds: [selectedSessionId],
    lifecycleState: "running" as LifecycleState,
    trusted: true,
    readOnly: false,
    hostLocked: false,
    auditAvailable: true,
    ...overrides
  };
}

describe("command intents", () => {
  it("recognizes V1 command intents and write actions", () => {
    expect(isCommandIntent("prompt")).toBe(true);
    expect(isCommandIntent("lan_disable")).toBe(true);
    expect(isCommandIntent("bulk_prompt")).toBe(false);
    expect(isWriteAction("prompt")).toBe(true);
    expect(isWriteAction("lock")).toBe(false);
  });

  it("exposes primary and utility slash allowlists", () => {
    expect(primarySlashCommands).toEqual(["/model", "/goal", "/plan"]);
    expect(utilitySlashCommands).toEqual(["/usage", "/compact", "/skills"]);
    expect(allowedSlashCommands).toHaveLength(6);
    expect(isAllowedSlashCommand("/goal")).toBe(true);
    expect(isAllowedSlashCommand("/resume")).toBe(false);
    expect(slashCommandKind("/model")).toBe("primary");
    expect(slashCommandKind("/usage")).toBe("utility");
  });
});

describe("write eligibility", () => {
  it("allows a trusted one-session prompt to a running session", () => {
    expect(checkWriteEligibility(writableContext())).toEqual({ allowed: true });
  });

  it("rejects multi-session or mismatched target writes", () => {
    const otherSession = parseSessionId("sess_write_02");

    if (!otherSession.ok) {
      throw new Error(otherSession.message);
    }

    expect(
      checkWriteEligibility(
        writableContext({
          targetSessionIds: [selectedSessionId, otherSession.value]
        })
      )
    ).toMatchObject({ allowed: false, code: "multi_session_write" });

    expect(
      checkWriteEligibility(
        writableContext({
          targetSessionIds: [otherSession.value],
          sessionId: selectedSessionId
        })
      )
    ).toMatchObject({ allowed: false, code: "multi_session_write" });
  });

  it("rejects unsupported actions and slash commands", () => {
    expect(checkWriteEligibility(writableContext({ action: "bulk_prompt" }))).toMatchObject({
      allowed: false,
      code: "invalid_action"
    });

    expect(checkWriteEligibility(writableContext({ action: "slash", slashCommand: "/resume" }))).toMatchObject({
      allowed: false,
      code: "unsupported_slash"
    });

    expect(checkWriteEligibility(writableContext({ action: "slash", slashCommand: "/plan" }))).toEqual({ allowed: true });
  });

  it("rejects trust, read-only, and locked host failures before session dispatch", () => {
    expect(checkWriteEligibility(writableContext({ trusted: false }))).toMatchObject({
      allowed: false,
      code: "untrusted",
      errorCode: "permission_denied"
    });

    expect(checkWriteEligibility(writableContext({ readOnly: true }))).toMatchObject({
      allowed: false,
      code: "read_only",
      errorCode: "read_only"
    });

    expect(checkWriteEligibility(writableContext({ hostLocked: true }))).toMatchObject({
      allowed: false,
      code: "locked",
      errorCode: "host_locked"
    });
  });

  it.each([
    ["stale", "stale"],
    ["stopped", "stopped"],
    ["crashed", "crashed"],
    ["unknown", "unknown"],
    ["starting", "not_running"],
    ["stopping", "not_running"]
  ] satisfies ReadonlyArray<readonly [LifecycleState, string]>)("rejects %s lifecycle writes", (lifecycleState, code) => {
    expect(checkWriteEligibility(writableContext({ lifecycleState }))).toMatchObject({
      allowed: false,
      code
    });
  });

  it("requires confirmation for raw input and audit availability for writes", () => {
    expect(checkWriteEligibility(writableContext({ action: "raw_input" }))).toMatchObject({
      allowed: false,
      code: "raw_input_confirmation_required"
    });

    expect(checkWriteEligibility(writableContext({ action: "raw_input", rawInputConfirmed: true }))).toEqual({
      allowed: true
    });

    expect(checkWriteEligibility(writableContext({ auditAvailable: false }))).toMatchObject({
      allowed: false,
      code: "audit_unavailable",
      retryable: true
    });
  });
});
