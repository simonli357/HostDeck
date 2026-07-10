import { describe, expect, it } from "vitest";
import { type CodexBindingDescriptor, codexBindingDescriptor } from "./binding.js";
import {
  assessCodexCompatibility,
  HostDeckCodexCompatibilityError,
  parseCodexCliVersionOutput
} from "./compatibility.js";

const checkedAt = "2026-07-09T21:00:00.000Z";

describe("Codex generated binding compatibility", () => {
  it("allows mutation only for the reviewed version, binding, platform, and plan catalog", () => {
    const result = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe()
    });

    expect(result).toMatchObject({
      state: "ready",
      mutation_policy: "allowed",
      observed_version: "0.144.0",
      binding_id: codexBindingDescriptor.binding_id,
      reason: null
    });
    expect(result.capabilities.every((capability) => capability.state === "available")).toBe(true);
  });

  it("blocks unsupported and malformed Codex versions", () => {
    expect(
      assessCodexCompatibility({
        observed_version: "0.145.0",
        checked_at: checkedAt,
        handshake: initializedProbe()
      })
    ).toMatchObject({ state: "incompatible", mutation_policy: "blocked", reason: expect.stringContaining("requires exactly 0.144.0") });
    expect(
      assessCodexCompatibility({
        observed_version: "nightly",
        checked_at: checkedAt,
        handshake: initializedProbe()
      })
    ).toMatchObject({ state: "incompatible", mutation_policy: "blocked", observed_version: null });
  });

  it("blocks unreviewed schema identity before considering runtime readiness", () => {
    const binding = cloneBinding({ binding_id: "codex-app-server-0.144.0-experimental:sha256:unreviewed" });
    const result = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe(),
      binding
    });

    expect(result).toMatchObject({ state: "incompatible", mutation_policy: "blocked", reason: expect.stringContaining("unreviewed") });
    expect(result.capabilities.every((capability) => capability.state === "unavailable")).toBe(true);
  });

  it("blocks missing plan and approval protocol evidence", () => {
    const noPlan = cloneBinding({
      surface: {
        ...codexBindingDescriptor.surface,
        client_methods: codexBindingDescriptor.surface.client_methods.filter((method) => method !== "collaborationMode/list")
      }
    });
    const noPlanResult = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe(),
      binding: noPlan
    });
    expect(noPlanResult).toMatchObject({ state: "incompatible", mutation_policy: "blocked" });
    expect(noPlanResult.capabilities.find((capability) => capability.name === "plan")).toMatchObject({ state: "unavailable" });

    const noApproval = cloneBinding({
      surface: {
        ...codexBindingDescriptor.surface,
        server_requests: codexBindingDescriptor.surface.server_requests.filter(
          (method) => method !== "item/fileChange/requestApproval"
        )
      }
    });
    const noApprovalResult = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe(),
      binding: noApproval
    });
    expect(noApprovalResult).toMatchObject({ state: "incompatible", mutation_policy: "blocked" });
    expect(noApprovalResult.capabilities.find((capability) => capability.name === "approvals")).toMatchObject({
      state: "unavailable"
    });
  });

  it.each([
    ["thread_lifecycle", "client_methods", "thread/start"],
    ["turn_input", "client_methods", "turn/start"],
    ["turn_steer", "client_methods", "turn/steer"],
    ["turn_interrupt", "client_methods", "turn/interrupt"],
    ["model", "client_methods", "model/list"],
    ["goal", "client_methods", "thread/goal/set"],
    ["plan", "client_methods", "collaborationMode/list"],
    ["approvals", "server_requests", "item/commandExecution/requestApproval"],
    ["multi_client", "policy_evidence", "multi_client_version_policy"]
  ] as const)("blocks mutation when required capability %s loses %s evidence", (capabilityName, category, marker) => {
    const binding = withoutEvidence(category, marker);
    const result = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe(),
      binding
    });

    expect(result).toMatchObject({ state: "incompatible", mutation_policy: "blocked" });
    expect(result.capabilities.find((capability) => capability.name === capabilityName)).toMatchObject({ state: "unavailable" });
  });

  it("blocks an initialized runtime that does not advertise required plan modes", () => {
    const result = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe({ collaboration_modes: ["Default"] })
    });

    expect(result).toMatchObject({
      state: "incompatible",
      mutation_policy: "blocked",
      reason: "Required Plan collaboration semantics are unavailable."
    });
    expect(result.capabilities.find((capability) => capability.name === "plan")).toMatchObject({ state: "unavailable" });
  });

  it("keeps failed or absent handshakes disconnected and mutation-blocked", () => {
    expect(
      assessCodexCompatibility({
        observed_version: "0.144.0",
        checked_at: checkedAt,
        handshake: { state: "not_attempted" }
      })
    ).toMatchObject({ state: "disconnected", mutation_policy: "blocked" });
    expect(
      assessCodexCompatibility({
        observed_version: "0.144.0",
        checked_at: checkedAt,
        handshake: { state: "failed", reason: "initialize timed out" }
      })
    ).toMatchObject({ state: "disconnected", mutation_policy: "blocked", reason: expect.stringContaining("timed out") });
  });

  it("rejects unsupported initialized platforms", () => {
    expect(
      assessCodexCompatibility({
        observed_version: "0.144.0",
        checked_at: checkedAt,
        handshake: initializedProbe({ platform_os: "windows", platform_family: "windows" })
      })
    ).toMatchObject({ state: "incompatible", mutation_policy: "blocked", reason: expect.stringContaining("Linux/Unix") });
  });

  it("rejects a connected app-server whose user agent reports a different runtime version", () => {
    expect(
      assessCodexCompatibility({
        observed_version: "0.144.0",
        checked_at: checkedAt,
        handshake: initializedProbe({ user_agent: "hostdeck/0.145.0 (Ubuntu 24.4.0; x86_64)" })
      })
    ).toMatchObject({ state: "incompatible", mutation_policy: "blocked", reason: expect.stringContaining("does not match") });
  });

  it("keeps mutation ready when only a known optional capability is absent", () => {
    const withoutUsage = cloneBinding({
      surface: {
        ...codexBindingDescriptor.surface,
        client_methods: codexBindingDescriptor.surface.client_methods.filter((method) => method !== "account/usage/read")
      }
    });
    const result = assessCodexCompatibility({
      observed_version: "0.144.0",
      checked_at: checkedAt,
      handshake: initializedProbe(),
      binding: withoutUsage
    });

    expect(result).toMatchObject({ state: "ready", mutation_policy: "allowed" });
    expect(result.capabilities.find((capability) => capability.name === "usage")).toMatchObject({ state: "unavailable" });
  });

  it("is deterministic under repeated compatibility evaluation and does not mutate the binding", () => {
    const before = JSON.stringify(codexBindingDescriptor);
    const results = Array.from({ length: 32 }, () =>
      assessCodexCompatibility({
        observed_version: "0.144.0",
        checked_at: checkedAt,
        handshake: initializedProbe()
      })
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(JSON.stringify(codexBindingDescriptor)).toBe(before);
  });

  it("fails loudly when the compatibility result timestamp violates the normalized contract", () => {
    expect(() =>
      assessCodexCompatibility({
        observed_version: "0.144.0",
        checked_at: "not-a-timestamp",
        handshake: initializedProbe()
      })
    ).toThrow(HostDeckCodexCompatibilityError);
  });
});

