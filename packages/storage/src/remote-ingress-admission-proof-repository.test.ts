import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RemoteIngressAdmissionProof,
  type RemoteIngressState,
  remoteIngressAdmissionProofSchema,
  remoteIngressStateSchema
} from "@hostdeck/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import { defaultMigrations } from "./migrations.js";
import {
  assertRemoteIngressAdmissionProofRepository,
  createRemoteIngressAdmissionProofRepository,
  HostDeckRemoteIngressAdmissionProofRepositoryError
} from "./remote-ingress-admission-proof-repository.js";
import { createRemoteIngressStateRepository } from "./remote-ingress-state-repository.js";
import { createSelectedAuditRepository } from "./selected-audit-repository.js";

const tempDirs: string[] = [];
const origin = "https://hostdeck-proof.fixture-tailnet.ts.net";
const profileKey = `sha256:${"1".repeat(64)}`;
const acceptedAt = "2026-07-13T18:00:00.000Z";
const stateAt = "2026-07-13T18:00:01.000Z";
const terminalAt = "2026-07-13T18:00:02.000Z";
const provenAt = "2026-07-13T18:00:03.000Z";
const operationId = "op_remote_admission_proof_001";

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("remote admission proof migration", () => {
  it("adds one empty proof row owner and atomic accepted-mutation invalidation trigger", () => {
    const path = tempDbPath();
    const prior = openMigratedDatabase(path, {
      migrations: defaultMigrations.slice(0, -1),
      now: fixedNow
    });
    prior.db.close();

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([
        "202607130015_remote_admission_proof"
      ]);
      expect(
        migrated.db
          .prepare(
            "SELECT COUNT(*) AS count FROM selected_remote_ingress_admission_proof"
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        migrated.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'selected_remote_ingress_admission_proof_invalidate'"
          )
          .get()
      ).toEqual({
        name: "selected_remote_ingress_admission_proof_invalidate"
      });
    } finally {
      migrated.db.close();
    }
  });
});

