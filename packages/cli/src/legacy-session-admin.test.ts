import { chmodSync, linkSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createLegacySessionAdmin } from "./legacy-session-admin.js";

const tempDirs: string[] = [];
const fixedNow = new Date("2026-07-09T08:00:00.000Z");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("CLI legacy session administration", () => {
  it("exposes only status and confirmed reset", () => {
    const harness = createHarness();
    expect(Object.keys(harness.admin).sort()).toEqual([
      "getLegacySessions",
      "resetLegacySessions"
    ]);
    expect(Object.isFrozen(harness.admin)).toBe(true);
    expect(
      harness.admin.getLegacySessions()
    ).toEqual({
      disposition: "legacy_unmigrated",
      legacy_session_count: 0
    });
    expect(() =>
      harness.admin.resetLegacySessions({ confirmed: false } as never)
    ).toThrow();
  });

  it("reports, resets, and idempotently preserves selected settings", () => {
    const harness = createHarness();
    const opened = openMigratedDatabase(harness.databasePath, {
      now: () => fixedNow
    });
    try {
      const settings = createSettingsRepository(opened.db);
      settings.getOrCreateDefault({
        stateDir: harness.stateDir,
        now: () => fixedNow
      });
      settings.transitionHostLock({ locked: true, now: fixedNow });
      opened.db
        .prepare(
          `
            INSERT INTO sessions (
              id, name, cwd, backend_type, tmux_session, tmux_window, tmux_pane,
              lifecycle_state, created_at, updated_at, stale_reason
            ) VALUES (?, ?, ?, 'tmux', ?, NULL, NULL, 'stopped', ?, ?, NULL)
          `
        )
        .run(
          "sess_legacy_admin_01",
          "legacy-admin",
          "/tmp/legacy-admin",
          "hostdeck_sess_legacy_admin_01",
          fixedNow.toISOString(),
          fixedNow.toISOString()
        );
    } finally {
      opened.db.close();
    }

    expect(harness.admin.getLegacySessions()).toEqual({
      disposition: "legacy_unmigrated",
      legacy_session_count: 1
    });
    expect(
      harness.admin.resetLegacySessions({ confirmed: true })
    ).toEqual({
      disposition: "legacy_unmigrated",
      removed_session_count: 1,
      remaining_session_count: 0
    });
    expect(
      harness.admin.resetLegacySessions({ confirmed: true })
    ).toEqual({
      disposition: "legacy_unmigrated",
      removed_session_count: 0,
      remaining_session_count: 0
    });

    const verified = openMigratedDatabase(harness.databasePath);
    try {
      expect(createSettingsRepository(verified.db).require().locked).toBe(true);
    } finally {
      verified.db.close();
    }
  });

  it("repairs owner mode drift and rejects a hard-linked database", () => {
    const harness = createHarness();
    harness.admin.getLegacySessions();
    chmodSync(harness.databasePath, 0o644);

    harness.admin.getLegacySessions();
    expect(lstatSync(harness.databasePath).mode & 0o7777).toBe(0o600);

    linkSync(
      harness.databasePath,
      join(harness.stateDir, "hostdeck-copy.sqlite")
    );
    expect(() => harness.admin.getLegacySessions()).toThrow(/not secure/u);
  });
});

function createHarness(): {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly admin: ReturnType<typeof createLegacySessionAdmin>;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "hostdeck-cli-legacy-admin-"));
  const databasePath = join(stateDir, "hostdeck.sqlite");
  tempDirs.push(stateDir);
  return {
    stateDir,
    databasePath,
    admin: createLegacySessionAdmin({
      stateDir,
      databasePath,
      now: () => fixedNow
    })
  };
}
