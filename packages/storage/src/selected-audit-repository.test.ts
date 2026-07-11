import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { selectedAuditEventRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  type SelectedAuditRepositoryErrorCode
} from "./selected-audit-repository.js";

const tempDirs: string[] = [];
const acceptedAt = "2026-07-10T18:00:00.000Z";
const terminalAt = "2026-07-10T18:01:00.000Z";
const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve("better-sqlite3");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("selected audit repository", () => {
  it("persists one accepted record followed by one successful terminal record", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_audit_success01";
      const accepted = repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:success:accepted" }));
      const acceptedJson = rawRecordJson(open.db, "audit:success:accepted");

      expect(accepted).toMatchObject({ operation_id: operationId, state: "pending" });
      expect(accepted.records).toHaveLength(1);
      expect(repository.get(operationId)).toEqual(accepted);

      const terminal = repository.recordTerminal(
        terminalRecord(operationId, "audit:success:terminal", "succeeded", null, {
          payload_summary: { result: "turn_started" }
        })
      );

      expect(terminal.state).toBe("terminal");
      expect(terminal.records.map((record) => record.outcome)).toEqual(["accepted", "succeeded"]);
      expect(repository.require(operationId)).toEqual(terminal);
      expect(rawRows(open.db, operationId)).toHaveLength(2);
      expect(rawRecordJson(open.db, "audit:success:accepted")).toBe(acceptedJson);
    } finally {
      open.db.close();
    }
  });

  it("records a standalone pre-dispatch rejection and forbids a later dispatch", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_audit_rejected01";
      const rejected = repository.recordRejected(
        terminalRecord(operationId, "audit:rejected:terminal", "rejected", "validation_error")
      );

      expect(rejected.state).toBe("terminal");
      expect(rejected.records.map((record) => record.outcome)).toEqual(["rejected"]);
      expectAuditError(
        () => repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:rejected:late-accepted" })),
        "audit_operation_exists"
      );
      expectAuditError(
        () => repository.recordTerminal(terminalRecord(operationId, "audit:rejected:late-terminal", "failed", "runtime_unavailable")),
        "audit_operation_terminal"
      );
      expect(rawRows(open.db, operationId)).toHaveLength(1);
    } finally {
      open.db.close();
    }
  });

  it("persists every selected audit action with its required exact target type", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const actionTargets = [
        ["prompt", auditTarget()],
        ["model", auditTarget()],
        ["goal", auditTarget()],
        ["plan", auditTarget()],
        ["usage", auditTarget()],
        ["compact", auditTarget()],
        ["skills", auditTarget()],
        ["archive", auditTarget()],
        [
          "approval_response",
          {
            type: "approval",
            session_id: auditTarget().session_id,
            codex_thread_id: auditTarget().codex_thread_id,
            request_id: "approval:audit:1"
          }
        ],
        [
          "interrupt",
          {
            type: "turn",
            session_id: auditTarget().session_id,
            codex_thread_id: auditTarget().codex_thread_id,
            turn_id: "turn-audit-1"
          }
        ],
        ["pair_request", hostTarget()],
        ["pair_claim", hostTarget()],
        ["device_revoke", { type: "device", device_id: "device:audit:revoked" }],
        ["lock", hostTarget()],
        ["unlock", hostTarget()],
        ["lan_configure", hostTarget()],
        ["lan_enable", hostTarget()],
        ["lan_disable", hostTarget()],
        ["certificate_rotate", hostTarget()]
      ] as const;

      for (const [index, [action, target]] of actionTargets.entries()) {
        const operationId = `op_audit_action_${String(index).padStart(2, "0")}`;
        const trail = repository.recordRejected(
          terminalRecord(operationId, `audit:action:${index}`, "rejected", "validation_error", { action, target })
        );
        expect(trail.records[0]).toMatchObject({ action, target });
      }

      expect(open.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 19 });
    } finally {
      open.db.close();
    }
  });

  it("preserves explicit failed and incomplete terminal causes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const cases = [
        ["op_audit_failed01", "failed", "runtime_unavailable"],
        ["op_audit_incomplete01", "incomplete", "operation_timeout"]
      ] as const;

      for (const [operationId, outcome, errorCode] of cases) {
        repository.recordAccepted(auditRecord({ operation_id: operationId, id: `audit:${outcome}:accepted` }));
        const trail = repository.recordTerminal(
          terminalRecord(operationId, `audit:${outcome}:terminal`, outcome, errorCode)
        );
        expect(trail.records[1]).toMatchObject({ outcome, error_code: errorCode });
      }
    } finally {
      open.db.close();
    }
  });

  it("rejects missing, duplicate, conflicting, and reused operation phases", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_audit_transition01";

      expectAuditError(
        () => repository.recordTerminal(terminalRecord(operationId, "audit:transition:early", "succeeded", null)),
        "audit_operation_not_found"
      );
      repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:transition:accepted" }));
      expectAuditError(
        () => repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:transition:duplicate" })),
        "audit_operation_exists"
      );

      repository.recordTerminal(terminalRecord(operationId, "audit:transition:terminal", "succeeded", null));
      expectAuditError(
        () => repository.recordTerminal(terminalRecord(operationId, "audit:transition:conflict", "failed", "runtime_unavailable")),
        "audit_operation_terminal"
      );

      expectAuditError(
        () =>
          repository.recordAccepted(
            auditRecord({ operation_id: "op_audit_recordreuse1", id: "audit:transition:accepted" })
          ),
        "audit_record_exists"
      );
      expectAuditError(() => repository.require("op_audit_missing01"), "audit_operation_not_found");
      expectAuditError(() => repository.get("not-an-operation-id"), "invalid_audit_operation_id");
    } finally {
      open.db.close();
    }
  });

  it("enforces actor, action, target, record-id, and instant continuity before terminal insert", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_audit_continuity1";
      const acceptedId = "audit:continuity:accepted";
      repository.recordAccepted(auditRecord({ operation_id: operationId, id: acceptedId }));

      const conflicts = [
        terminalRecord(operationId, "audit:continuity:actor", "succeeded", null, {
          actor: { ...auditActor(), device_id: "device:audit:other" }
        }),
        terminalRecord(operationId, "audit:continuity:action", "succeeded", null, { action: "archive" }),
        terminalRecord(operationId, "audit:continuity:target", "succeeded", null, {
          target: { ...auditTarget(), codex_thread_id: "thread-audit-other" }
        }),
        terminalRecord(operationId, acceptedId, "succeeded", null),
        terminalRecord(operationId, "audit:continuity:time", "succeeded", null, {
          at: "2026-07-10T19:59:59.999+02:00"
        })
      ];

      for (const conflict of conflicts) {
        expectAuditError(() => repository.recordTerminal(conflict), "audit_operation_conflict");
        expect(repository.require(operationId).state).toBe("pending");
      }

      const terminal = repository.recordTerminal(
        terminalRecord(operationId, "audit:continuity:terminal", "succeeded", null, {
          at: "2026-07-10T14:01:00.000-04:00"
        })
      );
      expect(terminal.state).toBe("terminal");
    } finally {
      open.db.close();
    }
  });

  it("rejects unknown actions, unsafe payloads, incoherent errors, and method misuse before write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const candidates = [
        auditRecord({ action: "unknown_action" }),
        auditRecord({ payload_summary: { auth_token: "secret" } }),
        auditRecord({ payload_summary: { preview: "x".repeat(257) } }),
        auditRecord({ error_code: "runtime_unavailable" })
      ];

      for (const candidate of candidates) {
        expectAuditError(() => repository.recordAccepted(candidate), "invalid_audit_record");
      }
      expectAuditError(
        () => repository.recordAccepted(terminalRecord("op_audit_misuse01", "audit:misuse:terminal", "succeeded", null)),
        "invalid_audit_record"
      );
      expectAuditError(
        () => repository.recordRejected(auditRecord({ operation_id: "op_audit_misuse02", id: "audit:misuse:accepted" })),
        "invalid_audit_record"
      );
      expectAuditError(
        () => repository.recordTerminal(terminalRecord("op_audit_misuse03", "audit:misuse:rejected", "rejected", "validation_error")),
        "invalid_audit_record"
      );
      expect(open.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get()).toEqual({ count: 0 });
    } finally {
      open.db.close();
    }
  });

  it("survives restart as pending, forbids accepted-row rewrites, and later appends incomplete", () => {
    const path = tempDbPath();
    const operationId = "op_audit_restart01";
    const acceptedId = "audit:restart:accepted";
    const first = openMigratedDatabase(path, { now: fixedNow });
    let acceptedJson: string;
    try {
      createSelectedAuditRepository(first.db).recordAccepted(auditRecord({ operation_id: operationId, id: acceptedId }));
      acceptedJson = rawRecordJson(first.db, acceptedId);
    } finally {
      first.db.close();
    }

    const second = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(second.db);
      expect(repository.require(operationId).state).toBe("pending");
      expect(() =>
        second.db.prepare("UPDATE selected_audit_events SET outcome = 'succeeded' WHERE id = ?").run(acceptedId)
      ).toThrow("selected audit events are append-only");

      const trail = repository.recordTerminal(
        terminalRecord(operationId, "audit:restart:incomplete", "incomplete", "runtime_unavailable")
      );
      expect(trail.records.map((record) => record.outcome)).toEqual(["accepted", "incomplete"]);
      expect(rawRecordJson(second.db, acceptedId)).toBe(acceptedJson);
    } finally {
      second.db.close();
    }
  });

  it("serializes truly concurrent two-connection accepted and terminal contenders to one winner", async () => {
    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    try {
      open.db.pragma("busy_timeout = 2000");
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_audit_race0001";
      const acceptedWinner = startConcurrentRawInsert(
        path,
        auditRecord({ operation_id: operationId, id: "audit:race:accepted-winner" })
      );
      await acceptedWinner.inserted;
      expectAuditError(
        () => repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:race:accepted-loser" })),
        "audit_operation_exists"
      );
      await acceptedWinner.completed;

      expect(repository.require(operationId).state).toBe("pending");
      const terminalWinner = startConcurrentRawInsert(
        path,
        terminalRecord(operationId, "audit:race:terminal-winner", "succeeded", null)
      );
      await terminalWinner.inserted;
      expectAuditError(
        () =>
          repository.recordTerminal(
            terminalRecord(operationId, "audit:race:terminal-loser", "failed", "runtime_unavailable")
          ),
        "audit_operation_terminal"
      );
      await terminalWinner.completed;

      const trail = repository.require(operationId);
      expect(trail.state).toBe("terminal");
      expect(trail.records).toHaveLength(2);
      expect(rawRows(open.db, operationId)).toHaveLength(2);
    } finally {
      open.db.close();
    }
  });

  it("rolls back forced accepted and terminal insert failures without partial truth", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedAuditRepository(open.db);
      const operationId = "op_audit_rollback01";
      installForcedFailure(open.db, "audit:rollback:accepted");
      expectAuditError(
        () => repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:rollback:accepted" })),
        "audit_write_failed"
      );
      expect(repository.get(operationId)).toBeNull();

      open.db.exec("DROP TRIGGER force_selected_audit_failure");
      repository.recordAccepted(auditRecord({ operation_id: operationId, id: "audit:rollback:accepted" }));
      installForcedFailure(open.db, "audit:rollback:terminal");
      expectAuditError(
        () => repository.recordTerminal(terminalRecord(operationId, "audit:rollback:terminal", "succeeded", null)),
        "audit_write_failed"
      );
      expect(repository.require(operationId)).toMatchObject({ state: "pending" });
      expect(rawRows(open.db, operationId)).toHaveLength(1);

      open.db.exec("DROP TRIGGER force_selected_audit_failure");
      expect(repository.recordTerminal(terminalRecord(operationId, "audit:rollback:terminal", "succeeded", null)).state).toBe(
        "terminal"
      );
    } finally {
      open.db.close();
    }
  });

  it("rejects direct illegal transitions and fails loudly on contradictory persisted JSON", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const earlyTerminal = terminalRecord("op_audit_rawearly1", "audit:raw:early", "succeeded", null);
      expect(() => insertRawRecord(open.db, earlyTerminal)).toThrow("selected audit terminal requires accepted");

      const rejectedOperationId = "op_audit_rawreject1";
      insertRawRecord(
        open.db,
        terminalRecord(rejectedOperationId, "audit:raw:rejected", "rejected", "validation_error")
      );
      expect(() =>
        insertRawRecord(
          open.db,
          auditRecord({ operation_id: rejectedOperationId, id: "audit:raw:accepted-after-rejected" })
        )
      ).toThrow("selected audit operation already has a trail");

      const operationId = "op_audit_corrupt01";
      const columns = auditRecord({ operation_id: operationId, id: "audit:corrupt:columns" });
      const contradictoryJson = auditRecord({ operation_id: "op_audit_corrupt02", id: "audit:corrupt:json" });
      insertRawRecord(open.db, columns, contradictoryJson);

      expectAuditError(() => createSelectedAuditRepository(open.db).require(operationId), "invalid_audit_trail");

      const conflictingOperationId = "op_audit_corrupt03";
      insertRawRecord(
        open.db,
        auditRecord({ operation_id: conflictingOperationId, id: "audit:corrupt:accepted" })
      );
      insertRawRecord(
        open.db,
        terminalRecord(conflictingOperationId, "audit:corrupt:terminal", "succeeded", null, {
          actor: { ...auditActor(), origin: "https://other-hostdeck.local" }
        })
      );
      expectAuditError(() => createSelectedAuditRepository(open.db).require(conflictingOperationId), "invalid_audit_trail");
    } finally {
      open.db.close();
    }
  });

  it("reports closed selected audit storage as unavailable", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    const repository = createSelectedAuditRepository(open.db);
    open.db.close();

    expectAuditError(() => repository.get("op_audit_closed001"), "audit_unavailable");
    expectAuditError(
      () => repository.recordAccepted(auditRecord({ operation_id: "op_audit_closed002", id: "audit:closed:accepted" })),
      "audit_unavailable"
    );
  });
});

