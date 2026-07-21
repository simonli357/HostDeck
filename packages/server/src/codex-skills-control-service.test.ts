import {
  type CodexSkillsClient,
  type CodexSkillsListInput,
  type CodexSkillsListing,
  HostDeckCodexAdapterError
} from "@hostdeck/codex-adapter";
import {
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexSkillsControlErrorCode,
  type CodexSkillsControlStatePort,
  createCodexSkillsControlService,
  HostDeckCodexSkillsControlError
} from "./codex-skills-control-service.js";
import {
  testOperationDeadline,
  withTestOperationDeadlines
} from "./test-operation-deadline.js";

const targetA = {
  type: "managed_session",
  session_id: "sess_skills_control_a",
  codex_thread_id: "thread-skills-control-a"
} as const;
const targetB = {
  type: "managed_session",
  session_id: "sess_skills_control_b",
  codex_thread_id: "thread-skills-control-b"
} as const;
const cwdA = "/tmp/hostdeck-skills-control-a";
const cwdB = "/tmp/hostdeck-skills-control-b";
const observedAt = "2026-07-11T19:30:00.000Z";

interface TestTarget {
  readonly type: "managed_session";
  readonly session_id: string;
  readonly codex_thread_id: string;
}

describe("Codex skills control service", () => {
  it("resolves one exact selected cwd and returns a frozen path-redacted snapshot", async () => {
    const harness = createHarness();
    harness.states.put(selectedState(targetA, cwdA));
    const controller = new AbortController();

    const snapshot = await harness.service.list(
      skillsIntent(targetA, "op_skills_control_content_0001"),
      controller.signal
    );
    expect(snapshot).toEqual({
      target: targetA,
      runtime_version: "0.144.0",
      connection_generation: 3,
      observed_at: observedAt,
      state: "content",
      skills: [
        { name: "alpha", description: "Alpha skill.", scope: "repo", enabled: true },
        { name: "beta", description: null, scope: "system", enabled: false }
      ],
      error_count: 0
    });
    expect(harness.skills.calls).toHaveLength(1);
    expect(harness.skills.calls[0]).toMatchObject({ cwd: cwdA });
    expect(harness.skills.calls[0]?.deadline?.signal).toBe(controller.signal);
    expect(harness.states.getCalls).toBe(2);
    expect(Object.isFrozen(harness.service)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.skills)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/cwd|path|prompt|command|url|transport|message/iu);
  });

  it("preserves exact content, empty, partial, and error state", async () => {
    for (const listing of [
      validListing(),
      validListing({ state: "empty", skills: [], error_count: 0 }),
      validListing({ state: "partial", error_count: 2 }),
      validListing({ state: "error", skills: [], error_count: 2 })
    ] as const) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA, cwdA));
      harness.skills.listing = listing;
      await expect(
        harness.service.list(skillsIntent(targetA, `op_skills_control_${listing.state}_0001`))
      ).resolves.toMatchObject({ state: listing.state, error_count: listing.error_count });
    }
  });

  it("rejects missing, mismatched, archived, stale, recovery, and cwd-conflict targets before read", async () => {
    const cases: Array<{
      readonly state: SelectedSessionState | null;
      readonly target: TestTarget;
      readonly code: CodexSkillsControlErrorCode;
    }> = [
      { state: null, target: targetA, code: "target_not_found" },
      {
        state: selectedState(targetA, cwdA),
        target: { ...targetA, codex_thread_id: targetB.codex_thread_id },
        code: "target_mismatch"
      },
      { state: selectedState(targetA, cwdA, { archived: true }), target: targetA, code: "target_not_readable" },
      { state: selectedState(targetA, cwdA, { stale: true }), target: targetA, code: "target_stale" },
      { state: selectedState(targetA, cwdA, { recovery: true }), target: targetA, code: "target_stale" },
      { state: selectedState(targetA, cwdA, { projectionCwd: cwdB }), target: targetA, code: "target_stale" },
      { state: selectedState(targetA, cwdA, { runtimeVersion: "0.143.0" }), target: targetA, code: "target_stale" }
    ];

    for (const testCase of cases) {
      const harness = createHarness();
      if (testCase.state !== null) harness.states.put(testCase.state);
      await expectControlError(
        harness.service.list(skillsIntent(testCase.target, `op_skills_control_${testCase.code}_0001`)),
        testCase.code
      );
      expect(harness.skills.calls).toHaveLength(0);
    }
  });

  it("rejects archive, cwd, runtime, and freshness races after one read", async () => {
    const races = [
      selectedState(targetA, cwdA, { archived: true }),
      selectedState(targetA, cwdB),
      selectedState(targetA, cwdA, { runtimeVersion: "0.143.0" }),
      selectedState(targetA, cwdA, { stale: true })
    ];
    for (const nextState of races) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA, cwdA));
      harness.skills.onList = () => harness.states.put(nextState);
      await expect(harness.service.list(skillsIntent(targetA, "op_skills_control_race_0001"))).rejects.toBeInstanceOf(
        HostDeckCodexSkillsControlError
      );
      expect(harness.skills.calls).toHaveLength(1);
    }
  });

  it("rejects positive runtime identity races after one read", async () => {
    const mutations = [
      (skills: FakeSkillsClient) => {
        skills.currentGeneration = 4;
      },
      (skills: FakeSkillsClient) => {
        skills.currentVersion = "0.145.0";
      }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA, cwdA));
      harness.skills.onList = () => mutate(harness.skills);
      await expectControlError(
        harness.service.list(skillsIntent(targetA, `op_skills_control_runtime_race_000${index + 1}`)),
        "runtime_unavailable"
      );
      expect(harness.skills.calls).toHaveLength(1);
    }
  });

  it("rejects a valid adapter snapshot from another runtime identity", async () => {
    for (const listing of [
      validListing({ connection_generation: 4 }),
      validListing({ runtime_version: "0.145.0" })
    ]) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA, cwdA));
      harness.skills.listing = listing;
      await expectControlError(
        harness.service.list(skillsIntent(targetA, "op_skills_control_listing_identity_0001")),
        "runtime_unavailable"
      );
      expect(harness.skills.calls).toHaveLength(1);
    }
  });

  it("rejects malformed adapter listings without a partial public snapshot", async () => {
    const malformed: unknown[] = [
      { ...validListing(), extra: true },
      { ...validListing(), connection_generation: 0 },
      { ...validListing(), runtime_version: "bad version" },
      { ...validListing(), state: "empty" },
      { ...validListing(), skills: [...validListing().skills].reverse() },
      { ...validListing(), skills: [validListing().skills[0], validListing().skills[0]] },
      { ...validListing(), error_count: 257 },
      { ...validListing(), observed_at: "invalid" }
    ];
    for (const listing of malformed) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA, cwdA));
      harness.skills.listing = listing as CodexSkillsListing;
      await expectControlError(
        harness.service.list(skillsIntent(targetA, "op_skills_control_malformed_0001")),
        "runtime_protocol_error"
      );
      expect(harness.skills.calls).toHaveLength(1);
    }
  });

  it("maps unsupported, malformed, overload, timeout, and unknown adapter failures", async () => {
    const mappings = [
      ["unsupported_method", "capability_unsupported"],
      ["invalid_protocol_message", "runtime_protocol_error"],
      ["broker_overloaded", "service_overloaded"],
      ["request_timeout", "operation_timeout"]
    ] as const;
    for (const [adapterCode, controlCode] of mappings) {
      const harness = createHarness();
      harness.states.put(selectedState(targetA, cwdA));
      harness.skills.error = new HostDeckCodexAdapterError(adapterCode, "skills failed", {
        outcome: "not_applicable",
        retry_safe: adapterCode === "request_timeout"
      });
      await expectControlError(
        harness.service.list(skillsIntent(targetA, `op_skills_control_${adapterCode}_0001`)),
        controlCode
      );
    }

    const harness = createHarness();
    harness.states.put(selectedState(targetA, cwdA));
    harness.skills.error = new Error("unexpected adapter failure");
    await expectControlError(
      harness.service.list(skillsIntent(targetA, "op_skills_control_unknown_0001")),
      "runtime_unavailable"
    );
  });

  it("keeps two targets isolated and repeated reads stateless", async () => {
    const harness = createHarness();
    harness.states.put(selectedState(targetA, cwdA));
    harness.states.put(selectedState(targetB, cwdB));

    const first = await harness.service.list(skillsIntent(targetA, "op_skills_control_isolate_a_0001"));
    const second = await harness.service.list(skillsIntent(targetB, "op_skills_control_isolate_b_0001"));
    const repeated = await harness.service.list(skillsIntent(targetA, "op_skills_control_repeat_a_0001"));
    expect(first.skills).toEqual(second.skills);
    expect(first.skills).toEqual(repeated.skills);
    expect(first.target).toEqual(targetA);
    expect(second.target).toEqual(targetB);
    expect(harness.skills.calls.map((call) => call.cwd)).toEqual([cwdA, cwdB, cwdA]);
  });

  it("validates intent, signal, options, and selected-state failures", async () => {
    const harness = createHarness();
    harness.states.put(selectedState(targetA, cwdA));
    await expectControlError(
      harness.service.list({ ...skillsIntent(targetA, "op_skills_control_extra_0001"), cwd: cwdB }),
      "invalid_request"
    );
    await expectControlError(
      harness.service.list(skillsIntent(targetA, "op_skills_control_signal_0001"), "bad" as never),
      "invalid_request"
    );
    expect(harness.skills.calls).toHaveLength(0);

    expect(() => createCodexSkillsControlService(null as never)).toThrow(TypeError);
    expect(() =>
      createCodexSkillsControlService({ skills: harness.skills, states: harness.states, extra: true } as never)
    ).toThrow(TypeError);

    const brokenStates: CodexSkillsControlStatePort = {
      get() {
        throw new Error("database unavailable");
      }
    };
    await expectControlError(
      createCodexSkillsControlService({ skills: harness.skills, states: brokenStates }).list(
        skillsIntent(targetA, "op_skills_control_storage_0001"),
        testOperationDeadline()
      ),
      "state_unavailable"
    );
  });
});

