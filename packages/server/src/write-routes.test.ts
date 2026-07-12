import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageSessionRecord } from "@hostdeck/contracts";
import {
  type AuditEventRepository,
  createAuditEventRepository,
  createAuthDeviceRepository,
  createSessionRepository,
  createSettingsRepository,
  HostDeckAuditRepositoryError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { createFakeTmuxAdapter, type FakeTmuxAdapter } from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createWriteRouteHandlers } from "./write-routes.js";

const tempDirs: string[] = [];
const timestamp = "2026-07-09T08:00:00.000Z";
const laterTimestamp = "2026-07-09T08:05:00.000Z";
const rawDeviceToken = "device_token_for_write_route_123456";
const rawCsrfToken = "csrf_token_for_write_route_123456";
const readOnlyDeviceToken = "device_token_for_read_only_write_route_123456";
const readOnlyCsrfToken = "csrf_token_for_read_only_write_route_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("session write route handlers", () => {
  it("accepts prompt, slash, stop, and raw-input writes after audit preflight and exact tmux dispatch", async () => {
    const harness = createHarness();

    try {
      harness.createWriteDevice();
      const prompt = await harness.createRunningSession("sess_write_route_01", "prompt-demo");
      const slash = await harness.createRunningSession("sess_write_route_02", "slash-demo");
      const stop = await harness.createRunningSession("sess_write_route_03", "stop-demo");
      const raw = await harness.createRunningSession("sess_write_route_04", "raw-demo");

      await expect(
        harness.handlers.promptInput({
          params: { session_id: prompt.id },
          body: { text: "Continue with the next task." },
          rawDeviceToken,
          rawCsrfToken
        })
      ).resolves.toMatchObject({
        status: 202,
        body: { accepted: true, session_id: prompt.id, action: "prompt", audit_required: true }
      });

      await expect(
        harness.handlers.slashCommand({
          params: { session_id: slash.id },
          body: { command: "/plan", argument: "next route work" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).resolves.toMatchObject({
        status: 202,
        body: { accepted: true, session_id: slash.id, action: "slash", audit_required: true }
      });

      await expect(
        harness.handlers.stopSession({
          params: { session_id: stop.id },
          body: { confirm: true },
          rawDeviceToken,
          rawCsrfToken
        })
      ).resolves.toMatchObject({
        status: 202,
        body: { accepted: true, session_id: stop.id, action: "stop", audit_required: true }
      });

      await expect(
        harness.handlers.rawInput({
          params: { session_id: raw.id },
          body: { text: "q", confirmed: true },
          rawDeviceToken,
          rawCsrfToken
        })
      ).resolves.toMatchObject({
        status: 202,
        body: { accepted: true, session_id: raw.id, action: "raw_input", audit_required: true }
      });

      expect(harness.tmux.sentInputs()).toMatchObject([
        { sessionId: prompt.id, text: "Continue with the next task.", enter: true },
        { sessionId: slash.id, text: "/plan next route work", enter: true },
        { sessionId: raw.id, text: "q", enter: false }
      ]);
      await expect(harness.tmux.getTarget(stop.id)).resolves.toBeNull();
      expect(harness.sessions.require(stop.id)).toMatchObject({
        lifecycle_state: "stopped",
        stale_reason: null,
        updated_at: timestamp
      });
      expect(harness.audit.require("audit_001")).toMatchObject({
        actor: { type: "dashboard", client_id: "client_write_route", permission: "write" },
        action: "prompt",
        session_id: prompt.id,
        payload_summary: {
          text_length: 28,
          text_preview: "Continue with the next task."
        },
        result: "accepted",
        error_code: null
      });
      expect(harness.audit.require("audit_002")).toMatchObject({
        action: "slash",
        session_id: slash.id,
        payload_summary: {
          command: "/plan",
          argument_length: 15
        },
        result: "accepted"
      });
      expect(harness.audit.require("audit_003")).toMatchObject({
        action: "stop",
        session_id: stop.id,
        payload_summary: { confirmed: true },
        result: "accepted"
      });
      expect(harness.audit.require("audit_004")).toMatchObject({
        action: "raw_input",
        session_id: raw.id,
        payload_summary: { text_length: 1, confirmed: true },
        result: "accepted"
      });
    } finally {
      harness.close();
    }
  });

  it("accepts local-admin CLI writes without browser cookie or CSRF tokens", async () => {
    const harness = createHarness();

    try {
      const prompt = await harness.createRunningSession("sess_write_cli_01", "cli-prompt-demo");
      const stop = await harness.createRunningSession("sess_write_cli_02", "cli-stop-demo");

      await expect(
        harness.handlers.promptInput({
          params: { session_id: prompt.id },
          body: { text: "Continue from CLI." },
          localAdmin: true
        })
      ).resolves.toMatchObject({
        status: 202,
        body: { accepted: true, session_id: prompt.id, action: "prompt", audit_required: true }
      });

      await expect(
        harness.handlers.stopSession({
          params: { session_id: stop.id },
          body: { confirm: true },
          localAdmin: true
        })
      ).resolves.toMatchObject({
        status: 202,
        body: { accepted: true, session_id: stop.id, action: "stop", audit_required: true }
      });

      expect(harness.tmux.sentInputs()).toMatchObject([{ sessionId: prompt.id, text: "Continue from CLI.", enter: true }]);
      await expect(harness.tmux.getTarget(stop.id)).resolves.toBeNull();
      expect(harness.audit.require("audit_001")).toMatchObject({
        actor: { type: "cli", client_id: "local_admin", permission: "write" },
        action: "prompt",
        session_id: prompt.id,
        result: "accepted"
      });
      expect(harness.audit.require("audit_002")).toMatchObject({
        actor: { type: "cli", client_id: "local_admin", permission: "write" },
        action: "stop",
        session_id: stop.id,
        result: "accepted"
      });
    } finally {
      harness.close();
    }
  });

  it("rejects malformed requests, missing sessions, untrusted clients, read-only clients, locked hosts, unsupported slash, multi-session writes, and raw input without tmux send", async () => {
    const malformedHarness = createHarness();

    try {
      malformedHarness.createWriteDevice();
      expect(
        await malformedHarness.handlers.promptInput({
          params: { session_id: "bad" },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 400,
        body: { accepted: false, error: { code: "validation_error", field: "session_id" } }
      });
      expect(
        await malformedHarness.handlers.promptInput({
          params: { session_id: "sess_write_missing_01" },
          body: {},
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 400,
        body: { accepted: false, error: { code: "validation_error", field: "body" } }
      });
      expect(malformedHarness.tmux.sentInputs()).toEqual([]);
      expect(malformedHarness.audit.list()).toHaveLength(0);
    } finally {
      malformedHarness.close();
    }

    const harness = createHarness();

    try {
      harness.createWriteDevice();
      harness.createReadOnlyDevice();
      harness.authDevices.create({
        id: "client_expired_route",
        rawDeviceToken: "device_token_for_expired_write_route_123456",
        rawCsrfToken: "csrf_token_for_expired_write_route_123456",
        permission: "write",
        createdAt: fixedNow(),
        expiresAt: new Date("2026-07-09T07:00:00.000Z")
      });
      harness.authDevices.create({
        id: "client_revoked_route",
        rawDeviceToken: "device_token_for_revoked_write_route_123456",
        rawCsrfToken: "csrf_token_for_revoked_write_route_123456",
        permission: "write",
        createdAt: fixedNow()
      });
      harness.authDevices.revoke("client_revoked_route", { now: fixedNow() });
      const session = await harness.createRunningSession("sess_write_route_05", "reject-demo");

      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" }
        })
      ).toMatchObject({
        status: 401,
        body: { accepted: false, error: { code: "permission_denied" } }
      });
      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken: "wrong_csrf_token_for_write_route_123456"
        })
      ).toMatchObject({
        status: 403,
        body: { accepted: false, error: { code: "permission_denied" } }
      });
      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken: "device_token_for_expired_write_route_123456",
          rawCsrfToken: "csrf_token_for_expired_write_route_123456"
        })
      ).toMatchObject({
        status: 401,
        body: { accepted: false, error: { code: "permission_denied" } }
      });
      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken: "device_token_for_revoked_write_route_123456",
          rawCsrfToken: "csrf_token_for_revoked_write_route_123456"
        })
      ).toMatchObject({
        status: 401,
        body: { accepted: false, error: { code: "permission_denied" } }
      });
      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken: readOnlyDeviceToken,
          rawCsrfToken: readOnlyCsrfToken
        })
      ).toMatchObject({
        status: 403,
        body: { accepted: false, error: { code: "read_only" } }
      });
      expect(
        await harness.handlers.promptInput({
          params: { session_id: "sess_write_missing_02" },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 404,
        body: { accepted: false, error: { code: "session_not_found" } }
      });

      harness.settings.setLocked(true, { now: laterNow });
      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 423,
        body: {
          accepted: false,
          error: {
            code: "host_locked",
            session_id: session.id,
            details: { denial_code: "locked" }
          }
        }
      });
      harness.settings.setLocked(false, { now: laterNow });

      expect(
        await harness.handlers.slashCommand({
          params: { session_id: session.id },
          body: { command: "/resume" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 400,
        body: {
          accepted: false,
          error: {
            code: "unsupported_slash",
            session_id: session.id,
            details: { denial_code: "unsupported_slash" }
          }
        }
      });

      expect(
        await harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          targetSessionIds: [session.id, "sess_write_other_01"],
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 400,
        body: {
          accepted: false,
          error: {
            code: "validation_error",
            session_id: session.id,
            details: { denial_code: "multi_session_write" }
          }
        }
      });

      expect(
        await harness.handlers.rawInput({
          params: { session_id: session.id },
          body: { text: "q" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 400,
        body: { accepted: false, error: { code: "validation_error", field: "body" } }
      });

      expect(harness.tmux.sentInputs()).toEqual([]);
      expect(harness.audit.require("audit_001")).toMatchObject({ action: "prompt", result: "rejected", error_code: "host_locked" });
      expect(harness.audit.require("audit_002")).toMatchObject({ action: "slash", result: "rejected", error_code: "unsupported_slash" });
      expect(harness.audit.require("audit_003")).toMatchObject({ action: "prompt", result: "rejected", error_code: "validation_error" });
    } finally {
      harness.close();
    }
  });

  it.each([
    ["stale", "stale_session", "stale"],
    ["stopped", "session_not_writable", "stopped"],
    ["crashed", "session_not_writable", "crashed"],
    ["unknown", "session_not_writable", "unknown"],
    ["starting", "session_not_writable", "not_running"],
    ["stopping", "session_not_writable", "not_running"]
  ] satisfies ReadonlyArray<readonly [StorageSessionRecord["lifecycle_state"], string, string]>)(
    "rejects %s session writes before tmux dispatch",
    async (lifecycleState, errorCode, denialCode) => {
      const harness = createHarness();

      try {
        harness.createWriteDevice();
        const session = harness.createSession(`sess_write_${lifecycleState}_01`, `${lifecycleState}-demo`, {
          lifecycle_state: lifecycleState,
          stale_reason: lifecycleState === "stale" ? "tmux target missing" : null
        });

        expect(
          await harness.handlers.promptInput({
            params: { session_id: session.id },
            body: { text: "hello" },
            rawDeviceToken,
            rawCsrfToken
          })
        ).toMatchObject({
          status: 409,
          body: {
            accepted: false,
            error: {
              code: errorCode,
              session_id: session.id,
              details: { denial_code: denialCode }
            }
          }
        });
        expect(harness.tmux.sentInputs()).toEqual([]);
        expect(harness.audit.require("audit_001")).toMatchObject({
          action: "prompt",
          session_id: session.id,
          result: "rejected",
          error_code: errorCode
        });
      } finally {
        harness.close();
      }
    }
  );

  it("rejects audit-unavailable and tmux-dispatch failures without fake accepted success", async () => {
    const auditUnavailable = createHarness({ auditEvents: unavailableAuditEvents() });

    try {
      auditUnavailable.createWriteDevice();
      const session = await auditUnavailable.createRunningSession("sess_write_route_06", "audit-demo");

      expect(
        await auditUnavailable.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 503,
        body: {
          accepted: false,
          error: {
            code: "audit_unavailable",
            retryable: true,
            session_id: session.id
          }
        }
      });
      expect(auditUnavailable.tmux.sentInputs()).toEqual([]);
    } finally {
      auditUnavailable.close();
    }

    const tmuxFailure = createHarness();

    try {
      tmuxFailure.createWriteDevice();
      const session = tmuxFailure.createSession("sess_write_route_07", "tmux-failure-demo");

      expect(
        await tmuxFailure.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 502,
        body: {
          accepted: false,
          error: {
            code: "tmux_error",
            retryable: true,
            session_id: session.id,
            details: {
              error_name: "HostDeckTmuxAdapterError",
              reason: `Tmux target for ${session.id} does not exist.`
            }
          }
        }
      });
      expect(tmuxFailure.audit.require("audit_001")).toMatchObject({
        action: "prompt",
        session_id: session.id,
        result: "accepted",
        error_code: null
      });
      expect(tmuxFailure.audit.require("audit_002")).toMatchObject({
        action: "prompt",
        session_id: session.id,
        result: "failed",
        error_code: "tmux_error"
      });
      expect(tmuxFailure.tmux.sentInputs()).toEqual([]);
    } finally {
      tmuxFailure.close();
    }
  });

  it("classifies monotonic authentication conflicts and failures before session access or dispatch", async () => {
    const conflictHarness = createHarness();
    try {
      conflictHarness.createWriteDevice();
      conflictHarness.authDevices.authenticateDeviceToken({ rawDeviceToken, now: laterNow() });

      expect(
        await conflictHarness.handlers.promptInput({
          params: { session_id: "sess_write_auth_conflict_01" },
          body: { text: "must not dispatch" },
          rawDeviceToken,
          rawCsrfToken
        })
      ).toMatchObject({
        status: 409,
        body: { accepted: false, error: { code: "operation_conflict" } }
      });
      expect(conflictHarness.audit.list()).toEqual([]);
      expect(conflictHarness.tmux.sentInputs()).toEqual([]);
    } finally {
      conflictHarness.close();
    }

    const failureHarness = createHarness();
    try {
      failureHarness.createWriteDevice();
      failureHarness.db.exec(`
        CREATE TRIGGER fail_write_route_auth_touch
        BEFORE UPDATE OF last_used_at ON auth_devices
        BEGIN
          SELECT RAISE(ABORT, 'forced write route auth failure');
        END;
      `);

      const failed = await failureHarness.handlers.promptInput({
        params: { session_id: "sess_write_auth_failure_01" },
        body: { text: "must not dispatch" },
        rawDeviceToken,
        rawCsrfToken
      });
      expect(failed).toMatchObject({
        status: 500,
        body: { accepted: false, error: { code: "storage_error", message: "Auth device authentication failed." } }
      });
      expect(JSON.stringify(failed)).not.toMatch(/forced write route auth|device_token|csrf_token/iu);
      expect(failureHarness.audit.list()).toEqual([]);
      expect(failureHarness.tmux.sentInputs()).toEqual([]);
    } finally {
      failureHarness.close();
    }
  });
});

