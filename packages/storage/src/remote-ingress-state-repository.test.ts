import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RemoteIngressState,
  remoteIngressStateSchema
} from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckMigrationError,
  openMigratedDatabase,
  runMigrations
} from "./migration-runner.js";
import { defaultMigrations, type StorageMigration } from "./migrations.js";
import {
  assertRemoteIngressStateRepository,
  createRemoteIngressStateRepository,
  HostDeckRemoteIngressStateRepositoryError
} from "./remote-ingress-state-repository.js";

const tempDirs: string[] = [];
const origin = "https://hostdeck-storage.fixture-tailnet.ts.net";
const otherOrigin = "https://hostdeck-storage.other-tailnet.ts.net";
const profileKey = `sha256:${"1".repeat(64)}`;
const otherProfileKey = `sha256:${"2".repeat(64)}`;
const forbiddenSecret = "tskey-auth-secret-dat-v1-031";

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("remote ingress state migration", () => {
  it("upgrades the prior schema without rewriting historical state", () => {
    const path = tempDbPath();
    const priorMigrations = defaultMigrations.slice(0, -3);
    const prior = openMigratedDatabase(path, {
      migrations: priorMigrations,
      now: fixedNow
    });
    prior.db
      .prepare(
        `
          INSERT INTO selected_lan_configuration (
            id, schema_version, bind_host, address_family, bind_port,
            configured_origin, root_fingerprint_sha256,
            leaf_fingerprint_sha256, leaf_valid_from, leaf_expires_at, updated_at
          ) VALUES (
            'hostdeck_lan_configuration', 1, '192.168.0.29', 'ipv4', 3777,
            'https://192.168.0.29:3777', @root, @leaf,
            '2026-07-12T20:00:00.000Z', '2027-07-12T20:00:00.000Z',
            '2026-07-12T20:00:00.000Z'
          )
        `
      )
      .run({ root: "a".repeat(64), leaf: "b".repeat(64) });
    const historicalBefore = prior.db
      .prepare("SELECT * FROM selected_lan_configuration")
      .get();
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607130013_remote_ingress_state",
        "202607130014_remote_audit_catalog",
        "202607130015_remote_admission_proof"
      ]);
      expect(
        migrated.db.prepare("SELECT * FROM selected_lan_configuration").get()
      ).toEqual(historicalBefore);
      expect(
        migrated.db
          .prepare("SELECT COUNT(*) AS count FROM selected_remote_ingress_state")
          .get()
      ).toEqual({ count: 0 });
      expect(
        migrated.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'selected_remote_ingress_%' ORDER BY name"
          )
          .all()
      ).toEqual([
        { name: "selected_remote_ingress_admission_proof_invalidate" },
        { name: "selected_remote_ingress_generation_step" },
        { name: "selected_remote_ingress_initial_generation" },
        { name: "selected_remote_ingress_no_delete" }
      ]);
    } finally {
      migrated.db.close();
    }
  });

  it("rolls back an interrupted upgrade and rejects a code downgrade", () => {
    const path = tempDbPath();
    const priorMigrations = defaultMigrations.slice(0, -3);
    const prior = openMigratedDatabase(path, {
      migrations: priorMigrations,
      now: fixedNow
    });
    prior.db.close();

    const forcedFailure = {
      version: "202607130014_remote_ingress_failure_probe",
      sql: "CREATE TABLE remote_ingress_failure_probe (id TEXT); INVALID SQL;"
    } satisfies StorageMigration;
    const interrupted = new Database(path);
    try {
      expect(() =>
        runMigrations(interrupted, {
          migrations: [...defaultMigrations, forcedFailure],
          now: fixedNow
        })
      ).toThrow(HostDeckMigrationError);
      expect(
        interrupted
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'selected_remote_ingress_state'"
          )
          .get()
      ).toBeUndefined();
      expect(
        interrupted.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
      ).toEqual({ count: priorMigrations.length });
    } finally {
      interrupted.close();
    }

    const current = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(() =>
        runMigrations(current.db, {
          migrations: priorMigrations,
          now: fixedNow
        })
      ).toThrowError(
        expect.objectContaining({ code: "unknown_migration" })
      );
      expect(
        current.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
      ).toEqual({ count: defaultMigrations.length });
    } finally {
      current.db.close();
    }
  });
});

