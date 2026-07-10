import {
  codexVersionSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema
} from "@hostdeck/contracts";
import {
  type RuntimeCapability,
  requiredRuntimeCapabilities,
  runtimeCapabilities
} from "@hostdeck/core";
import { type CodexBindingDescriptor, type CodexProtocolSurface, codexBindingDescriptor } from "./binding.js";

export type CodexCompatibilityErrorCode = "invalid_compatibility_result" | "invalid_version_output";

export class HostDeckCodexCompatibilityError extends Error {
  constructor(
    readonly code: CodexCompatibilityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexCompatibilityError";
  }
}

export type CodexHandshakeProbe =
  | {
      readonly state: "not_attempted";
    }
  | {
      readonly state: "failed";
      readonly reason: string;
    }
  | {
      readonly state: "initialized";
      readonly user_agent: string;
      readonly platform_family: string;
      readonly platform_os: string;
      readonly collaboration_modes: readonly string[];
    };

export interface AssessCodexCompatibilityInput {
  readonly observed_version: string | null;
  readonly checked_at: string;
  readonly handshake: CodexHandshakeProbe;
  readonly binding?: CodexBindingDescriptor;
}

interface CapabilityRule {
  readonly client_methods?: readonly string[];
  readonly server_requests?: readonly string[];
  readonly server_notifications?: readonly string[];
  readonly turn_start_fields?: readonly string[];
  readonly policy_evidence?: readonly string[];
}

const capabilityRules = {
  thread_lifecycle: {
    client_methods: [
      "thread/start",
      "thread/resume",
      "thread/archive",
      "thread/list",
      "thread/loaded/list",
      "thread/read",
      "thread/name/set"
    ],
    server_notifications: ["thread/started", "thread/status/changed", "thread/archived"]
  },
  turn_input: { client_methods: ["turn/start"], turn_start_fields: ["threadId", "input"] },
  turn_steer: { client_methods: ["turn/steer"] },
  turn_interrupt: { client_methods: ["turn/interrupt"], server_notifications: ["turn/completed"] },
  model: { client_methods: ["model/list", "turn/start"], turn_start_fields: ["model"] },
  goal: {
    client_methods: ["thread/goal/set", "thread/goal/get", "thread/goal/clear"],
    server_notifications: ["thread/goal/updated", "thread/goal/cleared"]
  },
  plan: {
    client_methods: ["collaborationMode/list", "turn/start"],
    server_notifications: ["turn/plan/updated", "item/plan/delta"],
    turn_start_fields: ["collaborationMode"],
    policy_evidence: ["experimental_api", "plan_mode_catalog"]
  },
  usage: { client_methods: ["account/usage/read"], server_notifications: ["thread/tokenUsage/updated"] },
  compact: {
    client_methods: ["thread/compact/start"],
    server_notifications: ["item/started", "turn/completed"],
    policy_evidence: ["context_compaction_item_type"]
  },
  skills: { client_methods: ["skills/list"] },
  approvals: {
    server_requests: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
    policy_evidence: ["command_approval_response_type", "file_approval_response_type"]
  },
  multi_client: { policy_evidence: ["multi_client_version_policy"] }
} as const satisfies Readonly<Record<RuntimeCapability, CapabilityRule>>;

const requiredCapabilitySet = new Set<RuntimeCapability>(requiredRuntimeCapabilities);

export function parseCodexCliVersionOutput(output: string): string {
  const match = /^codex-cli (\S+)\n?$/u.exec(output);
  const parsed = match?.[1] === undefined ? null : codexVersionSchema.safeParse(match[1]);
  if (parsed === null || !parsed.success) {
    throw new HostDeckCodexCompatibilityError(
      "invalid_version_output",
      "Expected `codex --version` to return exactly `codex-cli <semver>`."
    );
  }
  return parsed.data;
}

