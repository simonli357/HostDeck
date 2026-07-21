import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexTurnIdSchema,
  promptOperationIntentSchema,
  resolveResourceBudget,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  type CreateHostDeckPromptRouteRegistrationInput,
  type CreateHostDeckSessionArchiveRouteRegistrationInput,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckPromptRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createHostDeckSessionArchiveRouteRegistration
} from "../packages/server/src/index.js";
import {
  createSelectedAuditRepository,
  openMigratedDatabase,
  type SelectedSessionState
} from "../packages/storage/src/index.js";

const directories: string[] = [];
const timestamp = "2026-07-16T10:00:00.000Z";
const archivedAt = "2026-07-16T10:00:01.000Z";
const runtimeVersion = "0.144.0";
const localOrigin = "http://127.0.0.1:3777";
const localHeaders = Object.freeze({ host: new URL(localOrigin).host });
const alphaSessionId = "sess_admission_cross_alpha";
const alphaThreadId = "thread-admission-cross-alpha";
const betaSessionId = "sess_admission_cross_beta";
const betaThreadId = "thread-admission-cross-beta";
const promptOperationId = "op_admission_cross_prompt_001";
const contendedArchiveOperationId = "op_admission_cross_archive_001";
const isolatedArchiveOperationId = "op_admission_cross_archive_002";
const privatePrompt = "ADMISSION_CROSS_PRIVATE_SENTINEL continue the selected work";
const resourceBudget = resolveResourceBudget({
  mutation_max_requests_per_device: 100,
  mutation_max_in_flight_per_device: 4,
  mutation_max_in_flight_per_target: 1,
  mutation_max_in_flight_global: 4
});
const runtimeCapabilities = [
  "thread_lifecycle",
  "turn_input",
  "turn_steer",
  "turn_interrupt",
  "model",
  "goal",
  "plan",
  "approvals",
  "usage",
  "compact",
  "skills",
  "multi_client"
] as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected write admission cross-route vertical", () => {
  it("shares replay, conflict, and target capacity across production prompt and archive routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-admission-cross-route-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecordId = 0;
    let auditTime = Date.parse(timestamp);
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => new Date(auditTime++).toISOString(),
      create_record_id: () => `audit_admission_cross_${++auditRecordId}`
    });
    let admissionTime = 0;
    const admission = createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget,
      now: () => admissionTime
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback admission vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback admission vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(timestamp)
    });
    let lockChecks = 0;
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => {
          lockChecks += 1;
          return settings();
        },
        transition() {
          throw new Error("Admission vertical must not transition host lock.");
        }
      },
      now: () => new Date(timestamp)
    });

    const activeStates = new Map<string, SelectedSessionState>([
      [alphaSessionId, selectedState(alphaSessionId, alphaThreadId, false)],
      [betaSessionId, selectedState(betaSessionId, betaThreadId, false)]
    ]);
    const promptStarted = deferred<void>();
    const releasePrompt = deferred<void>();
    const promptDispatches: unknown[] = [];
    let promptSnapshots = 0;
    const prompts: CreateHostDeckPromptRouteRegistrationInput["prompts"] = {
      async snapshot() {
        promptSnapshots += 1;
        return {
          phase: "idle",
          last_action: null,
          operation_id: null,
          turn_id: null,
          model_revision: null,
          plan_revision: null,
          requested_at: null,
          accepted_at: null,
          started_at: null,
          error: null
        };
      },
      async dispatch(candidate, signal) {
        const intent = promptOperationIntentSchema.parse(candidate);
        if (!(signal instanceof AbortSignal)) {
          throw new TypeError("Prompt dispatch signal is unavailable.");
        }
        promptDispatches.push(intent);
        promptStarted.resolve();
        await releasePrompt.promise;
        return {
          thread_id: intent.target.codex_thread_id,
          turn_id: codexTurnIdSchema.parse("turn-admission-cross-001"),
          state: "accepted",
          action: "start",
          model_revision: null,
          plan_revision: null,
          steerable: false
        };
      }
    };
    const archiveCalls: string[] = [];
    const sessions: CreateHostDeckSessionArchiveRouteRegistrationInput["sessions"] = {
      read(sessionId) {
        const state = activeStates.get(sessionId);
        if (state === undefined) throw new Error("Unknown admission vertical session.");
        return state;
      },
      async archive(sessionId) {
        const active = activeStates.get(sessionId);
        if (active === undefined) throw new Error("Unknown admission vertical session.");
        archiveCalls.push(sessionId);
        return selectedState(
          active.mapping.id,
          active.mapping.codex_thread_id,
          true
        );
      }
    };
    const runtime = { read: () => runtimeCompatibility() };
    const promptRegistration = createHostDeckPromptRouteRegistration({
      admission,
      audit,
      csrf,
      lock,
      prompts,
      runtime,
      sessions: { read: sessions.read }
    });
    const archiveRegistration = createHostDeckSessionArchiveRouteRegistration({
      admission,
      audit,
      csrf,
      lock,
      runtime,
      sessions,
      subscribers: {
        archive_session: () => 0
      }
    });
    const internalErrors: unknown[] = [];
    const app = createHostDeckFastifyApp({
      observeInternalError: (error) => internalErrors.push(error),
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback admission vertical must not authenticate a device.");
        },
        now: () => new Date(timestamp)
      }),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: localOrigin
      }),
      resourceBudget,
      routePlugins: [promptRegistration, archiveRegistration]
    });
    await app.listen({
      host: "127.0.0.1",
      port: 0,
      listenTextResolver: () => ""
    });

    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Admission cross-route listener is unavailable.");
      }
      const promptPayload = {
        operation_id: promptOperationId,
        kind: "prompt" as const,
        text: privatePrompt
      };
      const body = JSON.stringify(promptPayload);
      let responseReceived = false;
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${alphaSessionId}/prompts`,
        headers: {
          host: localHeaders.host,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close"
        }
      });
      outgoing.once("response", () => {
        responseReceived = true;
      });
      const closed = new Promise<void>((resolve) => {
        outgoing.once("error", () => resolve());
        outgoing.once("close", () => resolve());
      });
      outgoing.end(body);
      await promptStarted.promise;
      outgoing.destroy();
      await closed;
      expect(responseReceived).toBe(false);
      expect(auditRepository.require(promptOperationId)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });

      const inFlightReplay = app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/prompts`,
        headers: localHeaders,
        payload: promptPayload
      });
      await waitFor(() => admission.snapshot().in_flight_replays === 1);

      const crossRouteConflict = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/archive`,
        headers: localHeaders,
        payload: {
          operation_id: promptOperationId,
          kind: "archive",
          confirm: true
        }
      });
      expect(crossRouteConflict.statusCode, crossRouteConflict.body).toBe(409);
      expect(crossRouteConflict.json()).toMatchObject({
        error: { code: "operation_conflict", retryable: false }
      });

      const targetContender = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/archive`,
        headers: localHeaders,
        payload: {
          operation_id: contendedArchiveOperationId,
          kind: "archive",
          confirm: true
        }
      });
      expect(targetContender.statusCode, targetContender.body).toBe(503);
      expect(targetContender.json()).toMatchObject({
        error: { code: "service_overloaded", retryable: true }
      });
      expect(auditRepository.get(contendedArchiveOperationId)).toBeNull();

      const isolated = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${betaSessionId}/archive`,
        headers: localHeaders,
        payload: {
          operation_id: isolatedArchiveOperationId,
          kind: "archive",
          confirm: true
        }
      });
      expect(isolated.statusCode, isolated.body).toBe(202);
      expect(isolated.json()).toMatchObject({
        operation_id: isolatedArchiveOperationId,
        state: "accepted",
        target: { session_id: betaSessionId, codex_thread_id: betaThreadId }
      });
      expect(archiveCalls).toEqual([betaSessionId]);
      expect(auditRepository.require(isolatedArchiveOperationId).records).toHaveLength(2);

      releasePrompt.resolve();
      const joined = await inFlightReplay;
      expect(joined.statusCode, joined.body).toBe(202);
      expect(joined.json()).toMatchObject({
        operation_id: promptOperationId,
        state: "accepted",
        target: { session_id: alphaSessionId, codex_thread_id: alphaThreadId }
      });
      await waitFor(
        () => auditRepository.get(promptOperationId)?.state === "terminal"
      );

      const terminalReplay = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/prompts`,
        headers: localHeaders,
        payload: promptPayload
      });
      expect(terminalReplay.statusCode, terminalReplay.body).toBe(202);
      expect(terminalReplay.json()).toEqual(joined.json());

      const changedPayload = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/prompts`,
        headers: localHeaders,
        payload: { ...promptPayload, text: `${privatePrompt} changed` }
      });
      expect(changedPayload.statusCode, changedPayload.body).toBe(409);
      expect(changedPayload.json()).toMatchObject({
        error: { code: "operation_conflict", retryable: false }
      });
      expect(promptDispatches).toHaveLength(1);
      expect(promptSnapshots).toBe(2);
      expect(auditRepository.require(promptOperationId)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "succeeded" }
        ]
      });

      const targetRetry = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/archive`,
        headers: localHeaders,
        payload: {
          operation_id: contendedArchiveOperationId,
          kind: "archive",
          confirm: true
        }
      });
      expect(targetRetry.statusCode, targetRetry.body).toBe(202);
      expect(targetRetry.json()).toMatchObject({
        operation_id: contendedArchiveOperationId,
        state: "accepted",
        target: { session_id: alphaSessionId, codex_thread_id: alphaThreadId }
      });
      expect(archiveCalls).toEqual([betaSessionId, alphaSessionId]);
      expect(auditRepository.require(contendedArchiveOperationId).records).toHaveLength(2);

      expect(admission.snapshot()).toMatchObject({
        attempts: 8,
        owner_claims: 4,
        in_flight_replays: 1,
        terminal_replays: 1,
        operation_conflicts: 2,
        target_rejections: 1,
        value_settlements: 3,
        abandoned_owners: 1,
        active_owners: 0,
        active_targets: 0,
        active_waiters: 0,
        tracked_operations: 3,
        tracked_rate_buckets: 1
      });
      expect(lockChecks).toBe(4);
      expect(auditRecordId).toBe(6);
      expect(internalErrors).toEqual([]);

      admissionTime = resourceBudget.admission_state_ttl_ms;
      const postTtlRetry = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${alphaSessionId}/prompts`,
        headers: localHeaders,
        payload: promptPayload
      });
      expect(postTtlRetry.statusCode, postTtlRetry.body).toBe(409);
      expect(postTtlRetry.json()).toMatchObject({
        error: { code: "operation_conflict", retryable: false }
      });
      expect(promptDispatches).toHaveLength(1);
      expect(auditRepository.require(promptOperationId).records).toHaveLength(2);
      expect(admission.snapshot()).toMatchObject({
        attempts: 9,
        owner_claims: 5,
        operation_conflicts: 2,
        error_settlements: 1,
        active_owners: 0,
        active_targets: 0,
        tracked_operations: 1,
        tracked_rate_buckets: 1
      });
      expect(lockChecks).toBe(5);

      const rawAuditRows = open.db
        .prepare(
          "SELECT operation_id, record_json FROM selected_audit_events ORDER BY rowid"
        )
        .all() as readonly {
        readonly operation_id: string;
        readonly record_json: string;
      }[];
      expect(rawAuditRows).toHaveLength(6);
      const rawAudit = rawAuditRows
        .map((row) => `${row.operation_id}:${row.record_json}`)
        .join("\n");
      expect(rawAudit).not.toContain(privatePrompt);
      const diagnostics = JSON.stringify(admission.snapshot());
      expect(diagnostics).not.toMatch(
        /ADMISSION_CROSS_PRIVATE_SENTINEL|sess_admission_cross|thread-admission-cross|op_admission_cross/iu
      );
    } finally {
      releasePrompt.resolve();
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

function selectedState(
  sessionId: string,
  threadId: string,
  archived: boolean
): SelectedSessionState {
  const stateAt = archived ? archivedAt : timestamp;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: sessionId,
    codex_thread_id: threadId,
    cwd: `/tmp/hostdeck-${sessionId}`,
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: "selected",
    created_at: timestamp,
    updated_at: stateAt,
    archived_at: archived ? archivedAt : null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id: mapping.id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: mapping.archived_at,
      session_state: archived ? "archived" : "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: stateAt,
      last_activity_at: stateAt,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Admission cross-route fixture.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function runtimeCompatibility() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-admission-cross-001",
    capabilities: runtimeCapabilities.map((name) => ({
      name,
      state: "available",
      reason: null
    })),
    checked_at: timestamp,
    reason: null
  });
}

function settings() {
  return Object.freeze({
    locked: false,
    settings_updated_at: timestamp
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => {
      if (resolvePromise === undefined) throw new Error("Deferred is unavailable.");
      resolvePromise(value as T);
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Admission cross-route condition was not observed.");
}