describe("remote ingress state repository", () => {
  it("persists one exact state with an initial generation and frozen receipts", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressStateRepository(open.db);
      assertRemoteIngressStateRepository(repository);
      expect(repository.read()).toBeNull();

      const initial = readyState(1);
      const receipt = repository.compareAndSet({
        expected_generation: null,
        state: initial
      });
      expect(receipt).toEqual({ before: null, after: initial });
      expect(repository.read()).toEqual(initial);
      expect(Object.isFrozen(repository)).toBe(true);
      expect(isDeepFrozen(receipt)).toBe(true);
      expect(isDeepFrozen(repository.read())).toBe(true);
      expect(() => assertRemoteIngressStateRepository({ ...repository })).toThrow(
        TypeError
      );
    } finally {
      open.db.close();
    }
  });

  it("serializes compare-and-set writers and survives restart", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const firstRepository = createRemoteIngressStateRepository(first.db);
      const secondRepository = createRemoteIngressStateRepository(second.db);
      firstRepository.compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });

      const winningState = disabledState(2, "exact");
      firstRepository.compareAndSet({
        expected_generation: 1,
        state: winningState
      });
      expect(() =>
        secondRepository.compareAndSet({
          expected_generation: 1,
          state: disabledState(2, "absent")
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_conflict" })
      );
      expect(secondRepository.read()).toEqual(winningState);
    } finally {
      second.db.close();
      first.db.close();
    }

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(createRemoteIngressStateRepository(reopened.db).read()).toEqual(
        disabledState(2, "exact")
      );
    } finally {
      reopened.db.close();
    }
  });

  it("requires explicit verified disablement before profile or Serve selection changes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressStateRepository(open.db);
      repository.compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });

      expect(() =>
        repository.compareAndSet({
          expected_generation: 1,
          state: readyState(2, {
            externalOrigin: otherOrigin,
            selectedProfileKey: otherProfileKey
          })
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_selection_conflict" })
      );

      repository.compareAndSet({
        expected_generation: 1,
        state: disabledState(2, "exact")
      });
      expect(() =>
        repository.compareAndSet({
          expected_generation: 2,
          state: readyState(3, {
            externalOrigin: otherOrigin,
            selectedProfileKey: otherProfileKey
          })
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_selection_conflict" })
      );

      repository.compareAndSet({
        expected_generation: 2,
        state: disabledState(3, "absent")
      });
      const switched = readyState(4, {
        externalOrigin: otherOrigin,
        selectedProfileKey: otherProfileKey
      });
      expect(
        repository.compareAndSet({
          expected_generation: 3,
          state: switched
        }).after
      ).toEqual(switched);
    } finally {
      open.db.close();
    }
  });

  it("preserves update and last-observation chronology", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressStateRepository(open.db);
      repository.compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });
      expect(() =>
        repository.compareAndSet({
          expected_generation: 1,
          state: readyState(2, { timestamp: timestamp(0) })
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_time_conflict" })
      );
      expect(() =>
        repository.compareAndSet({
          expected_generation: 1,
          state: failedObservationState(2)
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_time_conflict" })
      );
      expect(repository.read()).toEqual(readyState(1));
    } finally {
      open.db.close();
    }
  });

  it("persists profile-away, observer failure, and recovery without changing selection", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressStateRepository(open.db);
      repository.compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });
      const away = profileChangedState(2);
      expect(
        repository.compareAndSet({ expected_generation: 1, state: away }).after
      ).toEqual(away);

      const failed = failedObservationState(3, timestamp(2));
      expect(
        repository.compareAndSet({ expected_generation: 2, state: failed }).after
      ).toEqual(failed);
      expect(repository.read()).toMatchObject({
        generation: 3,
        profile: {
          comparison: { expected_profile_key: profileKey }
        },
        observed_at: timestamp(2),
        reason: "command_timeout"
      });

      const recovered = readyState(4);
      expect(
        repository.compareAndSet({
          expected_generation: 3,
          state: recovered
        }).after
      ).toEqual(recovered);
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed and hostile input before mutation without retaining secrets", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createRemoteIngressStateRepository(open.db);
      const stateWithSecret = {
        ...readyState(1),
        raw_output: forbiddenSecret
      };
      const accessor = {
        expected_generation: null,
        state: readyState(1)
      } as Record<string, unknown>;
      Object.defineProperty(accessor, "state", {
        enumerable: true,
        get() {
          throw new Error(forbiddenSecret);
        }
      });
      const hostileProxy = new Proxy(
        { expected_generation: null, state: readyState(1) },
        {
          ownKeys() {
            throw new Error(forbiddenSecret);
          }
        }
      );
      const invalidInputs: unknown[] = [
        null,
        {},
        { expected_generation: 0, state: readyState(1) },
        { expected_generation: null, state: readyState(2) },
        { expected_generation: null, state: stateWithSecret },
        { expected_generation: null, state: readyState(1), extra: true },
        accessor,
        hostileProxy
      ];

      for (const input of invalidInputs) {
        let thrown: unknown;
        try {
          repository.compareAndSet(input as never);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(HostDeckRemoteIngressStateRepositoryError);
        expect(thrown).toMatchObject({ code: "invalid_remote_ingress_state" });
        expect(JSON.stringify(thrown)).not.toContain(forbiddenSecret);
      }
      expect(repository.read()).toBeNull();
    } finally {
      open.db.close();
    }
    expect(readFileSync(path).includes(Buffer.from(forbiddenSecret))).toBe(false);
  });

  it("fails closed for corrupt, read-only, closed, locked, and exhausted state", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    createRemoteIngressStateRepository(first.db).compareAndSet({
      expected_generation: null,
      state: readyState(1)
    });
    const second = openMigratedDatabase(path, { now: fixedNow });
    second.db.pragma("busy_timeout = 1");
    try {
      first.db.exec("BEGIN IMMEDIATE");
      expect(() =>
        createRemoteIngressStateRepository(second.db).compareAndSet({
          expected_generation: 1,
          state: disabledState(2, "exact")
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_unavailable" })
      );
      first.db.exec("ROLLBACK");
    } finally {
      if (first.db.inTransaction) first.db.exec("ROLLBACK");
      second.db.close();
      first.db.close();
    }

    const readOnly = new Database(path, { readonly: true });
    try {
      expect(() =>
        createRemoteIngressStateRepository(readOnly).compareAndSet({
          expected_generation: 1,
          state: disabledState(2, "exact")
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_unavailable" })
      );
    } finally {
      readOnly.close();
    }

    const closed = new Database(path);
    const closedRepository = createRemoteIngressStateRepository(closed);
    closed.close();
    expect(() => closedRepository.read()).toThrowError(
      expect.objectContaining({ code: "remote_ingress_unavailable" })
    );

    const corrupt = new Database(path);
    try {
      corrupt.exec("DROP TRIGGER selected_remote_ingress_generation_step");
      corrupt.pragma("ignore_check_constraints = ON");
      corrupt
        .prepare(
          "UPDATE selected_remote_ingress_state SET generation = 2, profile_state = 'other'"
        )
        .run();
      corrupt.pragma("ignore_check_constraints = OFF");
      expect(() => createRemoteIngressStateRepository(corrupt).read()).toThrowError(
        expect.objectContaining({ code: "invalid_persisted_remote_ingress_state" })
      );
    } finally {
      corrupt.close();
    }

    const exhaustedPath = tempDbPath();
    const exhausted = openMigratedDatabase(exhaustedPath, { now: fixedNow });
    try {
      const repository = createRemoteIngressStateRepository(exhausted.db);
      repository.compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });
      exhausted.db.exec("DROP TRIGGER selected_remote_ingress_generation_step");
      exhausted.db
        .prepare("UPDATE selected_remote_ingress_state SET generation = ?")
        .run(Number.MAX_SAFE_INTEGER);
      expect(() =>
        repository.compareAndSet({
          expected_generation: Number.MAX_SAFE_INTEGER,
          state: readyState(Number.MAX_SAFE_INTEGER)
        })
      ).toThrowError(
        expect.objectContaining({ code: "remote_ingress_generation_exhausted" })
      );
    } finally {
      exhausted.db.close();
    }
  });

  it("enforces generation and durable-disable rules in SQLite", () => {
    const initialPath = tempDbPath();
    const initial = openMigratedDatabase(initialPath, { now: fixedNow });
    try {
      const columns = readyStateRow(readyState(2));
      expect(() =>
        initial.db
          .prepare(
            `
              INSERT INTO selected_remote_ingress_state (
                id, schema_version, generation, intent, availability, admission,
                observation, client, profile_state, profile_relation,
                expected_profile_key, active_profile_key, serve_state,
                expected_external_origin, expected_https_port, expected_path,
                expected_proxy_origin, expected_visibility, external_origin,
                operation_failure, unavailable_reason, observed_at, updated_at
              ) VALUES (
                @id, @schema_version, @generation, @intent, @availability,
                @admission, @observation, @client, @profile_state,
                @profile_relation, @expected_profile_key, @active_profile_key,
                @serve_state, @expected_external_origin, @expected_https_port,
                @expected_path, @expected_proxy_origin, @expected_visibility,
                @external_origin, @operation_failure, @unavailable_reason,
                @observed_at, @updated_at
              )
            `
          )
          .run(columns)
      ).toThrow();
    } finally {
      initial.db.close();
    }

    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      createRemoteIngressStateRepository(open.db).compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });
      expect(() =>
        open.db
          .prepare("UPDATE selected_remote_ingress_state SET generation = 3")
          .run()
      ).toThrow();
      expect(() =>
        open.db.prepare("DELETE FROM selected_remote_ingress_state").run()
      ).toThrow();
      expect(
        open.db
          .prepare(
            "SELECT generation, intent, availability, admission FROM selected_remote_ingress_state"
          )
          .get()
      ).toEqual({
        generation: 1,
        intent: "enabled",
        availability: "ready",
        admission: "open"
      });
    } finally {
      open.db.close();
    }
  });

  it("stores only bounded normalized columns and no raw identity or credentials", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    try {
      createRemoteIngressStateRepository(open.db).compareAndSet({
        expected_generation: null,
        state: readyState(1)
      });
      const columns = (
        open.db.prepare("PRAGMA table_info(selected_remote_ingress_state)").all() as Array<{
          readonly name: string;
        }>
      ).map(({ name }) => name);
      const rowText = JSON.stringify(
        open.db.prepare("SELECT * FROM selected_remote_ingress_state").get()
      );
      for (const forbidden of [
        "account",
        "auth_key",
        "credential",
        "email",
        "login",
        "node_key",
        "pairing",
        "raw_output",
        "secret",
        "tailscale_identity"
      ]) {
        expect(columns).not.toContain(forbidden);
        expect(rowText).not.toContain(forbidden);
      }
      expect(rowText).toContain(origin);
      expect(rowText).toContain(profileKey);
    } finally {
      open.db.close();
    }

    const bytes = readFileSync(path).toString("utf8");
    expect(bytes).toContain(origin);
    expect(bytes).toContain(profileKey);
    expect(bytes).not.toContain(forbiddenSecret);
    expect(bytes).not.toContain("tskey-");
    expect(bytes).not.toContain("node_key");
    expect(bytes).not.toContain("raw_output");
  });
});

