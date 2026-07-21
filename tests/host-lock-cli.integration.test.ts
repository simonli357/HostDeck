import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import { defaultResourceBudget } from "../packages/contracts/src/index.js";
import {
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createSecurityMutationAuditExecutor
} from "../packages/server/src/index.js";
import {
  createSelectedAuditRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";

const temporaryDirectories: string[] = [];
const createdAt = "2026-07-20T14:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("host-lock CLI vertical", () => {
  it("uses selected HTTP audit/storage and never opens the CLI database path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-host-lock-cli-"));
    temporaryDirectories.push(directory);
    const serverDatabasePath = join(directory, "server.sqlite");
    const cliStateDir = join(directory, "cli-legacy-state");
    const cliDatabasePath = join(cliStateDir, "must-not-open.sqlite");
    const opened = openMigratedDatabase(serverDatabasePath, {
      now: () => new Date(createdAt)
    });
    const settings = createSettingsRepository(opened.db);
    settings.getOrCreateDefault({
      stateDir: join(directory, "server-state"),
      now: () => new Date(createdAt)
    });
    let transitionClock = Date.parse(createdAt);
    const nextTransitionDate = () => {
      transitionClock += 1_000;
      return new Date(transitionClock);
    };
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings.readHostLock(),
        transition: (input) => settings.transitionHostLock(input)
      },
      now: nextTransitionDate
    });
    const audits = createSelectedAuditRepository(opened.db);
    let auditId = 0;
    const audit = createSecurityMutationAuditExecutor({
      repository: audits,
      now: () => nextTransitionDate().toISOString(),
      create_record_id: () => `audit_host_lock_cli_${++auditId}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Local CLI lock must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Local CLI lock must not rotate browser CSRF.");
        }
      },
      now: () => new Date(createdAt)
    });
    const port = await availableLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Local CLI lock must not authenticate a device.");
        },
        now: () => new Date(createdAt)
      }),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: origin
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckHostLockRouteRegistration({ audit, csrf, lock })
      ]
    });
    await app.listen({
      host: "127.0.0.1",
      port,
      listenTextResolver: () => ""
    });

    try {
      const common = [
        "--api-url",
        origin,
        "--state-dir",
        cliStateDir,
        "--database",
        cliDatabasePath
      ] as const;
      const locked = await runCli([...common, "lock", "--json"], {
        env: {},
        createHostLockOperationId: () => "op_host_lock_vertical_001"
      });
      const unlocked = await runCli([...common, "unlock", "--json"], {
        env: {},
        createHostLockOperationId: () => "op_host_unlock_vertical_001"
      });

      expect(locked).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(locked.stdout)).toMatchObject({
        authentication_state: "local_admin",
        configured_origin: origin,
        network_mode: "loopback",
        transport: "http",
        locked: true
      });
      expect(unlocked).toMatchObject({
        exitCode: cliExitCodes.ok,
        stderr: ""
      });
      expect(JSON.parse(unlocked.stdout)).toMatchObject({ locked: false });
      expect(settings.readHostLock().locked).toBe(false);
      expect(audits.require("op_host_lock_vertical_001").records).toMatchObject([
        { phase: "accepted", action: "lock", outcome: "accepted" },
        { phase: "terminal", action: "lock", outcome: "succeeded" }
      ]);
      expect(
        audits.require("op_host_unlock_vertical_001").records
      ).toMatchObject([
        { phase: "accepted", action: "unlock", outcome: "accepted" },
        { phase: "terminal", action: "unlock", outcome: "succeeded" }
      ]);
      expect(existsSync(cliStateDir)).toBe(false);
      expect(existsSync(cliDatabasePath)).toBe(false);
    } finally {
      await app.close();
      opened.db.close();
    }
  });
});

function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Loopback port allocation failed.")));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}
