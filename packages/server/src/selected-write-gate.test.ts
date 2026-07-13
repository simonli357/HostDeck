import "reflect-metadata";

import { mkdtempSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  defaultRetentionPolicy,
  managedSessionTargetSchema,
  promptOperationIntentSchema,
  resolveResourceBudget
} from "@hostdeck/contracts";
import {
  createSelectedAuditRepository,
  HostDeckAuthRepositoryError,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  hostDeckNoStoreRouteConfig
} from "./fastify-app.js";
import { HostDeckHttpError } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import {
  createHostDeckHostLockPolicy,
  hostDeckHostLockPolicySnapshot
} from "./host-lock-routes.js";
import { createHostDeckLanCertificatePolicy } from "./lan-certificate-policy.js";
import {
  createSecurityMutationAuditExecutor
} from "./security-mutation-audit-executor.js";
import {
  type SelectedApiRouteManifestEntry,
  selectedApiRouteManifest
} from "./selected-api-route-manifest.js";
import {
  assertHostDeckSelectedWriteGate,
  createHostDeckSelectedWriteAuditPort,
  createHostDeckSelectedWriteGate,
  createHostDeckSelectedWriteMutation,
  createHostDeckSelectedWriteTargetResolution,
  type ExecuteSelectedWriteAuditInput,
  type HostDeckSelectedWriteAuditExecute,
  HostDeckSelectedWriteGateError,
  parseSelectedWriteAuditSummary
} from "./selected-write-gate.js";