function createHarness(input: { readonly auditEvents?: AuditEventRepository } = {}) {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  const settings = createSettingsRepository(open.db);
  settings.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
  const sessions = createSessionRepository(open.db);
  const authDevices = createAuthDeviceRepository(open.db);
  const audit = createAuditEventRepository(open.db);
  const tmux = createFakeTmuxAdapter({ now: fixedNow });
  let nextAuditId = 1;
  const handlers = createWriteRouteHandlers({
    sessions,
    settings,
    authDevices,
    auditEvents: input.auditEvents ?? audit,
    tmux,
    now: fixedNow,
    createAuditId: () => `audit_${String(nextAuditId++).padStart(3, "0")}`
  });

  return {
    audit,
    authDevices,
    db: open.db,
    handlers,
    sessions,
    settings,
    tmux,
    createWriteDevice() {
      return authDevices.create({
        id: "client_write_route",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });
    },
    createReadOnlyDevice() {
      return authDevices.create({
        id: "client_read_only_route",
        rawDeviceToken: readOnlyDeviceToken,
        rawCsrfToken: readOnlyCsrfToken,
        permission: "read",
        createdAt: fixedNow()
      });
    },
    createSession(id: string, name: string, overrides: Partial<StorageSessionRecord> = {}) {
      return sessions.create(sessionRecord(id, name, overrides));
    },
    async createRunningSession(id: string, name: string) {
      const session = sessions.create(sessionRecord(id, name));
      await startFakeTarget(tmux, session);
      return session;
    },
    close: () => open.db.close()
  };
}

