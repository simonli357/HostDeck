import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckLanConfigurationRepository,
  type HostDeckLanCertificateDescriptor
} from "./lan-configuration-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";
import { createSettingsRepository } from "./settings-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected LAN configuration repository", () => {
  it("configures one exact durable descriptor without enabling LAN", () => {
    const open = preparedDatabase();
    try {
      const repository = createHostDeckLanConfigurationRepository(open.db);
      expect(repository.read().configuration).toBeNull();
      const receipt = repository.configure({ ...descriptor(), now: configureNow() });

      expect(receipt).toEqual({
        before: null,
        after: {
          id: "hostdeck_lan_configuration",
          schema_version: 1,
          ...descriptor(),
          updated_at: configureNow().toISOString()
        },
        changed: true
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.after)).toBe(true);
      expect(repository.read()).toMatchObject({
        settings: {
          bind_mode: "localhost",
          bind_host: "127.0.0.1",
          lan_enabled: false
        },
        configuration: descriptor()
      });
    } finally {
      open.db.close();
    }
  });

  it("keeps equal configuration as a true no-op and rejects regressing changed state", () => {
    const open = preparedDatabase();
    try {
      const repository = createHostDeckLanConfigurationRepository(open.db);
      repository.configure({ ...descriptor(), now: configureNow() });
      const noOp = repository.configure({ ...descriptor(), now: fixedNow() });
      expect(noOp.changed).toBe(false);
      expect(noOp.after.updated_at).toBe(configureNow().toISOString());

      expect(() =>
        repository.configure({
          ...descriptor({ bind_port: 8443 }),
          now: fixedNow()
        })
      ).toThrowError(
        expect.objectContaining({ code: "lan_configuration_time_conflict" })
      );
      expect(repository.read().configuration?.bind_port).toBe(3777);
    } finally {
      open.db.close();
    }
  });

  it("enables and disables only selected settings network fields", () => {
    const open = preparedDatabase();
    try {
      const settings = createSettingsRepository(open.db);
      settings.transitionHostLock({ locked: true, now: lockNow() });
      const before = settings.require();
      const repository = createHostDeckLanConfigurationRepository(open.db);
      repository.configure({ ...descriptor(), now: configureAfterLockNow() });

      const enabled = repository.transitionMode({
        enabled: true,
        expected_configuration: descriptor(),
        now: enableNow()
      });
      expect(enabled).toEqual({
        before: {
          mode: "loopback",
          host: "127.0.0.1",
          port: 3777,
          settings_updated_at: before.updated_at
        },
        after: {
          mode: "lan",
          host: "192.168.0.29",
          port: 3777,
          settings_updated_at: enableNow().toISOString()
        },
        changed: true
      });
      expect(repository.transitionMode({
        enabled: true,
        expected_configuration: descriptor(),
        now: fixedNow()
      }).changed).toBe(false);
      expect(settings.require()).toEqual({
        ...before,
        bind_mode: "lan",
        bind_host: "192.168.0.29",
        lan_enabled: true,
        updated_at: enableNow().toISOString()
      });

      const disabled = repository.transitionMode({ enabled: false, now: disableNow() });
      expect(disabled.after).toEqual({
        mode: "loopback",
        host: "127.0.0.1",
        port: 3777,
        settings_updated_at: disableNow().toISOString()
      });
      expect(repository.transitionMode({ enabled: false, now: fixedNow() }).changed).toBe(false);
      expect(settings.require()).toEqual({
        ...before,
        bind_mode: "localhost",
        bind_host: "127.0.0.1",
        lan_enabled: false,
        updated_at: disableNow().toISOString()
      });
      expect(repository.read().configuration).toMatchObject(descriptor());
    } finally {
      open.db.close();
    }
  });

  it("rejects missing, stale, or enabled configuration without partial mutation", () => {
    const open = preparedDatabase();
    try {
      const repository = createHostDeckLanConfigurationRepository(open.db);
      expect(() =>
        repository.transitionMode({
          enabled: true,
          expected_configuration: descriptor(),
          now: enableNow()
        })
      ).toThrowError(expect.objectContaining({ code: "lan_configuration_missing" }));

      repository.configure({ ...descriptor(), now: configureNow() });
      expect(() =>
        repository.transitionMode({
          enabled: true,
          expected_configuration: descriptor({ leaf_fingerprint_sha256: "c".repeat(64) }),
          now: enableNow()
        })
      ).toThrowError(expect.objectContaining({ code: "lan_configuration_conflict" }));
      expect(repository.read().settings.lan_enabled).toBe(false);

      repository.transitionMode({
        enabled: true,
        expected_configuration: descriptor(),
        now: enableNow()
      });
      expect(() =>
        repository.configure({
          ...descriptor({ bind_port: 8443 }),
          now: disableNow()
        })
      ).toThrowError(expect.objectContaining({ code: "lan_configuration_conflict" }));
      expect(repository.read()).toMatchObject({
        settings: { lan_enabled: true, bind_port: 3777 },
        configuration: { bind_port: 3777 }
      });
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed, inherited, accessor, and contradictory inputs before writes", () => {
    const open = preparedDatabase();
    try {
      const repository = createHostDeckLanConfigurationRepository(open.db);
      const valid = { ...descriptor(), now: configureNow() };
      const invalid: unknown[] = [
        null,
        {},
        { ...valid, bind_host: "192.168.000.029" },
        { ...valid, address_family: "ipv6" },
        { ...valid, configured_origin: "https://192.168.0.30:3777" },
        { ...valid, bind_port: 0 },
        { ...valid, root_fingerprint_sha256: "A".repeat(64) },
        { ...valid, leaf_expires_at: valid.leaf_valid_from },
        { ...valid, now: new Date(Number.NaN) },
        { ...valid, extra: true },
        Object.assign(Object.create({ bind_host: valid.bind_host }), {
          ...valid,
          bind_host: undefined
        })
      ];
      const accessor = { ...valid } as Record<string, unknown>;
      Object.defineProperty(accessor, "now", { enumerable: true, get: configureNow });
      invalid.push(accessor);
      for (const candidate of invalid) {
        expect(() => repository.configure(candidate as never)).toThrowError(
          expect.objectContaining({ code: "invalid_lan_configuration" })
        );
      }
      expect(repository.read().configuration).toBeNull();
    } finally {
      open.db.close();
    }
  });

  it("serializes two writers and preserves state across restart", () => {
    const path = tempDbPath();
    const first = openMigratedDatabase(path, { now: fixedNow });
    createSettingsRepository(first.db).getOrCreateDefault({
      stateDir: tempStateDir(),
      now: fixedNow
    });
    const second = openMigratedDatabase(path, { now: fixedNow });
    second.db.pragma("busy_timeout = 1");
    try {
      first.db.exec("BEGIN IMMEDIATE");
      expect(() =>
        createHostDeckLanConfigurationRepository(second.db).configure({
          ...descriptor(),
          now: configureNow()
        })
      ).toThrowError(
        expect.objectContaining({ code: "lan_configuration_unavailable" })
      );
      first.db.exec("ROLLBACK");
      createHostDeckLanConfigurationRepository(second.db).configure({
        ...descriptor(),
        now: configureNow()
      });
    } finally {
      if (first.db.inTransaction) first.db.exec("ROLLBACK");
      second.db.close();
      first.db.close();
    }

    const reopened = openMigratedDatabase(path, { now: fixedNow });
    try {
      expect(createHostDeckLanConfigurationRepository(reopened.db).read()).toMatchObject({
        settings: { lan_enabled: false },
        configuration: descriptor()
      });
    } finally {
      reopened.db.close();
    }
  });

  it("fails closed for missing, corrupt, read-only, and closed storage", () => {
    const missing = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      expect(() => createHostDeckLanConfigurationRepository(missing.db).read()).toThrowError(
        expect.objectContaining({ code: "settings_missing" })
      );
    } finally {
      missing.db.close();
    }

    const path = tempDbPath();
    const open = openMigratedDatabase(path, { now: fixedNow });
    createSettingsRepository(open.db).getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
    createHostDeckLanConfigurationRepository(open.db).configure({ ...descriptor(), now: configureNow() });
    open.db.close();

    const readOnly = new Database(path, { readonly: true });
    try {
      expect(() =>
        createHostDeckLanConfigurationRepository(readOnly).transitionMode({
          enabled: true,
          expected_configuration: descriptor(),
          now: enableNow()
        })
      ).toThrowError(
        expect.objectContaining({ code: "lan_configuration_unavailable" })
      );
    } finally {
      readOnly.close();
    }

    const closed = new Database(path);
    const closedRepository = createHostDeckLanConfigurationRepository(closed);
    closed.close();
    expect(() => closedRepository.read()).toThrowError(
      expect.objectContaining({ code: "lan_configuration_unavailable" })
    );

    const corrupt = new Database(path);
    try {
      corrupt.pragma("ignore_check_constraints = ON");
      corrupt.prepare(
        "UPDATE selected_lan_configuration SET bind_host = '0.0.0.0' WHERE id = 'hostdeck_lan_configuration'"
      ).run();
      corrupt.pragma("ignore_check_constraints = OFF");
      expect(() => createHostDeckLanConfigurationRepository(corrupt).read()).toThrowError(
        expect.objectContaining({ code: "invalid_lan_configuration" })
      );
    } finally {
      corrupt.close();
    }
  });
});