const tempDirectories: string[] = [];
const openDatabases: Array<{ readonly close: () => unknown }> = [];
const localOrigin = "http://localhost";
const secureOrigin = "https://192.168.0.29:3777";
const rawDeviceToken = "D".repeat(43);
const rawCsrfToken = "C".repeat(43);
const createdAt = "2026-07-13T14:00:00.000Z";
const authenticatedAt = "2026-07-13T14:01:00.000Z";
const authorizedAt = "2026-07-13T14:02:00.000Z";
const auditAt = "2026-07-13T14:03:00.000Z";
const promptTarget = Object.freeze(
  managedSessionTargetSchema.parse({
    type: "managed_session",
    session_id: "sess_gate_alpha",
    codex_thread_id: "thread-gate-alpha"
  })
);
const secondPromptTarget = Object.freeze(
  managedSessionTargetSchema.parse({
    type: "managed_session",
    session_id: "sess_gate_bravo",
    codex_thread_id: "thread-gate-bravo"
  })
);
const acceptedAuditContext = Object.freeze({ audit_state: "accepted" as const });
const shortRequestBudget = resolveResourceBudget({
  http_headers_timeout_ms: 1_000,
  http_request_receive_timeout_ms: 1_000,
  http_request_deadline_ms: 1_100,
  protocol_read_timeout_ms: 1_000,
  protocol_mutation_timeout_ms: 1_000,
  protocol_start_timeout_ms: 1_000,
  cli_connect_timeout_ms: 1_000,
  cli_request_timeout_ms: 1_100
});

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected exact-target write gate", () => {
  it("brands exact configuration and rejects copied, accessor, and contradictory manifest inputs", () => {
    const dependencies = createGateDependencies("prompt_dispatch");
    const gate = createHostDeckSelectedWriteGate(dependencies);
    expect(Object.isFrozen(gate)).toBe(true);
    expect(() => assertHostDeckSelectedWriteGate(gate)).not.toThrow();
    expect(() => assertHostDeckSelectedWriteGate(Object.freeze({ ...gate }))).toThrow(TypeError);
    expect(gate.snapshot()).toEqual(emptyGateSnapshot());
    expect(Object.isFrozen(gate.snapshot())).toBe(true);

    const promptManifest = manifest("prompt_dispatch");
    const wrongExecutor = createHostDeckSelectedWriteAuditPort<"prompt">({
      executor: "security_executor",
      execute: createPassThroughAuditExecute([])
    });
    const invalidInputs = [
      null,
      {},
      { ...dependencies, extra: true },
      { ...dependencies, manifest: { ...promptManifest } },
      { ...dependencies, manifest: manifest("session_detail") },
      { ...dependencies, manifest: manifest("host_lock") },
      { ...dependencies, audit: Object.freeze({ ...dependencies.audit }) },
      { ...dependencies, csrf: Object.freeze({ ...dependencies.csrf }) },
      { ...dependencies, lock: Object.freeze({ ...dependencies.lock }) },
      { ...dependencies, audit: wrongExecutor }
    ];
    for (const candidate of invalidInputs) {
      expect(() => createHostDeckSelectedWriteGate(candidate as never)).toThrow(
        expect.objectContaining({
          code: "configuration_invalid",
          stage: "configuration",
          retry_safe: false
        })
      );
    }

    let accessorCalls = 0;
    const accessor = Object.defineProperties(
      {
        audit: dependencies.audit,
        csrf: dependencies.csrf,
        lock: dependencies.lock
      },
      {
        manifest: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return promptManifest;
          }
        }
      }
    );
    expect(() => createHostDeckSelectedWriteGate(accessor as never)).toThrow(
      HostDeckSelectedWriteGateError
    );
    expect(accessorCalls).toBe(0);
  });

  it("rejects malformed execution envelopes before invoking any callback", async () => {
    const gate = createHostDeckSelectedWriteGate(createGateDependencies("prompt_dispatch"));
    let callbackCalls = 0;
    let accessorCalls = 0;
    const execution = {
      candidate: null,
      dispatch: () => {
        callbackCalls += 1;
      },
      parse: () => {
        callbackCalls += 1;
      },
      prepare_response: () => {
        callbackCalls += 1;
      },
      request: Object.freeze({}),
      resolve_target: () => {
        callbackCalls += 1;
      }
    };
    const accessor = Object.defineProperties(
      {
        candidate: execution.candidate,
        dispatch: execution.dispatch,
        prepare_response: execution.prepare_response,
        request: execution.request,
        resolve_target: execution.resolve_target
      },
      {
        parse: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return execution.parse;
          }
        }
      }
    );
    const invalid = [null, {}, { ...execution, extra: true }, accessor];

    for (const candidate of invalid) {
      await expect(gate.execute(candidate as never)).rejects.toMatchObject({
        code: "input_invalid",
        stage: "input",
        retry_safe: true
      });
    }
    expect(callbackCalls).toBe(0);
    expect(accessorCalls).toBe(0);
    expect(gate.snapshot()).toEqual({
      ...emptyGateSnapshot(),
      attempts: invalid.length,
      contract_failures: invalid.length
    });
  });

  it("canonicalizes exact targets and enforces versioned secret-free action summaries", () => {
    const mutation = promptMutation("op_gate_contract_0001", promptTarget, "hello");
    expect(Object.isFrozen(mutation)).toBe(true);
    expect(Object.isFrozen(mutation.target)).toBe(true);
    expect(Object.isFrozen(mutation.accepted_summary)).toBe(true);
    expect(mutation.accepted_summary).toEqual({ schema_version: 1, text_length: 5 });

    const mutableValue = {
      text: "original",
      metadata: { flags: [true, false] }
    };
    const canonical = createHostDeckSelectedWriteMutation({
      operation_id: "op_gate_contract_0005",
      action: "prompt",
      target: promptTarget,
      accepted_summary: { schema_version: 1, text_length: 8 },
      value: mutableValue
    });
    mutableValue.text = "changed";
    mutableValue.metadata.flags[0] = false;
    expect(canonical.value).toEqual({
      text: "original",
      metadata: { flags: [true, false] }
    });
    expect(Object.isFrozen(canonical.value)).toBe(true);
    expect(Object.isFrozen(canonical.value.metadata)).toBe(true);
    expect(Object.isFrozen(canonical.value.metadata.flags)).toBe(true);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      createHostDeckSelectedWriteMutation({
        operation_id: "op_gate_contract_0006",
        action: "prompt",
        target: promptTarget,
        accepted_summary: { schema_version: 1, text_length: 1 },
        value: cyclic
      })
    ).toThrow(TypeError);
    expect(() =>
      createHostDeckSelectedWriteMutation({
        operation_id: "op_gate_contract_0007",
        action: "prompt",
        target: promptTarget,
        accepted_summary: { schema_version: 1, text_length: 1 },
        value: { ["k".repeat(257)]: true }
      })
    ).toThrow(TypeError);

    expect(
      parseSelectedWriteAuditSummary("prompt", "terminal", "succeeded", {
        schema_version: 1,
        accepted: true
      })
    ).toEqual({ schema_version: 1, accepted: true });
    expect(
      parseSelectedWriteAuditSummary("device_revoke", "accepted", "accepted", {
        schema_version: 1,
        previously_revoked: false
      })
    ).toEqual({ schema_version: 1, previously_revoked: false });
    expect(
      parseSelectedWriteAuditSummary("model", "accepted", "accepted", {
        schema_version: 1,
        model_id: "m".repeat(160),
        reasoning_effort: "e".repeat(80),
        expected_revision_present: false
      })
    ).toMatchObject({ model_id: "m".repeat(160), reasoning_effort: "e".repeat(80) });
    expect(
      parseSelectedWriteAuditSummary("goal", "accepted", "accepted", {
        schema_version: 1,
        goal_action: "set",
        objective_length: 1,
        expected_revision_present: false
      })
    ).toMatchObject({ goal_action: "set", objective_length: 1 });
    expect(
      parseSelectedWriteAuditSummary("goal", "accepted", "accepted", {
        schema_version: 1,
        goal_action: "clear",
        objective_length: 0,
        expected_revision_present: true
      })
    ).toMatchObject({ goal_action: "clear", objective_length: 0 });

    for (const summary of [
      {},
      { schema_version: 2, text_length: 5 },
      { schema_version: 1, prompt: "private prompt", text_length: 14 },
      { schema_version: 1, command: "/plan" },
      { schema_version: 1, raw_payload: "private" },
      { schema_version: 1, text_length: 20_001 },
      { schema_version: 1, accepted: true }
    ]) {
      expect(() =>
        createHostDeckSelectedWriteMutation({
          operation_id: "op_gate_contract_0002",
          action: "prompt",
          target: promptTarget,
          accepted_summary: summary,
          value: Object.freeze({ text: "private prompt" })
        })
      ).toThrow(TypeError);
    }
    expect(() =>
      parseSelectedWriteAuditSummary("prompt", "terminal", "failed", {
        schema_version: 1,
        accepted: true
      })
    ).toThrow(TypeError);
    for (const [action, summary] of [
      [
        "session_start",
        { schema_version: 1, name_length: 65, cwd_present: true }
      ],
      [
        "model",
        {
          schema_version: 1,
          model_id: "m".repeat(161),
          reasoning_effort: null,
          expected_revision_present: false
        }
      ],
      [
        "model",
        {
          schema_version: 1,
          model_id: "model",
          reasoning_effort: "e".repeat(81),
          expected_revision_present: false
        }
      ],
      [
        "goal",
        {
          schema_version: 1,
          goal_action: "set",
          objective_length: 0,
          expected_revision_present: false
        }
      ],
      [
        "goal",
        {
          schema_version: 1,
          goal_action: "clear",
          objective_length: 1,
          expected_revision_present: true
        }
      ],
      [
        "goal",
        {
          schema_version: 1,
          goal_action: "clear",
          objective_length: 0,
          expected_revision_present: false
        }
      ]
    ] as const) {
      expect(() =>
        parseSelectedWriteAuditSummary(action, "accepted", "accepted", summary)
      ).toThrow(TypeError);
    }
    expect(() =>
      parseSelectedWriteAuditSummary("prompt", "terminal", "succeeded", {
        schema_version: 1,
        accepted: true,
        text_length: 5
      })
    ).toThrow(TypeError);
    expect(() =>
      parseSelectedWriteAuditSummary("prompt", "accepted", "succeeded", {
        schema_version: 1,
        text_length: 5
      })
    ).toThrow(TypeError);

    let accessorCalls = 0;
    const targetAccessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "managed_session";
      }
    });
    const summaryAccessor = Object.defineProperty({}, "schema_version", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 1;
      }
    });
    expect(() =>
      createHostDeckSelectedWriteMutation({
        operation_id: "op_gate_contract_0003",
        action: "prompt",
        target: targetAccessor as never,
        accepted_summary: { schema_version: 1, text_length: 1 },
        value: null
      })
    ).toThrow(TypeError);
    expect(() =>
      createHostDeckSelectedWriteMutation({
        operation_id: "op_gate_contract_0004",
        action: "prompt",
        target: promptTarget,
        accepted_summary: summaryAccessor,
        value: null
      })
    ).toThrow(TypeError);
    expect(accessorCalls).toBe(0);
  });

  it("runs local-admin parse, authorization, lock, target, audit, dispatch, preparation, and terminal proof once in order", async () => {
    const harness = createPromptHarness();
    await harness.app.ready();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        payload: promptRequest("op_gate_order_0001", promptTarget, "hello")
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        operation_id: "op_gate_order_0001",
        dispatched: true,
        target_session_id: promptTarget.session_id
      });
      expect(harness.events).toEqual([
        "parse",
        "lock:read",
        "target:resolve",
        "audit:accepted",
        "dispatch",
        "response:prepare",
        "audit:succeeded"
      ]);
      expect(harness.authenticationCalls()).toBe(0);
      expect(harness.csrfCalls()).toBe(0);
      expect(harness.gate.snapshot()).toEqual({
        ...emptyGateSnapshot(),
        attempts: 1,
        dispatches: 1,
        response_preparations: 1,
        succeeded_results: 1
      });
    } finally {
      await harness.app.close();
    }
  });

  it("stops at the first failing stage without touching later ports or leaking private causes", async () => {
    const cases: readonly {
      readonly name: string;
      readonly options: PromptHarnessOptions;
      readonly expectedEvents: readonly string[];
      readonly status: number;
      readonly code: string;
    }[] = [
      {
        name: "parse",
        options: { parseFailure: true },
        expectedEvents: ["parse"],
        status: 500,
        code: "internal_error"
      },
      {
        name: "lock",
        options: { locked: true },
        expectedEvents: ["parse", "lock:read"],
        status: 423,
        code: "host_locked"
      },
      {
        name: "target",
        options: { targetFailure: true },
        expectedEvents: ["parse", "lock:read", "target:resolve"],
        status: 500,
        code: "internal_error"
      },
      {
        name: "capability drift",
        options: { wrongCapability: true },
        expectedEvents: ["parse", "lock:read", "target:resolve"],
        status: 500,
        code: "internal_error"
      },
      {
        name: "target drift",
        options: { wrongTarget: true },
        expectedEvents: ["parse", "lock:read", "target:resolve"],
        status: 500,
        code: "internal_error"
      },
      {
        name: "audit before dispatch",
        options: { auditFailure: true },
        expectedEvents: ["parse", "lock:read", "target:resolve", "audit:accepted"],
        status: 500,
        code: "internal_error"
      },
      {
        name: "accepted proof",
        options: { invalidAcceptedContext: true },
        expectedEvents: ["parse", "lock:read", "target:resolve", "audit:accepted"],
        status: 500,
        code: "internal_error"
      }
    ];

    for (const fixtureCase of cases) {
      const harness = createPromptHarness(fixtureCase.options);
      await harness.app.ready();
      try {
        const response = await harness.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
          payload: promptRequest(
            `op_gate_failure_${fixtureCase.name.replaceAll(" ", "_")}`,
            promptTarget,
            "PRIVATE_PROMPT_SENTINEL"
          )
        });
        expect(response.statusCode, `${fixtureCase.name}: ${response.body}`).toBe(
          fixtureCase.status
        );
        expect(response.json()).toMatchObject({ error: { code: fixtureCase.code } });
        expect(harness.events, fixtureCase.name).toEqual(fixtureCase.expectedEvents);
        expect(response.body).not.toContain("PRIVATE_PROMPT_SENTINEL");
        expect(response.body).not.toContain("private-stage-cause");
      } finally {
        await harness.app.close();
      }
    }
  });

  it("redacts callback-owned HTTP messages and details at parse, target, and audit boundaries", async () => {
    const cases = [
      {
        stage: "parse",
        expectedCode: "validation_error",
        expectedStatus: 400,
        expectedEvents: ["parse"],
        expectedMessage: "Selected mutation input is invalid."
      },
      {
        stage: "target",
        expectedCode: "stale_session",
        expectedStatus: 409,
        expectedEvents: ["parse", "lock:read", "target:resolve"],
        expectedMessage: "Selected mutation target is unavailable."
      },
      {
        stage: "audit",
        expectedCode: "internal_error",
        expectedStatus: 500,
        expectedEvents: ["parse", "lock:read", "target:resolve", "audit:accepted"],
        expectedMessage: undefined
      }
    ] as const;

    for (const fixtureCase of cases) {
      const harness = createPromptHarness({ privateHttpErrorStage: fixtureCase.stage });
      await harness.app.ready();
      try {
        const response = await harness.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
          payload: promptRequest(`op_gate_private_http_${fixtureCase.stage}`, promptTarget, "hello")
        });
        expect(response.statusCode, response.body).toBe(fixtureCase.expectedStatus);
        expect(response.json()).toMatchObject({
          error: {
            code: fixtureCase.expectedCode,
            ...(fixtureCase.expectedMessage === undefined
              ? {}
              : { message: fixtureCase.expectedMessage })
          }
        });
        expect(harness.events).toEqual(fixtureCase.expectedEvents);
        expect(response.body).not.toContain("PRIVATE_HTTP_MESSAGE_SENTINEL");
        expect(response.body).not.toContain("PRIVATE_HTTP_DETAIL_SENTINEL");
      } finally {
        await harness.app.close();
      }
    }
  });

  it("rejects paired plaintext, read-only, and invalid-CSRF requests before lock, target, audit, or dispatch", async () => {
    const plaintext = createPromptHarness({ paired: true });
    await plaintext.app.ready();
    try {
      const response = await injectPairedPrompt(plaintext.app, localOrigin, rawCsrfToken);
      expect(response.statusCode, response.body).toBe(426);
      expect(response.json()).toMatchObject({ error: { code: "insecure_transport" } });
      expect(plaintext.events).toEqual(["parse", "auth:device"]);
      expect(plaintext.csrfCalls()).toBe(0);
    } finally {
      await plaintext.app.close();
    }

    const secureReadOnly = await createSecurePromptHarness({ permission: "read" });
    try {
      const response = await securePromptRequest(secureReadOnly.app, rawCsrfToken);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "read_only" } });
      expect(secureReadOnly.events).toEqual(["parse", "auth:device"]);
      expect(secureReadOnly.csrfCalls()).toBe(0);
    } finally {
      await secureReadOnly.app.close();
    }

    const secureInvalidCsrf = await createSecurePromptHarness({ rejectCsrf: true });
    try {
      const response = await securePromptRequest(secureInvalidCsrf.app, "X".repeat(43));
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "permission_denied" } });
      expect(secureInvalidCsrf.events).toEqual([
        "parse",
        "auth:device",
        "csrf:authorize"
      ]);
    } finally {
      await secureInvalidCsrf.app.close();
    }
  }, 30_000);

  it("composes paired HTTPS authentication and current CSRF before one lock read and exact dispatch", async () => {
    const harness = await createSecurePromptHarness();
    try {
      const response = await securePromptRequest(harness.app, rawCsrfToken);
      expect(
        response.statusCode,
        `${response.body} events=${JSON.stringify(harness.events)} snapshot=${JSON.stringify(harness.gate.snapshot())}`
      ).toBe(200);
      expect(response.json()).toMatchObject({ dispatched: true });
      expect(response.body).not.toContain(rawDeviceToken);
      expect(response.body).not.toContain(rawCsrfToken);
      expect(response.body).not.toContain("hello");
      expect(harness.events).toEqual([
        "parse",
        "auth:device",
        "csrf:authorize",
        "lock:read",
        "target:resolve",
        "audit:accepted",
        "dispatch",
        "response:prepare",
        "audit:succeeded"
      ]);
      expect(harness.authenticationCalls()).toBe(1);
      expect(harness.csrfCalls()).toBe(1);
    } finally {
      await harness.app.close();
    }
  }, 30_000);

  it("keeps revoked, expired, stale, and incompatible states explicit before audit or dispatch", async () => {
    for (const authError of ["device_revoked", "device_expired"] as const) {
      const harness = createPromptHarness({ authError, paired: true });
      await harness.app.ready();
      try {
        const response = await injectPairedPrompt(harness.app, localOrigin, rawCsrfToken);
        expect(response.statusCode, `${authError}: ${response.body}`).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: "permission_denied" } });
        expect(harness.events).toEqual(["parse", "auth:device"]);
      } finally {
        await harness.app.close();
      }
    }

    for (const targetHttpError of ["stale_session", "incompatible_runtime"] as const) {
      const harness = createPromptHarness({ targetHttpError });
      await harness.app.ready();
      try {
        const response = await harness.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
          payload: promptRequest(
            `op_gate_target_${targetHttpError}`,
            promptTarget,
            "hello"
          )
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: targetHttpError } });
        expect(harness.events).toEqual(["parse", "lock:read", "target:resolve"]);
      } finally {
        await harness.app.close();
      }
    }
  });

  it("rejects forged mutation, resolution, dispatch-summary, and audit-result proofs without redispatch", async () => {
    const cases: readonly {
      readonly options: PromptHarnessOptions;
      readonly expectedEvents: readonly string[];
      readonly expectedDispatches: number;
    }[] = [
      {
        options: { forgedMutation: true },
        expectedEvents: ["parse"],
        expectedDispatches: 0
      },
      {
        options: { forgedResolution: true },
        expectedEvents: ["parse", "lock:read", "target:resolve"],
        expectedDispatches: 0
      },
      {
        options: { malformedDispatchSummary: true },
        expectedEvents: [
          "parse",
          "lock:read",
          "target:resolve",
          "audit:accepted",
          "dispatch"
        ],
        expectedDispatches: 1
      },
      {
        options: { accessorDispatchResult: true },
        expectedEvents: [
          "parse",
          "lock:read",
          "target:resolve",
          "audit:accepted",
          "dispatch"
        ],
        expectedDispatches: 1
      },
      {
        options: { unfrozenAuditResult: true },
        expectedEvents: [
          "parse",
          "lock:read",
          "target:resolve",
          "audit:accepted",
          "dispatch",
          "response:prepare",
          "audit:succeeded"
        ],
        expectedDispatches: 1
      },
      {
        options: { accessorAuditResult: true },
        expectedEvents: [
          "parse",
          "lock:read",
          "target:resolve",
          "audit:accepted",
          "dispatch",
          "response:prepare",
          "audit:succeeded"
        ],
        expectedDispatches: 1
      }
    ];
    for (const [index, fixtureCase] of cases.entries()) {
      const harness = createPromptHarness(fixtureCase.options);
      await harness.app.ready();
      try {
        const response = await harness.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
          payload: promptRequest(`op_gate_forged_000${index + 1}`, promptTarget, "hello")
        });
        expect(response.statusCode, response.body).toBe(500);
        expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
        expect(harness.events).toEqual(fixtureCase.expectedEvents);
        expect(harness.gate.snapshot().dispatches).toBe(fixtureCase.expectedDispatches);
        expect(response.body).not.toContain("private-stage-cause");
      } finally {
        await harness.app.close();
      }
    }
  });

  it("records accepted-but-not-sent timeout as failed and post-dispatch timeout as incomplete", async () => {
    const beforeDispatch = createPromptHarness({
      auditDelayMs: 1_250,
      shortDeadline: true
    });
    await beforeDispatch.app.ready();
    try {
      const response = await beforeDispatch.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        payload: promptRequest("op_gate_timeout_0001", promptTarget, "hello")
      });
      expect(response.statusCode, response.body).toBe(504);
      expect(response.json()).toMatchObject({ error: { code: "operation_timeout" } });
      await waitFor(() => beforeDispatch.gate.snapshot().failed_results === 1);
      expect(beforeDispatch.events).toEqual([
        "parse",
        "lock:read",
        "target:resolve",
        "audit:accepted",
        "audit:failed"
      ]);
      expect(beforeDispatch.gate.snapshot()).toMatchObject({
        dispatches: 0,
        failed_results: 1,
        incomplete_results: 0,
        pre_dispatch_timeouts: 1
      });
    } finally {
      await beforeDispatch.app.close();
    }

    const afterDispatch = createPromptHarness({
      dispatchDelayThenThrowMs: 1_250,
      shortDeadline: true
    });
    await afterDispatch.app.ready();
    try {
      const response = await afterDispatch.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        payload: promptRequest("op_gate_timeout_0002", promptTarget, "hello")
      });
      expect(response.statusCode, response.body).toBe(504);
      expect(response.json()).toMatchObject({ error: { code: "operation_timeout" } });
      await waitFor(() => afterDispatch.gate.snapshot().incomplete_results === 1);
      expect(afterDispatch.events).toEqual([
        "parse",
        "lock:read",
        "target:resolve",
        "audit:accepted",
        "dispatch",
        "audit:incomplete"
      ]);
      expect(afterDispatch.gate.snapshot()).toMatchObject({
        dispatches: 1,
        failed_results: 0,
        incomplete_results: 1,
        pre_dispatch_timeouts: 0
      });
    } finally {
      await afterDispatch.app.close();
    }
  }, 15_000);

  it("returns authoritative failed and incomplete dispatch outcomes without response preparation", async () => {
    const cases = [
      {
        outcome: "failed",
        operationId: "op_gate_outcome_0001",
        expectedCode: "operation_conflict"
      },
      {
        outcome: "incomplete",
        operationId: "op_gate_outcome_0002",
        expectedCode: "runtime_unavailable"
      }
    ] as const;

    for (const fixtureCase of cases) {
      const harness = createPromptHarness({ dispatchOutcome: fixtureCase.outcome });
      await harness.app.ready();
      try {
        const response = await harness.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
          payload: promptRequest(fixtureCase.operationId, promptTarget, "hello")
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: fixtureCase.expectedCode } });
        expect(harness.events).toEqual([
          "parse",
          "lock:read",
          "target:resolve",
          "audit:accepted",
          "dispatch",
          `audit:${fixtureCase.outcome}`
        ]);
        expect(harness.gate.snapshot()).toMatchObject({
          dispatches: 1,
          failed_results: fixtureCase.outcome === "failed" ? 1 : 0,
          incomplete_results: fixtureCase.outcome === "incomplete" ? 1 : 0,
          response_preparations: 0,
          succeeded_results: 0
        });
      } finally {
        await harness.app.close();
      }
    }
  });

  it("prevents a hostile audit port from dispatching twice and rejects contradictory terminal results", async () => {
    const duplicate = createPromptHarness({ duplicateTransition: true });
    await duplicate.app.ready();
    try {
      const response = await duplicate.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        payload: promptRequest("op_gate_hostile_0001", promptTarget, "hello")
      });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
      expect(duplicate.events.filter((event) => event === "dispatch")).toHaveLength(1);
      expect(duplicate.events).toContain("audit:second-transition-blocked");
      expect(duplicate.gate.snapshot()).toMatchObject({
        audit_failures: 1,
        dispatches: 1,
        contract_failures: 2,
        succeeded_results: 0
      });
    } finally {
      await duplicate.app.close();
    }

    const duplicatePreparation = createPromptHarness({ duplicatePreparation: true });
    await duplicatePreparation.app.ready();
    try {
      const response = await duplicatePreparation.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        payload: promptRequest("op_gate_hostile_0003", promptTarget, "hello")
      });
      expect(response.statusCode, response.body).toBe(500);
      expect(duplicatePreparation.events.filter((event) => event === "dispatch")).toHaveLength(1);
      expect(duplicatePreparation.events).toContain("audit:second-preparation-blocked");
      expect(duplicatePreparation.gate.snapshot()).toMatchObject({
        audit_failures: 1,
        contract_failures: 2,
        dispatches: 1,
        response_preparations: 1,
        succeeded_results: 0
      });
    } finally {
      await duplicatePreparation.app.close();
    }

    const contradictory = createPromptHarness({ contradictoryAuditResult: true });
    await contradictory.app.ready();
    try {
      const response = await contradictory.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        payload: promptRequest("op_gate_hostile_0002", promptTarget, "hello")
      });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
      expect(contradictory.events.filter((event) => event === "dispatch")).toHaveLength(1);
      expect(contradictory.gate.snapshot()).toMatchObject({
        audit_failures: 1,
        contract_failures: 1,
        dispatches: 1,
        succeeded_results: 0
      });
    } finally {
      await contradictory.app.close();
    }
  });

  it("closes transition and response callbacks when the audit promise settles", async () => {
    const cases = [
      {
        options: { lateTransition: true },
        operationId: "op_gate_late_0001",
        blockedEvent: "audit:late-transition-blocked",
        expectedDispatches: 0
      },
      {
        options: { latePreparation: true },
        operationId: "op_gate_late_0002",
        blockedEvent: "audit:late-preparation-blocked",
        expectedDispatches: 1
      }
    ] as const;

    for (const fixtureCase of cases) {
      const harness = createPromptHarness(fixtureCase.options);
      await harness.app.ready();
      try {
        const response = await harness.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
          payload: promptRequest(fixtureCase.operationId, promptTarget, "hello")
        });
        expect(response.statusCode, response.body).toBe(500);
        expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
        await waitFor(() => harness.events.includes(fixtureCase.blockedEvent));
        expect(harness.events.filter((event) => event === "dispatch")).toHaveLength(
          fixtureCase.expectedDispatches
        );
        expect(harness.events).not.toContain("audit:late-transition-ran");
        expect(harness.events).not.toContain("audit:late-preparation-ran");
        expect(harness.gate.snapshot()).toMatchObject({
          audit_failures: 1,
          dispatches: fixtureCase.expectedDispatches,
          response_preparations: 0,
          succeeded_results: 0
        });
      } finally {
        await harness.app.close();
      }
    }
  });

  it("uses the real security executor and SQLite trail to reject concurrent duplicate operation IDs before a second dispatch", async () => {
    const barrier = deferred<void>();
    const harness = createDeviceRevokeHarness({ dispatchBarrier: barrier.promise });
    await harness.app.ready();
    try {
      const first = harness.app.inject({
        method: "POST",
        url: "/api/v1/access/devices/client_target_alpha/revoke",
        payload: { operation_id: "op_gate_revoke_0001", confirmed: true }
      });
      await harness.dispatchStarted.promise;
      const second = harness.app.inject({
        method: "POST",
        url: "/api/v1/access/devices/client_target_alpha/revoke",
        payload: { operation_id: "op_gate_revoke_0001", confirmed: true }
      });
      await waitFor(() => harness.auditAttempts() === 2);
      barrier.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(harness.dispatches()).toBe(1);
      expect(harness.lockChecks()).toBe(0);
      const trail = harness.repository.require("op_gate_revoke_0001");
      expect(trail.state).toBe("terminal");
      expect(trail.records).toMatchObject([
        {
          action: "device_revoke",
          phase: "accepted",
          outcome: "accepted",
          target: { type: "device", device_id: "client_target_alpha" },
          payload_summary: { schema_version: 1, previously_revoked: false }
        },
        {
          action: "device_revoke",
          phase: "terminal",
          outcome: "succeeded",
          target: { type: "device", device_id: "client_target_alpha" },
          payload_summary: { schema_version: 1, authority_invalidated: true }
        }
      ]);
      expect(harness.gate.snapshot()).toMatchObject({
        attempts: 2,
        audit_failures: 1,
        dispatches: 1,
        succeeded_results: 1
      });
    } finally {
      barrier.resolve();
      await harness.app.close();
    }
  });

  it("preserves truthful real audit state across dispatch, response, and terminal-audit failures", async () => {
    const cases = [
      {
        name: "dispatch",
        operationId: "op_gate_truth_0001",
        options: { dispatchFailure: true },
        expectedStatus: 500,
        expectedCode: "internal_error",
        expectedState: "terminal",
        expectedOutcome: "incomplete"
      },
      {
        name: "response",
        operationId: "op_gate_truth_0002",
        options: { prepareFailure: true },
        expectedStatus: 500,
        expectedCode: "internal_error",
        expectedState: "terminal",
        expectedOutcome: "succeeded"
      },
      {
        name: "terminal audit",
        operationId: "op_gate_truth_0003",
        options: { terminalAuditFailure: true },
        expectedStatus: 503,
        expectedCode: "audit_unavailable",
        expectedState: "pending",
        expectedOutcome: "accepted"
      }
    ] as const;
    for (const fixtureCase of cases) {
      const harness = createDeviceRevokeHarness(fixtureCase.options);
      await harness.app.ready();
      try {
        const request = () =>
          harness.app.inject({
            method: "POST",
            url: "/api/v1/access/devices/client_target_truth/revoke",
            payload: { operation_id: fixtureCase.operationId, confirmed: true }
          });
        const response = await request();
        expect(response.statusCode, `${fixtureCase.name}: ${response.body}`).toBe(
          fixtureCase.expectedStatus
        );
        expect(response.json()).toMatchObject({
          error: { code: fixtureCase.expectedCode }
        });
        expect(response.body).not.toContain("private-stage-cause");
        expect(harness.dispatches()).toBe(1);
        expect(harness.lockChecks()).toBe(0);
        const trail = harness.repository.require(fixtureCase.operationId);
        expect(trail.state).toBe(fixtureCase.expectedState);
        expect(trail.records.at(-1)?.outcome).toBe(fixtureCase.expectedOutcome);

        if (fixtureCase.name === "terminal audit") {
          const duplicate = await request();
          expect(duplicate.statusCode).toBe(409);
          expect(duplicate.json()).toMatchObject({
            error: { code: "operation_conflict" }
          });
          expect(harness.dispatches()).toBe(1);
          expect(harness.repository.require(fixtureCase.operationId).state).toBe("pending");
        }
      } finally {
        await harness.app.close();
      }
    }
  });

  it("keeps independent operation IDs and exact targets isolated in real durable trails", async () => {
    const harness = createDeviceRevokeHarness();
    await harness.app.ready();
    try {
      const responses = await Promise.all([
        harness.app.inject({
          method: "POST",
          url: "/api/v1/access/devices/client_target_alpha/revoke",
          payload: { operation_id: "op_gate_revoke_0002", confirmed: true }
        }),
        harness.app.inject({
          method: "POST",
          url: "/api/v1/access/devices/client_target_bravo/revoke",
          payload: { operation_id: "op_gate_revoke_0003", confirmed: true }
        })
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(harness.dispatches()).toBe(2);
      expect(harness.lockChecks()).toBe(0);
      expect(
        harness.repository.require("op_gate_revoke_0002").records[0]?.target
      ).toEqual({ type: "device", device_id: "client_target_alpha" });
      expect(
        harness.repository.require("op_gate_revoke_0003").records[0]?.target
      ).toEqual({ type: "device", device_id: "client_target_bravo" });
    } finally {
      await harness.app.close();
    }
  });
});