class FakeSkillsClient implements CodexSkillsClient {
  readonly calls: CodexSkillsListInput[] = [];
  listing: CodexSkillsListing = validListing();
  currentGeneration = 3;
  currentVersion = "0.144.0";
  error: Error | null = null;
  onList: (() => void) | null = null;

  get runtime_version(): string {
    return this.currentVersion;
  }

  get connection_generation(): number {
    return this.currentGeneration;
  }

  async listForCwd(input: CodexSkillsListInput): Promise<CodexSkillsListing> {
    this.calls.push({ ...input });
    this.onList?.();
    if (this.error !== null) throw this.error;
    return this.listing;
  }
}

class MemorySkillsStates implements CodexSkillsControlStatePort {
  readonly values = new Map<string, SelectedSessionState>();
  getCalls = 0;

  put(state: SelectedSessionState): void {
    this.values.set(state.mapping.id, state);
  }

  get = (sessionId: string) => {
    this.getCalls += 1;
    return this.values.get(sessionId) ?? null;
  };
}

function createHarness() {
  const skills = new FakeSkillsClient();
  const states = new MemorySkillsStates();
  const service = withTestOperationDeadlines(
    createCodexSkillsControlService({ skills, states }),
    ["list"]
  );
  return { skills, states, service };
}

function skillsIntent(target: TestTarget, operationId: string) {
  return { operation_id: operationId, target, kind: "skills" } as const;
}