export function assessCodexCompatibility(input: AssessCodexCompatibilityInput): RuntimeCompatibility {
  const binding = input.binding ?? codexBindingDescriptor;
  const parsedVersion = input.observed_version === null ? null : codexVersionSchema.safeParse(input.observed_version);

  if (parsedVersion === null || !parsedVersion.success) {
    return incompatible(input.checked_at, input.observed_version, binding, "Codex version is missing or malformed.");
  }
  if (parsedVersion.data !== binding.codex_version || binding.codex_version !== codexBindingDescriptor.codex_version) {
    return incompatible(
      input.checked_at,
      parsedVersion.data,
      binding,
      `Unsupported Codex ${parsedVersion.data}; HostDeck requires exactly ${codexBindingDescriptor.codex_version}.`
    );
  }
  if (
    binding.binding_id !== codexBindingDescriptor.binding_id ||
    binding.tree_sha256 !== codexBindingDescriptor.tree_sha256 ||
    binding.experimental_api !== true
  ) {
    return incompatible(input.checked_at, parsedVersion.data, binding, "Generated Codex binding identity is unreviewed or contradictory.");
  }

  const capabilities = evaluateSurface(binding.surface);
  const missingRequired = capabilities.filter(
    (capability) => requiredCapabilitySet.has(capability.name) && capability.state !== "available"
  );
  if (missingRequired.length > 0) {
    return finalize({
      source: "codex_app_server",
      state: "incompatible",
      mutation_policy: "blocked",
      observed_version: parsedVersion.data,
      binding_id: binding.binding_id,
      capabilities,
      checked_at: input.checked_at,
      reason: bounded(`Required generated protocol evidence is missing: ${missingRequired.map((entry) => entry.name).join(", ")}.`)
    });
  }

  if (input.handshake.state !== "initialized") {
    const reason =
      input.handshake.state === "failed"
        ? bounded(`Codex app-server handshake failed: ${input.handshake.reason}`)
        : "Codex app-server handshake has not completed.";
    return finalize({
      source: "codex_app_server",
      state: "disconnected",
      mutation_policy: "blocked",
      observed_version: parsedVersion.data,
      binding_id: binding.binding_id,
      capabilities: capabilities.map((entry) => ({ ...entry, state: "unknown" as const, reason })),
      checked_at: input.checked_at,
      reason
    });
  }

  if (!matchesRuntimeUserAgent(input.handshake.user_agent, parsedVersion.data)) {
    return incompatible(input.checked_at, parsedVersion.data, binding, "Initialized app-server version does not match the probed Codex binary.");
  }
  if (input.handshake.platform_family !== "unix" || input.handshake.platform_os !== "linux") {
    return incompatible(input.checked_at, parsedVersion.data, binding, "Initialized app-server is not the supported Linux/Unix runtime.");
  }

  const modes = new Set(input.handshake.collaboration_modes.map((mode) => mode.trim().toLowerCase()));
  if (!modes.has("plan") || !modes.has("default")) {
    const withMissingPlan = capabilities.map((entry) =>
      entry.name === "plan"
        ? { ...entry, state: "unavailable" as const, reason: "Initialized app-server did not advertise both Plan and Default modes." }
        : entry
    );
    return finalize({
      source: "codex_app_server",
      state: "incompatible",
      mutation_policy: "blocked",
      observed_version: parsedVersion.data,
      binding_id: binding.binding_id,
      capabilities: withMissingPlan,
      checked_at: input.checked_at,
      reason: "Required Plan collaboration semantics are unavailable."
    });
  }

  return finalize({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: parsedVersion.data,
    binding_id: binding.binding_id,
    capabilities,
    checked_at: input.checked_at,
    reason: null
  });
}

function evaluateSurface(surface: CodexProtocolSurface): RuntimeCompatibility["capabilities"] {
  return runtimeCapabilities.map((name) => {
    const missing = missingEvidence(surface, capabilityRules[name]);
    return missing.length === 0
      ? { name, state: "available" as const, reason: null }
      : {
          name,
          state: "unavailable" as const,
          reason: bounded(`Missing binding evidence: ${missing.join(", ")}.`)
        };
  });
}

function missingEvidence(surface: CodexProtocolSurface, rule: CapabilityRule): readonly string[] {
  const missing: string[] = [];
  for (const category of ["client_methods", "server_requests", "server_notifications", "turn_start_fields", "policy_evidence"] as const) {
    const available = new Set(surface[category]);
    for (const expected of rule[category] ?? []) {
      if (!available.has(expected)) missing.push(`${category}:${expected}`);
    }
  }
  return missing;
}

function incompatible(
  checkedAt: string,
  observedVersion: string | null,
  binding: CodexBindingDescriptor,
  reason: string
): RuntimeCompatibility {
  const boundedReason = bounded(reason);
  return finalize({
    source: "codex_app_server",
    state: "incompatible",
    mutation_policy: "blocked",
    observed_version: codexVersionSchema.safeParse(observedVersion).success ? observedVersion : null,
    binding_id: binding.binding_id,
    capabilities: runtimeCapabilities.map((name) => ({ name, state: "unavailable", reason: boundedReason })),
    checked_at: checkedAt,
    reason: boundedReason
  });
}

function finalize(candidate: unknown): RuntimeCompatibility {
  const parsed = runtimeCompatibilitySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HostDeckCodexCompatibilityError("invalid_compatibility_result", "Codex compatibility result violated its normalized contract.", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function bounded(value: string): string {
  const normalized = value.trim() || "Codex compatibility failed without a usable reason.";
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function matchesRuntimeUserAgent(userAgent: string, version: string): boolean {
  const prefix = `hostdeck/${version}`;
  return userAgent === prefix || userAgent.startsWith(`${prefix} `);
}