interface PromptHarnessOptions {
  readonly accessorAuditResult?: boolean;
  readonly accessorDispatchResult?: boolean;
  readonly auditDelayMs?: number;
  readonly auditFailure?: boolean;
  readonly authError?: "device_expired" | "device_revoked";
  readonly contradictoryAuditResult?: boolean;
  readonly dispatchDelayThenThrowMs?: number;
  readonly dispatchOutcome?: "failed" | "incomplete";
  readonly duplicatePreparation?: boolean;
  readonly duplicateTransition?: boolean;
  readonly forgedMutation?: boolean;
  readonly forgedResolution?: boolean;
  readonly invalidAcceptedContext?: boolean;
  readonly latePreparation?: boolean;
  readonly lateTransition?: boolean;
  readonly locked?: boolean;
  readonly malformedDispatchSummary?: boolean;
  readonly paired?: boolean;
  readonly parseFailure?: boolean;
  readonly permission?: "read" | "write";
  readonly prepareFailure?: boolean;
  readonly privateHttpErrorStage?: "audit" | "parse" | "target";
  readonly rejectCsrf?: boolean;
  readonly secure?: boolean;
  readonly shortDeadline?: boolean;
  readonly targetFailure?: boolean;
  readonly targetHttpError?: "incompatible_runtime" | "stale_session";
  readonly unfrozenAuditResult?: boolean;
  readonly wrongCapability?: boolean;
  readonly wrongTarget?: boolean;
}

