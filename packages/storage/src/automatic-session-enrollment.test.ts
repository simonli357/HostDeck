import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectedProjectionEventSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveAutomaticSessionIdentity,
  HostDeckAutomaticSessionIdentityError
} from "./automatic-session-identity.js";
import { HostDeckMigrationError, openMigratedDatabase, runMigrations } from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckAutomaticSessionMembershipMigration,
  hostDeckNativeSessionMembershipMigration,
  type StorageMigration
} from "./migrations.js";
import {
  createSelectedAuditRepository,
  reconcileSelectedAuditOrphansBatch
} from "./selected-audit-repository.js";
import {
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "./selected-state-repository.js";

const tempDirectories: string[] = [];
const nativeThreadId = "019f489a-1f9d-7402-ae00-eac6ea322f64";
const secondNativeThreadId = "019f489a-1f9d-7402-ae00-eac6ea322f65";
const createdAt = "2026-08-14T16:00:00.000Z";
const enrolledAt = "2026-08-14T16:01:00.000Z";

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("automatic session identity", () => {
  it("derives injective valid ids and aliases from the full native UUID", () => {
    const first = deriveAutomaticSessionIdentity(nativeThreadId, "Side Cue App");
    const repeated = deriveAutomaticSessionIdentity(nativeThreadId, "Side Cue App");
    const second = deriveAutomaticSessionIdentity(secondNativeThreadId, "Side Cue App");

    expect(first).toEqual(repeated);
    expect(first).toEqual({
      alias: "side-cue-app-019f489a1f9d7402ae00eac6ea322f64",
      internal_session_id: "sess_019f489a1f9d7402ae00eac6ea322f64"
    });
    expect(second.alias).not.toBe(first.alias);
    expect(second.internal_session_id).not.toBe(first.internal_session_id);
    expect(deriveAutomaticSessionIdentity(nativeThreadId, "界".repeat(160)).alias).toBe(
      "codex-019f489a1f9d7402ae00eac6ea322f64"
    );
    expect(() => deriveAutomaticSessionIdentity(nativeThreadId.toUpperCase(), "Side Cue App")).toThrow(
      HostDeckAutomaticSessionIdentityError
    );
  });
});

describe("automatic session enrollment repository", () => {
  it("atomically creates one mapping, projection, boundary, and immutable membership with dual-id reads", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const candidate = automaticCandidate();
      const result = repository.enrollAutomatic(candidate);

      expect(result).toEqual({
        created: true,
        refreshed: false,
        membership: candidate.membership,
        state: candidate.state
      });
      expect(repository.getByTargetId(candidate.membership.native_thread_id)).toEqual(candidate.state);
      expect(repository.getByTargetId(candidate.membership.session_id)).toEqual(candidate.state);
      expect(repository.requireByTargetId(candidate.membership.native_thread_id)).toEqual(candidate.state);
      expect(repository.getSharedMembership(candidate.membership.session_id)).toEqual(candidate.membership);
      expect(repository.getSharedMembershipByThreadId(candidate.membership.native_thread_id)).toEqual(candidate.membership);
      expect(repository.listSharedMemberships()).toEqual([candidate.membership]);
      expect(repository.getNativeMembership(candidate.membership.session_id)).toBeNull();
      expect(repository.listEvents(candidate.membership.session_id)).toMatchObject({
        events: [{ cursor: 1, reason: "enrollment", type: "replay_boundary" }],
        next_cursor: 1,
        truncated: true
      });
      expect(rawSelectedCounts(open.db)).toEqual({ events: 1, memberships: 1, projections: 1, sessions: 1 });
      expect(() =>
        open.db
          .prepare("UPDATE selected_native_session_memberships SET enrolled_at = ? WHERE session_id = ?")
          .run("2026-08-14T16:02:00.000Z", candidate.membership.session_id)
      ).toThrow("native session membership is immutable");
      expectRepositoryError(() => repository.getByTargetId("thread-not-native"), "session_not_found");
    } finally {
      open.db.close();
    }
  });

  it("converges stale repository instances and restart reads on the same native identity", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    const candidate = automaticCandidate();
    try {
      expect(createSelectedStateRepository(first.db).enrollAutomatic(candidate).created).toBe(true);
      expect(createSelectedStateRepository(second.db).enrollAutomatic(candidate)).toEqual({
        created: false,
        refreshed: false,
        membership: candidate.membership,
        state: candidate.state
      });
      expect(rawSelectedCounts(second.db)).toEqual({ events: 1, memberships: 1, projections: 1, sessions: 1 });
    } finally {
      first.db.close();
      second.db.close();
    }

    const restarted = openMigratedDatabase(path, { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(restarted.db);
      expect(repository.requireByTargetId(nativeThreadId)).toEqual(candidate.state);
      expect(repository.enrollAutomatic(candidate).created).toBe(false);
      expect(rawSelectedCounts(restarted.db)).toEqual({ events: 1, memberships: 1, projections: 1, sessions: 1 });
    } finally {
      restarted.db.close();
    }
  });

  it("recovers an existing HostDeck mapping in place and resets only its bounded projection at a visible boundary", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const initial = repository.create(existingHostDeckStateCandidate());
      const priorEvent = selectedProjectionEventSchema.parse({
        session_id: initial.mapping.id,
        cursor: 1,
        captured_at: "2026-08-14T16:00:30.000Z",
        upstream_at: "2026-08-14T16:00:30.000Z",
        codex_event_id: "prior:event:1",
        codex_event_type: "prior/message",
        content_state: "complete",
        content_notice: null,
        type: "message",
        role: "agent",
        phase: "completed",
        item_id: "prior-item-1",
        text: "Prior bounded HostDeck projection."
      });
      const priorRecord = { event: priorEvent, byte_length: selectedProjectedEventByteLength(priorEvent) };
      repository.appendEvent(
        priorRecord,
        {
          ...initial.projection,
          session: {
            ...initial.projection.session,
            updated_at: priorEvent.captured_at,
            last_activity_at: priorEvent.captured_at,
            recent_summary: "Prior bounded HostDeck projection.",
            last_event_cursor: 1
          },
          retained_event_count: 1,
          retained_event_bytes: priorRecord.byte_length,
          earliest_retained_cursor: 1
        },
        selectedStateRevision(initial)
      );
      open.db
        .prepare(
          "UPDATE selected_sessions SET runtime_version = '0.144.0', disposition = 'recovery_required', updated_at = ? WHERE id = ?"
        )
        .run("2026-08-14T16:00:31.000Z", initial.mapping.id);
      open.db
        .prepare(
          `
            UPDATE selected_session_projections SET
              session_state = 'unknown', turn_state = 'unknown', attention = 'unknown',
              freshness = 'stale', freshness_reason = 'Managed Codex runtime version changed.',
              updated_at = ?, model = NULL, settings_json = NULL,
              recent_summary = 'Managed Codex runtime version changed.'
            WHERE session_id = ?
          `
        )
        .run("2026-08-14T16:00:31.000Z", initial.mapping.id);

      const result = repository.enrollAutomatic(automaticCandidate());
      expect(result.created).toBe(false);
      expect(result.refreshed).toBe(true);
      expect(result.state.mapping).toMatchObject({
        id: initial.mapping.id,
        name: initial.mapping.name,
        codex_thread_id: nativeThreadId,
        disposition: "selected",
        runtime_version: "0.148.0"
      });
      expect(result.membership).toEqual({
        session_id: initial.mapping.id,
        native_thread_id: nativeThreadId,
        origin: "automatic",
        enrollment_origin: "loaded_before",
        enrolled_at: enrolledAt
      });
      expect(repository.requireByTargetId(nativeThreadId).mapping.id).toBe(initial.mapping.id);
      expect(repository.listEvents(initial.mapping.id)).toMatchObject({
        events: [{ after: 1, cursor: 2, reason: "enrollment", type: "replay_boundary" }],
        next_cursor: 2,
        truncated: true
      });
      expect(JSON.stringify(repository.listEvents(initial.mapping.id))).not.toContain(
        "Prior bounded HostDeck projection."
      );
      expect(rawSelectedCounts(open.db)).toEqual({ events: 1, memberships: 1, projections: 1, sessions: 1 });
    } finally {
      open.db.close();
    }
  });

  it("refreshes a recovery-required adopted mapping without rewriting its historical membership", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const adoption = adoptionCandidate();
      repository.adopt(adoption);
      open.db
        .prepare(
          "UPDATE selected_sessions SET runtime_version = '0.144.0', disposition = 'recovery_required', updated_at = ? WHERE id = ?"
        )
        .run("2026-08-14T16:02:00.000Z", adoption.state.mapping.id);
      open.db
        .prepare(
          `
            UPDATE selected_session_projections SET
              session_state = 'unknown', turn_state = 'unknown', attention = 'unknown',
              freshness = 'stale', freshness_reason = 'Managed Codex runtime version changed.',
              updated_at = ?, model = NULL, settings_json = NULL,
              recent_summary = 'Managed Codex runtime version changed.'
            WHERE session_id = ?
          `
        )
        .run("2026-08-14T16:02:00.000Z", adoption.state.mapping.id);
      const membershipBefore = JSON.stringify(
        open.db.prepare("SELECT * FROM selected_native_session_memberships WHERE session_id = ?").get(
          adoption.state.mapping.id
        )
      );

      const result = repository.enrollAutomatic(automaticCandidate());

      expect(result).toMatchObject({
        created: false,
        refreshed: true,
        membership: adoption.membership,
        state: {
          mapping: {
            id: adoption.state.mapping.id,
            name: adoption.state.mapping.name,
            disposition: "selected",
            runtime_version: "0.148.0"
          },
          projection: {
            session: { freshness: "current", session_state: "active" },
            retention_boundary_cursor: 1
          }
        }
      });
      expect(
        JSON.stringify(
          open.db.prepare("SELECT * FROM selected_native_session_memberships WHERE session_id = ?").get(
            adoption.state.mapping.id
          )
        )
      ).toBe(membershipBefore);
      expect(repository.listEvents(adoption.state.mapping.id).events).toMatchObject([
        { after: 1, cursor: 2, reason: "enrollment", type: "replay_boundary" }
      ]);
    } finally {
      open.db.close();
    }
  });

  it("rolls back every row on membership storage failure and rejects unbounded membership fields", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const candidate = automaticCandidate();
      open.db.exec(`
        CREATE TRIGGER force_automatic_membership_failure
        BEFORE INSERT ON selected_native_session_memberships
        WHEN NEW.origin = 'automatic'
        BEGIN
          SELECT RAISE(ABORT, 'forced automatic membership failure');
        END;
      `);
      expectRepositoryError(() => repository.enrollAutomatic(candidate), "invalid_membership");
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 0, sessions: 0 });
      open.db.exec("DROP TRIGGER force_automatic_membership_failure");

      expectRepositoryError(
        () =>
          repository.enrollAutomatic({
            ...candidate,
            membership: { ...candidate.membership, rollout_path: "/private/codex/rollout.jsonl" }
          }),
        "invalid_membership"
      );
      expectRepositoryError(
        () => repository.enrollAutomatic({ ...candidate, project_cue: "x".repeat(161) }),
        "invalid_membership"
      );
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 0, sessions: 0 });
      expect(JSON.stringify(open.db.prepare("PRAGMA table_info(selected_native_session_memberships)").all())).not.toContain(
        "transcript"
      );
      expect(JSON.stringify(open.db.prepare("PRAGMA table_info(selected_native_session_memberships)").all())).not.toContain(
        "rollout"
      );
    } finally {
      open.db.close();
    }
  });

  it("restores an existing mapping and projection when in-place enrollment cannot persist membership", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createSelectedStateRepository(open.db);
      const existing = repository.create(existingHostDeckStateCandidate());
      open.db.exec(`
        CREATE TRIGGER force_existing_membership_failure
        BEFORE INSERT ON selected_native_session_memberships
        WHEN NEW.origin = 'automatic'
        BEGIN
          SELECT RAISE(ABORT, 'forced existing membership failure');
        END;
      `);

      expectRepositoryError(() => repository.enrollAutomatic(automaticCandidate()), "invalid_membership");
      expect(repository.require(existing.mapping.id)).toEqual(existing);
      expect(repository.getSharedMembership(existing.mapping.id)).toBeNull();
      expect(repository.listEvents(existing.mapping.id)).toMatchObject({ events: [], next_cursor: 0 });
      expect(rawSelectedCounts(open.db)).toEqual({ events: 0, memberships: 0, projections: 1, sessions: 1 });
    } finally {
      open.db.close();
    }
  });
});

