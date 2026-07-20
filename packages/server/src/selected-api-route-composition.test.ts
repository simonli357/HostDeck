import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget } from "@hostdeck/contracts";
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
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
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

const fixtures: CompositionFixture[] = [];
const fixedTime = "2026-07-20T12:00:00.000Z";

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
