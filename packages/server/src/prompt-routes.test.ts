import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type PromptTurnControlSnapshot,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexPromptControlOutcome,
  HostDeckCodexPromptControlError
} from "./codex-prompt-control-service.js";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  hostDeckLoopbackTestAuthority,
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  HostDeckManagedCodexThreadServiceError,
  type ManagedCodexThreadServiceOutcome
} from "./managed-thread-service.js";
import {
  type CreateHostDeckPromptRouteRegistrationInput,
  createHostDeckPromptRouteRegistration,
  hostDeckPromptRouteRegistrationId
} from "./prompt-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-15T20:00:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_prompt_route_001";
const threadId = "thread-prompt-route-001";
const privatePrompt = "PROMPT_ROUTE_PRIVATE_SENTINEL continue the selected task";
const promptRequest = Object.freeze({
  operation_id: "op_prompt_route_001",
  kind: "prompt" as const,
  text: privatePrompt
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session prompt route", () => {
  it("requires exact branded composition and registers the manifest route once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration.id).toBe(hostDeckPromptRouteRegistrationId);
      expect(harness.registration.surface).toBe("api");
      expect(Object.isFrozen(harness.registration)).toBe(true);
      expect(() =>
        harness.registration.register(harness.app, {
          resourceBudget: defaultResourceBudget,
          surface: "api"
        })
      ).toThrow("already registered");

      let accessorCalls = 0;
      const accessor = Object.defineProperty({}, "audit", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("private-accessor-sentinel");
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
        { ...harness.routeInput, audit: {} },
        { ...harness.routeInput, csrf: {} },
        { ...harness.routeInput, lock: {} },
        { ...harness.routeInput, prompts: {} },
        {
          ...harness.routeInput,
          prompts: {
            dispatch: harness.routeInput.prompts.dispatch,
            snapshot: harness.routeInput.prompts.snapshot,
            extra: true
          }
        },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, sessions: {} },
        accessor
      ]) {
        expect(() =>
          createHostDeckPromptRouteRegistration(candidate as never)
        ).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("starts once over loopback with the exact durable audit receipt and no prompt persistence", async () => {
    const harness = await createHarness();
    try {
      const response = await sendPrompt(harness, promptRequest);
      expect(response.statusCode, response.body).toBe(202);
      const trail = harness.auditRepository.require(promptRequest.operation_id);
      const accepted = trail.records[0];
      expect(response.json()).toEqual({
        operation_id: promptRequest.operation_id,
        kind: "prompt",
        target: {
          type: "managed_session",
          session_id: sessionId,
          codex_thread_id: threadId
        },
        state: "accepted",
        accepted_at: accepted?.at,
        audit_record_id: accepted?.id,
        turn_id: "turn-prompt-route-001",
        action: "start"
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(harness.readCalls()).toEqual([sessionId, sessionId]);
      expect(harness.runtimeReads()).toBe(2);
      expect(harness.snapshotCalls()).toHaveLength(2);
      expect(harness.dispatchCalls()).toEqual([
        {
          operation_id: promptRequest.operation_id,
          target: {
            type: "managed_session",
            session_id: sessionId,
            codex_thread_id: threadId
          },
          kind: "prompt",
          text: privatePrompt
        }
      ]);
      expect(harness.dispatchThis()).toBeUndefined();
      expect(harness.acceptedBeforeDispatch()).toBe(true);
      expect(harness.signalObserved()).toBe(true);
      expect(trail).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            action: "prompt",
            payload_summary: {
              schema_version: 1,
              text_length: privatePrompt.length
            },
            error_code: null
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            action: "prompt",
            payload_summary: { schema_version: 1, accepted: true },
            error_code: null
          }
        ]
      });
      const raw = harness.rawAuditRecords(promptRequest.operation_id).join("\n");
      expect(raw).not.toContain(privatePrompt);
      expect(raw).not.toContain("PROMPT_ROUTE_PRIVATE_SENTINEL");
      expect(response.body).not.toContain(privatePrompt);
    } finally {
      await harness.close();
    }
  });

  it("accepts only event-proven exact-turn steer for an in-progress session", async () => {
    const steerSnapshot = promptSnapshot("steerable");
    const harness = await createHarness({
      stateResults: [selectedState("in_progress")],
      snapshotResults: [steerSnapshot],
      dispatchResult: {
        thread_id: threadId,
        turn_id: steerSnapshot.turn_id,
        state: "accepted",
        action: "steer",
        model_revision: null,
        plan_revision: null,
        steerable: true
      }
    });
    try {
      const response = await sendPrompt(harness, {
        ...promptRequest,
        operation_id: "op_prompt_route_steer"
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        action: "steer",
        turn_id: steerSnapshot.turn_id
      });
      expect(harness.dispatchCalls()).toHaveLength(1);
    } finally {
      await harness.close();
    }

    for (const [label, snapshot] of [
      ["idle", promptSnapshot("idle")],
      ["accepted", promptSnapshot("accepted")]
    ] as const) {
      const unproven = await createHarness({
        stateResults: [selectedState("in_progress")],
        snapshotResults: [snapshot]
      });
      const operationId = `op_prompt_route_unproven_${label}`;
      try {
        const response = await sendPrompt(unproven, {
          ...promptRequest,
          operation_id: operationId
        });
        expectStableError(response, 409, "operation_conflict", true);
        expect(unproven.dispatchCalls()).toEqual([]);
        expect(unproven.auditRepository.get(operationId)).toBeNull();
      } finally {
        await unproven.close();
      }
    }
  });

  it("rejects malformed requests, injected targets, methods, paths, query, and lock before target state", async () => {
    const harness = await createHarness();
    try {
      const candidates = [
        { ...promptRequest, target: { session_id: sessionId, codex_thread_id: "thread-injected" } },
        { ...promptRequest, codex_thread_id: "thread-injected" },
        { ...promptRequest, text: "   " },
        { ...promptRequest, text: "x".repeat(20_001) }
      ];
      for (const candidate of candidates) {
        const response = await sendPrompt(harness, candidate);
        expectStableError(response, 400, "validation_error");
      }
      const query = await injectHostDeckLoopback(harness.app, {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/prompts?target=other`,
        payload: promptRequest
      });
      expectStableError(query, 400, "validation_error");
      for (const method of ["GET", "HEAD"] as const) {
        const response = await injectHostDeckLoopback(harness.app, {
          method,
          url: `/api/v1/sessions/${sessionId}/prompts`
        });
        expectStableError(response, 405, "method_not_allowed");
      }
      const invalidPath = await injectHostDeckLoopback(harness.app, {
        method: "POST",
        url: "/api/v1/sessions/session%20with%20spaces/prompts",
        payload: promptRequest
      });
      expectStableError(invalidPath, 400, "validation_error");
      const adjacent = await injectHostDeckLoopback(harness.app, {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/prompts/extra`,
        payload: promptRequest
      });
      expectStableError(adjacent, 404, "route_not_found");
      expect(harness.readCalls()).toEqual([]);
      expect(harness.runtimeReads()).toBe(0);
      expect(harness.dispatchCalls()).toEqual([]);
    } finally {
      await harness.close();
    }

    const locked = await createHarness({ locked: true });
    try {
      const response = await sendPrompt(locked, {
        ...promptRequest,
        operation_id: "op_prompt_route_locked"
      });
      expectStableError(response, 423, "host_locked");
      expect(locked.readCalls()).toEqual([]);
      expect(locked.runtimeReads()).toBe(0);
      expect(locked.dispatchCalls()).toEqual([]);
    } finally {
      await locked.close();
    }
  });

  it("rejects missing, archived, waiting, stale, recovery, and contradictory sessions before audit", async () => {
    const cases: readonly [string, HarnessOptions, number, string, boolean][] = [
      [
        "missing",
        { readError: managedServiceError("thread_not_found", "not_sent") },
        404,
        "session_not_found",
        false
      ],
      ["archived", { stateResults: [selectedState("archived")] }, 409, "session_not_writable", false],
      ["waiting", { stateResults: [selectedState("waiting")] }, 409, "session_not_writable", true],
      ["stale", { stateResults: [selectedState("stale")] }, 409, "stale_session", false],
      ["recovery", { stateResults: [selectedState("recovery")] }, 409, "stale_session", false],
      ["contradictory", { stateResults: [selectedState("contradictory")] }, 409, "stale_session", false]
    ];
    for (const [label, options, status, code, retryable] of cases) {
      const harness = await createHarness(options);
      const operationId = `op_prompt_route_state_${label}`;
      try {
        const response = await sendPrompt(harness, {
          ...promptRequest,
          operation_id: operationId
        });
        expectStableError(response, status, code, retryable);
        expect(harness.runtimeReads()).toBe(0);
        expect(harness.snapshotCalls()).toEqual([]);
        expect(harness.dispatchCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }
  });

  it("rejects runtime drift, disconnect, blocked mutation, and prompt capability loss before audit", async () => {
    const cases: readonly [string, unknown, number, string][] = [
      ["drift", runtimeCandidate({ version: "0.145.0" }), 409, "incompatible_runtime"],
      ["disconnected", runtimeCandidate({ state: "disconnected" }), 503, "runtime_unavailable"],
      [
        "turn-steer-missing",
        runtimeCandidate({ state: "incompatible", unavailableCapability: "turn_steer" }),
        409,
        "incompatible_runtime"
      ],
      [
        "blocked",
        runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" }),
        409,
        "incompatible_runtime"
      ]
    ];
    for (const [label, runtime, status, code] of cases) {
      const harness = await createHarness({ runtimeResults: [runtime] });
      const operationId = `op_prompt_route_runtime_${label}`;
      try {
        const response = await sendPrompt(harness, {
          ...promptRequest,
          operation_id: operationId
        });
        expectStableError(response, status, code, code === "runtime_unavailable");
        expect(harness.snapshotCalls()).toEqual([]);
        expect(harness.dispatchCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }
  });

  it("records pre-dispatch target drift as failed without crossing targets", async () => {
    const operationId = "op_prompt_route_predispatch_drift";
    const harness = await createHarness({
      stateResults: [selectedState("terminal"), selectedState("contradictory")]
    });
    try {
      const response = await sendPrompt(harness, {
        ...promptRequest,
        operation_id: operationId
      });
      expectStableError(response, 409, "stale_session");
      expect(harness.dispatchCalls()).toEqual([]);
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "failed", error_code: "stale_session" }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("distinguishes known rejection, possible-send ambiguity, and malformed acceptance", async () => {
    const cases: readonly [string, HarnessOptions, number, string, string][] = [
      [
        "known",
        { dispatchError: promptServiceError("operation_conflict", "remote_rejected") },
        409,
        "operation_conflict",
        "failed"
      ],
      [
        "unknown",
        { dispatchError: promptServiceError("unknown_outcome", "unknown") },
        409,
        "unknown_error",
        "incomplete"
      ],
      [
        "malformed",
        { dispatchResult: { private: "private-result-sentinel" } },
        500,
        "internal_error",
        "incomplete"
      ]
    ];
    for (const [label, options, status, code, outcome] of cases) {
      const harness = await createHarness(options);
      const operationId = `op_prompt_route_dispatch_${label}`;
      try {
        const response = await sendPrompt(harness, {
          ...promptRequest,
          operation_id: operationId
        });
        expectStableError(response, status, code, label === "known");
        expect(response.body).not.toContain("private-result-sentinel");
        expect(response.body).not.toContain(privatePrompt);
        expect(harness.dispatchCalls()).toHaveLength(1);
        expect(harness.auditRepository.require(operationId)).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", outcome: "accepted" },
            { phase: "terminal", outcome, error_code: code }
          ]
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("replays duplicate operation results without a second prompt dispatch", async () => {
    const harness = await createHarness();
    try {
      const first = await sendPrompt(harness, promptRequest);
      expect(first.statusCode, first.body).toBe(202);
      const duplicate = await sendPrompt(harness, promptRequest);
      expect(duplicate.statusCode, duplicate.body).toBe(202);
      expect(duplicate.json()).toEqual(first.json());
      expect(harness.dispatchCalls()).toHaveLength(1);
      expect(
        harness.auditRepository.require(promptRequest.operation_id).records
      ).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("keeps accepted prompt and terminal audit authoritative after HTTP response loss", async () => {
    let releaseDispatch: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const operationId = "op_prompt_route_response_loss";
    const harness = await createHarness({ dispatchBarrier: barrier });
    try {
      await harness.app.listen({
        host: "127.0.0.1",
        port: 0,
        listenTextResolver: () => ""
      });
      const address = harness.app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Prompt response-loss listener is unavailable.");
      }
      const body = JSON.stringify({
        ...promptRequest,
        operation_id: operationId
      });
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${sessionId}/prompts`,
        headers: {
          host: hostDeckLoopbackTestAuthority,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close"
        }
      });
      const closed = new Promise<void>((resolve) => {
        outgoing.once("error", () => resolve());
        outgoing.once("close", () => resolve());
      });
      outgoing.end(body);
      await waitFor(() => harness.dispatchCalls().length === 1);
      outgoing.destroy();
      releaseDispatch?.();
      await closed;
      await waitFor(
        () => harness.auditRepository.get(operationId)?.state === "terminal"
      );

      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "succeeded" }
        ]
      });
      const retry = await sendPrompt(harness, {
        ...promptRequest,
        operation_id: operationId
      });
      expect(retry.statusCode, retry.body).toBe(202);
      expect(retry.json()).toMatchObject({ operation_id: operationId, state: "accepted" });
      expect(harness.dispatchCalls()).toHaveLength(1);
    } finally {
      releaseDispatch?.();
      await harness.close();
    }
  });

  it("suppresses success when terminal audit proof fails after Codex acceptance", async () => {
    let releaseDispatch: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const operationId = "op_prompt_route_terminal_audit_failure";
    const harness = await createHarness({ dispatchBarrier: barrier });
    try {
      const responsePromise = sendPrompt(harness, {
        ...promptRequest,
        operation_id: operationId
      });
      await waitFor(() => harness.dispatchCalls().length === 1);
      harness.failTerminalAudit();
      releaseDispatch?.();
      const response = await responsePromise;
      expectStableError(response, 503, "audit_unavailable");
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
      expect(harness.dispatchCalls()).toHaveLength(1);
    } finally {
      releaseDispatch?.();
      await harness.close();
    }
  });
});

interface HarnessOptions {
  readonly dispatchBarrier?: Promise<void>;
  readonly dispatchError?: Error;
  readonly dispatchResult?: unknown;
  readonly locked?: boolean;
  readonly readError?: Error;
  readonly runtimeResults?: readonly unknown[];
  readonly snapshotError?: Error;
  readonly snapshotResults?: readonly unknown[];
  readonly stateResults?: readonly unknown[];
}

interface RouteInputFixture {
  readonly admission: CreateHostDeckPromptRouteRegistrationInput["admission"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly prompts: CreateHostDeckPromptRouteRegistrationInput["prompts"];
  readonly runtime: CreateHostDeckPromptRouteRegistrationInput["runtime"];
  readonly sessions: CreateHostDeckPromptRouteRegistrationInput["sessions"];
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly acceptedBeforeDispatch: () => boolean;
  readonly dispatchCalls: () => readonly Record<string, unknown>[];
  readonly dispatchThis: () => unknown;
  readonly readCalls: () => readonly string[];
  readonly runtimeReads: () => number;
  readonly signalObserved: () => boolean;
  readonly snapshotCalls: () => readonly unknown[];
  readonly rawAuditRecords: (operationId: string) => readonly string[];
  readonly failTerminalAudit: () => void;
  readonly close: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-prompt-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => new Date(timestamp)
  });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_prompt_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback prompt must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback prompt must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Prompt route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const readCalls: string[] = [];
  const snapshotCalls: unknown[] = [];
  const dispatchCalls: Record<string, unknown>[] = [];
  let runtimeReads = 0;
  let readIndex = 0;
  let runtimeIndex = 0;
  let snapshotIndex = 0;
  let dispatchThis: unknown = "not-called";
  let acceptedBeforeDispatch = false;
  let signalObserved = false;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    csrf,
    lock,
    prompts: {
      async snapshot(target: unknown) {
        snapshotCalls.push(target);
        if (options.snapshotError !== undefined) throw options.snapshotError;
        return sequenceValue(
          options.snapshotResults ?? [promptSnapshot("idle")],
          snapshotIndex++
        );
      },
      async dispatch(this: void, intent: unknown, signal?: AbortSignal) {
        dispatchThis = this;
        const captured = { ...(intent as Record<string, unknown>) };
        dispatchCalls.push(captured);
        const operationId = String(captured.operation_id ?? "");
        acceptedBeforeDispatch =
          auditRepository.get(operationId)?.records[0]?.phase === "accepted";
        signalObserved = signal instanceof AbortSignal;
        await options.dispatchBarrier;
        if (options.dispatchError !== undefined) throw options.dispatchError;
        return options.dispatchResult ?? {
          thread_id: threadId,
          turn_id: "turn-prompt-route-001",
          state: "accepted",
          action: "start",
          model_revision: null,
          plan_revision: null,
          steerable: false
        };
      }
    } as unknown as RouteInputFixture["prompts"],
    runtime: {
      read() {
        runtimeReads += 1;
        return sequenceValue(
          options.runtimeResults ?? [runtimeCandidate()],
          runtimeIndex++
        );
      }
    },
    sessions: {
      read(candidate) {
        readCalls.push(candidate);
        if (options.readError !== undefined) throw options.readError;
        return sequenceValue(
          options.stateResults ?? [selectedState("terminal")],
          readIndex++
        ) as SelectedSessionState;
      }
    }
  };
  const registration = createHostDeckPromptRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback prompt must not authenticate a device.");
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
    app,
    auditRepository,
    registration,
    routeInput,
    acceptedBeforeDispatch: () => acceptedBeforeDispatch,
    dispatchCalls: () => [...dispatchCalls],
    dispatchThis: () => dispatchThis,
    readCalls: () => [...readCalls],
    runtimeReads: () => runtimeReads,
    signalObserved: () => signalObserved,
    snapshotCalls: () => [...snapshotCalls],
    rawAuditRecords(operationId) {
      return (open.db
        .prepare(
          "SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase"
        )
        .all(operationId) as readonly { readonly record_json: string }[])
        .map((row) => row.record_json);
    },
    failTerminalAudit() {
      open.db.exec(`
        CREATE TRIGGER fail_prompt_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced prompt terminal audit failure');
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

function selectedState(
  state: "archived" | "contradictory" | "in_progress" | "recovery" | "stale" | "terminal" | "waiting"
): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "prompt-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-prompt-route",
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
      cwd:
        state === "contradictory"
          ? "/tmp/hostdeck-prompt-route-contradictory"
          : mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: archivedAt,
      session_state: state === "archived" ? "archived" : stale ? "stale" : "active",
      turn_state:
        state === "in_progress"
          ? "in_progress"
          : state === "waiting"
            ? "waiting_for_input"
            : stale
              ? "unknown"
              : "idle",
      attention:
        state === "waiting" ? "needs_input" : stale ? "unknown" : "none",
      freshness: stale ? "stale" : "current",
      freshness_reason: stale ? "Projection requires reconciliation." : null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Managed prompt route test session.",
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
    mutation_policy:
      input.mutationPolicy ??
      (state === "ready" || state === "degraded" ? "allowed" : "blocked"),
    observed_version: connected ? (input.version ?? runtimeVersion) : null,
    binding_id: connected ? "binding-prompt-route-001" : null,
    capabilities: runtimeCapabilities.map((name) =>
      name === input.unavailableCapability ||
      (state === "incompatible" && input.unavailableCapability === undefined && name === "turn_input")
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not ready."
  });
}

function promptSnapshot(
  phase: "accepted" | "idle" | "steerable"
): PromptTurnControlSnapshot {
  if (phase === "idle") {
    return {
      phase,
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
  }
  return {
    phase,
    last_action: "start",
    operation_id: "op_prompt_route_prior",
    turn_id: "turn-prompt-route-prior",
    model_revision: null,
    plan_revision: null,
    requested_at: timestamp,
    accepted_at: timestamp,
    started_at: phase === "steerable" ? timestamp : null,
    error: null
  } as PromptTurnControlSnapshot;
}

function settings(locked: boolean) {
  return Object.freeze({
    locked,
    settings_updated_at: timestamp
  });
}

function promptServiceError(
  code: HostDeckCodexPromptControlError["code"],
  outcome: CodexPromptControlOutcome
): HostDeckCodexPromptControlError {
  return new HostDeckCodexPromptControlError(
    code,
    code === "unknown_outcome" ? "unknown_error" : "operation_conflict",
    "private-prompt-service-error-sentinel",
    outcome,
    false
  );
}

function managedServiceError(
  code: HostDeckManagedCodexThreadServiceError["code"],
  outcome: ManagedCodexThreadServiceOutcome
): HostDeckManagedCodexThreadServiceError {
  return new HostDeckManagedCodexThreadServiceError(
    code,
    "private-managed-service-error-sentinel",
    outcome,
    false,
    threadId
  );
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Prompt route test sequence is empty.");
  return value;
}

async function sendPrompt(
  harness: Pick<Harness, "app">,
  payload: Readonly<Record<string, unknown>>
) {
  return await injectHostDeckLoopback(harness.app, {
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/prompts`,
    payload
  });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toContain("private-");
  expect(response.body).not.toContain(privatePrompt);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for prompt route condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