describe("automatic session membership migration", () => {
  it("preserves a historical adoption identity and reuses it during automatic enrollment", () => {
    const path = tempDbPath();
    const historical = openMigratedDatabase(path, {
      migrations: migrationsThrough(hostDeckNativeSessionMembershipMigration.version),
      now: fixedNow
    });
    const adoption = adoptionCandidate();
    let historicalMembershipJson: string;
    try {
      const repository = createSelectedStateRepository(historical.db);
      repository.adopt(adoption);
      historicalMembershipJson = JSON.stringify(
        historical.db.prepare("SELECT * FROM selected_native_session_memberships").get()
      );
    } finally {
      historical.db.close();
    }

    const migrated = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(migrated.result.applied).toEqual([hostDeckAutomaticSessionMembershipMigration.version]);
      const repository = createSelectedStateRepository(migrated.db);
      expect(repository.getNativeMembership(adoption.membership.session_id)).toEqual(adoption.membership);
      expect(repository.getSharedMembership(adoption.membership.session_id)).toEqual(adoption.membership);
      const reused = repository.enrollAutomatic(automaticCandidate());
      expect(reused).toEqual({
        created: false,
        refreshed: false,
        membership: adoption.membership,
        state: adoption.state
      });
      expect(repository.requireByTargetId(nativeThreadId).mapping.id).toBe(adoption.membership.session_id);
      expect(rawSelectedCounts(migrated.db)).toEqual({ events: 1, memberships: 1, projections: 1, sessions: 1 });

      const migratedRow = migrated.db.prepare("SELECT * FROM selected_native_session_memberships").get() as Record<
        string,
        unknown
      >;
      expect(JSON.stringify({
        session_id: migratedRow.session_id,
        codex_thread_id: migratedRow.codex_thread_id,
        origin: migratedRow.origin,
        adopted_at: migratedRow.adopted_at,
        handoff_confirmed_at: migratedRow.handoff_confirmed_at
      })).toBe(historicalMembershipJson);
      expect(migratedRow).toMatchObject({ enrollment_origin: null, enrolled_at: null });
    } finally {
      migrated.db.close();
    }
  });

  it("adds current enrollment audit trails and reconciles accepted-only startup work", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const audit = createSelectedAuditRepository(open.db);
      const accepted = enrollmentAccepted("op_session_enroll_current");
      expect(audit.recordAccepted(accepted)).toMatchObject({ state: "pending" });
      expect(
        audit.recordTerminal({
          ...accepted,
          id: `${accepted.id}:terminal`,
          at: enrolledAt,
          phase: "terminal",
          outcome: "succeeded",
          payload_summary: {
            schema_version: 1,
            enrolled: true,
            created: true,
            refreshed: false
          }
        })
      ).toMatchObject({
        state: "terminal",
        records: [{ action: "session_enroll", outcome: "accepted" }, { outcome: "succeeded" }]
      });

      const orphan = enrollmentAccepted("op_session_enroll_orphan");
      audit.recordAccepted(orphan);
      expect(
        reconcileSelectedAuditOrphansBatch(open.db, {
          eligible_before: "2026-08-14T16:00:30.000Z",
          max_reconciled_operations: 1,
          reconciled_at: enrolledAt
        })
      ).toMatchObject({ reconciled_operation_count: 1, remaining: false });
      expect(audit.require(orphan.operation_id).records[1]).toMatchObject({
        action: "session_enroll",
        outcome: "incomplete",
        payload_summary: { schema_version: 1, reconciliation_reason: "host_restart_without_terminal" }
      });
    } finally {
      open.db.close();
    }
  });

  it("rolls back an interrupted membership and audit catalog rebuild together", () => {
    const migrations = migrationsThrough(hostDeckNativeSessionMembershipMigration.version);
    const open = openMigratedDatabase(tempDbPath(), { migrations, now: fixedNow });
    try {
      const adoption = adoptionCandidate();
      createSelectedStateRepository(open.db).adopt(adoption);
      const beforeTableSql = tableSql(open.db, "selected_native_session_memberships");
      const beforeAuditSql = tableSql(open.db, "selected_audit_events");
      const beforeMembership = JSON.stringify(
        open.db.prepare("SELECT * FROM selected_native_session_memberships").get()
      );
      const interrupted = {
        ...hostDeckAutomaticSessionMembershipMigration,
        sql: `${hostDeckAutomaticSessionMembershipMigration.sql}\nSELECT * FROM forced_automatic_membership_failure;`
      } satisfies StorageMigration;

      expect(() => runMigrations(open.db, { migrations: [...migrations, interrupted], now: fixedNow })).toThrow(
        HostDeckMigrationError
      );
      expect(tableSql(open.db, "selected_native_session_memberships")).toBe(beforeTableSql);
      expect(tableSql(open.db, "selected_audit_events")).toBe(beforeAuditSql);
      expect(JSON.stringify(open.db.prepare("SELECT * FROM selected_native_session_memberships").get())).toBe(
        beforeMembership
      );
    } finally {
      open.db.close();
    }
  });
});

