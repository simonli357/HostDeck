import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { createOperationDeadlineView } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  type CodexApprovalRequestPort,
  createCodexApprovalClient
} from "./approval-client.js";
import type { CodexServerResponseOptions } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { CodexRequestId } from "./protocol.js";

const checkedAt = "2026-07-10T21:30:00.000Z";
const startedAtMs = Date.parse(checkedAt);

describe("Codex approval client", () => {
  it("strictly maps reviewed command and file requests with canonical protocol ids", () => {
    const port = fakePort();
    const client = createCodexApprovalClient(port);
    const command = client.parseRequest(commandRequest(7));
    const file = client.parseRequest(fileRequest("approval-file-1"));

    expect(command).toEqual({
      method: "item/commandExecution/requestApproval",
      protocol_request_id: 7,
      request_id: "number:7",
      thread_id: "thread-approval-a",
      turn_id: "turn-approval-a",
      item_id: "item-command-a",
      generation: 1,
      started_at: checkedAt,
      action: "touch /tmp/hostdeck-approved",
      scope: "/tmp/approval-project",
      reason: "The read-only sandbox blocks this command.",
      risk: "elevated",
      grant_scope: "one_time"
    });
    expect(file).toMatchObject({
      request_id: "string:approval-file-1",
      action: "Apply proposed file changes",
      scope: "/tmp/approval-project",
      risk: "broad"
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(file)).toBe(true);
  });

  it("marks permission-expanding command requests broad without selecting a session grant", () => {
    const request = commandRequest("approval-network-1");
    const parsed = createCodexApprovalClient(fakePort()).parseRequest({
      ...request,
      params: {
        ...request.params,
        networkApprovalContext: { host: "example.invalid", protocol: "https" },
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/approval-project/input"],
            write: null,
            entries: [{ path: { type: "glob_pattern", pattern: "/tmp/approval-project/output/**" }, access: "write" }]
          }
        },
        proposedNetworkPolicyAmendments: [{ host: "example.invalid", action: "allow" }],
        availableDecisions: ["acceptForSession", "decline"]
      }
    });

    expect(parsed).toMatchObject({ risk: "broad", grant_scope: "one_time" });
    expect(parsed.scope).toBe(
      [
        "Working directory: /tmp/approval-project",
        "Network target: https://example.invalid",
        "Additional network access: enabled",
        "Additional read paths: /tmp/approval-project/input",
        "Additional filesystem entries: write:glob:/tmp/approval-project/output/**"
      ].join("\n")
    );
  });

  it("maps approve and deny to exact method-compatible one-time responses", async () => {
    const port = fakePort();
    const client = createCodexApprovalClient(port);
    const command = client.parseRequest(commandRequest(3));
    const file = client.parseRequest(fileRequest("approval-file-2"));

    await client.respond({ request: command, decision: "approve" });
    await client.respond({ request: file, decision: "deny" });

    expect(port.responses).toEqual([
      { id: 3, result: { decision: "accept" } },
      { id: "approval-file-2", result: { decision: "decline" } }
    ]);
  });

  it("bounds background responses and derives user responses from the exact request deadline", async () => {
    const port = fakePort();
    const client = createCodexApprovalClient(port, { mutation_timeout_ms: 1_000 });
    const background = client.parseRequest(commandRequest(4));
    await client.respond({ request: background, decision: "deny" });
    expect(port.responseOptions[0]).toEqual({ timeout_ms: 1_000 });

    let now = 10;
    const controller = new AbortController();
    const deadline = createOperationDeadlineView({
      timeoutMs: 80,
      signal: controller.signal,
      clock: { now: () => now }
    });
    now = 40;
    const user = client.parseRequest(fileRequest("approval-file-deadline"));
    await client.respond({ request: user, decision: "approve", deadline });
    expect(port.responseOptions[1]).toEqual({
      signal: controller.signal,
      timeout_ms: 50
    });

    controller.abort(new Error("client disconnected"));
    await expect(
      client.respond({
        request: client.parseRequest(commandRequest(5)),
        decision: "deny",
        deadline
      })
    ).rejects.toMatchObject({
      code: "request_aborted",
      outcome: "not_sent",
      retry_safe: true
    });
    expect(port.responses).toHaveLength(2);
  });

  it("rejects malformed, oversized, incomplete, unsupported-decision, and extra request shapes", () => {
    const client = createCodexApprovalClient(fakePort());
    const base = commandRequest(1);
    const invalid = [
      { ...base, extra: true },
      { ...base, params: { ...base.params, command: null } },
      { ...base, params: { ...base.params, command: "x".repeat(1_001) } },
      { ...base, params: { ...base.params, command: "touch safe\u0000hidden" } },
      { ...base, params: { ...base.params, command: "touch safe\u202ehidden" } },
      { ...base, params: { ...base.params, startedAtMs: -1 } },
      { ...base, params: { ...base.params, threadId: "" } },
      { ...base, params: { ...base.params, networkApprovalContext: { host: "example.invalid" } } },
      { ...base, params: { ...base.params, proposedNetworkPolicyAmendments: [{ host: "example.invalid" }] } },
      { ...base, params: { ...base.params, commandActions: [{ type: "read", command: "cat file" }] } },
      { ...base, params: { ...base.params, availableDecisions: ["acceptForever"] } },
      {
        ...base,
        params: {
          ...base.params,
          cwd: `/${"c".repeat(499)}`,
          additionalPermissions: {
            network: null,
            fileSystem: { read: [`/${"r".repeat(499)}`], write: null }
          }
        }
      },
      {
        ...base,
        method: "item/permissions/requestApproval",
        classification: "generated_unsupported"
      }
    ];

    for (const candidate of invalid) {
      expect(() => client.parseRequest(candidate), JSON.stringify(candidate).slice(0, 160)).toThrow(HostDeckCodexAdapterError);
    }
  });

  it("rejects unavailable capability, malformed response input, and cross-generation response", async () => {
    const unsupported = createCodexApprovalClient(fakePort(compatibilityWithApprovals("unavailable")));
    expect(() => unsupported.parseRequest(commandRequest(1))).toThrow("does not support structured approvals");

    const port = fakePort();
    const client = createCodexApprovalClient(port);
    const request = client.parseRequest(commandRequest(2));
    await expect(client.respond({ request, decision: "approve", extra: true } as never)).rejects.toMatchObject({
      code: "invalid_protocol_message",
      outcome: "not_sent"
    });
    await expect(
      client.respond({ request: { ...request, request_id: "string:forged" as never }, decision: "approve" })
    ).rejects.toMatchObject({ code: "invalid_protocol_message", outcome: "not_sent" });
    port.generation = 2;
    await expect(client.respond({ request, decision: "approve" })).rejects.toMatchObject({
      code: "unknown_outcome",
      outcome: "unknown",
      retry_safe: false
    });
    expect(port.responses).toHaveLength(0);
  });

  it("allows idle composition but requires a positive generation for use", () => {
    const port = fakePort();
    port.generation = 0;
    const client = createCodexApprovalClient(port);
    expect(() => client.generation).toThrow(HostDeckCodexAdapterError);
    expect(() => client.parseRequest(commandRequest(1))).toThrow(HostDeckCodexAdapterError);

    port.generation = 1;
    expect(client.parseRequest(commandRequest(1))).toMatchObject({ generation: 1 });

    port.generation = -1;
    expect(() => createCodexApprovalClient(port)).toThrow(TypeError);
  });
});