interface ReadyStateOptions {
  readonly externalOrigin?: string;
  readonly selectedProfileKey?: string;
  readonly timestamp?: string;
}

function readyState(
  generation: number,
  options: ReadyStateOptions = {}
): RemoteIngressState {
  const externalOrigin = options.externalOrigin ?? origin;
  const selectedProfileKey = options.selectedProfileKey ?? profileKey;
  const at = options.timestamp ?? timestamp(generation);
  return parseState({
    schema_version: 1,
    generation,
    intent: "enabled",
    availability: "ready",
    admission: "open",
    observation: "current",
    client: "available",
    profile: dedicatedProfile(selectedProfileKey),
    serve: "exact",
    expected_serve: serveDescriptor(externalOrigin),
    external_origin: externalOrigin,
    operation_failure: null,
    reason: null,
    observed_at: at,
    updated_at: at
  });
}

function disabledState(
  generation: number,
  serve: "exact" | "absent"
): RemoteIngressState {
  const at = timestamp(generation);
  return parseState({
    ...readyState(generation),
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    serve,
    observed_at: at,
    updated_at: at
  });
}

function failedObservationState(
  generation: number,
  observedAt: string | null = null
): RemoteIngressState {
  return parseState({
    ...readyState(generation),
    availability: "unavailable",
    admission: "closed",
    observation: "failed",
    client: "error",
    profile: {
      state: "unknown",
      comparison: {
        relation: "unknown",
        expected_profile_key: profileKey,
        active_profile_key: null
      }
    },
    serve: null,
    operation_failure: "command_timeout",
    reason: "command_timeout",
    observed_at: observedAt,
    updated_at: timestamp(generation)
  });
}

