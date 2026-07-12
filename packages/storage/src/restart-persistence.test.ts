import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRetentionPolicy } from "@hostdeck/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditEventRepository } from "./audit-repository.js";
import { createAuthDeviceRepository, createLegacyPairingCodeRepository } from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createRetentionRepository } from "./retention-repository.js";
import { createSessionMetadataRepository, createSessionRepository } from "./session-repository.js";
import { createSettingsRepository } from "./settings-repository.js";

const tempDirs: string[] = [];
const sessionId = "sess_restart_01";
const rawCode = "restart-code-123456";
const rawDeviceToken = "restart_device_token_for_phone_writes_123456";
const rawCsrfToken = "restart_csrf_token_for_phone_writes_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("storage restart persistence", () => {
  it("reloads durable settings, session, auth, audit, output, and retention state after reopen", () => {
    const dbPath = tempDbPath();
    const stateDir = tempStateDir();
    const cwd = tempCwd();
    const firstOpen = openMigratedDatabase(dbPath, { now: fixedNow });

    try {
      seedDurableState(firstOpen.db, stateDir, cwd);
    } finally {
      firstOpen.db.close();
    }

    const secondOpen = openMigratedDatabase(dbPath, { now: fixedNow });

    try {
      expect(secondOpen.result.applied).toEqual([]);

      const settings = createSettingsRepository(secondOpen.db).require();
      expect(settings).toMatchObject({
        state_dir: stateDir,
        bind_mode: "lan",
        bind_host: "0.0.0.0",
        lan_enabled: true,
        locked: true
      });

      expect(createSessionRepository(secondOpen.db).require(sessionId)).toMatchObject({
        cwd,
        lifecycle_state: "running"
      });
      expect(createSessionMetadataRepository(secondOpen.db).require(sessionId)).toMatchObject({
        branch: "feature/restart-persistence",
        last_output_cursor: 5,
        status: "running",
        attention: "watch"
      });

      expect(
        createAuthDeviceRepository(secondOpen.db).authorizeBrowserWrite({
          rawDeviceToken,
          rawCsrfToken,
          now: laterNow()
        }).id
      ).toBe("client_restart");
      expect(createLegacyPairingCodeRepository(secondOpen.db).require("pair_restart").used_at).toBe(
        "2026-07-08T22:00:00.000Z"
      );

      const audit = createAuditEventRepository(secondOpen.db);
      expect(audit.require("audit_restart_prompt").session_id).toBe(sessionId);
      expect(audit.list({ sessionId }).map((event) => event.id)).toEqual(["audit_restart_prompt"]);

      const retention = createRetentionRepository(secondOpen.db);
      expect(retention.getLatestBoundary({ scope: "output", sessionId })).toMatchObject({
        reason: "event_limit",
        truncated_before_cursor: 2,
        retained_record_count: 3
      });
      expect(retention.listOutputReplay(sessionId, { after: 1, limit: 10 })).toMatchObject({
        truncated: true,
        next_cursor: 6
      });
      expect(retention.listOutputReplay(sessionId, { after: 1, limit: 10 }).events.map((event) => event.cursor)).toEqual([3, 4, 5]);

      expect(tableNames(secondOpen.db)).not.toEqual(expect.arrayContaining(["stream_subscriptions", "output_readers"]));
    } finally {
      secondOpen.db.close();
    }
  });
});

function seedDurableState(db: Database.Database, stateDir: string, cwd: string): void {
  const settings = createSettingsRepository(db);
  settings.getOrCreateDefault({ stateDir, now: fixedNow });
  settings.setLocked(true, { now: laterNow });
  settings.setLanEnabled(true, { bindHost: "0.0.0.0", now: laterNow });

  createSessionRepository(db).create(sessionRecord(cwd));
  createSessionMetadataRepository(db).upsert(metadataRecord());

  const pairingCodes = createLegacyPairingCodeRepository(db);
  pairingCodes.createLegacy({
    id: "pair_restart",
    rawCode,
    permission: "write",
    clientLabel: "restart-phone",
    createdAt: fixedNow(),
    expiresAt: laterNow()
  });
  pairingCodes.claimLegacy({
    rawCode,
    deviceId: "client_restart",
    rawDeviceToken,
    rawCsrfToken,
    now: fixedNow()
  });

  createAuditEventRepository(db).append(auditEvent());

  const retention = createRetentionRepository(db);
  for (const cursor of [1, 2, 3, 4, 5]) {
    retention.appendOutputEvent(outputEvent(cursor), {
      now: fixedNow,
      retention: {
        ...defaultRetentionPolicy,
        output_event_limit: 3,
        output_byte_limit: 1_000_000
      }
    });
  }
}

function sessionRecord(cwd: string) {
  return {
    id: sessionId,
    name: "restart-demo",
    cwd,
    backend: {
      type: "tmux",
      tmux_session: "hostdeck-restart-demo",
      tmux_window: null,
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: "2026-07-08T22:00:00.000Z",
    updated_at: "2026-07-08T22:00:00.000Z",
    stale_reason: null
  };
}

function metadataRecord() {
  return {
    session_id: sessionId,
    branch: "feature/restart-persistence",
    last_activity_at: "2026-07-08T22:00:00.000Z",
    status: "running",
    attention: "watch",
    summary: "Running restart persistence test.",
    last_output_cursor: 5,
    updated_at: "2026-07-08T22:00:00.000Z"
  };
}

function auditEvent() {
  return {
    id: "audit_restart_prompt",
    at: "2026-07-08T22:00:00.000Z",
    actor: {
      type: "dashboard",
      client_id: "client_restart",
      permission: "write"
    },
    action: "prompt",
    session_id: sessionId,
    payload_summary: {
      text_length: 7,
      text_preview: "Restart"
    },
    result: "accepted",
    error_code: null
  };
}

function outputEvent(cursor: number) {
  return {
    session_id: sessionId,
    cursor,
    order: cursor - 1,
    captured_at: "2026-07-08T22:00:00.000Z",
    kind: "output",
    payload: `line ${cursor}`,
    truncated_before: null
  };
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ readonly name: string }>;

  return rows.map((row) => row.name);
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-restart-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-restart-state-"));
  tempDirs.push(dir);
  return dir;
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-restart-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
