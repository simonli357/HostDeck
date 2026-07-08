import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "./migration-runner.js";
import { createDefaultSettings, createSettingsRepository, HostDeckSettingsError } from "./settings-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("settings repository", () => {
  it("creates and persists safe default settings", () => {
    const path = tempDbPath();
    const stateDir = tempStateDir();
    const firstOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repo = createSettingsRepository(firstOpen.db);
      const settings = repo.getOrCreateDefault({ stateDir, now: fixedNow });

      expect(settings.bind_mode).toBe("localhost");
      expect(settings.bind_host).toBe("127.0.0.1");
      expect(settings.bind_port).toBe(3777);
      expect(settings.lan_enabled).toBe(false);
      expect(settings.locked).toBe(false);
      expect(settings.retention.output_event_limit).toBe(10_000);
    } finally {
      firstOpen.db.close();
    }

    const secondOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      expect(createSettingsRepository(secondOpen.db).require().state_dir).toBe(stateDir);
    } finally {
      secondOpen.db.close();
    }
  });

  it("persists lock and LAN changes", () => {
    const path = tempDbPath();
    const firstOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repo = createSettingsRepository(firstOpen.db);
      repo.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });

      expect(repo.setLocked(true, { now: laterNow }).locked).toBe(true);
      const lan = repo.setLanEnabled(true, { bindHost: "0.0.0.0", now: laterNow });
      expect(lan.bind_mode).toBe("lan");
      expect(lan.bind_host).toBe("0.0.0.0");
      expect(lan.lan_enabled).toBe(true);
    } finally {
      firstOpen.db.close();
    }

    const secondOpen = openMigratedDatabase(path, { now: fixedNow });

    try {
      const repo = createSettingsRepository(secondOpen.db);
      const persisted = repo.require();

      expect(persisted.locked).toBe(true);
      expect(persisted.bind_mode).toBe("lan");
      expect(persisted.bind_host).toBe("0.0.0.0");
      expect(persisted.lan_enabled).toBe(true);

      const localhost = repo.setLanEnabled(false, { now: laterNow });
      expect(localhost.bind_mode).toBe("localhost");
      expect(localhost.bind_host).toBe("127.0.0.1");
      expect(localhost.lan_enabled).toBe(false);
    } finally {
      secondOpen.db.close();
    }
  });

  it("rejects invalid settings before write", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const repo = createSettingsRepository(open.db);
      const defaults = createDefaultSettings({ stateDir: tempStateDir(), now: fixedNow });

      expect(() =>
        repo.save({
          ...defaults,
          bind_mode: "lan",
          lan_enabled: false
        })
      ).toThrow(HostDeckSettingsError);
    } finally {
      open.db.close();
    }
  });

  it("rejects invalid bind hosts and LAN loopback writes", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const repo = createSettingsRepository(open.db);
      const defaults = createDefaultSettings({ stateDir: tempStateDir(), now: fixedNow });

      expect(() =>
        repo.save({
          ...defaults,
          bind_host: "not a host"
        })
      ).toThrow(HostDeckSettingsError);

      expect(() =>
        repo.save({
          ...defaults,
          bind_mode: "lan",
          bind_host: "127.0.0.1",
          lan_enabled: true
        })
      ).toThrow(HostDeckSettingsError);
    } finally {
      open.db.close();
    }
  });

  it("blocks startup on invalid persisted settings", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      open.db.pragma("ignore_check_constraints = ON");
      open.db
        .prepare(
          `
            INSERT INTO settings (
              id,
              schema_version,
              state_dir,
              bind_mode,
              bind_host,
              bind_port,
              lan_enabled,
              locked,
              output_event_limit,
              output_byte_limit,
              audit_event_limit,
              audit_retention_days,
              updated_at
            ) VALUES (
              'hostdeck_settings',
              1,
              '/tmp/hostdeck-state',
              'localhost',
              '127.0.0.1',
              0,
              0,
              0,
              10000,
              10000000,
              5000,
              30,
              '2026-07-08T22:00:00.000Z'
            )
          `
        )
        .run();
      open.db.pragma("ignore_check_constraints = OFF");

      expect(() => createSettingsRepository(open.db).require()).toThrow(HostDeckSettingsError);
    } finally {
      open.db.close();
    }
  });

  it("blocks startup on invalid persisted bind host", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      open.db
        .prepare(
          `
            INSERT INTO settings (
              id,
              schema_version,
              state_dir,
              bind_mode,
              bind_host,
              bind_port,
              lan_enabled,
              locked,
              output_event_limit,
              output_byte_limit,
              audit_event_limit,
              audit_retention_days,
              updated_at
            ) VALUES (
              'hostdeck_settings',
              1,
              '/tmp/hostdeck-state',
              'localhost',
              'not a host',
              3777,
              0,
              0,
              10000,
              10000000,
              5000,
              30,
              '2026-07-08T22:00:00.000Z'
            )
          `
        )
        .run();

      expect(() => createSettingsRepository(open.db).require()).toThrow(HostDeckSettingsError);
    } finally {
      open.db.close();
    }
  });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-settings-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-state-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