interface PromptHarness {
  readonly app: HostDeckFastifyInstance;
  readonly authenticationCalls: () => number;
  readonly csrfCalls: () => number;
  readonly events: string[];
  readonly gate: ReturnType<typeof createHostDeckSelectedWriteGate<"prompt">>;
}

interface PromptGateResponse {
  readonly operation_id: string;
  readonly dispatched: true;
  readonly target_session_id: string;
}

interface DeviceRevokeGateResponse {
  readonly operation_id: string;
  readonly device_id: string;
  readonly authority_invalidated: true;
}

function createPromptHarness(options: PromptHarnessOptions = {}): PromptHarness {
  const events: string[] = [];
  let authenticationCalls = 0;
  let csrfCalls = 0;
  const permission = options.permission ?? "write";
  const authentication = frozenAuthentication(permission, authenticatedAt);
  const csrfAuthentication = frozenAuthentication(permission, authorizedAt);
  const audit = createHostDeckSelectedWriteAuditPort<"prompt">({
    executor: "selected_write_gate",
    execute: createPassThroughAuditExecute(events, options)
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: () => {
        csrfCalls += 1;
        events.push("csrf:authorize");
        if (options.rejectCsrf) {
          throw new HostDeckAuthRepositoryError(
            "csrf_mismatch",
            "private-stage-cause"
          );
        }
        return csrfAuthentication;
      },
      rotateBootstrap: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(authorizedAt)
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => {
        events.push("lock:read");
        return settings(options.locked ?? false);
      },
      transition: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(authorizedAt)
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest: manifest("prompt_dispatch"),
    audit,
    csrf,
    lock
  });
  const registration = promptRegistration(gate, events, options);
  const transport = options.secure ? "https" : "http";
  const origin = options.secure ? secureOrigin : localOrigin;
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        authenticationCalls += 1;
        events.push("auth:device");
        if (options.authError !== undefined) {
          throw new HostDeckAuthRepositoryError(options.authError, "private-stage-cause");
        }
        if (options.paired || options.secure) return authentication;
        throw new HostDeckAuthRepositoryError("device_not_found", "Device unavailable.");
      },
      now: () => new Date(authenticatedAt)
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: [origin],
      mode: options.secure ? "lan" : "loopback",
      transport
    }),
    resourceBudget: options.shortDeadline ? shortRequestBudget : defaultResourceBudget,
    routePlugins: [registration]
  });
  return {
    app,
    authenticationCalls: () => authenticationCalls,
    csrfCalls: () => csrfCalls,
    events,
    gate
  };
}