function validListing(overrides: Partial<CodexSkillsListing> = {}): CodexSkillsListing {
  return {
    runtime_version: "0.144.0",
    connection_generation: 3,
    observed_at: observedAt as CodexSkillsListing["observed_at"],
    state: "content",
    skills: [
      { name: "alpha", description: "Alpha skill.", scope: "repo", enabled: true },
      { name: "beta", description: null, scope: "system", enabled: false }
    ],
    error_count: 0,
    ...overrides
  };
}

function selectedState(
  target: TestTarget,
  cwd: string,
  options: {
    readonly archived?: boolean;
    readonly projectionCwd?: string;
    readonly recovery?: boolean;
    readonly runtimeVersion?: string;
    readonly stale?: boolean;
  } = {}
): SelectedSessionState {
  const runtimeVersion = options.runtimeVersion ?? "0.144.0";
  const archivedAt = options.archived ? observedAt : null;
  const projectionCwd = options.projectionCwd ?? cwd;
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: target.session_id,
      name: target.session_id.replace(/^sess_/u, ""),
      codex_thread_id: target.codex_thread_id,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      disposition: options.recovery ? "recovery_required" : "selected",
      created_at: observedAt,
      updated_at: observedAt,
      archived_at: archivedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: target.session_id,
        name: target.session_id.replace(/^sess_/u, ""),
        codex_thread_id: target.codex_thread_id,
        cwd: projectionCwd,
        runtime_source: "codex_app_server",
        runtime_version: runtimeVersion,
        created_at: observedAt,
        archived_at: archivedAt,
        session_state: options.archived ? "archived" : "active",
        turn_state: "idle",
        attention: "none",
        freshness: options.stale ? "stale" : "current",
        freshness_reason: options.stale ? "Runtime reconnect is required." : null,
        updated_at: observedAt,
        last_activity_at: null,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

async function expectControlError(
  promise: Promise<unknown>,
  code: CodexSkillsControlErrorCode
): Promise<HostDeckCodexSkillsControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexSkillsControlError);
    expect(error).toMatchObject({ code });
    return error as HostDeckCodexSkillsControlError;
  }
  throw new Error(`Expected skills control error ${code}.`);
}