function automaticCandidate() {
  const identity = deriveAutomaticSessionIdentity(nativeThreadId, "Side Cue App");
  const boundary = selectedProjectionEventSchema.parse({
    session_id: identity.internal_session_id,
    cursor: 1,
    captured_at: enrolledAt,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after: null,
    next_cursor: 1,
    reason: "enrollment"
  });
  const boundaryRecord = { event: boundary, byte_length: selectedProjectedEventByteLength(boundary) };
  const mapping = {
    id: identity.internal_session_id,
    name: identity.alias,
    codex_thread_id: nativeThreadId,
    cwd: "/home/simonli/Videos/apps/side_cue_app",
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.148.0",
    disposition: "selected" as const,
    created_at: createdAt,
    updated_at: enrolledAt,
    archived_at: null
  };
  const state = {
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: null,
        session_state: "active" as const,
        turn_state: "idle" as const,
        attention: "none" as const,
        freshness: "current" as const,
        freshness_reason: null,
        updated_at: enrolledAt,
        last_activity_at: null,
        branch: "main",
        model: null,
        settings: null,
        goal: null,
        recent_summary: "Native Codex session enrolled.",
        last_event_cursor: 1
      },
      retained_event_count: 1,
      retained_event_bytes: boundaryRecord.byte_length,
      earliest_retained_cursor: 1,
      retention_boundary_cursor: null
    }
  };
  return {
    membership: {
      session_id: mapping.id,
      native_thread_id: nativeThreadId,
      origin: "automatic" as const,
      enrollment_origin: "loaded_before" as const,
      enrolled_at: enrolledAt
    },
    state,
    events: [boundaryRecord],
    project_cue: "Side Cue App"
  };
}