async function createSecurePromptHarness(
  options: PromptHarnessOptions = {}
): Promise<PromptHarness> {
  const directory = tempDirectory("hostdeck-write-gate-certificate-");
  const certificates = createHostDeckLanCertificatePolicy({
    assignedAddresses: () => ["192.168.0.29"],
    certificateDirectory: directory,
    now: () => new Date(createdAt)
  });
  await certificates.configure({
    bind_host: "192.168.0.29",
    bind_port: 3777,
    certificate_action: "issue_leaf"
  });
  const events: string[] = [];
  let authenticationCalls = 0;
  let csrfCalls = 0;
  const permission = options.permission ?? "write";
  const authentication = frozenAuthentication(permission, authenticatedAt);
  const csrfAuthentication = frozenAuthentication(permission, authorizedAt);
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: () => {
        csrfCalls += 1;
        events.push("csrf:authorize");
        if (options.rejectCsrf) {
          throw new HostDeckAuthRepositoryError("csrf_mismatch", "private-stage-cause");
        }
        return csrfAuthentication;
      },
      rotateBootstrap: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(authorizedAt)
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => {
        events.push("lock:read");
        return settings(options.locked ?? false);
      },
      transition: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(authorizedAt)
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest: manifest("prompt_dispatch"),
    audit: createHostDeckSelectedWriteAuditPort<"prompt">({
      executor: "selected_write_gate",
      execute: createPassThroughAuditExecute(events, options)
    }),
    csrf,
    lock
  });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        authenticationCalls += 1;
        events.push("auth:device");
        return authentication;
      },
      now: () => new Date(authenticatedAt)
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: [secureOrigin],
      mode: "lan",
      transport: "https"
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [promptRegistration(gate, events, { ...options, secure: true })],
    tls: certificates.loadTls({ bind_host: "192.168.0.29", bind_port: 3777 })
  });
  await app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
  return {
    app,
    authenticationCalls: () => authenticationCalls,
    csrfCalls: () => csrfCalls,
    events,
    gate
  };
}

