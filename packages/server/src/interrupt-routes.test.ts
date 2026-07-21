import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedOperationProgress,
  selectedOperationProgressSchema,
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
  type CodexInterruptControlErrorCode,
  type CodexInterruptControlOutcome,
  HostDeckCodexInterruptControlError
} from "./codex-interrupt-control-service.js";
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
import {
  type CreateHostDeckInterruptRouteRegistrationInput,
  createHostDeckInterruptRouteRegistration,
  hostDeckInterruptRouteRegistrationId
} from "./interrupt-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-16T18:30:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_interrupt_route_001";
const threadId = "thread-interrupt-route-001";
const turnId = "turn-interrupt-route-001";
const operationId = "op_interrupt_route_0001";
const interruptRequest = Object.freeze({
  operation_id: operationId,
  kind: "interrupt" as const,
  confirm: true as const
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("selected interrupt route", () => {
  it("requires exact composition and registers the selected manifest route once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration).toMatchObject({ id: hostDeckInterruptRouteRegistrationId, surface: "api" });
      expect(Object.isFrozen(harness.registration)).toBe(true);
      expect(() =>
        harness.registration.register(harness.app, { resourceBudget: defaultResourceBudget, surface: "api" })
      ).toThrow("already registered");

      let accessorCalls = 0;
      const accessor = Object.defineProperty({}, "interrupts", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("private interrupt accessor");
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
        { ...harness.routeInput, interrupts: {} },
        { ...harness.routeInput, interrupts: { ...harness.routeInput.interrupts, extra: true } },
        { ...harness.routeInput, audit: {} },
        { ...harness.routeInput, csrf: {} },
        { ...harness.routeInput, lock: {} },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, state: {} },
        accessor
      ]) {
        expect(() => createHostDeckInterruptRouteRegistration(candidate as never)).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("audits acceptance, sends once, waits for exact event truth, and returns terminal HTTP 200", async () => {
    const harness = await createHarness();
    try {
      const response = await interruptTurn(harness, interruptRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.json()).toEqual(progress("interrupted", null));
      expect(harness.requireCalls()).toEqual([turnTarget(), turnTarget()]);
      expect(harness.interruptCalls()).toEqual([
        {
          operation_id: operationId,
          target: turnTarget(),
          kind: "interrupt",
          confirm: true
        }
      ]);
      expect(harness.waitCalls()).toEqual([turnTarget()]);
      expect(harness.requireThis()).toBeUndefined();
      expect(harness.interruptThis()).toBeUndefined();
      expect(harness.waitThis()).toBeUndefined();
      expect(harness.acceptedBeforeInterrupt()).toBe(true);
      expect(harness.waitAfterInterrupt()).toBe(true);
      expect(harness.stateReads()).toBe(3);
      expect(harness.runtimeReads()).toBe(3);
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            action: "interrupt",
            target: turnTarget(),
            payload_summary: { schema_version: 1, confirmed: true }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, interrupted: true }
          }
        ]
      });
      const raw = harness.rawAuditRecords(operationId).join("\n");
      expect(raw).not.toMatch(/private interrupt|private terminal|\/private\/interrupt/iu);
      expect(raw.match(new RegExp(threadId, "gu"))).toHaveLength(2);
      expect(raw.match(new RegExp(turnId, "gu"))).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed wire input and adjacent methods before state, audit, or service access", async () => {
    const harness = await createHarness();
    try {
      for (const candidate of [
        { ...interruptRequest, confirm: false },
        { ...interruptRequest, target: turnTarget() },
        { ...interruptRequest, codex_thread_id: threadId },
        { ...interruptRequest, force: true },
        { ...interruptRequest, kind: "stop" }
      ]) {
        expectStableError(await interruptTurn(harness, candidate), 400, "validation_error");
      }
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "POST", url: `${interruptPath()}?force=true`, payload: interruptRequest }),
        400,
        "validation_error"
      );
      expect((await injectHostDeckLoopback(harness.app, { method: "GET", url: interruptPath() })).statusCode).toBe(405);
      expect((await injectHostDeckLoopback(harness.app, { method: "HEAD", url: interruptPath() })).statusCode).toBe(405);
      expect((await injectHostDeckLoopback(harness.app, { method: "PUT", url: interruptPath(), payload: interruptRequest })).statusCode).toBe(405);
      expect(harness.stateReads()).toBe(0);
      expect(harness.requireCalls()).toHaveLength(0);
      expect(harness.interruptCalls()).toHaveLength(0);
      expect(harness.auditCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("fails closed across selected state, runtime, lock, capability, and active-event admission", async () => {
    const cases: readonly [string, HarnessOptions, number, string, boolean?][] = [
      ["missing", { stateResults: [null] }, 404, "session_not_found"],
      ["archived", { stateResults: [selectedState("archived")] }, 409, "session_not_writable"],
      ["stale", { stateResults: [selectedState("stale")] }, 409, "stale_session"],
      ["recovery", { stateResults: [selectedState("recovery")] }, 409, "stale_session"],
      ["contradictory", { stateResults: [selectedState("contradictory")] }, 409, "stale_session"],
      ["disconnected", { runtimeResults: [runtimeCandidate({ state: "disconnected" })] }, 503, "runtime_unavailable", true],
      [
        "capability",
        { runtimeResults: [runtimeCandidate({ state: "incompatible", unavailableCapability: "turn_interrupt" })] },
        409,
        "capability_unavailable"
      ],
      ["version", { runtimeResults: [runtimeCandidate({ version: "0.145.0" })] }, 409, "stale_session"],
      ["locked", { locked: true }, 423, "host_locked"],
      ["blocked", { runtimeResults: [runtimeCandidate({ mutationPolicy: "blocked", state: "degraded" })] }, 409, "incompatible_runtime"],
      [
        "no-event",
        { requireErrors: [interruptServiceError("operation_conflict", "operation_conflict", "not_sent")] },
        409,
        "operation_conflict"
      ],
      [
        "state-port",
        { requireErrors: [interruptServiceError("state_unavailable", "storage_error", "not_sent")] },
        500,
        "storage_error",
        true
      ]
    ];
    for (const [label, options, status, code, retryable] of cases) {
      const operation = `op_interrupt_route_admission_${label}`;
      const harness = await createHarness(options);
      try {
        expectStableError(
          await interruptTurn(harness, { ...interruptRequest, operation_id: operation }),
          status,
          code,
          retryable ?? false
        );
        expect(harness.interruptCalls()).toHaveLength(0);
        expect(harness.auditRepository.get(operation)).toBeNull();
      } finally {
        await harness.close();
      }
    }
  });

  it("rechecks exact active-turn admission after accepted audit and before the only wire call", async () => {
    const harness = await createHarness({
      requireErrors: [null, interruptServiceError("operation_conflict", "operation_conflict", "not_sent")]
    });
    try {
      expectStableError(await interruptTurn(harness, interruptRequest), 409, "operation_conflict");
      expect(harness.interruptCalls()).toHaveLength(0);
      expect(harness.auditRepository.require(operationId).records).toMatchObject([
        { phase: "accepted", outcome: "accepted" },
        { phase: "terminal", outcome: "failed", error_code: "operation_conflict" }
      ]);
    } finally {
      await harness.close();
    }
  });

  it("distinguishes known failures, possible send, and exact eventual interrupt proof", async () => {
    const known = await createHarness({
      interruptError: interruptServiceError("runtime_unavailable", "runtime_unavailable", "not_sent")
    });
    try {
      expectStableError(await interruptTurn(known, interruptRequest), 503, "runtime_unavailable", true);
      expect(known.waitCalls()).toHaveLength(0);
      expect(known.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "failed" });
    } finally {
      await known.close();
    }

    const rejected = await createHarness({
      interruptError: interruptServiceError("operation_conflict", "operation_conflict", "remote_rejected")
    });
    try {
      expectStableError(await interruptTurn(rejected, interruptRequest), 409, "operation_conflict");
      expect(rejected.waitCalls()).toHaveLength(0);
      expect(rejected.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "failed" });
    } finally {
      await rejected.close();
    }

    const possible = await createHarness({
      interruptError: interruptServiceError("unknown_outcome", "unknown_error", "unknown")
    });
    try {
      expect((await interruptTurn(possible, interruptRequest)).statusCode).toBe(200);
      expect(possible.interruptCalls()).toHaveLength(1);
      expect(possible.waitCalls()).toHaveLength(1);
      expect(possible.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "succeeded" });
    } finally {
      await possible.close();
    }

    const unresolved = await createHarness({
      interruptError: interruptServiceError("unknown_outcome", "unknown_error", "unknown"),
      waitError: interruptServiceError("unknown_outcome", "operation_timeout", "unknown")
    });
    try {
      expectStableError(await interruptTurn(unresolved, interruptRequest), 504, "operation_timeout");
      expect(unresolved.interruptCalls()).toHaveLength(1);
      expect(unresolved.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "incomplete" });
    } finally {
      await unresolved.close();
    }
  });

  it("never promotes normal completion, failure, archive, or malformed progress to interrupted success", async () => {
    const cases: readonly [string, HarnessOptions, number, string, string][] = [
      ["completed", { terminalResults: [progress("failed", error("operation_conflict"))] }, 409, "operation_conflict", "failed"],
      ["failed", { interruptResults: [progress("failed", error("operation_conflict"))] }, 409, "operation_conflict", "failed"],
      [
        "archive",
        { interruptResults: [progress("incomplete", error("session_not_writable"))] },
        409,
        "session_not_writable",
        "incomplete"
      ],
      [
        "malformed",
        { terminalResults: [{ ...progress("interrupted", null), turn_id: "turn-interrupt-foreign" }] },
        502,
        "protocol_error",
        "incomplete"
      ]
    ];
    for (const [label, options, status, code, auditOutcome] of cases) {
      const harness = await createHarness(options);
      try {
        expectStableError(await interruptTurn(harness, interruptRequest), status, code);
        expect(harness.interruptCalls(), label).toHaveLength(1);
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: auditOutcome });
      } finally {
        await harness.close();
      }
    }
  });

  it("marks post-dispatch continuity drift incomplete and does not redispatch", async () => {
    const harness = await createHarness({
      stateResults: [selectedState("active"), selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await interruptTurn(harness, interruptRequest), 409, "stale_session");
      expect(harness.interruptCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "incomplete" });
    } finally {
      await harness.close();
    }
  });

  it("replays duplicate operation results and suppresses success when terminal audit fails", async () => {
    const duplicate = await createHarness();
    try {
      const first = await interruptTurn(duplicate, interruptRequest);
      expect(first.statusCode, first.body).toBe(200);
      const replay = await interruptTurn(duplicate, interruptRequest);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(duplicate.interruptCalls()).toHaveLength(1);
    } finally {
      await duplicate.close();
    }

    const terminalAudit = await createHarness();
    try {
      terminalAudit.failTerminalAudit();
      expectStableError(await interruptTurn(terminalAudit, interruptRequest), 503, "audit_unavailable");
      expect(terminalAudit.interruptCalls()).toHaveLength(1);
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
  readonly interruptError?: Error;
  readonly interruptResults?: readonly unknown[];
  readonly locked?: boolean;
  readonly requireErrors?: readonly (Error | null)[];
  readonly runtimeResults?: readonly unknown[];
  readonly stateResults?: readonly unknown[];
  readonly terminalResults?: readonly unknown[];
  readonly waitError?: Error;
}

interface RouteInputFixture {
  readonly admission: CreateHostDeckInterruptRouteRegistrationInput["admission"];
  readonly interrupts: CreateHostDeckInterruptRouteRegistrationInput["interrupts"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: CreateHostDeckInterruptRouteRegistrationInput["runtime"];
  readonly state: CreateHostDeckInterruptRouteRegistrationInput["state"];
}

interface Harness {
  readonly acceptedBeforeInterrupt: () => boolean;
  readonly app: HostDeckFastifyInstance;
  readonly auditCount: () => number;
  readonly auditRepository: SelectedAuditRepository;
  readonly close: () => Promise<void>;
  readonly failTerminalAudit: () => void;
  readonly interruptCalls: () => readonly Record<string, unknown>[];
  readonly interruptThis: () => unknown;
  readonly rawAuditRecords: (operation: string) => readonly string[];
  readonly registration: HostDeckRoutePluginRegistration;
  readonly requireCalls: () => readonly unknown[];
  readonly requireThis: () => unknown;
  readonly routeInput: RouteInputFixture;
  readonly runtimeReads: () => number;
  readonly stateReads: () => number;
  readonly waitAfterInterrupt: () => boolean;
  readonly waitCalls: () => readonly unknown[];
  readonly waitThis: () => unknown;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-interrupt-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_interrupt_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback interrupt route must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback interrupt route must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Interrupt route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const requireCalls: unknown[] = [];
  const interruptCalls: Record<string, unknown>[] = [];
  const waitCalls: unknown[] = [];
  let requireThis: unknown = "not-called";
  let interruptThis: unknown = "not-called";
  let waitThis: unknown = "not-called";
  let acceptedBeforeInterrupt = false;
  let waitAfterInterrupt = false;
  let requireIndex = 0;
  let interruptIndex = 0;
  let terminalIndex = 0;
  let stateIndex = 0;
  let runtimeIndex = 0;
  let stateReads = 0;
  let runtimeReads = 0;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    interrupts: {
      async requireInterruptible(this: void, target: unknown) {
        requireThis = this;
        requireCalls.push(target);
        const failure = options.requireErrors?.[Math.min(requireIndex++, options.requireErrors.length - 1)] ?? null;
        if (failure !== null) throw failure;
      },
      async interrupt(this: void, intent: unknown, deadline: OperationDeadline) {
        interruptThis = this;
        const captured = { ...(intent as Record<string, unknown>) };
        interruptCalls.push(captured);
        acceptedBeforeInterrupt = auditRepository.get(String(captured.operation_id ?? ""))?.records[0]?.phase === "accepted";
        expect(deadline.signal).toBeInstanceOf(AbortSignal);
        if (options.interruptError !== undefined) throw options.interruptError;
        return sequenceValue(options.interruptResults ?? [progress("accepted", null)], interruptIndex++) as SelectedOperationProgress;
      },
      async waitForTerminal(this: void, target: unknown, deadline: OperationDeadline) {
        waitThis = this;
        waitCalls.push(target);
        waitAfterInterrupt = interruptCalls.length === 1 && deadline.signal instanceof AbortSignal;
        if (options.waitError !== undefined) throw options.waitError;
        return sequenceValue(options.terminalResults ?? [progress("interrupted", null)], terminalIndex++) as SelectedOperationProgress;
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
  const registration = createHostDeckInterruptRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback interrupt route must not authenticate a device.");
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
    acceptedBeforeInterrupt: () => acceptedBeforeInterrupt,
    app,
    auditCount: () =>
      (open.db.prepare("SELECT COUNT(*) AS count FROM selected_audit_events").get() as { readonly count: number }).count,
    auditRepository,
    registration,
    routeInput,
    interruptCalls: () => [...interruptCalls],
    interruptThis: () => interruptThis,
    requireCalls: () => [...requireCalls],
    requireThis: () => requireThis,
    runtimeReads: () => runtimeReads,
    stateReads: () => stateReads,
    waitAfterInterrupt: () => waitAfterInterrupt,
    waitCalls: () => [...waitCalls],
    waitThis: () => waitThis,
    rawAuditRecords(operation) {
      return (open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operation) as readonly { readonly record_json: string }[]).map((row) => row.record_json);
    },
    failTerminalAudit() {
      open.db.exec(`
        CREATE TRIGGER fail_interrupt_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced interrupt terminal audit failure');
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

function turnTarget() {
  return { type: "turn" as const, session_id: sessionId, codex_thread_id: threadId, turn_id: turnId };
}

function progress(
  state: "accepted" | "failed" | "incomplete" | "interrupted",
  failure: ReturnType<typeof error> | null,
  operation = operationId
): SelectedOperationProgress {
  return selectedOperationProgressSchema.parse({
    operation_id: operation,
    kind: "interrupt",
    target: turnTarget(),
    state,
    updated_at: timestamp,
    turn_id: turnId,
    error: failure
  });
}

function error(code: "operation_conflict" | "session_not_writable") {
  return { code, message: "private terminal interrupt error", retryable: false } as const;
}

function selectedState(state: "active" | "archived" | "contradictory" | "recovery" | "stale"): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "interrupt-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-interrupt-route",
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
      cwd: state === "contradictory" ? "/tmp/hostdeck-interrupt-route-other" : mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: archivedAt,
      session_state: state === "archived" ? "archived" : stale ? "stale" : "active",
      turn_state: state === "archived" ? "idle" : stale ? "unknown" : "in_progress",
      attention: state === "archived" ? "none" : stale ? "unknown" : "none",
      freshness: stale ? "stale" : "current",
      freshness_reason: stale ? "Projection requires reconciliation." : null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed interrupt route test session.",
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
    binding_id: connected ? "binding-interrupt-route-001" : null,
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

function interruptServiceError(
  code: CodexInterruptControlErrorCode,
  apiCode: ConstructorParameters<typeof HostDeckCodexInterruptControlError>[1],
  outcome: CodexInterruptControlOutcome
): HostDeckCodexInterruptControlError {
  return new HostDeckCodexInterruptControlError(code, apiCode, "private interrupt service error", outcome, false);
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Interrupt route test sequence is empty.");
  return value;
}

function interruptPath() {
  return `/api/v1/sessions/${sessionId}/turns/${turnId}/interrupt`;
}

async function interruptTurn(harness: Pick<Harness, "app">, payload: Readonly<Record<string, unknown>>) {
  return await injectHostDeckLoopback(harness.app, { method: "POST", url: interruptPath(), payload });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toMatch(/private interrupt|private terminal|\/private\/interrupt/iu);
}