function profileChangedState(generation: number): RemoteIngressState {
  const at = timestamp(generation);
  return parseState({
    ...readyState(generation),
    availability: "unavailable",
    admission: "closed",
    profile: {
      state: "other",
      comparison: {
        relation: "different",
        expected_profile_key: profileKey,
        active_profile_key: otherProfileKey
      }
    },
    serve: null,
    operation_failure: "profile_changed",
    reason: "profile_changed",
    observed_at: at,
    updated_at: at
  });
}

function dedicatedProfile(selectedProfileKey: string) {
  return {
    state: "dedicated",
    comparison: {
      relation: "match",
      expected_profile_key: selectedProfileKey,
      active_profile_key: selectedProfileKey
    }
  } as const;
}

function serveDescriptor(externalOrigin: string) {
  return {
    external_origin: externalOrigin,
    https_port: 443,
    path: "/",
    proxy_origin: "http://127.0.0.1:3777",
    visibility: "private"
  } as const;
}

function parseState(input: unknown): RemoteIngressState {
  return remoteIngressStateSchema.parse(input);
}

function timestamp(generation: number): string {
  const minute = Math.min(generation, 59);
  return new Date(Date.UTC(2026, 6, 13, 16, minute)).toISOString();
}

function fixedNow(): Date {
  return new Date("2026-07-13T16:00:00.000Z");
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-remote-ingress-"));
  tempDirs.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeepFrozen(child));
}

function readyStateRow(state: RemoteIngressState) {
  return {
    id: "hostdeck_remote_ingress",
    schema_version: state.schema_version,
    generation: state.generation,
    intent: state.intent,
    availability: state.availability,
    admission: state.admission,
    observation: state.observation,
    client: state.client,
    profile_state: state.profile.state,
    profile_relation: state.profile.comparison.relation,
    expected_profile_key: state.profile.comparison.expected_profile_key,
    active_profile_key: state.profile.comparison.active_profile_key,
    serve_state: state.serve,
    expected_external_origin: state.expected_serve?.external_origin ?? null,
    expected_https_port: state.expected_serve?.https_port ?? null,
    expected_path: state.expected_serve?.path ?? null,
    expected_proxy_origin: state.expected_serve?.proxy_origin ?? null,
    expected_visibility: state.expected_serve?.visibility ?? null,
    external_origin: state.external_origin,
    operation_failure: state.operation_failure,
    unavailable_reason: state.reason,
    observed_at: state.observed_at,
    updated_at: state.updated_at
  };
}
