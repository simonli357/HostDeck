import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type PendingApproval,
  pendingApprovalSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { type OperationDeadline, runtimeCapabilities } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CreateHostDeckApprovalRouteRegistrationInput,
  createHostDeckApprovalRouteRegistration,
  hostDeckApprovalRouteRegistrationId
} from "./approval-routes.js";
import {
  type CodexApprovalControlErrorCode,
  type CodexApprovalControlOutcome,
  HostDeckCodexApprovalControlError
} from "./codex-approval-control-service.js";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import { hostDeckLoopbackTestOrigin, injectHostDeckLoopback } from "./fastify-loopback-test-request.js";
import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-16T14:00:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_approval_route_001";
const threadId = "thread-approval-route-001";
const requestId = "string:approval-route-1";
const operationId = "op_approval_route_0001";
const responseRequest = Object.freeze({
  operation_id: operationId,
  kind: "approval_response" as const,
  decision: "approve" as const,
  confirm: true as const
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("selected approval routes", () => {
  it("requires exact accessor-free composition and registers both manifest routes once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration).toMatchObject({ id: hostDeckApprovalRouteRegistrationId, surface: "api" });
      expect(Object.isFrozen(harness.registration)).toBe(true);
      expect(() =>
        harness.registration.register(harness.app, { resourceBudget: defaultResourceBudget, surface: "api" })
      ).toThrow("already registered");

      let accessorCalls = 0;
      const accessor = Object.defineProperty({}, "approvals", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("private approval accessor");
        }
      });
      for (const candidate of [
        null,
        {},
        { ...harness.routeInput, extra: true },
        { ...harness.routeInput, admission: undefined },
        {
          ...harness.routeInput,
          admission: Object.freeze({ ...harness.routeInput.admission })
        },
        { ...harness.routeInput, approvals: {} },
        { ...harness.routeInput, approvals: { ...harness.routeInput.approvals, extra: true } },
        { ...harness.routeInput, audit: {} },
        { ...harness.routeInput, csrf: {} },
        { ...harness.routeInput, lock: {} },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, state: {} },
        accessor
      ]) {
        expect(() => createHostDeckApprovalRouteRegistration(candidate as never)).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reads an explicit target-correlated list with no-store and receiverless brackets", async () => {
    const listed = [approval("pending", null), approval("responding", null, "string:approval-route-2")];
    const harness = await createHarness({ listResults: [listed] });
    try {
      const response = await listApprovals(harness);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.json()).toEqual({ target: managedTarget(), approvals: listed });
      expect(harness.listCalls()).toEqual([managedTarget()]);
      expect(harness.listThis()).toBeUndefined();
      expect(harness.stateReads()).toBe(2);
      expect(harness.runtimeReads()).toBe(2);
      expect(harness.auditCount()).toBe(0);
    } finally {
      await harness.close();
    }

    const empty = await createHarness({ listResults: [[]] });
    try {
      expect((await listApprovals(empty)).json()).toEqual({ target: managedTarget(), approvals: [] });
    } finally {
      await empty.close();
    }
  });

  it("audits acceptance, sends once, waits for exact final truth, and returns HTTP 200", async () => {
    const harness = await createHarness();
    try {
      const response = await respondApproval(harness, responseRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        operation_id: operationId,
        requested_decision: "approve",
        approval: approval("approved", "approve")
      });
      expect(harness.snapshotCalls()).toEqual([approvalTarget(), approvalTarget()]);
      expect(harness.respondCalls()).toEqual([
        {
          operation_id: operationId,
          target: approvalTarget(),
          kind: "approval_response",
          decision: "approve",
          confirm: true
        }
      ]);
      expect(harness.waitCalls()).toEqual([approvalTarget()]);
      expect(harness.respondThis()).toBeUndefined();
      expect(harness.waitThis()).toBeUndefined();
      expect(harness.acceptedBeforeRespond()).toBe(true);
      expect(harness.waitAfterRespond()).toBe(true);
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            action: "approval_response",
            payload_summary: { schema_version: 1, decision: "approve", confirmed: true }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, decision_finalized: true }
          }
        ]
      });
      const raw = harness.rawAuditRecords(operationId).join("\n");
      expect(raw).not.toMatch(/private approval action|private approval reason|\/private\/approval/iu);
      expect(raw.match(new RegExp(threadId, "gu"))).toHaveLength(2);
      expect(raw.match(new RegExp(requestId, "gu"))).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed wire input and adjacent methods before state, audit, or service access", async () => {
    const harness = await createHarness();
    try {
      for (const candidate of [
        { ...responseRequest, confirm: false },
        { ...responseRequest, target: approvalTarget() },
        { ...responseRequest, thread_id: threadId },
        { ...responseRequest, force: true },
        { ...responseRequest, decision: "accept" }
      ]) {
        expectStableError(await respondApproval(harness, candidate), 400, "validation_error");
      }
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/approvals?x=1` }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/approvals`,
          headers: { "content-length": "1" }
        }),
        400,
        "validation_error"
      );
      expect((await injectHostDeckLoopback(harness.app, { method: "HEAD", url: `/api/v1/sessions/${sessionId}/approvals` })).statusCode).toBe(405);
      expect((await injectHostDeckLoopback(harness.app, { method: "PUT", url: approvalRespondPath() })).statusCode).toBe(405);
      expect(harness.stateReads()).toBe(0);
      expect(harness.listCalls()).toHaveLength(0);
      expect(harness.snapshotCalls()).toHaveLength(0);
      expect(harness.respondCalls()).toHaveLength(0);
      expect(harness.auditCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("fails closed for selected-state, runtime, lock, capability, and non-pending admission", async () => {
    const cases: readonly [string, HarnessOptions, number, string][] = [
      ["missing", { stateResults: [null] }, 404, "session_not_found"],
      ["archived", { stateResults: [selectedState("archived")] }, 409, "session_not_writable"],
      ["stale", { stateResults: [selectedState("stale")] }, 409, "stale_session"],
      ["recovery", { stateResults: [selectedState("recovery")] }, 409, "stale_session"],
      ["contradictory", { stateResults: [selectedState("contradictory")] }, 409, "stale_session"],
      ["disconnected", { runtimeResults: [runtimeCandidate({ state: "disconnected" })] }, 503, "runtime_unavailable"],
      [
        "capability",
        { runtimeResults: [runtimeCandidate({ state: "incompatible", unavailableCapability: "approvals" })] },
        409,
        "capability_unavailable"
      ],
      ["version", { runtimeResults: [runtimeCandidate({ version: "0.145.0" })] }, 409, "stale_session"],
      ["locked", { locked: true }, 423, "host_locked"],
      ["blocked", { runtimeResults: [runtimeCandidate({ mutationPolicy: "blocked", state: "degraded" })] }, 409, "incompatible_runtime"],
      ["absent", { snapshotResults: [null] }, 409, "approval_not_pending"],
      ["responding", { snapshotResults: [approval("responding", null)] }, 409, "approval_not_pending"],
      ["approved", { snapshotResults: [approval("approved", "approve")] }, 409, "approval_not_pending"],
      ["expired", { snapshotResults: [approval("expired", null)] }, 409, "approval_not_pending"],
      ["superseded", { snapshotResults: [approval("superseded", null)] }, 409, "approval_not_pending"]
    ];
    for (const [label, options, status, code] of cases) {
      const operation = `op_approval_route_admission_${label}`;
      const harness = await createHarness(options);
      try {
        expectStableError(
          await respondApproval(harness, { ...responseRequest, operation_id: operation }),
          status,
          code,
          code === "runtime_unavailable"
        );
        expect(harness.respondCalls()).toHaveLength(0);
        expect(harness.auditRepository.get(operation)).toBeNull();
      } finally {
        await harness.close();
      }
    }

    const readableBlocked = await createHarness({
      runtimeResults: [runtimeCandidate({ mutationPolicy: "blocked", state: "degraded" })]
    });
    try {
      expect((await listApprovals(readableBlocked)).statusCode).toBe(200);
    } finally {
      await readableBlocked.close();
    }
  });

  it("rechecks the same pending request after accepted audit and before the only response", async () => {
    const harness = await createHarness({
      snapshotResults: [approval("pending", null), approval("expired", null)]
    });
    try {
      expectStableError(await respondApproval(harness, responseRequest), 409, "approval_not_pending");
      expect(harness.respondCalls()).toHaveLength(0);
      expect(harness.auditRepository.require(operationId).records).toMatchObject([
        { phase: "accepted", outcome: "accepted" },
        { phase: "terminal", outcome: "failed", error_code: "approval_not_pending" }
      ]);
    } finally {
      await harness.close();
    }
  });

  it("distinguishes known-not-sent from possible-send and permits exact eventual proof", async () => {
    const known = await createHarness({
      respondError: approvalServiceError("runtime_unavailable", "runtime_unavailable", "not_sent")
    });
    try {
      expectStableError(await respondApproval(known, responseRequest), 503, "runtime_unavailable", true);
      expect(known.waitCalls()).toHaveLength(0);
      expect(known.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "failed" });
    } finally {
      await known.close();
    }

    const possible = await createHarness({
      respondError: approvalServiceError("unknown_outcome", "unknown_error", "unknown")
    });
    try {
      expect((await respondApproval(possible, responseRequest)).statusCode).toBe(200);
      expect(possible.respondCalls()).toHaveLength(1);
      expect(possible.waitCalls()).toHaveLength(1);
      expect(possible.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "succeeded" });
    } finally {
      await possible.close();
    }

    const unresolved = await createHarness({
      respondError: approvalServiceError("unknown_outcome", "unknown_error", "unknown"),
      waitError: approvalServiceError("unknown_outcome", "operation_timeout", "unknown")
    });
    try {
      expectStableError(await respondApproval(unresolved, responseRequest), 504, "operation_timeout");
      expect(unresolved.respondCalls()).toHaveLength(1);
      expect(unresolved.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "incomplete" });
    } finally {
      await unresolved.close();
    }
  });

  it("marks malformed terminal truth and post-dispatch drift incomplete without redispatch", async () => {
    const malformed = await createHarness({ terminalResults: [approval("responding", null)] });
    try {
      expectStableError(await respondApproval(malformed, responseRequest), 502, "protocol_error");
      expect(malformed.respondCalls()).toHaveLength(1);
      expect(malformed.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "incomplete" });
    } finally {
      await malformed.close();
    }

    const crossedDecision = await createHarness({ terminalResults: [approval("denied", "deny")] });
    try {
      expectStableError(await respondApproval(crossedDecision, responseRequest), 502, "protocol_error");
      expect(crossedDecision.respondCalls()).toHaveLength(1);
    } finally {
      await crossedDecision.close();
    }

    const drift = await createHarness({
      stateResults: [selectedState("active"), selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await respondApproval(drift, responseRequest), 409, "stale_session");
      expect(drift.respondCalls()).toHaveLength(1);
      expect(drift.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "incomplete" });
    } finally {
      await drift.close();
    }
  });

  it("replays duplicate operation results and suppresses success when terminal audit fails", async () => {
    const duplicate = await createHarness();
    try {
      const first = await respondApproval(duplicate, responseRequest);
      expect(first.statusCode, first.body).toBe(200);
      const replay = await respondApproval(duplicate, responseRequest);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(duplicate.respondCalls()).toHaveLength(1);
    } finally {
      await duplicate.close();
    }

    const terminalAudit = await createHarness();
    try {
      terminalAudit.failTerminalAudit();
      expectStableError(await respondApproval(terminalAudit, responseRequest), 503, "audit_unavailable");
      expect(terminalAudit.respondCalls()).toHaveLength(1);
      expect(terminalAudit.auditRepository.require(operationId)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
    } finally {
      await terminalAudit.close();
    }
  });
});

