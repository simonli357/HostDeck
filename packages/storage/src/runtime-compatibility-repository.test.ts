import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createRuntimeCompatibilityRepository,
  HostDeckRuntimeCompatibilityRepositoryError,
  type RuntimeCompatibilityRepositoryErrorCode
} from "./runtime-compatibility-repository.js";

const tempDirs: string[] = [];
const checkedAt = "2026-07-09T20:00:00.000Z";
const runtimeCapabilities = [
  "thread_lifecycle",
  "turn_input",
  "turn_steer",
  "turn_interrupt",
  "model",
  "goal",
  "plan",
  "usage",
  "compact",
  "skills",
  "approvals",
  "multi_client"
] as const;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("runtime compatibility repository", () => {
  it("stores, replaces, and reloads the latest negotiated compatibility result", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createRuntimeCompatibilityRepository(first.db);
      expect(repository.get()).toBeNull();
      expect(repository.put(compatibilityRecord()).compatibility.state).toBe("ready");
      expect(
        repository.put(
          compatibilityRecord({
            state: "degraded",
            reason: "Optional usage capability could not be confirmed.",
            overrides: { usage: "unknown" },
            recordedAt: "2026-07-09T20:01:00.000Z"
          })
        ).compatibility
      ).toMatchObject({
        state: "degraded",
        mutation_policy: "allowed"
      });
      expect(
        repository.put(
          compatibilityRecord({
            state: "degraded",
            reason: "Optional usage capability could not be confirmed.",
            overrides: { usage: "unknown" },
            recordedAt: "2026-07-09T20:01:00.000Z"
          })
        ).recorded_at
      ).toBe("2026-07-09T20:01:00.000Z");
      expectCompatibilityError(
        () => repository.put(compatibilityRecord({ recordedAt: "2026-07-09T20:00:30.000Z" })),
        "compatibility_conflict"
      );
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(createRuntimeCompatibilityRepository(second.db).get()).toMatchObject({
        compatibility: {
          state: "degraded",
          capabilities: expect.arrayContaining([{ name: "usage", state: "unknown", reason: "usage is unknown." }])
        },
        recorded_at: "2026-07-09T20:01:00.000Z"
      });
    } finally {
      second.db.close();
    }
  });

  it("rejects incompatible input before write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRuntimeCompatibilityRepository(open.db);
      expectCompatibilityError(
        () =>
          repository.put({
            ...compatibilityRecord(),
            compatibility: {
              ...compatibilityRecord().compatibility,
              mutation_policy: "blocked"
            }
          }),
        "invalid_compatibility"
      );
      expect(repository.get()).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("serializes competing writers and rejects conflicting equal-time results", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const firstRepository = createRuntimeCompatibilityRepository(first.db);
      const secondRepository = createRuntimeCompatibilityRepository(second.db);
      firstRepository.put(compatibilityRecord());

      expectCompatibilityError(
        () =>
          secondRepository.put(
            compatibilityRecord({
              state: "degraded",
              reason: "Conflicting result at the same recorded instant.",
              overrides: { usage: "unknown" }
            })
          ),
        "compatibility_conflict"
      );
      firstRepository.put(compatibilityRecord({ recordedAt: "2026-07-09T20:02:00.000Z" }));
      expectCompatibilityError(
        () => secondRepository.put(compatibilityRecord({ recordedAt: "2026-07-09T20:01:00.000Z" })),
        "compatibility_conflict"
      );
      expect(secondRepository.get()?.recorded_at).toBe("2026-07-09T20:02:00.000Z");
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  it("fails loudly when indexed columns contradict stored compatibility JSON", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRuntimeCompatibilityRepository(open.db);
      repository.put(compatibilityRecord());
      open.db.prepare("UPDATE selected_runtime_compatibility SET state = 'degraded', reason = 'tampered' WHERE id = 'hostdeck_runtime'").run();

      expectCompatibilityError(() => repository.get(), "invalid_persisted_compatibility");
    } finally {
      open.db.close();
    }
  });
});

function compatibilityRecord(
  input: {
    readonly state?: "ready" | "degraded";
    readonly reason?: string | null;
    readonly overrides?: Readonly<Record<string, "available" | "unavailable" | "unknown">>;
    readonly recordedAt?: string;
  } = {}
) {
  const state = input.state ?? "ready";
  return {
    id: "hostdeck_runtime",
    compatibility: {
      source: "codex_app_server",
      state,
      mutation_policy: "allowed",
      observed_version: "0.144.0",
      binding_id: "codex-app-server-0.144.0:sha256:storage-test",
      capabilities: runtimeCapabilities.map((name) => {
        const capabilityState = input.overrides?.[name] ?? (name === "compact" ? "unavailable" : "available");
        return {
          name,
          state: capabilityState,
          reason: capabilityState === "available" ? null : `${name} is ${capabilityState}.`
        };
      }),
      checked_at: checkedAt,
      reason: state === "ready" ? null : (input.reason ?? "Runtime is degraded.")
    },
    recorded_at: input.recordedAt ?? checkedAt
  };
}

function expectCompatibilityError(fn: () => unknown, code: RuntimeCompatibilityRepositoryErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckRuntimeCompatibilityRepositoryError);
    expect((error as HostDeckRuntimeCompatibilityRepositoryError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckRuntimeCompatibilityRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-runtime-compatibility-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(checkedAt);
}