function adoptionCandidate() {
  const automatic = automaticCandidate();
  const id = "sess_historical_adoption";
  const name = "historical-adoption";
  const boundary = selectedProjectionEventSchema.parse({
    ...automatic.events[0]?.event,
    session_id: id,
    reason: "adoption"
  });
  const boundaryRecord = { event: boundary, byte_length: selectedProjectedEventByteLength(boundary) };
  const mapping = { ...automatic.state.mapping, id, name };
  return {
    membership: {
      session_id: id,
      codex_thread_id: nativeThreadId,
      origin: "adopted" as const,
      adopted_at: enrolledAt,
      handoff_confirmed_at: enrolledAt
    },
    state: {
      mapping,
      projection: {
        ...automatic.state.projection,
        session: { ...automatic.state.projection.session, id, name },
        retained_event_bytes: boundaryRecord.byte_length
      }
    },
    events: [boundaryRecord]
  };
}

function existingHostDeckStateCandidate() {
  const automatic = automaticCandidate();
  const mapping = {
    ...automatic.state.mapping,
    id: "sess_existing_hostdeck",
    name: "sidecue-deck",
    updated_at: createdAt
  };
  return {
    mapping,
    projection: {
      session: {
        ...automatic.state.projection.session,
        id: mapping.id,
        name: mapping.name,
        updated_at: createdAt,
        recent_summary: "Existing HostDeck session.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function enrollmentAccepted(operationId: string) {
  return {
    id: `audit:${operationId}:accepted`,
    operation_id: operationId,
    at: createdAt,
    actor: { type: "system" as const, device_id: null, permission: null, origin: null },
    action: "session_enroll" as const,
    target: { type: "native_codex_thread" as const, codex_thread_id: nativeThreadId },
    phase: "accepted" as const,
    outcome: "accepted" as const,
    payload_summary: { schema_version: 1, enrollment_origin: "loaded_before" as const },
    error_code: null
  };
}

function migrationsThrough(version: string): readonly StorageMigration[] {
  const index = defaultMigrations.findIndex((migration) => migration.version === version);
  if (index < 0) throw new Error(`Missing migration ${version}.`);
  return defaultMigrations.slice(0, index + 1);
}

function rawSelectedCounts(db: Database.Database) {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    events: count("selected_projected_events"),
    memberships: count("selected_native_session_memberships"),
    projections: count("selected_session_projections"),
    sessions: count("selected_sessions")
  };
}

function tableSql(db: Database.Database, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { readonly sql: string }
    | undefined;
  if (row === undefined) throw new Error(`Missing table ${name}.`);
  return row.sql;
}

function expectRepositoryError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSelectedStateRepositoryError);
    expect((error as HostDeckSelectedStateRepositoryError).code).toBe(code);
    return;
  }
  throw new Error(`Expected repository error ${code}.`);
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-automatic-enrollment-"));
  tempDirectories.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date(createdAt);
}
