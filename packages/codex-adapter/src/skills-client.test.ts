import type { RuntimeCompatibility } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { CodexRequestInput } from "./broker.js";
import { assessCodexCompatibility } from "./compatibility.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  type CodexSkillsRequestPort,
  createCodexSkillsClient
} from "./skills-client.js";

const cwd = "/tmp/hostdeck-skills-adapter";
const observedAt = "2026-07-11T19:15:00.000Z";

describe("Codex skills client", () => {
  it("sends one exact selected-cwd read and returns sorted path-redacted summaries", async () => {
    const controller = new AbortController();
    const response = rawResponse({ skills: [rawSkill("beta"), rawSkill("alpha", { enabled: false, scope: "system" })] });
    const port = fakePort((request) => {
      expect(request).toEqual({
        method: "skills/list",
        params: { cwds: [cwd], forceReload: true },
        kind: "read",
        timeout_ms: 4_000,
        signal: controller.signal
      });
      return response;
    });
    const client = createCodexSkillsClient(port, { read_timeout_ms: 4_000, now: () => observedAt });

    const result = await client.listForCwd({ cwd, signal: controller.signal });
    expect(result).toEqual({
      runtime_version: "0.144.0",
      connection_generation: 3,
      observed_at: observedAt,
      state: "content",
      skills: [
        { name: "alpha", description: "Description for alpha.", scope: "system", enabled: false },
        { name: "beta", description: "Description for beta.", scope: "repo", enabled: true }
      ],
      error_count: 0
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.skills)).toBe(true);
    expect(Object.isFrozen(result.skills[0])).toBe(true);
    expect(port.requests).toHaveLength(1);

    const serialized = JSON.stringify(result);
    for (const secret of [cwd, "SKILL.md", "SENSITIVE_DEFAULT_PROMPT", "SENSITIVE_COMMAND", "https://secret.invalid"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("derives exact empty, partial, and error states without retaining raw errors", async () => {
    const empty = await createCodexSkillsClient(fakePort(() => rawResponse({ skills: [], errors: [] })), {
      now: () => observedAt
    }).listForCwd({ cwd });
    expect(empty).toMatchObject({ state: "empty", skills: [], error_count: 0 });

    const partial = await createCodexSkillsClient(
      fakePort(() => rawResponse({ skills: [rawSkill("alpha")], errors: [rawError()] })),
      { now: () => observedAt }
    ).listForCwd({ cwd });
    expect(partial).toMatchObject({ state: "partial", error_count: 1 });
    expect(JSON.stringify(partial)).not.toMatch(/SENSITIVE_ERROR|broken-skill/iu);

    const error = await createCodexSkillsClient(
      fakePort(() => rawResponse({ skills: [], errors: [rawError(), rawError("second")] })),
      { now: () => observedAt }
    ).listForCwd({ cwd });
    expect(error).toMatchObject({ state: "error", skills: [], error_count: 2 });
  });

  it("accepts only the reviewed omitted, null, or valid optional wire forms", async () => {
    const omitted = await createCodexSkillsClient(
      fakePort(() => rawResponse({ skills: [rawSkill("omitted", {}, false)] })),
      { now: () => observedAt }
    ).listForCwd({ cwd });
    expect(omitted.skills[0]?.name).toBe("omitted");

    const nullable = await createCodexSkillsClient(
      fakePort(() =>
        rawResponse({
          skills: [
            rawSkill("nullable", {
              shortDescription: null,
              interface: {
                displayName: null,
                shortDescription: null,
                iconSmall: null,
                iconLarge: null,
                brandColor: null,
                defaultPrompt: null
              },
              dependencies: null
            })
          ]
        })
      ),
      { now: () => observedAt }
    ).listForCwd({ cwd });
    expect(nullable.skills[0]?.name).toBe("nullable");

    for (const malformed of [
      rawSkill("bad-interface", { interface: undefined }),
      rawSkill("bad-dependencies", { dependencies: undefined }),
      rawSkill("bad-short", { shortDescription: undefined })
    ]) {
      await expectAdapterError(
        createCodexSkillsClient(fakePort(() => rawResponse({ skills: [malformed] })), {
          now: () => observedAt
        }).listForCwd({ cwd }),
        "invalid_protocol_message"
      );
    }
  });

  it("rejects response, cwd, skill, nested, and error shape drift", async () => {
    const candidates: unknown[] = [
      null,
      {},
      { data: [] },
      { data: [rawEntry(), rawEntry()] },
      { data: [{ ...rawEntry(), cwd: "/tmp/other-cwd" }] },
      { data: [{ ...rawEntry(), extra: true }] },
      rawResponse({ skills: [{ ...rawSkill("alpha"), extra: true }] }),
      rawResponse({ skills: [{ ...rawSkill("alpha"), scope: "unknown" }] }),
      rawResponse({ skills: [{ ...rawSkill("alpha"), enabled: "yes" }] }),
      rawResponse({ skills: [{ ...rawSkill("alpha"), path: "relative/SKILL.md" }] }),
      rawResponse({ skills: [rawSkill("alpha", { interface: { extra: true } })] }),
      rawResponse({ skills: [rawSkill("alpha", { dependencies: { tools: [{ type: "mcp" }] } })] }),
      rawResponse({ errors: [{ path: "/tmp/broken", message: "bad", extra: true }] }),
      rawResponse({ skills: [rawSkill("same"), rawSkill("same")] })
    ];
    for (const candidate of candidates) {
      const port = fakePort(() => candidate);
      await expectAdapterError(
        createCodexSkillsClient(port, { now: () => observedAt }).listForCwd({ cwd }),
        "invalid_protocol_message"
      );
      expect(port.requests).toHaveLength(1);
    }
  });

  it("enforces skill, error, dependency, and UTF-8 ceilings before returning data", async () => {
    const cases: Array<{ readonly response: unknown; readonly options: Record<string, number> }> = [
      {
        response: rawResponse({ skills: [rawSkill("alpha"), rawSkill("beta")] }),
        options: { max_entries_per_cwd: 1 }
      },
      {
        response: rawResponse({ errors: [rawError(), rawError("second")] }),
        options: { max_errors_per_cwd: 1 }
      },
      {
        response: rawResponse({
          skills: [
            rawSkill("alpha", {
              dependencies: { tools: [rawDependency(), rawDependency()] }
            })
          ]
        }),
        options: { max_dependencies_per_skill: 1 }
      },
      {
        response: rawResponse({ skills: [rawSkill("x".repeat(161))] }),
        options: {}
      },
      {
        response: rawResponse({ skills: [rawSkill("alpha", { description: "x".repeat(4_097) })] }),
        options: {}
      }
    ];
    for (const testCase of cases) {
      await expectAdapterError(
        createCodexSkillsClient(fakePort(() => testCase.response), {
          ...testCase.options,
          now: () => observedAt
        }).listForCwd({ cwd }),
        "broker_overloaded"
      );
    }
  });

  it("fails a generation race without retry and keeps capability states distinct", async () => {
    const raced = fakePort(() => {
      raced.currentGeneration += 1;
      return rawResponse();
    });
    const raceError = await expectAdapterError(
      createCodexSkillsClient(raced, { now: () => observedAt }).listForCwd({ cwd }),
      "transport_closed"
    );
    expect(raceError).toMatchObject({ outcome: "not_applicable", retry_safe: true });
    expect(raced.requests).toHaveLength(1);

    const unavailable = fakePort(() => rawResponse(), compatibilityWithSkillsState("unavailable"));
    await expectAdapterError(createCodexSkillsClient(unavailable).listForCwd({ cwd }), "unsupported_method");
    expect(unavailable.requests).toHaveLength(0);

    const disconnected = fakePort(() => rawResponse(), disconnectedCompatibility());
    await expectAdapterError(createCodexSkillsClient(disconnected).listForCwd({ cwd }), "handshake_failed");
    expect(disconnected.requests).toHaveLength(0);

    const invalidGeneration = fakePort(() => rawResponse());
    invalidGeneration.currentGeneration = 0;
    await expectAdapterError(createCodexSkillsClient(invalidGeneration).listForCwd({ cwd }), "protocol_violation");
    expect(invalidGeneration.requests).toHaveLength(0);
  });

  it("validates exact input/options and propagates a read failure once", async () => {
    const port = fakePort(() => rawResponse());
    await expectAdapterError(createCodexSkillsClient(port).listForCwd({ cwd: "relative" }), "invalid_protocol_message");
    await expectAdapterError(
      createCodexSkillsClient(port).listForCwd({ cwd, extra: true } as never),
      "invalid_protocol_message"
    );
    await expectAdapterError(
      createCodexSkillsClient(port).listForCwd({ cwd, signal: "bad" } as never),
      "invalid_protocol_message"
    );
    expect(port.requests).toHaveLength(0);

    expect(() => createCodexSkillsClient(fakePort(() => rawResponse()), { max_entries_per_cwd: 0 })).toThrow(
      HostDeckCodexAdapterError
    );
    expect(() => createCodexSkillsClient(fakePort(() => rawResponse()), { unknown: true } as never)).toThrow(
      HostDeckCodexAdapterError
    );
    expect(() => createCodexSkillsClient(null as never)).toThrow(TypeError);

    const timeoutPort = fakePort(() => {
      throw new HostDeckCodexAdapterError("request_timeout", "skills read timed out", {
        outcome: "not_applicable",
        retry_safe: true
      });
    });
    await expectAdapterError(createCodexSkillsClient(timeoutPort).listForCwd({ cwd }), "request_timeout");
    expect(timeoutPort.requests).toHaveLength(1);
  });

  it("returns deterministic repeated reads without retaining prior raw responses", async () => {
    let calls = 0;
    const port = fakePort(() => {
      calls += 1;
      return rawResponse({ skills: calls === 1 ? [rawSkill("beta"), rawSkill("alpha")] : [rawSkill("alpha"), rawSkill("beta")] });
    });
    const client = createCodexSkillsClient(port, { now: () => observedAt });
    expect(await client.listForCwd({ cwd })).toEqual(await client.listForCwd({ cwd }));
    expect(port.requests).toHaveLength(2);
  });
});

interface FakePort extends CodexSkillsRequestPort {
  readonly requests: CodexRequestInput[];
  currentGeneration: number;
}

function fakePort(
  handler: (request: CodexRequestInput) => unknown | Promise<unknown>,
  compatibility = readyCompatibility()
): FakePort {
  const requests: CodexRequestInput[] = [];
  const port: FakePort = {
    compatibility,
    currentGeneration: 3,
    get generation() {
      return port.currentGeneration;
    },
    requests,
    async request(request) {
      requests.push(request);
      return handler(request);
    }
  };
  return port;
}

function rawResponse(overrides: { readonly skills?: unknown[]; readonly errors?: unknown[] } = {}) {
  return { data: [rawEntry(overrides)] };
}

function rawEntry(overrides: { readonly skills?: unknown[]; readonly errors?: unknown[] } = {}) {
  return {
    cwd,
    skills: overrides.skills ?? [rawSkill("alpha")],
    errors: overrides.errors ?? []
  };
}

function rawSkill(name: string, overrides: Record<string, unknown> = {}, includeOptional = true) {
  return {
    name,
    description: `Description for ${name}.`,
    path: `/tmp/private-skills/${name}/SKILL.md`,
    scope: "repo",
    enabled: true,
    ...(includeOptional
      ? {
          shortDescription: `Short ${name}`,
          interface: {
            displayName: `Display ${name}`,
            shortDescription: `Interface ${name}`,
            iconSmall: `/tmp/private-skills/${name}/small.png`,
            iconLarge: `/tmp/private-skills/${name}/large.png`,
            brandColor: null,
            defaultPrompt: "SENSITIVE_DEFAULT_PROMPT"
          },
          dependencies: { tools: [rawDependency()] }
        }
      : {}),
    ...overrides
  };
}

function rawDependency() {
  return {
    type: "mcp",
    value: "sensitive-tool",
    description: "Sensitive dependency description.",
    transport: "stdio",
    command: "SENSITIVE_COMMAND",
    url: "https://secret.invalid"
  };
}

function rawError(suffix = "first") {
  return {
    path: `/tmp/broken-skill-${suffix}/SKILL.md`,
    message: `SENSITIVE_ERROR_${suffix}`
  };
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: observedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function compatibilityWithSkillsState(state: "unavailable" | "unknown"): RuntimeCompatibility {
  const compatibility = readyCompatibility();
  return {
    ...compatibility,
    state: "degraded",
    capabilities: compatibility.capabilities.map((capability) =>
      capability.name === "skills" ? { ...capability, state, reason: "test skills capability" } : capability
    )
  };
}

function disconnectedCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: observedAt,
    handshake: { state: "not_attempted" }
  });
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: HostDeckCodexAdapterError["code"]
): Promise<HostDeckCodexAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexAdapterError;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
