import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthDeviceRepository,
  HostDeckAuthRepositoryError
} from "./auth-repository.js";
import { openMigratedDatabase } from "./migration-runner.js";

const tempDirs: string[] = [];
const rawDeviceToken = "selected_device_token_for_phone_auth_123456";
const rawCsrfToken = "selected_csrf_token_for_phone_auth_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selected auth-device repository", () => {
  it("stores only hashes and authenticates read/write authority", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createAuthDeviceRepository(open.db);
      repository.create({
        id: "client_selected_auth",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });

      expect(repository.authenticateDeviceToken({ rawDeviceToken, now: laterNow() })).toMatchObject({
        trusted: true,
        readOnly: false,
        device: { id: "client_selected_auth" }
      });
      const serializedRows = JSON.stringify(open.db.prepare("SELECT * FROM auth_devices").all());
      expect(serializedRows).not.toContain(rawDeviceToken);
      expect(serializedRows).not.toContain(rawCsrfToken);
    } finally {
      open.db.close();
    }
  });

  it("rejects malformed secrets and unavailable devices", () => {
    const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
    try {
      const repository = createAuthDeviceRepository(open.db);
      expect(() =>
        repository.create({
          id: "client_invalid",
          rawDeviceToken: "short",
          rawCsrfToken,
          permission: "read",
          createdAt: fixedNow()
        })
      ).toThrow(HostDeckAuthRepositoryError);
      expect(() =>
        repository.authenticateDeviceToken({ rawDeviceToken, now: laterNow() })
      ).toThrow(HostDeckAuthRepositoryError);
    } finally {
      open.db.close();
    }
  });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-auth-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:01:00.000Z");
}