interface HarnessOptions {
  readonly listResults?: readonly unknown[];
  readonly locked?: boolean;
  readonly respondError?: Error;
  readonly respondResults?: readonly unknown[];
  readonly runtimeResults?: readonly unknown[];
  readonly snapshotResults?: readonly unknown[];
  readonly stateResults?: readonly unknown[];
  readonly terminalResults?: readonly unknown[];
  readonly waitError?: Error;
}

interface RouteInputFixture {
  readonly admission: CreateHostDeckApprovalRouteRegistrationInput["admission"];
  readonly approvals: CreateHostDeckApprovalRouteRegistrationInput["approvals"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: CreateHostDeckApprovalRouteRegistrationInput["runtime"];
  readonly state: CreateHostDeckApprovalRouteRegistrationInput["state"];
}

interface Harness {
  readonly acceptedBeforeRespond: () => boolean;
  readonly app: HostDeckFastifyInstance;
  readonly auditCount: () => number;
  readonly auditRepository: SelectedAuditRepository;
  readonly close: () => Promise<void>;
  readonly failTerminalAudit: () => void;
  readonly listCalls: () => readonly unknown[];
  readonly listThis: () => unknown;
  readonly rawAuditRecords: (operation: string) => readonly string[];
  readonly registration: HostDeckRoutePluginRegistration;
  readonly respondCalls: () => readonly Record<string, unknown>[];
  readonly respondThis: () => unknown;
  readonly routeInput: RouteInputFixture;
  readonly runtimeReads: () => number;
  readonly snapshotCalls: () => readonly unknown[];
  readonly stateReads: () => number;
  readonly waitAfterRespond: () => boolean;
  readonly waitCalls: () => readonly unknown[];
  readonly waitThis: () => unknown;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-approval-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_approval_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback approval route must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback approval route must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Approval route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const listCalls: unknown[] = [];
  const snapshotCalls: unknown[] = [];
  const respondCalls: Record<string, unknown>[] = [];
  const waitCalls: unknown[] = [];
  let listThis: unknown = "not-called";
  let respondThis: unknown = "not-called";
  let waitThis: unknown = "not-called";
  let acceptedBeforeRespond = false;
  let waitAfterRespond = false;
  let stateReads = 0;
  let runtimeReads = 0;
  let listIndex = 0;
  let snapshotIndex = 0;
  let respondIndex = 0;
  let terminalIndex = 0;
  let stateIndex = 0;
  let runtimeIndex = 0;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    approvals: {
      async list(this: void, target: unknown) {
        listThis = this;
        listCalls.push(target);
        return sequenceValue(options.listResults ?? [[]], listIndex++) as readonly PendingApproval[];
      },
      async snapshot(this: void, target: unknown) {
        snapshotCalls.push(target);
        return sequenceValue(options.snapshotResults ?? [approval("pending", null)], snapshotIndex++) as PendingApproval;
      },
      async respond(this: void, intent: unknown, deadline: OperationDeadline) {
        respondThis = this;
        expect(deadline.signal).toBeInstanceOf(AbortSignal);
        const captured = { ...(intent as Record<string, unknown>) };
        respondCalls.push(captured);
        acceptedBeforeRespond = auditRepository.get(String(captured.operation_id ?? ""))?.records[0]?.phase === "accepted";
        if (options.respondError !== undefined) throw options.respondError;
        return sequenceValue(options.respondResults ?? [approval("responding", null)], respondIndex++) as PendingApproval;
      },
      async waitForTerminal(this: void, target: unknown, deadline: OperationDeadline) {
        waitThis = this;
        waitCalls.push(target);
        waitAfterRespond = respondCalls.length === 1 && deadline.signal instanceof AbortSignal;
        if (options.waitError !== undefined) throw options.waitError;
        return sequenceValue(options.terminalResults ?? [approval("approved", "approve")], terminalIndex++) as PendingApproval;
      }
    },
    audit,
    csrf,
    lock,
    runtime: {
      read() {
        runtimeReads += 1;
        return sequenceValue(options.runtimeResults ?? [runtimeCandidate()], runtimeIndex++);
      }
    },
    state: {
      get() {
        stateReads += 1;
        return sequenceValue(options.stateResults ?? [selectedState("active")], stateIndex++) as SelectedSessionState | null;
      }
    }
  };
  const registration = createHostDeckApprovalRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback approval route must not authenticate a device.");
      },
      now: nextDate
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: hostDeckLoopbackTestOrigin
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  await app.ready();
  let closed = false;
  return {
    acceptedBeforeRespond: () => acceptedBeforeRespond,
    app,
    auditCount: () =>
      (open.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get() as { readonly count: number }).count,
    auditRepository,
    registration,
    routeInput,
    listCalls: () => [...listCalls],
    listThis: () => listThis,
    respondCalls: () => [...respondCalls],
    respondThis: () => respondThis,
    runtimeReads: () => runtimeReads,
    snapshotCalls: () => [...snapshotCalls],
    stateReads: () => stateReads,
    waitAfterRespond: () => waitAfterRespond,
    waitCalls: () => [...waitCalls],
    waitThis: () => waitThis,
    rawAuditRecords(operation) {
      return (open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operation) as readonly { readonly record_json: string }[]).map((row) => row.record_json);
    },
    failTerminalAudit() {
      open.db.exec(`
        CREATE TRIGGER fail_approval_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced approval terminal audit failure');
        END;
      `);
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      if (open.db.open) open.db.close();
    }
  };
}

