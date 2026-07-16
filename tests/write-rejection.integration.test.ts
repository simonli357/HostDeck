import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type { StorageSessionRecord } from "../packages/contracts/src/index.js";
import { createWriteRouteHandlers, type WriteRouteResult } from "../packages/server/src/index.js";
import {
  type AuditEventRepository,
  createAuditEventRepository,
  createAuthDeviceRepository,
  createSessionRepository,
  createSettingsRepository,
  HostDeckAuditRepositoryError,
  openMigratedDatabase
} from "../packages/storage/src/index.js";
import { createFakeTmuxAdapter, type FakeTmuxAdapter, type TmuxAdapter } from "../packages/tmux-adapter/src/index.js";

const tempDirs: string[] = [];
const timestamp = "2026-07-09T08:00:00.000Z";
const laterTimestamp = "2026-07-09T08:05:00.000Z";
const rawDeviceToken = "device_token_for_write_integration_123456";
const rawCsrfToken = "csrf_token_for_write_integration_123456";
const readOnlyDeviceToken = "device_token_for_read_only_write_integration_123456";
const readOnlyCsrfToken = "csrf_token_for_read_only_write_integration_123456";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("write rejection integration", () => {
  it.each([
    {
      name: "malformed session id",
      setup: (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        return harness.handlers.promptInput({
          params: { session_id: "bad" },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 400,
      expectedCode: "validation_error",
      expectedField: "session_id",
      expectedAudit: null
    },
    {
      name: "malformed prompt body",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        const session = await harness.createRunningSession("sess_int_reject_bad_body_01", "bad-body");
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: {},
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 400,
      expectedCode: "validation_error",
      expectedField: "body",
      expectedAudit: null
    },
    {
      name: "untrusted dashboard write",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        const session = await harness.createRunningSession("sess_int_reject_untrusted_01", "untrusted");
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" }
        });
      },
      expectedStatus: 401,
      expectedCode: "permission_denied",
      expectedAudit: null
    },
    {
      name: "read-only paired client",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createReadOnlyDevice();
        const session = await harness.createRunningSession("sess_int_reject_readonly_01", "read-only");
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken: readOnlyDeviceToken,
          rawCsrfToken: readOnlyCsrfToken
        });
      },
      expectedStatus: 403,
      expectedCode: "read_only",
      expectedAudit: null
    },
    {
      name: "locked host",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        const session = await harness.createRunningSession("sess_int_reject_locked_01", "locked");
        harness.settings.setLocked(true, { now: laterNow });
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 423,
      expectedCode: "host_locked",
      expectedAudit: "host_locked"
    },
    {
      name: "stale session",
      setup: (harness: WriteIntegrationHarness) => {
        const session = harness.createSession("sess_int_reject_stale_01", "stale", {
          lifecycle_state: "stale",
          stale_reason: "tmux target missing"
        });
        harness.createWriteDevice();
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 409,
      expectedCode: "stale_session",
      expectedAudit: "stale_session"
    },
    {
      name: "stopped session",
      setup: (harness: WriteIntegrationHarness) => {
        const session = harness.createSession("sess_int_reject_stopped_01", "stopped", { lifecycle_state: "stopped" });
        harness.createWriteDevice();
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 409,
      expectedCode: "session_not_writable",
      expectedAudit: "session_not_writable"
    },
    {
      name: "crashed session",
      setup: (harness: WriteIntegrationHarness) => {
        const session = harness.createSession("sess_int_reject_crashed_01", "crashed", { lifecycle_state: "crashed" });
        harness.createWriteDevice();
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 409,
      expectedCode: "session_not_writable",
      expectedAudit: "session_not_writable"
    },
    {
      name: "unknown session lifecycle",
      setup: (harness: WriteIntegrationHarness) => {
        const session = harness.createSession("sess_int_reject_unknown_01", "unknown", { lifecycle_state: "unknown" });
        harness.createWriteDevice();
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 409,
      expectedCode: "session_not_writable",
      expectedAudit: "session_not_writable"
    },
    {
      name: "unsupported slash command",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        const session = await harness.createRunningSession("sess_int_reject_slash_01", "slash");
        return harness.handlers.slashCommand({
          params: { session_id: session.id },
          body: { command: "/resume" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 400,
      expectedCode: "unsupported_slash",
      expectedAudit: "unsupported_slash"
    },
    {
      name: "multi-session target list",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        const session = await harness.createRunningSession("sess_int_reject_multi_01", "multi");
        return harness.handlers.promptInput({
          params: { session_id: session.id },
          body: { text: "hello" },
          targetSessionIds: [session.id, "sess_int_reject_multi_02"],
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 400,
      expectedCode: "validation_error",
      expectedAudit: "validation_error"
    },
    {
      name: "raw input without confirmation",
      setup: async (harness: WriteIntegrationHarness) => {
        harness.createWriteDevice();
        const session = await harness.createRunningSession("sess_int_reject_raw_01", "raw");
        return harness.handlers.rawInput({
          params: { session_id: session.id },
          body: { text: "q" },
          rawDeviceToken,
          rawCsrfToken
        });
      },
      expectedStatus: 400,
      expectedCode: "validation_error",
      expectedField: "body",
      expectedAudit: null
    }
  ] satisfies readonly RejectionScenario[])("rejects $name before tmux dispatch", async (scenario) => {
    const harness = createHarness();

    try {
      const result = await scenario.setup(harness);

      expect(result).toMatchObject({
        status: scenario.expectedStatus,
        body: {
          accepted: false,
          error: {
            code: scenario.expectedCode,
            ...(scenario.expectedField !== undefined ? { field: scenario.expectedField } : {})
          }
        }
      });
      expect(harness.dispatch.sendAttempts()).toBe(0);
      expect(harness.dispatch.stopAttempts()).toBe(0);
      expect(harness.tmux.sentInputs()).toEqual([]);

      if (scenario.expectedAudit === null) {
        expect(harness.audit.list()).toHaveLength(0);
      } else {
        expect(harness.audit.require("audit_001")).toMatchObject({
          result: "rejected",
          error_code: scenario.expectedAudit
        });
      }
    } finally {
      harness.close();
    }
  });

  it("rejects audit-unavailable writes before tmux dispatch", async () => {
    const harness = createHarness({ auditEvents: unavailableAuditEvents() });

    try {
      harness.createWriteDevice();
      const session = await harness.createRunningSession("sess_int_reject_audit_01", "audit");
      const result = await harness.handlers.stopSession({
        params: { session_id: session.id },
        body: { confirm: true },
        rawDeviceToken,
        rawCsrfToken
      });

      expect(result).toMatchObject({
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
      expect(harness.dispatch.sendAttempts()).toBe(0);
      expect(harness.dispatch.stopAttempts()).toBe(0);
      expect(harness.tmux.sentInputs()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("reports tmux dispatch failure without returning fake accepted success", async () => {
    const harness = createHarness();

    try {
      harness.createWriteDevice();
      const session = harness.createSession("sess_int_reject_dispatch_01", "dispatch-missing-target");
      const result = await harness.handlers.promptInput({
        params: { session_id: session.id },
        body: { text: "hello" },
        rawDeviceToken,
        rawCsrfToken
      });

      expect(result).toMatchObject({
        status: 502,
        body: {
          accepted: false,
          error: {
            code: "tmux_error",
            retryable: true,
            session_id: session.id
          }
        }
      });
      expect(harness.dispatch.sendAttempts()).toBe(1);
      expect(harness.dispatch.stopAttempts()).toBe(0);
      expect(harness.tmux.sentInputs()).toEqual([]);
      expect(harness.audit.require("audit_001")).toMatchObject({ result: "accepted", error_code: null });
      expect(harness.audit.require("audit_002")).toMatchObject({ result: "failed", error_code: "tmux_error" });
    } finally {
      harness.close();
    }
  });

  it("reports daemon-unavailable write commands before any write can reach the daemon", async () => {
    for (const args of [
      ["send", "sess_int_reject_unavailable_01", "hello"],
      ["stop", "contract-demo"]
    ] as const) {
      const result = await runCli(args, {
        env: {},
        fetch: async () => {
          throw new TypeError("connect ECONNREFUSED");
        }
      });

      expect(result.exitCode).toBe(cliExitCodes.daemonUnavailable);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("HostDeck CLI error (daemon_unavailable)");
      expect(result.stderr).toContain("Start the daemon with `codexdeck serve`, then retry.");
    }
  });
});

interface RejectionScenario {
  readonly name: string;
  readonly setup: (harness: WriteIntegrationHarness) => Promise<WriteRouteResult> | WriteRouteResult;
  readonly expectedStatus: number;
  readonly expectedCode: string;
  readonly expectedField?: string;
  readonly expectedAudit: string | null;
}

type WriteIntegrationHarness = ReturnType<typeof createHarness>;

function createHarness(input: { readonly auditEvents?: AuditEventRepository } = {}) {
  const open = openMigratedDatabase(tempDbPath(), { now: fixedNow });
  const settings = createSettingsRepository(open.db);
  settings.getOrCreateDefault({ stateDir: tempStateDir(), now: fixedNow });
  const sessions = createSessionRepository(open.db);
  const authDevices = createAuthDeviceRepository(open.db);
  const audit = createAuditEventRepository(open.db);
  const tmux = createFakeTmuxAdapter({ now: fixedNow });
  const dispatch = createDispatchProbe(tmux);
  let nextAuditId = 1;
  const handlers = createWriteRouteHandlers({
    sessions,
    settings,
    authDevices,
    auditEvents: input.auditEvents ?? audit,
    tmux: dispatch.tmux,
    now: fixedNow,
    createAuditId: () => `audit_${String(nextAuditId++).padStart(3, "0")}`
  });

  return {
    audit,
    authDevices,
    dispatch,
    handlers,
    sessions,
    settings,
    tmux,
    createWriteDevice() {
      return authDevices.create({
        id: "client_write_integration",
        rawDeviceToken,
        rawCsrfToken,
        permission: "write",
        createdAt: fixedNow()
      });
    },
    createReadOnlyDevice() {
      return authDevices.create({
        id: "client_read_only_integration",
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

function createDispatchProbe(tmux: FakeTmuxAdapter): {
  readonly tmux: Pick<TmuxAdapter, "sendInput" | "stopSession">;
  readonly sendAttempts: () => number;
  readonly stopAttempts: () => number;
} {
  let sendAttempts = 0;
  let stopAttempts = 0;

  return {
    tmux: {
      async sendInput(input) {
        sendAttempts += 1;
        return tmux.sendInput(input);
      },
      async stopSession(input) {
        stopAttempts += 1;
        return tmux.stopSession(input);
      }
    },
    sendAttempts: () => sendAttempts,
    stopAttempts: () => stopAttempts
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
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-write-integration-db-"));
  tempDirs.push(dir);
  return join(dir, "hostdeck.sqlite");
}

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-write-integration-state-"));
  tempDirs.push(dir);
  return dir;
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-write-integration-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date(timestamp);
}

function laterNow(): Date {
  return new Date(laterTimestamp);
}
