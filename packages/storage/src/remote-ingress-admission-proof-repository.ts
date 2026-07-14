import { isDeepStrictEqual } from "node:util";
import {
  type RemoteIngressAdmissionProof,
  remoteIngressAdmissionProofSchema,
  remoteIngressAuditSummarySchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { createRemoteIngressStateRepository } from "./remote-ingress-state-repository.js";
import { createSelectedAuditRepository } from "./selected-audit-repository.js";

export const hostDeckRemoteIngressAdmissionProofId =
  "hostdeck_remote_ingress_admission";

export type RemoteIngressAdmissionProofRepositoryErrorCode =
  | "invalid_admission_proof"
  | "invalid_persisted_admission_proof"
  | "admission_proof_conflict"
  | "admission_proof_state_unproven"
  | "admission_proof_audit_unproven"
  | "admission_proof_time_conflict"
  | "admission_proof_unavailable";

export class HostDeckRemoteIngressAdmissionProofRepositoryError extends Error {
  constructor(
    readonly code: RemoteIngressAdmissionProofRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HostDeckRemoteIngressAdmissionProofRepositoryError";
  }
}

export interface RemoteIngressAdmissionProofWriteReceipt {
  readonly before: RemoteIngressAdmissionProof | null;
  readonly after: RemoteIngressAdmissionProof;
}

export interface RemoteIngressAdmissionProofRepository {
  readonly read: () => RemoteIngressAdmissionProof | null;
  readonly prove: (
    proof: RemoteIngressAdmissionProof
  ) => RemoteIngressAdmissionProofWriteReceipt;
}

interface ProofRow {
  readonly id: unknown;
  readonly schema_version: unknown;
  readonly operation_id: unknown;
  readonly state_generation: unknown;
  readonly proven_at: unknown;
}

interface LatestRemoteAuditRow {
  readonly operation_id: unknown;
  readonly phase: unknown;
  readonly outcome: unknown;
}

const acceptedRepositories = new WeakSet<object>();

export function createRemoteIngressAdmissionProofRepository(
  db: Database.Database
): RemoteIngressAdmissionProofRepository {
  const states = createRemoteIngressStateRepository(db);
  const audits = createSelectedAuditRepository(db);
  const proveTransaction = db.transaction(
    (
      proof: RemoteIngressAdmissionProof
    ): RemoteIngressAdmissionProofWriteReceipt => {
      const before = readProof(db);
      assertProofProgression(before, proof);
      const state = states.read();
      if (
        state === null ||
        state.generation !== proof.generation ||
        state.intent !== "enabled" ||
        state.availability !== "ready" ||
        state.admission !== "open" ||
        state.observation !== "current" ||
        state.client !== "available" ||
        state.profile.state !== "dedicated" ||
        state.serve !== "exact" ||
        state.external_origin === null ||
        state.operation_failure !== null ||
        state.reason !== null
      ) {
        throw proofError(
          "admission_proof_state_unproven",
          "Remote admission proof requires one exact ready state generation."
        );
      }

      const trail = audits.get(proof.operation_id);
      const terminal = trail?.records[1];
      if (
        trail === null ||
        trail.state !== "terminal" ||
        terminal === undefined ||
        terminal.action !== "remote_enable" ||
        terminal.phase !== "terminal" ||
        terminal.outcome !== "succeeded" ||
        terminal.error_code !== null
      ) {
        throw proofError(
          "admission_proof_audit_unproven",
          "Remote admission proof requires one successful terminal enable audit."
        );
      }
      const summary = remoteIngressAuditSummarySchema.safeParse(
        terminal.payload_summary
      );
      const latest = readLatestRemoteAudit(db);
      if (
        !summary.success ||
        summary.data.action !== "remote_enable" ||
        summary.data.phase !== "terminal" ||
        summary.data.outcome !== "succeeded" ||
        latest === null ||
        latest.operation_id !== proof.operation_id ||
        latest.phase !== "terminal" ||
        latest.outcome !== "succeeded"
      ) {
        throw proofError(
          "admission_proof_audit_unproven",
          "Remote admission proof audit is not the current terminal operation."
        );
      }
      if (
        Date.parse(proof.proven_at) < Date.parse(state.updated_at) ||
        Date.parse(proof.proven_at) < Date.parse(terminal.at) ||
        (before !== null &&
          Date.parse(proof.proven_at) < Date.parse(before.proven_at))
      ) {
        throw proofError(
          "admission_proof_time_conflict",
          "Remote admission proof cannot precede its state or audit evidence."
        );
      }

      db.prepare(
        `
          INSERT INTO selected_remote_ingress_admission_proof (
            id, schema_version, operation_id, state_generation, proven_at
          ) VALUES (
            @id, @schema_version, @operation_id, @state_generation, @proven_at
          )
          ON CONFLICT(id) DO UPDATE SET
            schema_version = excluded.schema_version,
            operation_id = excluded.operation_id,
            state_generation = excluded.state_generation,
            proven_at = excluded.proven_at
        `
      ).run({
        id: hostDeckRemoteIngressAdmissionProofId,
        schema_version: proof.schema_version,
        operation_id: proof.operation_id,
        state_generation: proof.generation,
        proven_at: proof.proven_at
      });
      const after = readProof(db);
      if (after === null || !isDeepStrictEqual(after, proof)) {
        throw proofError(
          "admission_proof_conflict",
          "Remote admission proof did not commit exactly."
        );
      }
      return deepFreeze({ before, after });
    }
  ).immediate;

  const repository: RemoteIngressAdmissionProofRepository = Object.freeze({
    read() {
      try {
        return readProof(db);
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    prove(candidate: RemoteIngressAdmissionProof) {
      ensureWritable(db);
      const parsed = remoteIngressAdmissionProofSchema.safeParse(candidate);
      if (!parsed.success) throw invalidProof();
      try {
        return proveTransaction(deepFreeze(parsed.data));
      } catch (error) {
        throw sanitizeError(error);
      }
    }
  });
  acceptedRepositories.add(repository);
  return repository;
}

export function assertRemoteIngressAdmissionProofRepository(
  candidate: unknown
): asserts candidate is RemoteIngressAdmissionProofRepository {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedRepositories.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "Remote admission proof repository must be created by createRemoteIngressAdmissionProofRepository."
    );
  }
}

function readProof(
  db: Database.Database
): RemoteIngressAdmissionProof | null {
  const row = db
    .prepare(
      `
        SELECT id, schema_version, operation_id, state_generation, proven_at
        FROM selected_remote_ingress_admission_proof
        WHERE id = 'hostdeck_remote_ingress_admission'
      `
    )
    .get() as ProofRow | undefined;
  if (row === undefined) return null;
  const result = remoteIngressAdmissionProofSchema.safeParse({
    schema_version: row.schema_version,
    operation_id: row.operation_id,
    generation: row.state_generation,
    proven_at: row.proven_at
  });
  if (
    row.id !== hostDeckRemoteIngressAdmissionProofId ||
    !result.success
  ) {
    throw proofError(
      "invalid_persisted_admission_proof",
      "Persisted remote admission proof is invalid."
    );
  }
  return deepFreeze(result.data);
}

function readLatestRemoteAudit(
  db: Database.Database
): {
  readonly operation_id: string;
  readonly phase: "accepted" | "terminal";
  readonly outcome: "accepted" | "failed" | "incomplete" | "rejected" | "succeeded";
} | null {
  const outcomes = [
    "accepted",
    "failed",
    "incomplete",
    "rejected",
    "succeeded"
  ] as const;
  const row = db
    .prepare(
      `
        SELECT operation_id, phase, outcome
        FROM selected_audit_events
        WHERE action IN ('remote_enable', 'remote_disable')
        ORDER BY rowid DESC
        LIMIT 1
      `
    )
    .get() as LatestRemoteAuditRow | undefined;
  if (row === undefined) return null;
  if (
    typeof row.operation_id !== "string" ||
    (row.phase !== "accepted" && row.phase !== "terminal") ||
    typeof row.outcome !== "string" ||
    !(outcomes as readonly string[]).includes(row.outcome)
  ) {
    throw proofError(
      "admission_proof_audit_unproven",
      "Latest remote audit evidence is invalid."
    );
  }
  return Object.freeze({
    operation_id: row.operation_id,
    phase: row.phase,
    outcome: row.outcome as (typeof outcomes)[number]
  });
}

function assertProofProgression(
  before: RemoteIngressAdmissionProof | null,
  after: RemoteIngressAdmissionProof
): void {
  if (before === null) return;
  if (
    before.operation_id !== after.operation_id ||
    after.generation < before.generation
  ) {
    throw proofError(
      "admission_proof_conflict",
      "Remote admission proof cannot change operation or regress generation."
    );
  }
}

function ensureWritable(db: Database.Database): void {
  if (!db.open || db.readonly) {
    throw proofError(
      "admission_proof_unavailable",
      "Remote admission proof storage is unavailable."
    );
  }
}

function invalidProof(): HostDeckRemoteIngressAdmissionProofRepositoryError {
  return proofError(
    "invalid_admission_proof",
    "Remote admission proof input is invalid."
  );
}

function sanitizeError(
  error: unknown
): HostDeckRemoteIngressAdmissionProofRepositoryError {
  if (error instanceof HostDeckRemoteIngressAdmissionProofRepositoryError) {
    return error;
  }
  return proofError(
    "admission_proof_unavailable",
    "Remote admission proof storage is unavailable."
  );
}

function proofError(
  code: RemoteIngressAdmissionProofRepositoryErrorCode,
  message: string
): HostDeckRemoteIngressAdmissionProofRepositoryError {
  return new HostDeckRemoteIngressAdmissionProofRepositoryError(code, message);
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