function promptRegistration(
  gate: ReturnType<typeof createHostDeckSelectedWriteGate<"prompt">>,
  events: string[],
  options: PromptHarnessOptions
): HostDeckRoutePluginRegistration {
  const responseSchema = z
    .object({
      operation_id: z.string(),
      dispatched: z.literal(true),
      target_session_id: z.string()
    })
    .strict();
  return Object.freeze({
    id: "test-write-gate-prompt",
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      app.post(
        manifest("prompt_dispatch").path,
        {
          config: hostDeckNoStoreRouteConfig,
          schema: {
            body: promptOperationIntentSchema,
            params: z.object({ session_id: z.string() }).strict(),
            response: { 200: responseSchema }
          }
        },
        async (request) => {
          const params = request.params as { readonly session_id: string };
          const result = await gate.execute({
            request,
            candidate: request.body,
            parse(candidate) {
              events.push("parse");
              if (options.privateHttpErrorStage === "parse") {
                throw privateCallbackHttpError("parse");
              }
              if (options.parseFailure) throw new Error("private-stage-cause");
              const parsed = promptOperationIntentSchema.parse(candidate);
              if (parsed.target.session_id !== params.session_id) {
                throw new TypeError("Path and body target differ.");
              }
              const mutation = createHostDeckSelectedWriteMutation({
                operation_id: parsed.operation_id,
                action: "prompt",
                target: parsed.target,
                accepted_summary: {
                  schema_version: 1,
                  text_length: parsed.text.length
                },
                value: parsed
              });
              return options.forgedMutation
                ? (Object.freeze({ ...mutation }) as typeof mutation)
                : mutation;
            },
            resolve_target(mutation, context) {
              events.push("target:resolve");
              if (
                context.manifest !== manifest("prompt_dispatch") ||
                context.deadline.signal !== request.signal ||
                context.deadline.remainingMs() <= 0 ||
                context.lock?.locked !== false
              ) {
                throw new TypeError("Prompt target context is contradictory.");
              }
              if (options.privateHttpErrorStage === "target") {
                throw privateCallbackHttpError("target");
              }
              if (options.targetFailure) throw new Error("private-stage-cause");
              if (options.targetHttpError !== undefined) {
                throw new HostDeckHttpError({
                  code: options.targetHttpError,
                  message: "Selected target is not writable.",
                  retryable: false,
                  status: 409
                });
              }
              const resolution = createHostDeckSelectedWriteTargetResolution({
                target: options.wrongTarget ? secondPromptTarget : mutation.target,
                capability: options.wrongCapability ? "model" : "turn_input",
                value: Object.freeze({ runtime_state: "ready" as const })
              });
              return options.forgedResolution
                ? (Object.freeze({ ...resolution }) as typeof resolution)
                : resolution;
            },
            async dispatch(context) {
              events.push("dispatch");
              if (options.accessorDispatchResult) {
                return Object.defineProperties(
                  {},
                  {
                    outcome: {
                      enumerable: true,
                      get() {
                        events.push("dispatch:accessor-read");
                        return "succeeded";
                      }
                    },
                    payload_summary: {
                      enumerable: true,
                      value: Object.freeze({ schema_version: 1, accepted: true })
                    },
                    response: {
                      enumerable: true,
                      value: Object.freeze({ dispatched: true })
                    }
                  }
                );
              }
              if (options.dispatchDelayThenThrowMs !== undefined) {
                await sleep(options.dispatchDelayThenThrowMs);
                throw new Error("private-stage-cause");
              }
              if (options.dispatchOutcome !== undefined) {
                return Object.freeze({
                  outcome: options.dispatchOutcome,
                  error_code:
                    options.dispatchOutcome === "failed"
                      ? ("operation_conflict" as const)
                      : ("runtime_unavailable" as const),
                  payload_summary: Object.freeze({ schema_version: 1 })
                });
              }
              if (context.mutation.target.type !== "managed_session") {
                throw new TypeError("Prompt dispatch target is invalid.");
              }
              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: options.malformedDispatchSummary
                  ? Object.freeze({ schema_version: 1, raw_payload: "private-stage-cause" })
                  : Object.freeze({ schema_version: 1, accepted: true }),
                response: Object.freeze({
                  operation_id: context.mutation.operation_id,
                  target_session_id: context.mutation.target.session_id,
                  dispatched: true as const
                })
              });
            },
            prepare_response(response: PromptGateResponse) {
              events.push("response:prepare");
              if (options.prepareFailure) throw new Error("private-stage-cause");
              return Object.freeze({ ...response });
            }
          });
          if (result.outcome === "succeeded") return result.response;
          throw new HostDeckHttpError({
            code: result.error_code,
            message: "Selected write did not complete.",
            retryable: false,
            status: result.error_code === "operation_timeout" ? 504 : 409
          });
        }
      );
    }
  });
}

