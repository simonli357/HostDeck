import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckMigrationError,
  openMigratedDatabase
} from "./migration-runner.js";
import {
  defaultMigrations,
  hostDeckSelectedNetworkRetirementMigration,
  type StorageMigration
} from "./migrations.js";
import { createSettingsRepository } from "./settings-repository.js";

const tempDirectories: string[] = [];
const priorVersion = "202607160017_selected_session_settings_projection";

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected network retirement migration", () => {
  it("creates the selected settings schema on an empty database", () => {
    const opened = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      expect(settingsColumns(opened.db)).toEqual([
        "id",
        "schema_version",
        "state_dir",
        "bind_port",
        "locked",
        "output_event_limit",
        "output_byte_limit",
        "audit_event_limit",
        "audit_retention_days",
        "updated_at"
      ]);
      expect(tableExists(opened.db, "selected_lan_configuration")).toBe(false);
      expect(createSettingsRepository(opened.db).get()).toBeNull();
    } finally {
      opened.db.close();
    }
  });

  it.each([
    ["localhost", "127.0.0.1", 0],
    ["lan", "192.168.0.29", 1]
  ] as const)(
    "retires %s network settings while preserving selected settings and historical truth",
    (bindMode, bindHost, lanEnabled) => {
      const path = tempDbPath();
      const prior = openMigratedDatabase(path, {
        migrations: migrationsThrough(priorVersion),
        now: fixedNow
      });
      seedPriorSettings(prior.db, bindMode, bindHost, lanEnabled);
      seedHistoricalRows(prior.db);
      seedRetiredLanConfiguration(prior.db);
      prior.db.close();

      const migrated = openMigratedDatabase(path, { now: fixedNow });
      try {
        expect(migrated.result.applied).toEqual([
          hostDeckSelectedNetworkRetirementMigration.version
        ]);
        expect(createSettingsRepository(migrated.db).require()).toEqual({
          id: "hostdeck_settings",
          schema_version: 7,
          state_dir: "/tmp/hostdeck-retirement-state",
          bind_port: 4111,
          locked: true,
          retention: {
            output_event_limit: 1234,
            output_byte_limit: 567890,
            audit_event_limit: 321,
            audit_retention_days: 14
          },
          updated_at: "2026-07-20T12:34:56.000Z"
        });
        expect(settingsColumns(migrated.db)).not.toEqual(
          expect.arrayContaining(["bind_mode", "bind_host", "lan_enabled"])
        );
        expect(tableExists(migrated.db, "selected_lan_configuration")).toBe(false);
        expect(
          migrated.db.prepare("SELECT id, tmux_session FROM sessions").all()
        ).toEqual([
          { id: "sess_retirement_legacy", tmux_session: "legacy-retirement" }
        ]);
        expect(
          migrated.db.prepare("SELECT id FROM legacy_session_dispositions").all()
        ).toEqual([{ id: "sess_retirement_legacy" }]);
        expect(
          migrated.db.prepare("SELECT id, action FROM audit_events").all()
        ).toEqual([{ id: "audit_retirement_lan", action: "lan_enable" }]);
        expect(
          migrated.db.prepare("SELECT id, action FROM selected_audit_events").all()
        ).toEqual([
          {
            id: "audit:retirement:certificate:terminal",
            action: "certificate_rotate"
          }
        ]);
        expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
        expect(migrated.db.pragma("quick_check")).toEqual([
          { quick_check: "ok" }
        ]);
      } finally {
        migrated.db.close();
      }
    }
  );

  it("rolls back a failed retirement without losing legacy settings or LAN state", () => {
    const path = tempDbPath();
    const priorMigrations = migrationsThrough(priorVersion);
    const prior = openMigratedDatabase(path, {
      migrations: priorMigrations,
      now: fixedNow
    });
    seedPriorSettings(prior.db, "lan", "192.168.0.29", 1);
    seedHistoricalRows(prior.db);
    seedRetiredLanConfiguration(prior.db);
    prior.db.close();

    const failingMigration: StorageMigration = {
      ...hostDeckSelectedNetworkRetirementMigration,
      sql: `${hostDeckSelectedNetworkRetirementMigration.sql}\nSELECT * FROM missing_retirement_dependency;`
    };
    expect(() =>
      openMigratedDatabase(path, {
        migrations: [...priorMigrations, failingMigration],
        now: fixedNow
      })
    ).toThrow(HostDeckMigrationError);

    const inspected = new Database(path);
    try {
      expect(settingsColumns(inspected)).toEqual(
        expect.arrayContaining(["bind_mode", "bind_host", "lan_enabled"])
      );
      expect(
        inspected
          .prepare(
            "SELECT bind_mode, bind_host, lan_enabled FROM settings WHERE id = 'hostdeck_settings'"
          )
          .get()
      ).toEqual({
        bind_mode: "lan",
        bind_host: "192.168.0.29",
        lan_enabled: 1
      });
      expect(tableExists(inspected, "selected_lan_configuration")).toBe(true);
      expect(
        inspected.prepare("SELECT id FROM sessions").all()
      ).toEqual([{ id: "sess_retirement_legacy" }]);
      expect(
        inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
      ).toEqual({ count: 17 });
    } finally {
      inspected.close();
    }
  });
});