function preparedDatabase() {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  createSettingsRepository(open.db).getOrCreateDefault({
    stateDir: tempStateDir(),
    now: fixedNow
  });
  return open;
}

function descriptor(
  overrides: Partial<HostDeckLanCertificateDescriptor> = {}
): HostDeckLanCertificateDescriptor {
  const result: HostDeckLanCertificateDescriptor = {
    bind_host: "192.168.0.29",
    address_family: "ipv4",
    bind_port: 3777,
    configured_origin: "https://192.168.0.29:3777",
    root_fingerprint_sha256: "a".repeat(64),
    leaf_fingerprint_sha256: "b".repeat(64),
    leaf_valid_from: "2026-07-12T20:00:00.000Z",
    leaf_expires_at: "2027-08-13T20:00:00.000Z",
    ...overrides
  };
  return {
    ...result,
    configured_origin:
      overrides.configured_origin ??
      `https://${result.bind_host.includes(":") ? `[${result.bind_host}]` : result.bind_host}:${result.bind_port}`
  };
}

function fixedNow(): Date {
  return new Date("2026-07-12T19:00:00.000Z");
}

function lockNow(): Date {
  return new Date("2026-07-12T19:30:00.000Z");
}

function configureNow(): Date {
  return new Date("2026-07-12T20:00:00.000Z");
}

function configureAfterLockNow(): Date {
  return new Date("2026-07-12T20:30:00.000Z");
}

function enableNow(): Date {
  return new Date("2026-07-12T21:00:00.000Z");
}

function disableNow(): Date {
  return new Date("2026-07-12T22:00:00.000Z");
}

function tempStateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-lan-state-"));
  tempDirs.push(directory);
  return directory;
}

function tempDbPath(): string {
  return join(tempStateDir(), "hostdeck.sqlite");
}
