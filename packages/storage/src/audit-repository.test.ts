import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditRepositoryErrorCode, createAuditEventRepository, HostDeckAuditRepositoryError } from "./audit-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createSessionRepository } from "./session-repository.js";

const tempDirs: string[] = [];
const sessionId = "sess_audit_01";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("audit event repository", () => {
  it("persists required V1 action types with bounded payload summaries", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const audit = createAuditEventRepository(open.db);

      for (const event of requiredActionEvents()) {
        expect(audit.append(event).action).toBe(event.action);
      }

      expect(audit.list({ limit: 20 })).toHaveLength(10);
      expect(audit.list({ sessionId })).toHaveLength(4);
      expect(JSON.parse(auditRow(open.db, "audit_prompt").payload_summary_json)).toEqual({
        text_length: 8,
        text_preview: "Continue"
      });
    } finally {
      open.db.close();
    }
  });

  it("rejects sensitive and unbounded payload summaries before write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const audit = createAuditEventRepository(open.db);

      expectAuditError(
        () =>
          audit.append(
            auditEvent({
              id: "audit_secret",
              payload_summary: {
                auth_token: "secret"
              }
            })
          ),
        "invalid_audit_event"
      );

      expectAuditError(
        () =>
          audit.append(
            auditEvent({
              id: "audit_unbounded",
              payload_summary: {
                text_preview: "x".repeat(257)
              }
            })
          ),
        "invalid_audit_event"
      );

      expect(audit.list()).toEqual([]);
    } finally {
      open.db.close();
    }
  });

  it("reloads durable audit events after database reopen", () => {
    const path = tempDbPath();
    const firstOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      createSessionRepository(firstOpen.db).create(sessionRecord());
      createAuditEventRepository(firstOpen.db).append(auditEvent({ id: "audit_reload" }));
    } finally {
      firstOpen.db.close();
    }

    const secondOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      expect(createAuditEventRepository(secondOpen.db).require("audit_reload").payload_summary).toEqual({
        text_length: 8,
        text_preview: "Continue"
      });
    } finally {
      secondOpen.db.close();
    }
  });

  it("rejects duplicate ids and invalid list limits", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      createSessionRepository(open.db).create(sessionRecord());
      const audit = createAuditEventRepository(open.db);
      audit.append(auditEvent({ id: "audit_duplicate" }));

      expectAuditError(() => audit.append(auditEvent({ id: "audit_duplicate" })), "audit_event_exists");
      expectAuditError(() => audit.list({ limit: 0 }), "invalid_audit_event");
    } finally {
      open.db.close();
    }
  });

  it("blocks invalid persisted audit rows on read", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      open.db
        .prepare(
          `
            INSERT INTO audit_events (
              id,
              at,
              actor_type,
              actor_client_id,
              actor_permission,
              action,
              session_id,
              payload_summary_json,
              result,
              error_code
            ) VALUES (
              'audit_corrupt',
              '2026-07-08T22:00:00.000Z',
              'system',
              NULL,
              NULL,
              'lock',
              NULL,
              '{not json',
              'accepted',
              NULL
            )
          `
        )
        .run();

      expectAuditError(() => createAuditEventRepository(open.db).require("audit_corrupt"), "invalid_audit_event");
    } finally {
      open.db.close();
    }
  });
});

function requiredActionEvents() {
  return [
    auditEvent({ id: "audit_prompt", action: "prompt", payload_summary: { text_length: 8, text_preview: "Continue" } }),
    auditEvent({ id: "audit_slash", action: "slash", payload_summary: { command: "/plan" } }),
    auditEvent({ id: "audit_stop", action: "stop", payload_summary: { confirmed: true } }),
    auditEvent({ id: "audit_raw", action: "raw_input", payload_summary: { confirmed: true } }),
    auditEvent({ id: "audit_pair", action: "pair", session_id: null, payload_summary: { client_label: "phone" } }),
    auditEvent({ id: "audit_lock", action: "lock", session_id: null, payload_summary: { reason: "manual" } }),
    auditEvent({ id: "audit_unlock", action: "unlock", session_id: null, payload_summary: { source: "cli" } }),
    auditEvent({ id: "audit_lan_enable", action: "lan_enable", session_id: null, payload_summary: { enabled: true } }),
    auditEvent({ id: "audit_lan_disable", action: "lan_disable", session_id: null, payload_summary: { enabled: false } }),
    auditEvent({ id: "audit_token_revoke", action: "token_revoke", session_id: null, payload_summary: { client_id: "phone" } })
  ] as const;
}

function auditEvent(input: {
  readonly action?: string;
  readonly id: string;
  readonly payload_summary?: Record<string, unknown>;
  readonly session_id?: string | null;
}) {
  const sessionScoped = input.action === undefined || ["prompt", "slash", "stop", "raw_input"].includes(input.action);

  return {
    id: input.id,
    at: "2026-07-08T22:00:00.000Z",
    actor: {
      type: "dashboard",
      client_id: "client_phone",
      permission: "write"
    },
    action: input.action ?? "prompt",
    session_id: input.session_id ?? (sessionScoped ? sessionId : null),
    payload_summary: input.payload_summary ?? {
      text_length: 8,
      text_preview: "Continue"
    },
    result: "accepted",
    error_code: null
  };
}

function sessionRecord() {
  return {
    id: sessionId,
    name: "audit-demo",
    cwd: tempCwd(),
    backend: {
      type: "tmux",
      tmux_session: "hostdeck-audit-demo",
      tmux_window: null,
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function auditRow(db: Database.Database, id: string): { readonly payload_summary_json: string } {
  const row = db.prepare("SELECT payload_summary_json FROM audit_events WHERE id = ?").get(id) as
    | { readonly payload_summary_json: string }
    | undefined;

  if (row === undefined) {
    throw new Error(`Missing audit row ${id}.`);
  }

  return row;
}

function expectAuditError(fn: () => unknown, code: AuditRepositoryErrorCode): void {
  expect(fn).toThrow(HostDeckAuditRepositoryError);

  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckAuditRepositoryError);
    expect((error as HostDeckAuditRepositoryError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckAuditRepositoryError ${code}.`);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-audit-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-audit-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}