function auditRecord(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "audit:selected:accepted",
    operation_id: "op_audit_default01",
    at: acceptedAt,
    actor: auditActor(),
    action: "prompt",
    target: auditTarget(),
    phase: "accepted",
    outcome: "accepted",
    payload_summary: { text_length: 8, source: "dashboard" },
    error_code: null,
    ...overrides
  };
}

function terminalRecord(
  operationId: string,
  id: string,
  outcome: "failed" | "incomplete" | "rejected" | "succeeded",
  errorCode: string | null,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return auditRecord({
    id,
    operation_id: operationId,
    at: terminalAt,
    phase: "terminal",
    outcome,
    error_code: errorCode,
    payload_summary: { result: outcome },
    ...overrides
  });
}

function auditActor() {
  return {
    type: "dashboard",
    device_id: "device:audit:phone",
    permission: "write",
    origin: "https://hostdeck.local"
  } as const;
}

function auditTarget() {
  return {
    type: "managed_session",
    session_id: "sess_audit_selected",
    codex_thread_id: "thread-audit-selected"
  } as const;
}

function hostTarget() {
  return { type: "host", host_id: "local_host" } as const;
}

function insertRawRecord(
  db: Database.Database,
  structuralRecord: Readonly<Record<string, unknown>>,
  jsonRecord: Readonly<Record<string, unknown>> = structuralRecord
): void {
  const parsed = selectedAuditEventRecordSchema.parse(structuralRecord);
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, phase, outcome, error_code, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    parsed.id,
    parsed.operation_id,
    parsed.at,
    parsed.action,
    parsed.phase,
    parsed.outcome,
    parsed.error_code,
    JSON.stringify(jsonRecord)
  );
}

