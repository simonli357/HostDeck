import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

  it("transitions only host lock state and returns an exact frozen receipt", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const repo = createSettingsRepository(open.db);
      const beforeSettings = repo.getOrCreateDefault({
        stateDir: tempStateDir(),
        bindPort: 4111,
        now: fixedNow
      });
      const receipt = repo.transitionHostLock({
        locked: true,
        now: laterNow()
      });

      expect(receipt).toEqual({
        before: {
          locked: false,
          settings_updated_at: beforeSettings.updated_at
        },
        after: {
          locked: true,
          settings_updated_at: laterNow().toISOString()
        },
        changed: true
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.before)).toBe(true);
      expect(Object.isFrozen(receipt.after)).toBe(true);
      expect(repo.require()).toEqual({
        ...beforeSettings,
        locked: true,
        updated_at: laterNow().toISOString()
      });
    } finally {
      open.db.close();
    }
  });

  it("keeps idempotent lock state and chronology unchanged", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const repo = createSettingsRepository(open.db);
      repo.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
      repo.transitionHostLock({ locked: true, now: laterNow() });

      const receipt = repo.transitionHostLock({
        locked: true,
        now: fixedNow()
      });
      expect(receipt).toEqual({
        before: {
          locked: true,
          settings_updated_at: laterNow().toISOString()
        },
        after: {
          locked: true,
          settings_updated_at: laterNow().toISOString()
        },
        changed: false
      });
      expect(repo.require().updated_at).toBe(laterNow().toISOString());
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed and regressing lock transitions before mutation", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });

    try {
      const repo = createSettingsRepository(open.db);
      repo.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
      const invalidCandidates: unknown[] = [
        null,
        {},
        { locked: true },
        { locked: true, now: laterNow(), extra: true },
        { locked: "true", now: laterNow() },
        { locked: true, now: new Date(Number.NaN) },
        Object.assign(Object.create({ locked: true }), { now: laterNow() })
      ];
      const accessor = { locked: true } as Record<string, unknown>;
      Object.defineProperty(accessor, "now", {
        enumerable: true,
        get: laterNow
      });
      invalidCandidates.push(accessor);

      for (const candidate of invalidCandidates) {
        expect(() => repo.transitionHostLock(candidate as never)).toThrowError(
          expect.objectContaining({ code: "invalid_lock_transition" })
        );
      }
      expect(repo.require().locked).toBe(false);

      repo.transitionHostLock({ locked: true, now: laterNow() });
      expect(() =>
        repo.transitionHostLock({
          locked: false,
          now: new Date("2026-07-08T22:04:59.999Z")
        })
      ).toThrowError(
        expect.objectContaining({ code: "settings_lock_time_conflict" })
      );
      expect(repo.require()).toMatchObject({
        locked: true,
        updated_at: laterNow().toISOString()
      });
    } finally {
      open.db.close();
    }
  });

  it("serializes two repositories without caching lock truth and survives restart", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const firstRepo = createSettingsRepository(first.db);
    firstRepo.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });

    try {
      const secondRepo = createSettingsRepository(second.db);
      expect(
        firstRepo.transitionHostLock({ locked: true, now: laterNow() })
          .after.locked
      ).toBe(true);
      expect(
        secondRepo.transitionHostLock({
          locked: false,
          now: new Date("2026-07-08T22:06:00.000Z")
        }).before.locked
      ).toBe(true);
      expect(
        firstRepo.transitionHostLock({
          locked: true,
          now: new Date("2026-07-08T22:07:00.000Z")
        }).before.locked
      ).toBe(false);
    } finally {
      second.db.close();
      first.db.close();
    }

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(createSettingsRepository(reopened.db).require()).toMatchObject({
        locked: true,
        updated_at: "2026-07-08T22:07:00.000Z"
      });
    } finally {
      reopened.db.close();
    }
  });

  it("fails closed for missing, corrupt, busy, read-only, and closed storage", () => {
    const missingOpen = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      expect(() =>
        createSettingsRepository(missingOpen.db).transitionHostLock({
          locked: true,
          now: laterNow()
        })
      ).toThrowError(expect.objectContaining({ code: "settings_missing" }));
    } finally {
      missingOpen.db.close();
    }

    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    const firstRepo = createSettingsRepository(first.db);
    firstRepo.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
    const second = openMigratedDatabase(path, { now: fixedNow });
    second.db.pragma("busy_timeout = 1");
    try {
      first.db.exec("BEGIN IMMEDIATE");
      expect(() =>
        createSettingsRepository(second.db).transitionHostLock({
          locked: true,
          now: laterNow()
        })
      ).toThrowError(
        expect.objectContaining({ code: "settings_unavailable" })
      );
      first.db.exec("ROLLBACK");
      expect(
        createSettingsRepository(second.db).transitionHostLock({
          locked: true,
          now: laterNow()
        }).changed
      ).toBe(true);
    } finally {
      if (first.db.inTransaction) first.db.exec("ROLLBACK");
      second.db.close();
      first.db.close();
    }

    const readOnly = new Database(path, { readonly: true });
    try {
      expect(() =>
        createSettingsRepository(readOnly).transitionHostLock({
          locked: true,
          now: laterNow()
        })
      ).toThrowError(
        expect.objectContaining({ code: "settings_unavailable" })
      );
    } finally {
      readOnly.close();
    }

    const closed = new Database(path);
    const closedRepo = createSettingsRepository(closed);
    closed.close();
    expect(() =>
      closedRepo.transitionHostLock({ locked: false, now: laterNow() })
    ).toThrowError(expect.objectContaining({ code: "settings_unavailable" }));

    const corrupt = new Database(path);
    try {
      corrupt.pragma("ignore_check_constraints = ON");
      corrupt
        .prepare("UPDATE settings SET bind_port = 0 WHERE id = 'hostdeck_settings'")
        .run();
      corrupt.pragma("ignore_check_constraints = OFF");
      expect(() =>
        createSettingsRepository(corrupt).transitionHostLock({
          locked: false,
          now: new Date("2026-07-08T22:08:00.000Z")
        })
      ).toThrowError(expect.objectContaining({ code: "invalid_settings" }));
    } finally {
      corrupt.close();
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
  return `/tmp/hostdeck-state-${process.pid}-${tempDirs.length}`;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}