function managedTarget() {
  return { type: "managed_session" as const, session_id: sessionId, codex_thread_id: threadId };
}

function approvalTarget(id = requestId) {
  return { ...managedTarget(), type: "approval" as const, request_id: id };
}

function approval(
  state: PendingApproval["state"],
  decision: PendingApproval["decision"],
  id = requestId
): PendingApproval {
  return pendingApprovalSchema.parse({
    target: approvalTarget(id),
    action: "private approval action",
    scope: "/private/approval",
    reason: "private approval reason",
    risk: "elevated",
    grant_scope: "one_time",
    state,
    created_at: timestamp,
    expires_at: "2026-07-16T14:05:00.000Z",
    decision
  });
}

function selectedState(state: "active" | "archived" | "contradictory" | "recovery" | "stale"): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "approval-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-approval-route",
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: state === "recovery" ? "recovery_required" : "selected",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: archivedAt
  });
  const stale = state === "stale";
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id: mapping.id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: state === "contradictory" ? "/tmp/hostdeck-approval-route-other" : mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: archivedAt,
      session_state: state === "archived" ? "archived" : stale ? "stale" : "active",
      turn_state: state === "archived" ? "idle" : stale ? "unknown" : "waiting_for_approval",
      attention: state === "archived" ? "none" : stale ? "unknown" : "needs_approval",
      freshness: stale ? "stale" : "current",
      freshness_reason: stale ? "Projection requires reconciliation." : null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed approval route test session.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function runtimeCandidate(
  input: {
    readonly mutationPolicy?: RuntimeCompatibility["mutation_policy"];
    readonly state?: RuntimeCompatibility["state"];
    readonly unavailableCapability?: string;
    readonly version?: string;
  } = {}
): RuntimeCompatibility {
  const state = input.state ?? "ready";
  const connected = state !== "disconnected";
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state,
    mutation_policy: input.mutationPolicy ?? (state === "ready" || state === "degraded" ? "allowed" : "blocked"),
    observed_version: connected ? (input.version ?? runtimeVersion) : null,
    binding_id: connected ? "binding-approval-route-001" : null,
    capabilities: runtimeCapabilities.map((name) =>
      name === input.unavailableCapability
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not fully ready."
  });
}

function settings(locked: boolean) {
  return Object.freeze({
    locked,
    settings_updated_at: timestamp
  });
}

function approvalServiceError(
  code: CodexApprovalControlErrorCode,
  apiCode: ConstructorParameters<typeof HostDeckCodexApprovalControlError>[1],
  outcome: CodexApprovalControlOutcome
): HostDeckCodexApprovalControlError {
  return new HostDeckCodexApprovalControlError(code, apiCode, "private approval service error", outcome, false);
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Approval route test sequence is empty.");
  return value;
}

async function listApprovals(harness: Pick<Harness, "app">) {
  return await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/approvals` });
}

function approvalRespondPath() {
  return `/api/v1/sessions/${sessionId}/approvals/${encodeURIComponent(requestId)}/respond`;
}

async function respondApproval(harness: Pick<Harness, "app">, payload: Readonly<Record<string, unknown>>) {
  return await injectHostDeckLoopback(harness.app, { method: "POST", url: approvalRespondPath(), payload });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toMatch(/private approval|\/private\/approval/iu);
}