function installForcedFailure(db: Database.Database, recordId: string): void {
  db.exec(`
    CREATE TRIGGER force_selected_audit_failure
    AFTER INSERT ON selected_audit_events
    WHEN NEW.id = '${recordId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced selected audit write failure');
    END;
  `);
}

function rawRows(db: Database.Database, operationId: string): readonly unknown[] {
  return db.prepare("SELECT * FROM selected_audit_events WHERE operation_id = ? ORDER BY phase ASC").all(operationId);
}

function rawRecordJson(db: Database.Database, recordId: string): string {
  const row = db.prepare("SELECT record_json FROM selected_audit_events WHERE id = ?").get(recordId) as
    | { readonly record_json: string }
    | undefined;
  if (row === undefined) throw new Error(`Missing selected audit record ${recordId}.`);
  return row.record_json;
}

function expectAuditError(fn: () => unknown, code: SelectedAuditRepositoryErrorCode): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostDeckSelectedAuditRepositoryError);
  expect((caught as HostDeckSelectedAuditRepositoryError).code).toBe(code);
}

function startConcurrentRawInsert(
  path: string,
  candidate: Readonly<Record<string, unknown>>
): { readonly inserted: Promise<void>; readonly completed: Promise<void> } {
  const record = selectedAuditEventRecordSchema.parse(candidate);
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.databaseModule);
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 2000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO selected_audit_events " +
        "(id, operation_id, at, action, phase, outcome, error_code, record_json) " +
        "VALUES (@id, @operation_id, @at, @action, @phase, @outcome, @error_code, @record_json)"
      ).run(workerData.row);
      parentPort.postMessage("inserted");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      db.exec("COMMIT");
      db.close();
    `,
    {
      eval: true,
      workerData: {
        databaseModule: betterSqlite3Path,
        path,
        row: {
          id: record.id,
          operation_id: record.operation_id,
          at: record.at,
          action: record.action,
          phase: record.phase,
          outcome: record.outcome,
          error_code: record.error_code,
          record_json: JSON.stringify(record)
        }
      }
    }
  );

  const inserted = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (message === "inserted") resolve();
    });
    worker.once("error", reject);
  });
  const completed = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Selected audit race worker exited with code ${code}.`));
    });
  });
  return { inserted, completed };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-selected-audit-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-10T17:59:00.000Z");
}