describe("remote admission proof repository", () => {
  it("proves, persists, freezes, carries forward, and restarts one successful enable", () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createRemoteIngressAdmissionProofRepository(open.db);
      assertRemoteIngressAdmissionProofRepository(repository);
      expect(repository.read()).toBeNull();
      seedReadyEnable(open.db, 1, stateAt, operationId);

      const first = repository.prove(proof(1, provenAt));
      expect(first).toEqual({ before: null, after: proof(1, provenAt) });
      expect(isDeepFrozen(first)).toBe(true);
      expect(isDeepFrozen(repository.read())).toBe(true);

      createRemoteIngressStateRepository(open.db).compareAndSet({
        expected_generation: 1,
        state: readyState(2, "2026-07-13T18:00:04.000Z")
      });
      const carried = repository.prove(
        proof(2, "2026-07-13T18:00:05.000Z")
      );
      expect(carried.before).toEqual(proof(1, provenAt));
      expect(carried.after.generation).toBe(2);
      expect(() =>
        assertRemoteIngressAdmissionProofRepository({ ...repository })
      ).toThrow(TypeError);
    } finally {
      open.db.close();
    }

    const restarted = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(
        createRemoteIngressAdmissionProofRepository(restarted.db).read()
      ).toEqual(proof(2, "2026-07-13T18:00:05.000Z"));
    } finally {
      restarted.db.close();
    }
  });

  it("invalidates proof in the accepted audit insertion transaction", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const proofRepository = createRemoteIngressAdmissionProofRepository(
        open.db
      );
      seedReadyEnable(open.db, 1, stateAt, operationId);
      proofRepository.prove(proof(1, provenAt));

      createSelectedAuditRepository(open.db).recordAccepted(
        acceptedRecord(
          "remote_disable",
          "op_remote_admission_disable_002",
          "2026-07-13T18:00:04.000Z",
          {
            schema_version: 1,
            action: "remote_disable",
            requested_intent: "disabled",
            profile_state: "other",
            serve_state: null,
            phase: "accepted",
            outcome: "accepted"
          }
        )
      );
      expect(proofRepository.read()).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("rejects missing, pending, failed, stale-generation, regressing, and superseded evidence", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressAdmissionProofRepository(open.db);
      expect(() => repository.prove(proof(1, provenAt))).toThrowError(
        expect.objectContaining({ code: "admission_proof_state_unproven" })
      );

      createRemoteIngressStateRepository(open.db).compareAndSet({
        expected_generation: null,
        state: readyState(1, stateAt)
      });
      createSelectedAuditRepository(open.db).recordAccepted(
        acceptedRecord("remote_enable", operationId, acceptedAt, {
          schema_version: 1,
          action: "remote_enable",
          requested_intent: "enabled",
          profile_state: "dedicated",
          serve_state: "absent",
          phase: "accepted",
          outcome: "accepted"
        })
      );
      expect(() => repository.prove(proof(1, provenAt))).toThrowError(
        expect.objectContaining({ code: "admission_proof_audit_unproven" })
      );

      createSelectedAuditRepository(open.db).recordTerminal(
        terminalEnableRecord(operationId, terminalAt, "failed")
      );
      expect(() => repository.prove(proof(1, provenAt))).toThrowError(
        expect.objectContaining({ code: "admission_proof_audit_unproven" })
      );
    } finally {
      open.db.close();
    }

    const valid = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressAdmissionProofRepository(valid.db);
      seedReadyEnable(valid.db, 1, stateAt, operationId);
      expect(() => repository.prove(proof(2, provenAt))).toThrowError(
        expect.objectContaining({ code: "admission_proof_state_unproven" })
      );
      expect(() =>
        repository.prove(proof(1, "2026-07-13T18:00:00.500Z"))
      ).toThrowError(
        expect.objectContaining({ code: "admission_proof_time_conflict" })
      );
      repository.prove(proof(1, provenAt));
      expect(() =>
        repository.prove(proof(1, provenAt, "op_other_12345678"))
      ).toThrowError(
        expect.objectContaining({ code: "admission_proof_conflict" })
      );
    } finally {
      valid.db.close();
    }
  });

  it("rejects a stale two-handle generation and corrupt or read-only storage without leaking rows", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      seedReadyEnable(first.db, 1, stateAt, operationId);
      const firstProof = createRemoteIngressAdmissionProofRepository(first.db);
      const secondProof = createRemoteIngressAdmissionProofRepository(second.db);
      firstProof.prove(proof(1, provenAt));
      createRemoteIngressStateRepository(first.db).compareAndSet({
        expected_generation: 1,
        state: readyState(2, "2026-07-13T18:00:04.000Z")
      });
      firstProof.prove(proof(2, "2026-07-13T18:00:05.000Z"));
      expect(() => secondProof.prove(proof(1, provenAt))).toThrowError(
        expect.objectContaining({ code: "admission_proof_conflict" })
      );
      const persistedProof = first.db
        .prepare("SELECT * FROM selected_remote_ingress_admission_proof")
        .get();
      expect(persistedProof).toEqual({
        id: "hostdeck_remote_ingress_admission",
        schema_version: 1,
        operation_id: operationId,
        state_generation: 2,
        proven_at: "2026-07-13T18:00:05.000Z"
      });
      const serializedProof = JSON.stringify(persistedProof);
      expect(serializedProof).not.toContain(profileKey);
      expect(serializedProof).not.toContain(origin);
    } finally {
      second.db.close();
      first.db.close();
    }

    const corrupt = new Database(path);
    try {
      corrupt.pragma("ignore_check_constraints = ON");
      corrupt
        .prepare(
          "UPDATE selected_remote_ingress_admission_proof SET proven_at = 'bad'"
        )
        .run();
    } finally {
      corrupt.close();
    }
    const reopened = new Database(path, { readonly: true });
    try {
      const repository = createRemoteIngressAdmissionProofRepository(reopened);
      expect(() => repository.read()).toThrowError(
        expect.objectContaining({ code: "invalid_persisted_admission_proof" })
      );
      expect(() => repository.prove(proof(2, provenAt))).toThrowError(
        expect.objectContaining({ code: "admission_proof_unavailable" })
      );
    } finally {
      reopened.close();
    }
  });

  it("rejects malformed public proof input with one sanitized repository error", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createRemoteIngressAdmissionProofRepository(open.db);
      for (const candidate of [
        null,
        { ...proof(1, provenAt), generation: 0 },
        { ...proof(1, provenAt), extra: true },
        { ...proof(1, provenAt), operation_id: "secret" }
      ]) {
        expect(() =>
          repository.prove(candidate as never)
        ).toThrow(HostDeckRemoteIngressAdmissionProofRepositoryError);
      }
    } finally {
      open.db.close();
    }
  });
});

