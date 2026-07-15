import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedSessionMappingRecord,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createRuntimeCompatibilityRepository,
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  openMigratedDatabase,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckResumeMetadataReader,
  HostDeckResumeMetadataError,
  type HostDeckResumeRuntimePort,
  type HostDeckResumeStatePort
} from "./resume-metadata.js";

const roots: string[] = [];
const sessionId = "sess_resume_reader_001";
const threadId = "thread-resume-reader-001";
const runtimeVersion = "0.144.0";
const createdAt = "2026-07-15T12:00:00.000Z";
const updatedAt = "2026-07-15T12:01:00.000Z";
const socketPath = "/run/user/1000/hostdeck/app-server.sock";

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("managed-thread resume metadata reader", () => {
  it("snapshots exact accessor-free ports and invokes them without a receiver", () => {
    let stateThis: unknown = "not-called";
    let runtimeThis: unknown = "not-called";
    const state: { require: HostDeckResumeStatePort["require"] } = {
      require: function requireState(this: void, requestedSessionId) {
        stateThis = this;
        expect(requestedSessionId).toBe(sessionId);
        return stateCandidate();
      }
    };
    const runtime: { read: HostDeckResumeRuntimePort["read"] } = {
      read: function readRuntime(this: void) {
        runtimeThis = this;
        return runtimeCandidate();
      }
    };
    const reader = createHostDeckResumeMetadataReader({
      codexBin: "codex",
      runtime,
      socketPath,
      state
    });

    state.require = () => {
      throw new Error("mutated-state-private-sentinel");
    };
    runtime.read = () => {
      throw new Error("mutated-runtime-private-sentinel");
    };

    const response = reader.read(sessionId);
    expect(response).toMatchObject({
      session_id: sessionId,
      local_only: true,
      available: true,
      launch: {
        executable: "codex",
        args: ["resume", "--remote", `unix://${socketPath}`, threadId]
      }
    });
    expect(stateThis).toBeUndefined();
    expect(runtimeThis).toBeUndefined();
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.launch)).toBe(true);
    expect(Object.isFrozen(response.launch?.args)).toBe(true);

    const nullState = Object.assign(Object.create(null) as Record<string, unknown>, {
      require: () => stateCandidate()
    });
    const nullRuntime = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { read: () => runtimeCandidate() }
    );
    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      codexBin: "codex",
      runtime: nullRuntime,
      socketPath,
      state: nullState
    });
    expect(() =>
      createHostDeckResumeMetadataReader(nullInput as never).read(sessionId)
    ).not.toThrow();

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty(
      {
        codexBin: "codex",
        runtime: { read: () => runtimeCandidate() },
        socketPath
      },
      "state",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("input-accessor-private-sentinel");
        }
      }
    );
    const stateAccessor = Object.defineProperty({}, "require", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("port-accessor-private-sentinel");
      }
    });
    const validInput = {
      codexBin: "codex",
      runtime: { read: () => runtimeCandidate() },
      socketPath,
      state: { require: () => stateCandidate() }
    };
    const hostileProxy = new Proxy(validInput, {
      ownKeys() {
        throw new Error("input-proxy-private-sentinel");
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { ...validInput, extra: true },
      Object.assign(Object.create({ inherited: true }), validInput),
      { ...validInput, state: null },
      { ...validInput, state: {} },
      { ...validInput, state: { require: null } },
      { ...validInput, state: { require: () => stateCandidate(), extra: true } },
      { ...validInput, runtime: null },
      { ...validInput, runtime: {} },
      { ...validInput, runtime: { read: null } },
      { ...validInput, runtime: { read: () => runtimeCandidate(), extra: true } },
      inputAccessor,
      { ...validInput, state: stateAccessor },
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckResumeMetadataReader(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("rejects invalid command configuration during construction", () => {
    const base = {
      runtime: { read: () => runtimeCandidate() },
      state: { require: () => stateCandidate() }
    };
    for (const candidate of [
      { ...base, codexBin: "codex --shell", socketPath },
      { ...base, codexBin: "./codex", socketPath },
      { ...base, codexBin: "codex\nprivate", socketPath },
      { ...base, codexBin: "codex", socketPath: "relative.sock" },
      { ...base, codexBin: "codex", socketPath: "/tmp/app%2fsock" },
      { ...base, codexBin: `/${"x".repeat(980)}`, socketPath }
    ]) {
      expect(() => createHostDeckResumeMetadataReader(candidate)).toThrow(
        TypeError
      );
    }
  });

  it("derives one exact escaped command from the durable managed thread", () => {
    const escapedSocketPath = "/tmp/host deck/app's.sock";
    const reader = createReader({
      codexBin: "/opt/Codex Tools/cod'ex",
      socketPath: escapedSocketPath
    });
    const response = reader.read(sessionId);

    expect(response).toEqual({
      session_id: sessionId,
      local_only: true,
      available: true,
      command:
        "'/opt/Codex Tools/cod'\"'\"'ex' resume --remote " +
        "'unix:///tmp/host deck/app'\"'\"'s.sock' thread-resume-reader-001",
      launch: {
        executable: "/opt/Codex Tools/cod'ex",
        args: [
          "resume",
          "--remote",
          "unix:///tmp/host deck/app's.sock",
          threadId
        ]
      },
      unavailable_reason: null
    });
    expect(JSON.stringify(response)).not.toContain("/workspace/private");
    expect(response).not.toHaveProperty("codex_thread_id");
    expect(response).not.toHaveProperty("cwd");
    expect(response).not.toHaveProperty("binding_id");
  });

  it("publishes only explicit unavailable metadata when session or runtime readiness is absent", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly runtime?: RuntimeCompatibility | null;
      readonly state?: SelectedSessionState;
    }> = [
      { name: "starting", state: stateCandidate({ sessionState: "starting" }) },
      { name: "stale-state", state: stateCandidate({ sessionState: "stale" }) },
      { name: "unknown-state", state: stateCandidate({ sessionState: "unknown" }) },
      { name: "stale-projection", state: stateCandidate({ freshness: "stale" }) },
      { name: "runtime-not-recorded", runtime: null },
      {
        name: "runtime-disconnected",
        runtime: runtimeCandidate({
          state: "disconnected",
          mutationPolicy: "blocked",
          reason: "Private runtime connection is unavailable."
        })
      },
      {
        name: "runtime-incompatible",
        runtime: incompatibleRuntimeCandidate()
      },
      {
        name: "runtime-version-drift",
        runtime: runtimeCandidate({ observedVersion: "0.145.0" })
      },
      {
        name: "runtime-policy-blocked",
        runtime: runtimeCandidate({
          state: "degraded",
          mutationPolicy: "blocked",
          reason: "Runtime mutations are blocked."
        })
      }
    ];

    for (const testCase of cases) {
      const response = createReader({
        ...(testCase.runtime !== undefined
          ? { runtime: testCase.runtime }
          : {}),
        ...(testCase.state !== undefined ? { state: testCase.state } : {})
      }).read(sessionId);
      expect(response, testCase.name).toEqual({
        session_id: sessionId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: expect.any(String)
      });
      expect(response.unavailable_reason, testCase.name).not.toContain(threadId);
    }

    expect(
      createReader({
        runtime: runtimeCandidate({
          state: "degraded",
          mutationPolicy: "allowed",
          reason: "Only an optional capability is degraded."
        })
      }).read(sessionId)
    ).toMatchObject({ available: true });
  });

  it("fails closed for invalid targets, missing, archived, recovery, corrupt, and unavailable state", () => {
    let stateCalls = 0;
    const reader = createReader({
      statePort: {
        require() {
          stateCalls += 1;
          return stateCandidate();
        }
      }
    });
    for (const candidate of ["", "bad target", threadId, `${sessionId}/other`]) {
      expect(() => reader.read(candidate)).toThrow(TypeError);
    }
    expect(stateCalls).toBe(0);

    expectResumeError(
      () =>
        createReader({
          statePort: {
            require() {
              throw new HostDeckSelectedStateRepositoryError(
                "session_not_found",
                "database-private-session-name"
              );
            }
          }
        }).read(sessionId),
      "session_not_found",
      false
    );
    expectResumeError(
      () => createReader({ state: stateCandidate({ archived: true }) }).read(sessionId),
      "stale_session",
      false
    );
    expectResumeError(
      () =>
        createReader({
          state: stateCandidate({ disposition: "recovery_required" })
        }).read(sessionId),
      "stale_session",
      false
    );
    expectResumeError(
      () =>
        createReader({
          state: stateCandidate({ id: "sess_resume_reader_other" })
        }).read(sessionId),
      "state_unavailable",
      false
    );

    let returnedStateAccessorCalls = 0;
    const hostileState = Object.defineProperty({}, "mapping", {
      enumerable: true,
      get() {
        returnedStateAccessorCalls += 1;
        throw new Error("returned-state-private-sentinel");
      }
    });
    Object.defineProperty(hostileState, "projection", {
      enumerable: true,
      value: stateCandidate().projection
    });
    expectResumeError(
      () => createReader({ state: hostileState as never }).read(sessionId),
      "state_unavailable",
      false
    );
    expect(returnedStateAccessorCalls).toBe(0);

    const privateStateFailure = expectResumeError(
      () =>
        createReader({
          statePort: {
            require() {
              throw new Error("state-private-sentinel");
            }
          }
        }).read(sessionId),
      "state_unavailable",
      false
    );
    expect(privateStateFailure.message).not.toContain("private-sentinel");

    const malformedRuntime = { ...runtimeCandidate(), extra: "private" };
    const runtimeFailure = expectResumeError(
      () => createReader({ runtime: malformedRuntime as never }).read(sessionId),
      "runtime_unavailable",
      false
    );
    expect(runtimeFailure.message).not.toContain("private");
  });

  it("retries a changing snapshot and never returns metadata materialized from stale state", () => {
    let stateCalls = 0;
    let runtimeCalls = 0;
    const reader = createHostDeckResumeMetadataReader({
      codexBin: "codex",
      socketPath,
      state: {
        require() {
          stateCalls += 1;
          return stateCalls === 1
            ? stateCandidate({ sessionState: "starting" })
            : stateCandidate();
        }
      },
      runtime: {
        read() {
          runtimeCalls += 1;
          return runtimeCandidate();
        }
      }
    });

    expect(reader.read(sessionId)).toMatchObject({ available: true });
    expect(stateCalls).toBe(4);
    expect(runtimeCalls).toBe(4);
  });

  it("returns one sanitized retryable failure after three unstable snapshots", () => {
    let stateCalls = 0;
    let runtimeCalls = 0;
    const reader = createHostDeckResumeMetadataReader({
      codexBin: "codex",
      socketPath,
      state: {
        require() {
          stateCalls += 1;
          return stateCandidate({
            updatedAt:
              stateCalls % 2 === 0
                ? "2026-07-15T12:02:00.000Z"
                : updatedAt
          });
        }
      },
      runtime: {
        read() {
          runtimeCalls += 1;
          return runtimeCandidate();
        }
      }
    });

    const failure = expectResumeError(
      () => reader.read(sessionId),
      "unstable_state",
      true
    );
    expect(failure.message).toBe(
      "Managed-thread resume state changed during the bounded read."
    );
    expect(stateCalls).toBe(6);
    expect(runtimeCalls).toBe(6);
  });

  it("reads the exact mapping and compatibility records from migrated SQLite storage", () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-resume-reader-"));
    roots.push(root);
    const opened = openMigratedDatabase(join(root, "hostdeck.db"), {
      now: () => new Date(createdAt)
    });
    try {
      const states = createSelectedStateRepository(opened.db);
      const compatibility = createRuntimeCompatibilityRepository(opened.db);
      states.create(stateCandidate());
      compatibility.put({
        id: "hostdeck_runtime",
        compatibility: runtimeCandidate(),
        recorded_at: updatedAt
      });

      const reader = createHostDeckResumeMetadataReader({
        codexBin: "codex",
        socketPath,
        state: { require: states.require },
        runtime: {
          read: () => compatibility.get()?.compatibility ?? null
        }
      });
      expect(reader.read(sessionId)).toEqual({
        session_id: sessionId,
        local_only: true,
        available: true,
        command: `codex resume --remote unix://${socketPath} ${threadId}`,
        launch: {
          executable: "codex",
          args: ["resume", "--remote", `unix://${socketPath}`, threadId]
        },
        unavailable_reason: null
      });

      opened.db
        .prepare(
          "UPDATE selected_runtime_compatibility SET compatibility_json = json_set(compatibility_json, '$.reason', 'persisted-private-sentinel') WHERE id = 'hostdeck_runtime'"
        )
        .run();
      expectResumeError(
        () => reader.read(sessionId),
        "runtime_unavailable",
        true
      );
    } finally {
      opened.db.close();
    }
  });
});