function createPassThroughAuditExecute(
  events: string[],
  options: PromptHarnessOptions = {}
): HostDeckSelectedWriteAuditExecute<"prompt"> {
  return async function execute<TResponse, TPreparedResponse>(
    input: ExecuteSelectedWriteAuditInput<"prompt", TResponse, TPreparedResponse>
  ) {
    events.push("audit:accepted");
    if (options.privateHttpErrorStage === "audit") {
      throw privateCallbackHttpError("audit");
    }
    if (options.auditFailure) throw new Error("private-stage-cause");
    if (options.auditDelayMs !== undefined) await sleep(options.auditDelayMs);
    if (options.lateTransition) {
      setImmediate(() => {
        void Promise.resolve(input.transition(acceptedAuditContext)).then(
          () => events.push("audit:late-transition-ran"),
          () => events.push("audit:late-transition-blocked")
        );
      });
      return Object.freeze({
        outcome: "failed" as const,
        error_code: "internal_error" as const
      });
    }
    const transition = await input.transition(
      options.invalidAcceptedContext ? { audit_state: "accepted" } : acceptedAuditContext
    );
    if (options.latePreparation && transition.outcome === "succeeded") {
      setImmediate(() => {
        void Promise.resolve(input.prepare_response(transition.response)).then(
          () => events.push("audit:late-preparation-ran"),
          () => events.push("audit:late-preparation-blocked")
        );
      });
      return Object.freeze({
        outcome: "succeeded" as const,
        response: transition.response as unknown as TPreparedResponse
      });
    }
    if (options.duplicateTransition) {
      try {
        await input.transition(acceptedAuditContext);
      } catch {
        events.push("audit:second-transition-blocked");
      }
    }
    if (transition.outcome === "succeeded") {
      const prepared = await input.prepare_response(transition.response);
      if (options.duplicatePreparation) {
        try {
          await input.prepare_response(transition.response);
        } catch {
          events.push("audit:second-preparation-blocked");
        }
      }
      events.push("audit:succeeded");
      if (options.accessorAuditResult) {
        return Object.defineProperties(
          {},
          {
            outcome: {
              enumerable: true,
              get() {
                events.push("audit:accessor-read");
                return "succeeded";
              }
            },
            response: { enumerable: true, value: prepared }
          }
        ) as never;
      }
      if (options.contradictoryAuditResult) {
        return Object.freeze({
          outcome: "failed" as const,
          error_code: "internal_error" as const
        });
      }
      const result = { outcome: "succeeded" as const, response: prepared };
      return options.unfrozenAuditResult ? result : Object.freeze(result);
    }
    events.push(`audit:${transition.outcome}`);
    return Object.freeze({
      outcome: transition.outcome,
      error_code: transition.error_code
    });
  };
}

function createGateDependencies(routeId: string) {
  return {
    manifest: manifest(routeId),
    audit: createHostDeckSelectedWriteAuditPort<"prompt">({
      executor: "selected_write_gate",
      execute: createPassThroughAuditExecute([])
    }),
    csrf: createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: () => frozenAuthentication("write", authorizedAt),
        rotateBootstrap: () => {
          throw new Error("not used");
        }
      },
      now: () => new Date(authorizedAt)
    }),
    lock: createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(false),
        transition: () => {
          throw new Error("not used");
        }
      },
      now: () => new Date(authorizedAt)
    })
  };
}

interface DeviceRevokeHarness {
  readonly app: HostDeckFastifyInstance;
  readonly auditAttempts: () => number;
  readonly dispatches: () => number;
  readonly dispatchStarted: ReturnType<typeof deferred<void>>;
  readonly gate: ReturnType<typeof createHostDeckSelectedWriteGate<"device_revoke">>;
  readonly lockChecks: () => number;
  readonly repository: SelectedAuditRepository;
}

interface DeviceRevokeHarnessOptions {
  readonly dispatchBarrier?: Promise<void>;
  readonly dispatchFailure?: boolean;
  readonly prepareFailure?: boolean;
  readonly terminalAuditFailure?: boolean;
}