async function startFakeTarget(tmux: FakeTmuxAdapter, session: StorageSessionRecord) {
  await tmux.startSession({
    sessionId: session.id,
    sessionName: session.name,
    cwd: session.cwd,
    command: ["codex"]
  });
}

function sessionRecord(id: string, name: string, overrides: Partial<StorageSessionRecord> = {}): StorageSessionRecord {
  return {
    id,
    name,
    cwd: tempCwd(),
    backend: {
      type: "tmux",
      tmux_session: `hostdeck_${id}`,
      tmux_window: "codex",
      tmux_pane: "%1"
    },
    lifecycle_state: "running",
    created_at: timestamp,
    updated_at: timestamp,
    stale_reason: null,
    ...overrides
  } as StorageSessionRecord;
}

function unavailableAuditEvents(): AuditEventRepository {
  return {
    append() {
      throw new HostDeckAuditRepositoryError("audit_unavailable", "Audit storage is unavailable.");
    },
    get() {
      return null;
    },
    require() {
      throw new HostDeckAuditRepositoryError("audit_event_not_found", "Audit event does not exist.");
    },
    list() {
      return [];
    }
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-write-routes-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-write-routes-state-"));
  tempDirs.push(dir);
  return dir;
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-write-routes-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date(timestamp);
}

function laterNow(): Date {
  return new Date(laterTimestamp);
}