function seedReadyEnable(
  db: Database.Database,
  generation: number,
  updatedAt: string,
  currentOperationId: string
): void {
  createRemoteIngressStateRepository(db).compareAndSet({
    expected_generation: null,
    state: readyState(generation, updatedAt)
  });
  const audits = createSelectedAuditRepository(db);
  audits.recordAccepted(
    acceptedRecord("remote_enable", currentOperationId, acceptedAt, {
      schema_version: 1,
      action: "remote_enable",
      requested_intent: "enabled",
      profile_state: "dedicated",
      serve_state: "absent",
      phase: "accepted",
      outcome: "accepted"
    })
  );
  audits.recordTerminal(
    terminalEnableRecord(currentOperationId, terminalAt, "succeeded")
  );
}

function acceptedRecord(
  action: "remote_disable" | "remote_enable",
  currentOperationId: string,
  at: string,
  payloadSummary: Readonly<Record<string, unknown>>
) {
  return {
    id: `audit:${currentOperationId}:${action}:accepted`,
    operation_id: currentOperationId,
    at,
    actor: cliActor(),
    action,
    target: hostTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: payloadSummary,
    error_code: null
  } as const;
}

function terminalEnableRecord(
  currentOperationId: string,
  at: string,
  outcome: "failed" | "succeeded"
) {
  const succeeded = outcome === "succeeded";
  return {
    id: `audit:${currentOperationId}:remote_enable:terminal`,
    operation_id: currentOperationId,
    at,
    actor: cliActor(),
    action: "remote_enable",
    target: hostTarget(),
    phase: "terminal",
    outcome,
    payload_summary: {
      schema_version: 1,
      action: "remote_enable",
      requested_intent: "enabled",
      profile_state: "dedicated",
      serve_state: succeeded ? "exact" : "absent",
      phase: "terminal",
      outcome,
      admission: "closed",
      intent_persisted: true,
      serve_result: succeeded ? "applied" : "unchanged",
      reason: succeeded ? null : "command_failed",
      ...(succeeded ? { admission: "open" } : {})
    },
    error_code: succeeded ? null : "runtime_unavailable"
  } as const;
}

function readyState(generation: number, at: string): RemoteIngressState {
  return remoteIngressStateSchema.parse({
    schema_version: 1,
    generation,
    intent: "enabled",
    availability: "ready",
    admission: "open",
    observation: "current",
    client: "available",
    profile: {
      state: "dedicated",
      comparison: {
        relation: "match",
        expected_profile_key: profileKey,
        active_profile_key: profileKey
      }
    },
    serve: "exact",
    expected_serve: {
      external_origin: origin,
      https_port: 443,
      path: "/",
      proxy_origin: "http://127.0.0.1:3777",
      visibility: "private"
    },
    external_origin: origin,
    operation_failure: null,
    reason: null,
    observed_at: at,
    updated_at: at
  });
}

function proof(
  generation: number,
  at: string,
  currentOperationId: string = operationId
): RemoteIngressAdmissionProof {
  return remoteIngressAdmissionProofSchema.parse({
    schema_version: 1,
    operation_id: currentOperationId,
    generation,
    proven_at: at
  });
}

function cliActor() {
  return {
    type: "cli",
    device_id: null,
    permission: "local_admin",
    origin: null
  } as const;
}

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-remote-proof-"));
  tempDirs.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-13T17:59:00.000Z");
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}