function createReader(
  input: {
    readonly codexBin?: string;
    readonly runtime?: RuntimeCompatibility | null;
    readonly runtimePort?: HostDeckResumeRuntimePort;
    readonly socketPath?: string;
    readonly state?: SelectedSessionState | unknown;
    readonly statePort?: HostDeckResumeStatePort;
  } = {}
) {
  const state = input.state ?? stateCandidate();
  const runtime = input.runtime === undefined ? runtimeCandidate() : input.runtime;
  return createHostDeckResumeMetadataReader({
    codexBin: input.codexBin ?? "codex",
    socketPath: input.socketPath ?? socketPath,
    state: input.statePort ?? { require: () => state },
    runtime: input.runtimePort ?? { read: () => runtime }
  });
}

function stateCandidate(
  input: {
    readonly archived?: boolean;
    readonly disposition?: SelectedSessionMappingRecord["disposition"];
    readonly freshness?: SelectedSessionProjectionRecord["session"]["freshness"];
    readonly id?: string;
    readonly sessionState?: SelectedSessionProjectionRecord["session"]["session_state"];
    readonly updatedAt?: string;
  } = {}
): SelectedSessionState {
  const id = input.id ?? sessionId;
  const archived = input.archived ?? false;
  const freshness = input.freshness ?? "current";
  const sessionState = archived ? "archived" : (input.sessionState ?? "active");
  const archivedAt = archived ? updatedAt : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id,
    name: "resume-reader",
    codex_thread_id: threadId,
    cwd: "/workspace/private/resume-reader",
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: input.disposition ?? "selected",
    created_at: createdAt,
    updated_at: input.updatedAt ?? updatedAt,
    archived_at: archivedAt
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: archivedAt,
      session_state: sessionState,
      turn_state: "idle",
      attention: "none",
      freshness,
      freshness_reason:
        freshness === "current" ? null : "Projection freshness is unavailable.",
      updated_at: input.updatedAt ?? updatedAt,
      last_activity_at: null,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Managed session resume fixture.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function runtimeCandidate(
  input: {
    readonly mutationPolicy?: RuntimeCompatibility["mutation_policy"];
    readonly observedVersion?: string;
    readonly reason?: string | null;
    readonly state?: RuntimeCompatibility["state"];
  } = {}
): RuntimeCompatibility {
  const state = input.state ?? "ready";
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state,
    mutation_policy: input.mutationPolicy ?? "allowed",
    observed_version: input.observedVersion ?? runtimeVersion,
    binding_id: "binding-resume-reader-001",
    capabilities: runtimeCapabilities.map((name) => ({
      name,
      state: "available",
      reason: null
    })),
    checked_at: updatedAt,
    reason: input.reason === undefined ? (state === "ready" ? null : "Runtime is unavailable.") : input.reason
  });
}

function incompatibleRuntimeCandidate(): RuntimeCompatibility {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "incompatible",
    mutation_policy: "blocked",
    observed_version: runtimeVersion,
    binding_id: "binding-resume-reader-001",
    capabilities: runtimeCapabilities.map((name) =>
      name === "thread_lifecycle"
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: updatedAt,
    reason: "Required runtime capability is unavailable."
  });
}

function expectResumeError(
  action: () => unknown,
  code: HostDeckResumeMetadataError["code"],
  retryable: boolean
): HostDeckResumeMetadataError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckResumeMetadataError);
    expect((error as HostDeckResumeMetadataError).code).toBe(code);
    expect((error as HostDeckResumeMetadataError).retryable).toBe(retryable);
    return error as HostDeckResumeMetadataError;
  }
  throw new Error(`Expected HostDeckResumeMetadataError ${code}.`);
}
