import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  defaultRetentionPolicy,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  hostDeckFastifyRouteInventory
} from "./fastify-app.js";
import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import { createHostDeckHostHealthService } from "./host-health.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import { createHostDeckPairingPolicy } from "./pairing-routes.js";
import { createProjectionSubscriberStreamService } from "./projection-subscriber-stream.js";
import { createRemoteIngressControlService } from "./remote-ingress-control-service.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import {
  type CreateHostDeckSelectedApiRouteCompositionInput,
  createHostDeckSelectedApiRouteComposition,
  hostDeckSelectedApiRouteCompositionDescriptor
} from "./selected-api-route-composition.js";
import { selectedApiRouteManifest } from "./selected-api-route-manifest.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

interface CompositionFixture {
  readonly authentication: ReturnType<typeof createHostDeckRequestAuthenticationPolicy>;
  readonly close: () => void;
  readonly input: CreateHostDeckSelectedApiRouteCompositionInput;
  readonly portCalls: () => number;
}

interface HandlerProbeFixture extends CompositionFixture {
  readonly arm: (portName: string) => void;
  readonly assertConsumed: () => void;
  readonly auditPhases: (operationId: string) => readonly string[];
  readonly calls: () => readonly string[];
}

const fixtures: CompositionFixture[] = [];
const fixedTime = "2026-07-20T12:00:00.000Z";
const probeSessionId = "sess_composition_probe_001";
const probeThreadId = "thread-composition-probe-001";
const probeDeviceToken = "W".repeat(43);
const privateProbeSentinel = "HOSTDECK_COMPOSITION_PRIVATE_PROBE";

afterEach(() => {
  for (const fixture of fixtures.splice(0).reverse()) fixture.close();
});