function createDeviceRevokeHarness(
  options: DeviceRevokeHarnessOptions = {}
): DeviceRevokeHarness {
  const open = fixtureDatabase();
  const repository = createSelectedAuditRepository(open.db);
  const auditRepository: SelectedAuditRepository = options.terminalAuditFailure
    ? {
        ...repository,
        recordTerminal() {
          throw new HostDeckSelectedAuditRepositoryError(
            "audit_write_failed",
            "private-stage-cause"
          );
        }
      }
    : repository;
  let recordIndex = 0;
  let auditAttempts = 0;
  const security = createSecurityMutationAuditExecutor({
    repository: {
      ...auditRepository,
      recordAccepted(record) {
        auditAttempts += 1;
        return auditRepository.recordAccepted(record);
      }
    },
    now: () => new Date(Date.parse(auditAt) + recordIndex * 1_000).toISOString(),
    create_record_id: () => `audit:gate-revoke:${++recordIndex}`
  });
  const audit = createHostDeckSelectedWriteAuditPort<"device_revoke">({
    executor: "security_executor",
    execute: security.execute as HostDeckSelectedWriteAuditExecute<"device_revoke">
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: () => frozenAuthentication("write", authorizedAt),
      rotateBootstrap: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(authorizedAt)
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(false),
      transition: () => {
        throw new Error("not used");
      }
    },
    now: () => new Date(authorizedAt)
  });
  const gate = createHostDeckSelectedWriteGate({
    manifest: manifest("device_revoke"),
    audit,
    csrf,
    lock
  });
  let dispatches = 0;
  const dispatchStarted = deferred<void>();
  const registration: HostDeckRoutePluginRegistration = Object.freeze({
    id: "test-write-gate-revoke",
    surface: "api" as const,
    register(app: HostDeckFastifyInstance) {
      app.post(
        manifest("device_revoke").path,
        {
          config: hostDeckNoStoreRouteConfig,
          schema: {
            body: z
              .object({ operation_id: z.string(), confirmed: z.literal(true) })
              .strict(),
            params: z.object({ device_id: z.string() }).strict(),
            response: {
              200: z
                .object({
                  operation_id: z.string(),
                  device_id: z.string(),
                  authority_invalidated: z.literal(true)
                })
                .strict()
            }
          }
        },
        async (request) => {
          const body = request.body as {
            readonly operation_id: string;
            readonly confirmed: true;
          };
          const params = request.params as { readonly device_id: string };
          const target = Object.freeze({
            type: "device" as const,
            device_id: params.device_id
          });
          const result = await gate.execute({
            request,
            candidate: body,
            parse(candidate) {
              const parsed = z
                .object({ operation_id: z.string(), confirmed: z.literal(true) })
                .strict()
                .parse(candidate);
              return createHostDeckSelectedWriteMutation({
                operation_id: parsed.operation_id,
                action: "device_revoke",
                target,
                accepted_summary: {
                  schema_version: 1,
                  previously_revoked: false
                },
                value: parsed
              });
            },
            resolve_target(mutation) {
              return createHostDeckSelectedWriteTargetResolution({
                target: mutation.target,
                capability: null,
                value: Object.freeze({ previously_revoked: false })
              });
            },
            async dispatch(context) {
              dispatches += 1;
              dispatchStarted.resolve();
              await options.dispatchBarrier;
              if (options.dispatchFailure) throw new Error("private-stage-cause");
              if (context.mutation.target.type !== "device") {
                throw new TypeError("Device revoke target is invalid.");
              }
              return Object.freeze({
                outcome: "succeeded" as const,
                payload_summary: Object.freeze({
                  schema_version: 1,
                  authority_invalidated: true
                }),
                response: Object.freeze({
                  operation_id: context.mutation.operation_id,
                  device_id: context.mutation.target.device_id,
                  authority_invalidated: true as const
                })
              });
            },
            prepare_response(response: DeviceRevokeGateResponse) {
              if (options.prepareFailure) throw new Error("private-stage-cause");
              return Object.freeze({ ...response });
            }
          });
          if (result.outcome === "succeeded") return result.response;
          throw new HostDeckHttpError({
            code: result.error_code,
            message: "Device revocation did not complete.",
            retryable: false,
            status: 409
          });
        }
      );
    }
  });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new HostDeckAuthRepositoryError("device_not_found", "not used");
      },
      now: () => new Date(authenticatedAt)
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: [localOrigin],
      mode: "loopback",
      transport: "http"
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  return {
    app,
    auditAttempts: () => auditAttempts,
    dispatches: () => dispatches,
    dispatchStarted,
    gate,
    lockChecks: () => hostDeckHostLockPolicySnapshot(lock).gate_checks,
    repository
  };
}

function promptMutation(
  operationId: string,
  target: typeof promptTarget,
  text: string
) {
  return createHostDeckSelectedWriteMutation({
    operation_id: operationId,
    action: "prompt",
    target,
    accepted_summary: { schema_version: 1, text_length: text.length },
    value: Object.freeze({ text })
  });
}

function promptRequest(
  operationId: string,
  target: typeof promptTarget,
  text: string
) {
  return {
    operation_id: operationId,
    kind: "prompt" as const,
    target,
    text
  };
}

function injectPairedPrompt(
  app: HostDeckFastifyInstance,
  origin: string,
  csrfToken: string
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
    headers: pairedHeaders(origin, csrfToken),
    payload: promptRequest("op_gate_paired_0001", promptTarget, "hello")
  });
}

async function securePromptRequest(
  app: HostDeckFastifyInstance,
  csrfToken: string
): Promise<{ readonly statusCode: number; readonly body: string; readonly json: () => unknown }> {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Secure gate listener is unavailable.");
  }
  const payload = JSON.stringify(
    promptRequest("op_gate_secure_0001", promptTarget, "hello")
  );
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${promptTarget.session_id}/prompts`,
        rejectUnauthorized: false,
        headers: {
          ...pairedHeaders(secureOrigin, csrfToken),
          host: "192.168.0.29:3777",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            json: () => JSON.parse(body) as unknown
          });
        });
      }
    );
    request.once("error", reject);
    request.end(payload);
  });
}

function pairedHeaders(origin: string, csrfToken: string) {
  return {
    host: new URL(origin).host,
    origin,
    cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
    "x-hostdeck-csrf": csrfToken,
    "x-hostdeck-csrf-generation": "1"
  };
}

function privateCallbackHttpError(stage: "audit" | "parse" | "target"): HostDeckHttpError {
  return new HostDeckHttpError({
    code:
      stage === "parse"
        ? "validation_error"
        : stage === "target"
          ? "stale_session"
          : "internal_error",
    details: { private_detail: "PRIVATE_HTTP_DETAIL_SENTINEL" },
    message: "PRIVATE_HTTP_MESSAGE_SENTINEL",
    retryable: false,
    status: stage === "parse" ? 400 : stage === "target" ? 409 : 500
  });
}

function frozenAuthentication(permission: "read" | "write", lastUsedAt: string) {
  return Object.freeze({
    trusted: true as const,
    readOnly: permission === "read",
    device: Object.freeze({
      id: "client_phone",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt,
      client_label: "Android phone",
      permission,
      created_at: createdAt,
      last_used_at: lastUsedAt,
      expires_at: null,
      revoked_at: null
    })
  });
}

function settings(locked: boolean) {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/home/hostdeck/state",
    bind_mode: "localhost" as const,
    bind_host: "127.0.0.1",
    bind_port: 3210,
    lan_enabled: false,
    locked,
    retention: { ...defaultRetentionPolicy },
    updated_at: createdAt
  };
}

function manifest(id: string): SelectedApiRouteManifestEntry {
  const matches = selectedApiRouteManifest.filter((entry) => entry.id === id);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Missing selected manifest entry ${id}.`);
  }
  return matches[0];
}

function fixtureDatabase() {
  const directory = tempDirectory("hostdeck-write-gate-db-");
  const open = openMigratedDatabase(join(directory, "hostdeck.db"), {
    now: () => new Date(createdAt)
  });
  openDatabases.push(open.db);
  return open;
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for gate condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function emptyGateSnapshot() {
  return {
    attempts: 0,
    audit_failures: 0,
    authorization_failures: 0,
    contract_failures: 0,
    dispatches: 0,
    failed_results: 0,
    incomplete_results: 0,
    lock_failures: 0,
    parse_failures: 0,
    pre_dispatch_timeouts: 0,
    response_preparations: 0,
    succeeded_results: 0,
    target_failures: 0
  };
}