interface FakePort extends CodexApprovalRequestPort {
  generation: number;
  readonly responses: Array<{ readonly id: CodexRequestId; readonly result: unknown }>;
  readonly responseOptions: CodexServerResponseOptions[];
}

function fakePort(compatibility = readyCompatibility()): FakePort {
  const responses: FakePort["responses"] = [];
  const responseOptions: CodexServerResponseOptions[] = [];
  return {
    compatibility,
    generation: 1,
    responses,
    responseOptions,
    async respondToServerRequest(id, result, options = {}) {
      responses.push({ id, result });
      responseOptions.push(options);
    }
  };
}

function commandRequest(id: CodexRequestId) {
  return {
    kind: "server_request" as const,
    id,
    method: "item/commandExecution/requestApproval" as const,
    classification: "supported" as const,
    params: {
      threadId: "thread-approval-a",
      turnId: "turn-approval-a",
      itemId: "item-command-a",
      startedAtMs,
      approvalId: null,
      environmentId: null,
      reason: "The read-only sandbox blocks this command.",
      networkApprovalContext: null,
      command: "touch /tmp/hostdeck-approved",
      cwd: "/tmp/approval-project",
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "decline"]
    }
  };
}

function fileRequest(id: CodexRequestId) {
  return {
    kind: "server_request" as const,
    id,
    method: "item/fileChange/requestApproval" as const,
    classification: "supported" as const,
    params: {
      threadId: "thread-approval-a",
      turnId: "turn-approval-a",
      itemId: "item-file-a",
      startedAtMs,
      reason: "The patch needs workspace write access.",
      grantRoot: "/tmp/approval-project"
    }
  };
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function compatibilityWithApprovals(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "approvals" ? { ...capability, state, reason: "test approval capability" } : capability
    )
  };
}