describe("IFC-V1-046 selected API production route composition", () => {
  it("freezes an exact 22-registrar descriptor over all 35 manifest rows", () => {
    expect(Object.isFrozen(hostDeckSelectedApiRouteCompositionDescriptor)).toBe(true);
    expect(hostDeckSelectedApiRouteCompositionDescriptor).toHaveLength(22);
    expect(
      hostDeckSelectedApiRouteCompositionDescriptor.filter(
        (entry) => entry.surface === "api"
      )
    ).toHaveLength(21);
    expect(
      hostDeckSelectedApiRouteCompositionDescriptor.filter(
        (entry) => entry.surface === "sse"
      )
    ).toHaveLength(1);

    const registrationIds = hostDeckSelectedApiRouteCompositionDescriptor.map(
      (entry) => entry.registrationId
    );
    const manifestIds = hostDeckSelectedApiRouteCompositionDescriptor.flatMap(
      (entry) => entry.manifestIds
    );
    expect(new Set(registrationIds).size).toBe(22);
    expect(new Set(manifestIds).size).toBe(35);
    expect([...manifestIds].sort()).toEqual(
      selectedApiRouteManifest.map((entry) => entry.id).sort()
    );
    for (const entry of hostDeckSelectedApiRouteCompositionDescriptor) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.manifestIds)).toBe(true);
    }
  });

  it("rejects hostile top-level inputs without touching route ownership", () => {
    const inherited = Object.create({ state: "inherited" });
    const accessor = Object.defineProperty({}, "state", {
      enumerable: true,
      get: () => "forbidden"
    });
    for (const candidate of [null, [], {}, inherited, accessor]) {
      expect(() =>
        createHostDeckSelectedApiRouteComposition(
          candidate as CreateHostDeckSelectedApiRouteCompositionInput
        )
      ).toThrow(TypeError);
    }
  });

  it("preflights the complete graph, emits deterministic registrations, and rejects duplicate ownership", () => {
    const fixture = createFixture();
    const invalidState = {
      ...fixture.input.state,
      unexpected: () => undefined
    };
    expect(() =>
      createHostDeckSelectedApiRouteComposition({
        ...fixture.input,
        state: invalidState
      })
    ).toThrow("Selected state service is invalid.");

    const registrations = createHostDeckSelectedApiRouteComposition(
      fixture.input
    );
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(registrations).toHaveLength(22);
    expect(
      registrations.map(({ id, surface }) => ({ id, surface }))
    ).toEqual(
      hostDeckSelectedApiRouteCompositionDescriptor.map((entry) => ({
        id: entry.registrationId,
        surface: entry.surface
      }))
    );
    for (const registration of registrations) {
      expect(Object.isFrozen(registration)).toBe(true);
    }
    expect(() =>
      createHostDeckSelectedApiRouteComposition(fixture.input)
    ).toThrow("Selected API route composition already owns this admission policy.");
  });

  it("registers exactly the canonical 35 method/path pairs in a ready Fastify app", async () => {
    const fixture = createFixture();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: fixture.authentication,
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: ["http://127.0.0.1:48765"],
        mode: "loopback",
        transport: "http"
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: createHostDeckSelectedApiRouteComposition(fixture.input)
    });
    try {
      await app.ready();
      const inventory = hostDeckFastifyRouteInventory(app);
      expect(Object.isFrozen(inventory)).toBe(true);
      expect(
        inventory
          .map((entry) => `${entry.method} ${entry.path}`)
          .sort()
      ).toEqual(
        selectedApiRouteManifest
          .map((entry) => `${entry.method} ${entry.path}`)
          .sort()
      );
      expect(inventory).toHaveLength(35);
      expect(inventory.every((entry) => Object.isFrozen(entry))).toBe(true);
      expect(inventory.some((entry) => entry.method === "HEAD")).toBe(false);
      expect(
        inventory.some((entry) =>
          /\/(?:acceptance|certificates?|lan|network|raw|tmux)(?:\/|$)/u.test(
            entry.path
          )
        )
      ).toBe(false);

      const localRead = await app.inject({
        headers: { host: "127.0.0.1:48765" },
        method: "GET",
        url: "/api/v1/sessions"
      });
      expect(localRead.statusCode).toBe(500);
      expect(fixture.portCalls()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("drives every registration family through the assembled local or admitted-Serve handler", async () => {
    const exercisedRegistrationIds = new Set<string>();
    const local = createHandlerProbeFixture();
    const localApp = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: local.authentication,
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: ["http://127.0.0.1:48765"],
        mode: "loopback",
        transport: "http"
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: createHostDeckSelectedApiRouteComposition(local.input)
    });
    try {
      await localApp.ready();
      const liveness = await localApp.inject({
        headers: { host: "127.0.0.1:48765" },
        method: "GET",
        url: "/api/v1/health/live"
      });
      expect(liveness.statusCode).toBe(200);
      exercisedRegistrationIds.add(
        registrationIdForManifest("health_liveness")
      );

      const remoteStatus = await localApp.inject({
        headers: {
          host: "127.0.0.1:48765",
          [hostDeckLocalAdminRequestHeaderName]:
            hostDeckLocalAdminRequestHeaderValue
        },
        method: "GET",
        url: "/api/v1/remote/status"
      });
      expect(remoteStatus.statusCode, remoteStatus.body).toBe(200);

      const localProbes = [
        {
          manifestId: "session_list",
          port: "sessions.read.list",
          request: { method: "GET", url: "/api/v1/sessions" }
        },
        {
          manifestId: "session_start",
          port: "sessions.managed.start",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_start_001",
              name: "composition-probe",
              cwd: "/tmp/hostdeck-composition-probe"
            },
            url: "/api/v1/sessions"
          }
        },
        {
          manifestId: "session_events",
          port: "state.listEvents",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/events`
          }
        },
        {
          manifestId: "session_event_stream",
          port: "subscribers.open",
          request: {
            headers: { accept: "text/event-stream" },
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/events/stream`
          }
        },
        {
          manifestId: "session_resume_metadata",
          port: "sessions.resume.read",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/resume`
          }
        },
        {
          manifestId: "session_archive",
          port: "sessions.managed.archive",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_archive_001",
              kind: "archive",
              confirm: true
            },
            url: `/api/v1/sessions/${probeSessionId}/archive`
          }
        },
        {
          manifestId: "prompt_dispatch",
          port: "controls.prompts.dispatch",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_prompt_001",
              kind: "prompt",
              text: "bounded composition probe"
            },
            url: `/api/v1/sessions/${probeSessionId}/prompts`
          }
        },
        {
          manifestId: "model_read",
          port: "controls.models.snapshot",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/model`
          }
        },
        {
          manifestId: "goal_read",
          port: "controls.goals.snapshot",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/goal`
          }
        },
        {
          manifestId: "plan_read",
          port: "controls.plans.snapshot",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/plan`
          }
        },
        {
          manifestId: "usage_read",
          port: "controls.usage.read",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/usage`
          }
        },
        {
          manifestId: "compact_read",
          port: "controls.compact.snapshot",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/compact`
          }
        },
        {
          manifestId: "skills_read",
          port: "controls.skills.list",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/skills`
          }
        },
        {
          manifestId: "approval_list",
          port: "controls.approvals.list",
          request: {
            method: "GET",
            url: `/api/v1/sessions/${probeSessionId}/approvals`
          }
        },
        {
          manifestId: "turn_interrupt",
          port: "controls.interrupts.requireInterruptible",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_interrupt_001",
              kind: "interrupt",
              confirm: true
            },
            url: `/api/v1/sessions/${probeSessionId}/turns/turn-composition-probe-001/interrupt`
          }
        },
        {
          manifestId: "pair_request",
          port: "pairing.issue",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_pair_001",
              permission: "write",
              client_label: "Composition probe"
            },
            url: "/api/v1/access/pairing-codes"
          }
        },
        {
          manifestId: "access_state",
          port: "lock.read",
          request: { method: "GET", url: "/api/v1/access" }
        },
        {
          manifestId: "device_revoke",
          port: "devices.revoke",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_revoke_001",
              confirmed: true
            },
            url: "/api/v1/access/devices/client_composition_target/revoke"
          }
        },
        {
          manifestId: "remote_enable",
          port: "remote.observeCandidate",
          request: {
            method: "POST",
            payload: {
              operation_id: "op_composition_probe_remote_001",
              confirmed: true
            },
            url: "/api/v1/remote/enable"
          }
        }
      ] as const;

      for (const probe of localProbes) {
        local.arm(probe.port);
        const response = await localApp.inject({
          ...probe.request,
          headers: {
            host: "127.0.0.1:48765",
            ...("headers" in probe.request ? probe.request.headers : {})
          }
        });
        local.assertConsumed();
        expect(response.body).not.toContain(privateProbeSentinel);
        exercisedRegistrationIds.add(
          registrationIdForManifest(probe.manifestId)
        );
      }

      for (const operationId of [
        "op_composition_probe_start_001",
        "op_composition_probe_archive_001",
        "op_composition_probe_prompt_001",
        "op_composition_probe_pair_001",
        "op_composition_probe_revoke_001"
      ]) {
        expect(local.auditPhases(operationId)).toEqual([
          "accepted",
          "terminal"
        ]);
      }
    } finally {
      await localApp.close();
    }

    const remote = createHandlerProbeFixture();
    const externalOrigin =
      "https://hostdeck-handler-probe.fixture-tailnet.ts.net";
    const admission = Object.freeze({
      admission: "open" as const,
      external_origin: externalOrigin,
      generation: 1
    });
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    authority.synchronize(admission);
    const remoteApp = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      remoteIngressRequestAuthority: authority,
      requestAuthenticationPolicy: remote.authentication,
      resourceBudget: defaultResourceBudget,
      routePlugins: createHostDeckSelectedApiRouteComposition(remote.input),
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: "http://127.0.0.1:48765",
        readRemoteAdmission: () => admission
      })
    });
    const remoteHeaders = {
      host: "hostdeck-handler-probe.fixture-tailnet.ts.net",
      origin: externalOrigin,
      "x-forwarded-for": "100.64.0.42",
      "x-forwarded-host": "hostdeck-handler-probe.fixture-tailnet.ts.net",
      "x-forwarded-proto": "https"
    };
    try {
      await remoteApp.ready();
      remote.arm("pairing.claim");
      const claim = await remoteApp.inject({
        headers: remoteHeaders,
        method: "POST",
        payload: {
          operation_id: "op_composition_probe_claim_001",
          code: "abcdefghijklmnopqrstuv",
          client_label: "Composition phone"
        },
        url: "/api/v1/access/pairing-claims"
      });
      remote.assertConsumed();
      expect(claim.body).not.toContain(privateProbeSentinel);
      expect(remote.auditPhases("op_composition_probe_claim_001")).toEqual([
        "accepted",
        "terminal"
      ]);

      remote.arm("csrf.rotateBootstrap");
      const bootstrap = await remoteApp.inject({
        headers: {
          ...remoteHeaders,
          cookie: `hostdeck_device=${probeDeviceToken}`
        },
        method: "POST",
        payload: { operation_id: "op_composition_probe_csrf_001" },
        url: "/api/v1/access/csrf"
      });
      remote.assertConsumed();
      expect(bootstrap.body).not.toContain(privateProbeSentinel);
      expect(remote.auditPhases("op_composition_probe_csrf_001")).toEqual([
        "accepted",
        "terminal"
      ]);
      exercisedRegistrationIds.add(
        registrationIdForManifest("csrf_bootstrap")
      );

      remote.arm("devices.list");
      const devices = await remoteApp.inject({
        headers: {
          ...remoteHeaders,
          cookie: `hostdeck_device=${probeDeviceToken}`
        },
        method: "GET",
        url: "/api/v1/access/devices"
      });
      remote.assertConsumed();
      expect(devices.body).not.toContain(privateProbeSentinel);
      exercisedRegistrationIds.add(registrationIdForManifest("device_list"));
    } finally {
      await remoteApp.close();
      authority.close();
    }

    expect([...exercisedRegistrationIds].sort()).toEqual(
      hostDeckSelectedApiRouteCompositionDescriptor
        .map((entry) => entry.registrationId)
        .sort()
    );
    expect(local.calls()).not.toContain("authentication.device");
    expect(remote.calls()).toContain("authentication.device");
  });

  it("rejects unpaired admitted-Serve access before selected service side effects", async () => {
    const fixture = createFixture();
    const externalOrigin =
      "https://hostdeck-composition.fixture-tailnet.ts.net";
    const admission = Object.freeze({
      admission: "open" as const,
      external_origin: externalOrigin,
      generation: 1
    });
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    authority.synchronize(admission);
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      remoteIngressRequestAuthority: authority,
      requestAuthenticationPolicy: fixture.authentication,
      resourceBudget: defaultResourceBudget,
      routePlugins: createHostDeckSelectedApiRouteComposition(fixture.input),
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: "http://127.0.0.1:48765",
        readRemoteAdmission: () => admission
      })
    });
    const headers = {
      host: "hostdeck-composition.fixture-tailnet.ts.net",
      origin: externalOrigin,
      "x-forwarded-for": "100.64.0.42",
      "x-forwarded-host": "hostdeck-composition.fixture-tailnet.ts.net",
      "x-forwarded-proto": "https"
    };
    try {
      await app.ready();
      const liveness = await app.inject({
        headers,
        method: "GET",
        url: "/api/v1/health/live"
      });
      expect(liveness.statusCode).toBe(200);
      expect(liveness.json()).toEqual({ status: "alive" });

      const sessionRead = await app.inject({
        headers,
        method: "GET",
        url: "/api/v1/sessions"
      });
      expect(sessionRead.statusCode).toBe(401);

      const prompt = await app.inject({
        headers,
        method: "POST",
        payload: {
          kind: "prompt",
          operation_id: "op_composition_remote_prompt_001",
          text: "This must not dispatch."
        },
        url: "/api/v1/sessions/sess_composition_remote_001/prompts"
      });
      expect(prompt.statusCode).toBe(401);

      const remoteEnable = await app.inject({
        headers,
        method: "POST",
        payload: {
          confirmed: true,
          operation_id: "op_composition_remote_enable_001"
        },
        url: "/api/v1/remote/enable"
      });
      expect(remoteEnable.statusCode).toBe(403);
      expect(fixture.portCalls()).toBe(0);
    } finally {
      await app.close();
      authority.close();
    }
  });
});

function registrationIdForManifest(manifestId: string): string {
  const matches = hostDeckSelectedApiRouteCompositionDescriptor.filter(
    (entry) => entry.manifestIds.includes(manifestId)
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new TypeError("Composition manifest ownership is invalid.");
  }
  return matches[0].registrationId;
}

function createHandlerProbeFixture(): HandlerProbeFixture {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-selected-composition-probe-"));
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(fixedTime)
  });
  const calls: string[] = [];
  let expectedPort: string | null = null;
  const invoke = <Value>(portName: string, fallback: Value): Value => {
    calls.push(portName);
    if (portName === expectedPort) {
      expectedPort = null;
      throw new Error(privateProbeSentinel);
    }
    return fallback;
  };
  const requireProbe = (portName: string): never => {
    calls.push(portName);
    if (portName === expectedPort) {
      expectedPort = null;
      throw new Error(privateProbeSentinel);
    }
    throw new Error(`Unexpected composition probe call: ${portName}.`);
  };
  const now = () => new Date(fixedTime);
  const selectedState = selectedProbeState();
  const runtime = selectedProbeRuntime();
  const settings = selectedProbeSettings();
  const auditRepository = createSelectedAuditRepository(opened.db);
  let recordId = 0;
  const securityAudit = createSecurityMutationAuditExecutor({
    create_record_id: () => `audit:composition:probe:security:${++recordId}`,
    now: () => fixedTime,
    repository: auditRepository
  });
  const audit = createHostDeckSelectedWriteAuditExecutor({
    create_record_id: () => `audit:composition:probe:write:${++recordId}`,
    now: () => fixedTime,
    repository: auditRepository
  });
  const authenticatedDevice = Object.freeze({
    trusted: true as const,
    readOnly: false,
    device: Object.freeze({
      id: "client_composition_probe_writer",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: fixedTime,
      client_label: "Composition phone",
      permission: "write" as const,
      created_at: fixedTime,
      last_used_at: fixedTime,
      expires_at: null,
      revoked_at: null
    })
  });
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: () =>
      invoke("authentication.device", authenticatedDevice),
    now
  });
  const health = createHostDeckHostHealthService({ now });
  const remote = createRemoteIngressControlService({
    admissionProofs: createRemoteIngressAdmissionProofRepository(opened.db),
    audit: securityAudit,
    localOrigin: "http://127.0.0.1:48765",
    manager: Object.freeze({
      disable: () => requireProbe("remote.manager.disable"),
      enable: () => requireProbe("remote.manager.enable"),
      snapshot: () => requireProbe("remote.manager.snapshot")
    }),
    monotonicNow: () => 1,
    now,
    observer: Object.freeze({
      observeCandidate: () => requireProbe("remote.observeCandidate"),
      observeConfigured: () => requireProbe("remote.observeConfigured"),
      poll_interval_ms: 60_000
    }),
    states: createRemoteIngressStateRepository(opened.db)
  });
  const subscribers = createProjectionSubscriberStreamService({
    handoff: {
      open: () => requireProbe("subscribers.open")
    },
    observe_failure: () => undefined,
    resource_budget: defaultResourceBudget
  });
  const admission = createHostDeckSelectedWriteAdmissionPolicy({
    now: () => 1,
    resourceBudget: defaultResourceBudget
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: () => requireProbe("csrf.authorizeBrowserWrite"),
      rotateBootstrap: () => requireProbe("csrf.rotateBootstrap")
    },
    now
  });
  const lock = createHostDeckHostLockPolicy({
    now,
    settings: {
      read: () => invoke("lock.read", settings),
      transition: () => requireProbe("lock.transition")
    }
  });
  const pairing = createHostDeckPairingPolicy({
    createPairingId: () => "pair_composition_probe_000001",
    now,
    pairing: {
      claim: () => requireProbe("pairing.claim"),
      issue: () => requireProbe("pairing.issue")
    }
  });
  const input = {
    admission,
    audit,
    authentication,
    controls: {
      approvals: {
        list: () => requireProbe("controls.approvals.list"),
        respond: () => requireProbe("controls.approvals.respond"),
        snapshot: () => requireProbe("controls.approvals.snapshot"),
        waitForTerminal: () =>
          requireProbe("controls.approvals.waitForTerminal")
      },
      compact: {
        compact: () => requireProbe("controls.compact.compact"),
        snapshot: () => requireProbe("controls.compact.snapshot")
      },
      goals: {
        mutate: () => requireProbe("controls.goals.mutate"),
        snapshot: () => requireProbe("controls.goals.snapshot")
      },
      interrupts: {
        interrupt: () => requireProbe("controls.interrupts.interrupt"),
        requireInterruptible: () =>
          requireProbe("controls.interrupts.requireInterruptible"),
        waitForTerminal: () =>
          requireProbe("controls.interrupts.waitForTerminal")
      },
      models: {
        select: () => requireProbe("controls.models.select"),
        snapshot: () => requireProbe("controls.models.snapshot")
      },
      plans: {
        select: () => requireProbe("controls.plans.select"),
        snapshot: () => requireProbe("controls.plans.snapshot")
      },
      prompts: {
        dispatch: () => requireProbe("controls.prompts.dispatch"),
        snapshot: async () =>
          invoke("controls.prompts.snapshot", selectedProbePromptSnapshot())
      },
      skills: { list: () => requireProbe("controls.skills.list") },
      usage: { read: () => requireProbe("controls.usage.read") }
    },
    csrf,
    devices: {
      list: () => requireProbe("devices.list"),
      revoke: () => requireProbe("devices.revoke")
    },
    health,
    lock,
    now,
    observeSseError: () => undefined,
    pairing,
    remote,
    runtimes: {
      approvals: { read: () => invoke("runtimes.approvals.read", runtime) },
      compact: { read: () => invoke("runtimes.compact.read", runtime) },
      goals: { read: () => invoke("runtimes.goals.read", runtime) },
      interrupts: { read: () => invoke("runtimes.interrupts.read", runtime) },
      models: { read: () => invoke("runtimes.models.read", runtime) },
      plans: { read: () => invoke("runtimes.plans.read", runtime) },
      prompts: { read: () => invoke("runtimes.prompts.read", runtime) },
      sessionArchive: {
        read: () => invoke("runtimes.sessionArchive.read", runtime)
      },
      sessionStart: { read: () => invoke("runtimes.sessionStart.read", runtime) }
    },
    securityAudit,
    sessions: {
      managed: {
        archive: () => requireProbe("sessions.managed.archive"),
        read: () => invoke("sessions.managed.read", selectedState),
        start: () => requireProbe("sessions.managed.start")
      },
      read: {
        get: () => requireProbe("sessions.read.get"),
        list: () => requireProbe("sessions.read.list")
      },
      resume: { read: () => requireProbe("sessions.resume.read") },
      subscribers
    },
    state: {
      get: () => invoke("state.get", selectedState),
      listEvents: () => requireProbe("state.listEvents"),
      require: () => invoke("state.require", selectedState)
    }
  } satisfies CreateHostDeckSelectedApiRouteCompositionInput;
  let closed = false;
  const fixture: HandlerProbeFixture = {
    arm(portName) {
      if (expectedPort !== null || portName.length === 0) {
        throw new TypeError("Composition handler probe is already armed.");
      }
      expectedPort = portName;
    },
    assertConsumed() {
      if (expectedPort !== null) {
        const missedPort = expectedPort;
        expectedPort = null;
        throw new Error(`Composition handler did not reach ${missedPort}.`);
      }
    },
    auditPhases(operationId) {
      return Object.freeze(
        (
          opened.db
            .prepare(
              "SELECT phase FROM selected_audit_events WHERE operation_id = ? ORDER BY phase"
            )
            .all(operationId) as readonly { readonly phase: string }[]
        ).map((row) => row.phase)
      );
    },
    authentication,
    calls: () => Object.freeze([...calls]),
    close() {
      if (closed) return;
      closed = true;
      subscribers.close();
      if (opened.db.open) opened.db.close();
      rmSync(root, { force: true, recursive: true });
    },
    input,
    portCalls: () => calls.length
  };
  fixtures.push(fixture);
  return fixture;
}

function selectedProbeState() {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: probeSessionId,
    name: "composition-probe",
    codex_thread_id: probeThreadId,
    cwd: "/tmp/hostdeck-composition-probe",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: fixedTime,
    updated_at: fixedTime,
    archived_at: null
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
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: fixedTime,
      last_activity_at: fixedTime,
      branch: "main",
      model: "model-a",
      goal: null,
      recent_summary: "Composition probe state.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return Object.freeze({ mapping, projection });
}

function selectedProbeRuntime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: "0.144.0",
    binding_id: "binding-composition-probe-001",
    capabilities: runtimeCapabilities.map((name) => ({
      name,
      state: "available",
      reason: null
    })),
    checked_at: fixedTime,
    reason: null
  });
}

function selectedProbeSettings() {
  return Object.freeze({
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/tmp/hostdeck-composition-probe-state",
    bind_mode: "localhost" as const,
    bind_host: "127.0.0.1",
    bind_port: 48765,
    lan_enabled: false,
    locked: false,
    retention: { ...defaultRetentionPolicy },
    updated_at: fixedTime
  });
}

function selectedProbePromptSnapshot() {
  return Object.freeze({
    phase: "idle" as const,
    last_action: null,
    operation_id: null,
    turn_id: null,
    model_revision: null,
    plan_revision: null,
    requested_at: null,
    accepted_at: null,
    started_at: null,
    error: null
  });
}

function createFixture(): CompositionFixture {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-selected-composition-"));
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(fixedTime)
  });
  const now = () => new Date(fixedTime);
  let portCalls = 0;
  const fail = (): never => {
    portCalls += 1;
    throw new Error("Composition fixture port must not run during registration.");
  };
  const auditRepository = createSelectedAuditRepository(opened.db);
  let recordId = 0;
  const securityAudit = createSecurityMutationAuditExecutor({
    create_record_id: () => `audit:composition:security:${++recordId}`,
    now: () => fixedTime,
    repository: auditRepository
  });
  const audit = createHostDeckSelectedWriteAuditExecutor({
    create_record_id: () => `audit:composition:write:${++recordId}`,
    now: () => fixedTime,
    repository: auditRepository
  });
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: fail,
    now
  });
  const health = createHostDeckHostHealthService({ now });
  const remote = createRemoteIngressControlService({
    admissionProofs: createRemoteIngressAdmissionProofRepository(opened.db),
    audit: securityAudit,
    localOrigin: "http://127.0.0.1:48765",
    manager: Object.freeze({ disable: fail, enable: fail, snapshot: fail }),
    monotonicNow: () => 1,
    now,
    observer: Object.freeze({
      observeCandidate: fail,
      observeConfigured: fail,
      poll_interval_ms: 60_000
    }),
    states: createRemoteIngressStateRepository(opened.db)
  });
  const subscribers = createProjectionSubscriberStreamService({
    handoff: { open: fail },
    observe_failure: () => undefined,
    resource_budget: defaultResourceBudget
  });
  const admission = createHostDeckSelectedWriteAdmissionPolicy({
    now: () => 1,
    resourceBudget: defaultResourceBudget
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: { authorizeBrowserWrite: fail, rotateBootstrap: fail },
    now
  });
  const lock = createHostDeckHostLockPolicy({
    now,
    settings: { read: fail, transition: fail }
  });
  const pairing = createHostDeckPairingPolicy({
    createPairingId: () => "pair_composition_000000000001",
    now,
    pairing: { claim: fail, issue: fail }
  });
  const runtime = () => ({ read: fail });
  const input = {
    admission,
    audit,
    authentication,
    controls: {
      approvals: {
        list: fail,
        respond: fail,
        snapshot: fail,
        waitForTerminal: fail
      },
      compact: { compact: fail, snapshot: fail },
      goals: { mutate: fail, snapshot: fail },
      interrupts: {
        interrupt: fail,
        requireInterruptible: fail,
        waitForTerminal: fail
      },
      models: { select: fail, snapshot: fail },
      plans: { select: fail, snapshot: fail },
      prompts: { dispatch: fail, snapshot: fail },
      skills: { list: fail },
      usage: { read: fail }
    },
    csrf,
    devices: { list: fail, revoke: fail },
    health,
    lock,
    now,
    observeSseError: () => undefined,
    pairing,
    remote,
    runtimes: {
      approvals: runtime(),
      compact: runtime(),
      goals: runtime(),
      interrupts: runtime(),
      models: runtime(),
      plans: runtime(),
      prompts: runtime(),
      sessionArchive: runtime(),
      sessionStart: runtime()
    },
    securityAudit,
    sessions: {
      managed: { archive: fail, read: fail, start: fail },
      read: { get: fail, list: fail },
      resume: { read: fail },
      subscribers
    },
    state: { get: fail, listEvents: fail, require: fail }
  } satisfies CreateHostDeckSelectedApiRouteCompositionInput;
  let closed = false;
  const fixture: CompositionFixture = {
    authentication,
    close() {
      if (closed) return;
      closed = true;
      subscribers.close();
      if (opened.db.open) opened.db.close();
      rmSync(root, { force: true, recursive: true });
    },
    input,
    portCalls: () => portCalls
  };
  fixtures.push(fixture);
  return fixture;
}