describe("Codex CLI version output", () => {
  it("parses the exact supported CLI output shape", () => {
    expect(parseCodexCliVersionOutput("codex-cli 0.144.0\n")).toBe("0.144.0");
  });

  it.each(["0.144.0\n", "codex-cli nightly\n", "codex-cli 0.144.0 extra\n", ""])('rejects malformed output "%s"', (output) => {
    expect(() => parseCodexCliVersionOutput(output)).toThrow(HostDeckCodexCompatibilityError);
  });
});

function initializedProbe(
  overrides: Partial<Extract<Parameters<typeof assessCodexCompatibility>[0]["handshake"], { readonly state: "initialized" }>> = {}
) {
  return {
    state: "initialized",
    user_agent: "hostdeck/0.144.0 (Ubuntu 24.4.0; x86_64)",
    platform_family: "unix",
    platform_os: "linux",
    collaboration_modes: ["Plan", "Default"],
    ...overrides
  } as const;
}

function cloneBinding(overrides: Partial<CodexBindingDescriptor>): CodexBindingDescriptor {
  return {
    ...codexBindingDescriptor,
    ...overrides,
    surface: overrides.surface ?? codexBindingDescriptor.surface
  };
}

function withoutEvidence(category: keyof CodexBindingDescriptor["surface"], marker: string): CodexBindingDescriptor {
  return cloneBinding({
    surface: {
      ...codexBindingDescriptor.surface,
      [category]: codexBindingDescriptor.surface[category].filter((entry) => entry !== marker)
    }
  });
}