function seedPriorSettings(
  db: Database.Database,
  bindMode: "localhost" | "lan",
  bindHost: string,
  lanEnabled: 0 | 1
): void {
  db.prepare(
    `
      INSERT INTO settings (
        id, schema_version, state_dir, bind_mode, bind_host, bind_port,
        lan_enabled, locked, output_event_limit, output_byte_limit,
        audit_event_limit, audit_retention_days, updated_at
      ) VALUES (
        'hostdeck_settings', 7, '/tmp/hostdeck-retirement-state',
        @bind_mode, @bind_host, 4111, @lan_enabled, 1,
        1234, 567890, 321, 14, '2026-07-20T12:34:56.000Z'
      )
    `
  ).run({
    bind_mode: bindMode,
    bind_host: bindHost,
    lan_enabled: lanEnabled
  });
}

function seedHistoricalRows(db: Database.Database): void {
  db.prepare(
    `
      INSERT INTO sessions (
        id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
        lifecycle_state, created_at, updated_at, stale_reason
      ) VALUES (
        'sess_retirement_legacy', 'retirement-legacy', '/tmp/legacy', 'tmux',
        'legacy-retirement', NULL, NULL, 'stopped',
        '2026-07-12T10:00:00.000Z', '2026-07-12T10:01:00.000Z', NULL
      )
    `
  ).run();
  db.prepare(
    `
      INSERT INTO audit_events (
        id, at, actor_type, actor_client_id, actor_permission, action,
        session_id, payload_summary_json, result, error_code
      ) VALUES (
        'audit_retirement_lan', '2026-07-12T10:02:00.000Z', 'system',
        NULL, NULL, 'lan_enable', NULL, '{"historical":true}', 'succeeded', NULL
      )
    `
  ).run();
  db.prepare(
    `
      INSERT INTO selected_audit_events (
        id, operation_id, at, action, security_schema_version,
        phase, outcome, error_code, record_json
      ) VALUES (
        'audit:retirement:certificate:terminal', 'op_retirement_certificate',
        '2026-07-12T10:03:00.000Z', 'certificate_rotate', 1,
        'terminal', 'rejected', 'validation_error', '{"historical":true}'
      )
    `
  ).run();
}

function seedRetiredLanConfiguration(db: Database.Database): void {
  db.prepare(
    `
      INSERT INTO selected_lan_configuration (
        id, schema_version, bind_host, address_family, bind_port,
        configured_origin, root_fingerprint_sha256, leaf_fingerprint_sha256,
        leaf_valid_from, leaf_expires_at, updated_at
      ) VALUES (
        'hostdeck_lan_configuration', 1, '192.168.0.29', 'ipv4', 4111,
        'https://192.168.0.29:4111', @root, @leaf,
        '2026-07-12T10:00:00.000Z', '2027-07-12T10:00:00.000Z',
        '2026-07-12T10:00:00.000Z'
      )
    `
  ).run({ root: "a".repeat(64), leaf: "b".repeat(64) });
}

function settingsColumns(db: Database.Database): string[] {
  const rows = db.prepare("PRAGMA table_info(settings)").all() as Array<{
    readonly name: string;
  }>;
  return rows.map((row) => row.name);
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name) !== undefined
  );
}

function migrationsThrough(version: string): readonly StorageMigration[] {
  const index = defaultMigrations.findIndex(
    (migration) => migration.version === version
  );
  if (index < 0) throw new Error(`Unknown migration boundary ${version}.`);
  return defaultMigrations.slice(0, index + 1);
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-network-retirement-"));
  tempDirectories.push(directory);
  return join(directory, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-20T13:00:00.000Z");
}
