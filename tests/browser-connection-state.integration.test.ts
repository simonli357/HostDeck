import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodexTurnClient,
  CodexTurnInterruptInput,
  CodexTurnStartInput,
  CodexTurnSteerInput,
  NormalizedCodexEvent
} from "../packages/codex-adapter/src/index.js";
import {
  codexThreadIdSchema,
  codexTurnIdSchema,
  remoteIngressPublicStateSchema,
  resolveResourceBudget,
  runtimeCompatibilitySchema,
  type SelectedProjectionEvent,
  type SelectedSessionListInput,
  type SelectedSessionListPage,
  type SelectedSessionProjectionRecord,
  type SelectedSessionReadItem,
  selectedProjectionEventSchema,
  selectedSessionListPageSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  selectedSessionReadItemSchema
} from "../packages/contracts/src/index.js";
import type { OutputCursor, SessionId } from "../packages/core/src/index.js";
import { selectedProjectionSseWireByteLength } from "../packages/server/src/fastify-sse-source.js";
import {
  createCodexPromptControlService,
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckFastifyApp,
  createHostDeckHealthRouteRegistration,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckProjectionStreamRouteRegistration,
  createHostDeckPromptRouteRegistration,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createHostDeckSessionReadRouteRegistration,
  createHostDeckTailscaleServeFastifyApp,
  createProjectionSubscriberStreamService,
  createSecurityMutationAuditExecutor,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  HostDeckProjectionHandoffError,
  hostDeckDeviceCookieName,
  type OpenProjectionReplayLiveHandoffInput,
  type ProjectionHandoffFailure,
  type ProjectionReplayLiveHandoff,
  type ProjectionReplayLiveHandoffService
} from "../packages/server/src/index.js";
import {
  createAuthDeviceRepository,
  createDeviceRevocationRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSelectedStateRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";
import {
  type BrowserConnectionStateCoordinator,
  createBrowserConnectionStateCoordinator
} from "../packages/web/src/connection-state.js";
import { createBrowserCsrfClient } from "../packages/web/src/csrf-client.js";
import {
  type BrowserHttpFetchPort,
  createBrowserHttpClient
} from "../packages/web/src/http-client.js";
import {
  createPromptComposerController,
  type PromptComposerController,
  type PromptComposerDispatchInput
} from "../packages/web/src/prompt-composer-state.js";
import {
  appendSessionDetailEvent,
  createSessionDetailFeed,
  type SessionDetailFeedState
} from "../packages/web/src/session-detail-feed.js";
import {
  type BrowserSseFetchPort,
  createBrowserSseClient
} from "../packages/web/src/sse-client.js";

const externalOrigin =
  "https://hostdeck-connection-state.fixture-tailnet.ts.net";
const sessionId = "sess_connection_integration" as SessionId;
const missingSessionId = "sess_connection_missing";
const writerDeviceId = "client_connection_writer";
const readerDeviceId = "client_connection_reader";
const writerToken = "W".repeat(43);
const readerToken = "R".repeat(43);
const initialWriterCsrf = "I".repeat(43);
const initialReaderCsrf = "J".repeat(43);
const timestamp = "2026-07-22T19:00:00.000Z";
const promptThreadId = "thread-connection-integration";
const privatePrompt = "FE020_PRIVATE_PROMPT_SENTINEL validate the paired browser vertical";
const ambiguousPrompt = "FE020_AMBIGUOUS_PROMPT_SENTINEL prove response loss safety";
const resourceBudget = resolveResourceBudget({
  sse_heartbeat_interval_ms: 1_000
});
const harnesses: ConnectionServerHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.close();
});

describe("FE-V1-025 real shell connection-state composition", () => {
  it("coordinates loopback access, health, list, detail, boundary, stream, and cleanup", async () => {
    const harness = await createHarness("loopback");
    const page = harness.createPage(null);

    const mission = await page.coordinator.setTarget({ kind: "mission_control" });
    expect(mission).toMatchObject({
      phase: "ready",
      access: {
        data: {
          authentication_state: "unpaired",
          network_mode: "loopback",
          can_read_sessions: true,
          can_write_sessions: false
        }
      },
      host: { data: { access: { mode: "loopback_read" } } },
      targetState: {
        data: {
          kind: "mission_control",
          access: { mode: "loopback_read" },
          pageCount: 1
        }
      },
      writeEligibility: { eligible: false, causes: ["read_only_access"] },
      csrf: { phase: "idle", invalidationReason: "not_bootstrapped" }
    });
    expect(mission.targetState.data?.kind === "mission_control"
      ? mission.targetState.data.sessions.map((item) => item.session.id)
      : []).toEqual([sessionId]);
    expect(harness.requestPaths).not.toContain("/api/v1/access/csrf");

    const detail = await page.coordinator.setTarget({
      kind: "session_detail",
      sessionId
    });
    expect(detail).toMatchObject({
      phase: "degraded",
      targetState: {
        data: {
          kind: "session_detail",
          response: { session: { session: { id: sessionId, last_event_cursor: 1 } } }
        }
      },
      stream: {
        state: "idle",
        continuity: "boundary",
        boundary: { after: 0, cursor: 1, reason: "retention" }
      }
    });

    const events: SelectedProjectionEvent[] = [];
    page.coordinator.connectSessionStream((event) => events.push(event));
    await waitUntil(() => harness.handoff.activeSinkCount === 1);
    harness.handoff.publish(projectionEvent(2, "loopback live"));
    await waitUntil(() => events.some((event) => event.cursor === 2));
    expect(page.coordinator.snapshot().stream).toMatchObject({
      state: "connected",
      continuity: "boundary"
    });

    page.coordinator.close();
    await waitUntil(() => harness.subscribers.snapshot().active_subscribers === 0);
    expect(harness.handoff.activeSinkCount).toBe(0);
    expect(harness.sessionPortCounts()).toEqual({ get: 1, list: 1 });
    expect(JSON.stringify(page.coordinator.snapshot())).not.toContain(writerToken);
  });

  it("keeps remote unpaired access private and paired-read access read-only", async () => {
    const harness = await createHarness("serve");
    const unpaired = harness.createPage(null);

    const denied = await unpaired.coordinator.setTarget({ kind: "mission_control" });
    expect(denied).toMatchObject({
      phase: "access_limited",
      access: { data: { authentication_state: "unpaired" } },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      writeEligibility: { eligible: false, causes: ["unpaired"] }
    });
    expect(harness.sessionPortCounts()).toEqual({ get: 0, list: 0 });
    expect(harness.requestPaths).toEqual(["/api/v1/access"]);
    unpaired.coordinator.close();

    const reader = harness.createPage(readerToken);
    const mission = await reader.coordinator.setTarget({ kind: "mission_control" });
    expect(mission).toMatchObject({
      phase: "ready",
      access: {
        data: {
          authentication_state: "paired_device",
          device_id: readerDeviceId,
          permission: "read"
        }
      },
      host: { data: { access: { mode: "paired_read" } } },
      targetState: { data: { access: { mode: "paired_read" } } },
      csrf: { phase: "idle", invalidationReason: "not_bootstrapped" },
      writeEligibility: { eligible: false, causes: ["read_only_access"] }
    });
    expect(harness.requestPaths.filter((path) => path === "/api/v1/access/csrf")).toHaveLength(0);

    const notFound = await reader.coordinator.setTarget({
      kind: "session_detail",
      sessionId: missingSessionId
    });
    expect(notFound).toMatchObject({
      phase: "not_found",
      targetState: {
        state: "not_found",
        data: null,
        failure: { source: "session_detail", status: 404 }
      }
    });
    reader.coordinator.close();
  });

  it("rotates writer authority, reconnects SSE, locks, follows remote generation, and purges on revoke", async () => {
    const harness = await createHarness("serve");
    const page = harness.createPage(writerToken);

    const ready = await page.coordinator.setTarget({ kind: "mission_control" });
    expect(ready).toMatchObject({
      phase: "ready",
      access: { data: { permission: "write", device_id: writerDeviceId } },
      host: {
        data: {
          remote: { availability: "ready", state_generation: 31 },
          access: { mode: "paired_write" }
        }
      },
      csrf: { phase: "ready", generation: 2 },
      writeEligibility: { eligible: true, causes: [] }
    });

    harness.setCompatibilityHealth("degraded");
    const degraded = await page.coordinator.refresh();
    expect(degraded).toMatchObject({
      phase: "degraded",
      host: {
        data: {
          local: {
            state: "degraded",
            mutation_admission: "closed",
            components: expect.arrayContaining([
              expect.objectContaining({
                component: "compatibility",
                state: "degraded",
                causes: ["compatibility_degraded"]
              })
            ])
          }
        }
      },
      writeEligibility: { eligible: false, causes: ["host_not_ready"] }
    });
    harness.setCompatibilityHealth("ready");
    const healthRecovered = await page.coordinator.refresh();
    expect(healthRecovered).toMatchObject({
      phase: "ready",
      writeEligibility: { eligible: true, causes: [] }
    });

    await page.coordinator.setTarget({ kind: "session_detail", sessionId });
    const events: SelectedProjectionEvent[] = [];
    page.coordinator.connectSessionStream((event) => events.push(event));
    await waitUntil(() => harness.handoff.activeSinkCount === 1);
    harness.handoff.publish(projectionEvent(2, "writer live"));
    await waitUntil(() => events.some((event) => event.cursor === 2));
    harness.handoff.disconnectAll();
    await waitUntil(() => harness.handoff.activeSinkCount === 0);
    harness.handoff.append(projectionEvent(3, "writer replay"));
    await waitUntil(() => events.some((event) => event.cursor === 3), 3_000);
    expect(harness.handoff.openInputs.map((input) => input.after)).toEqual([1, 2]);
    expect(page.coordinator.snapshot()).toMatchObject({
      stream: { state: "connected", continuity: "boundary", failure: null },
      lastFailure: { source: "session_stream", reason: "transport_unavailable" }
    });

    page.coordinator.disconnectSessionStream();
    await page.coordinator.setTarget({ kind: "mission_control" });
    const lockedResponse = await page.coordinator.requestHostLock({
      body: {
        operation_id: "op_connection_integration_lock_0001",
        confirmed: true
      }
    });
    expect(lockedResponse.data).toMatchObject({ locked: true });
    const locked = await page.coordinator.refresh();
    expect(locked).toMatchObject({
      access: { data: { locked: true, can_write_sessions: false } },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });

    harness.setRemoteGeneration(32);
    const rotated = await page.coordinator.refresh();
    expect(rotated).toMatchObject({
      host: { data: { remote: { state_generation: 32 } } },
      csrf: {
        phase: "idle",
        generation: null,
        invalidationReason: "remote_authority_changed"
      },
      writeEligibility: {
        eligible: false,
        causes: ["host_locked", "csrf_not_ready"]
      }
    });
    const reauthorized = await page.coordinator.bootstrapCsrf();
    expect(reauthorized).toMatchObject({
      csrf: { phase: "ready", generation: 3 },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });

    harness.revokeWriter();
    const revoked = await page.coordinator.refresh();
    expect(revoked).toMatchObject({
      phase: "access_limited",
      access: { data: { authentication_state: "revoked_device" } },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "device_revoked" },
      writeEligibility: { eligible: false, causes: ["revoked_device"] }
    });
    const publicState = JSON.stringify(revoked);
    for (const secret of harness.secrets) expect(publicState).not.toContain(secret);

    page.coordinator.close();
    await waitUntil(() => harness.subscribers.snapshot().active_subscribers === 0);
    expect(harness.handoff.activeSinkCount).toBe(0);
    expect(harness.audit.require("op_connection_integration_lock_0001").records).toHaveLength(2);
  });
});

describe("FE-V1-020 real paired prompt-composer composition", () => {
  it("binds one browser prompt to selected admission, SQLite audit, and matching SSE truth", async () => {
    const harness = await createHarness("serve");
    const page = harness.createPage(writerToken);
    let feed: SessionDetailFeedState = createSessionDetailFeed(sessionId);
    let composer: PromptComposerController | null = null;
    let loseAcceptedResponse = false;
    const operationIds = [
      "op_fe020_browser_prompt_0001",
      "op_fe020_browser_prompt_0002",
      "op_fe020_browser_prompt_0003"
    ];

    await page.coordinator.setTarget({ kind: "session_detail", sessionId });
    page.coordinator.connectSessionStream(
      (event) => {
        feed = appendSessionDetailEvent(feed, event);
        composer?.updateContext({ snapshot: page.coordinator.snapshot(), feed });
      },
      { start: "recent" }
    );
    await waitUntil(
      () => page.coordinator.snapshot().stream.state === "connected" && feed.lastCursor === 1
    );

    composer = createPromptComposerController({
      sessionId,
      context: { snapshot: page.coordinator.snapshot(), feed },
      createOperationId: () => requiredShift(operationIds),
      dispatch: {
        async dispatch(input: PromptComposerDispatchInput) {
          const response = await page.coordinator.requestProtected(
            "prompt_dispatch",
            {
              params: { session_id: input.sessionId },
              body: input.request
            },
            { signal: input.signal }
          );
          if (loseAcceptedResponse) {
            throw new Error("Private response-loss fixture cause.");
          }
          return response.data;
        }
      }
    });
    const unsubscribe = page.coordinator.subscribe(() => {
      composer?.updateContext({ snapshot: page.coordinator.snapshot(), feed });
    });

    try {
      composer.setDraft(`  ${privatePrompt}  `);
      expect(await composer.submit()).toMatchObject({
        phase: "accepted",
        status: "New turn accepted",
        draft: ""
      });
      expect(harness.promptStartCalls()).toEqual([
        expect.objectContaining({
          operation_id: "op_fe020_browser_prompt_0001",
          thread_id: promptThreadId,
          text: privatePrompt
        })
      ]);
      expect(harness.rawAuditText("op_fe020_browser_prompt_0001")).not.toContain(
        privatePrompt
      );
      expect(JSON.stringify(composer.snapshot())).not.toMatch(
        /audit:connection-state|turn-connection-prompt/u
      );

      await harness.advancePromptTurn("in_progress", "turn-connection-prompt-001", 2);
      await waitUntil(() => composer?.snapshot().phase === "running");
      expect(composer.snapshot()).toMatchObject({
        status: "Turn running",
        sendEnabled: false
      });
      await harness.advancePromptTurn("completed", "turn-connection-prompt-001", 3);
      await waitUntil(() => composer?.snapshot().phase === "completed");
      expect(composer.snapshot().status).toBe("Turn completed");

      harness.setPromptAdmissionState("waiting_for_approval");
      composer.setDraft("FE020_REJECTED_PROMPT_SENTINEL reject stale browser admission");
      expect(await composer.submit()).toMatchObject({
        phase: "failed_retryable",
        status: "Prompt was not accepted",
        sendLabel: "Retry prompt",
        draft: "FE020_REJECTED_PROMPT_SENTINEL reject stale browser admission"
      });
      expect(harness.promptStartCalls()).toHaveLength(1);
      expect(harness.rawAuditText("op_fe020_browser_prompt_0002")).toBe("");

      harness.setPromptAdmissionState("completed");
      loseAcceptedResponse = true;
      composer.setDraft(ambiguousPrompt);
      expect(await composer.submit()).toMatchObject({
        phase: "outcome_unknown",
        reloadRequired: true,
        inputReadOnly: true,
        sendEnabled: false,
        draft: ambiguousPrompt
      });
      expect(harness.promptStartCalls()).toHaveLength(2);
      expect(harness.rawAuditText("op_fe020_browser_prompt_0003")).not.toContain(
        ambiguousPrompt
      );
      expect(
        `${composer.snapshot().status} ${composer.snapshot().statusDetail ?? ""}`
      ).not.toMatch(/SENTINEL|response-loss fixture/u);
      await composer.submit();
      expect(harness.promptStartCalls()).toHaveLength(2);

      expect(
        harness.requestPaths.filter(
          (path) => path === `/api/v1/sessions/${sessionId}/prompts`
        )
      ).toHaveLength(3);
      expect(harness.rawAuditText()).not.toMatch(
        /FE020_PRIVATE_PROMPT_SENTINEL|FE020_AMBIGUOUS_PROMPT_SENTINEL/u
      );
    } finally {
      unsubscribe();
      composer.close();
      page.coordinator.close();
      await waitUntil(() => harness.subscribers.snapshot().active_subscribers === 0);
      expect(harness.handoff.activeSinkCount).toBe(0);
    }
  });
});

type HarnessMode = "loopback" | "serve";

interface ConnectionServerHarness {
  readonly app: HostDeckFastifyInstance;
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly handoff: MemoryHandoffService;
  readonly requestPaths: string[];
  readonly secrets: ReadonlySet<string>;
  readonly subscribers: ReturnType<typeof createProjectionSubscriberStreamService>;
  readonly close: () => Promise<void>;
  readonly createPage: (token: string | null) => {
    readonly coordinator: BrowserConnectionStateCoordinator;
  };
  readonly advancePromptTurn: (
    state: "in_progress" | "completed",
    turnId: string,
    cursor: number
  ) => Promise<void>;
  readonly promptStartCalls: () => readonly CodexTurnStartInput[];
  readonly rawAuditText: (operationId?: string) => string;
  readonly revokeWriter: () => void;
  readonly sessionPortCounts: () => { readonly get: number; readonly list: number };
  readonly setCompatibilityHealth: (state: "degraded" | "ready") => void;
  readonly setPromptAdmissionState: (
    state: "completed" | "waiting_for_approval"
  ) => void;
  readonly setRemoteGeneration: (generation: number) => void;
}

async function createHarness(mode: HarnessMode): Promise<ConnectionServerHarness> {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-connection-state-"));
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(timestamp)
  });
  let wallTime = Date.parse(timestamp);
  const now = () => new Date(++wallTime);
  const port = await reservePort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const settings = createSettingsRepository(opened.db);
  settings.getOrCreateDefault({ stateDir: root, bindPort: port, now });
  const states = createSelectedStateRepository(opened.db);
  states.create(connectionPromptState());
  const promptTurns = new ConnectionPromptTurnClient();
  const promptService = createCodexPromptControlService({
    turns: promptTurns,
    models: noPendingPromptModels(),
    plans: noPendingPromptPlans(),
    states,
    now: () => timestamp
  });

  const auth = createAuthDeviceRepository(opened.db);
  auth.create({
    id: writerDeviceId,
    rawDeviceToken: writerToken,
    rawCsrfToken: initialWriterCsrf,
    permission: "write",
    clientLabel: "Connection-state writer",
    createdAt: now()
  });
  auth.create({
    id: readerDeviceId,
    rawDeviceToken: readerToken,
    rawCsrfToken: initialReaderCsrf,
    permission: "read",
    clientLabel: "Connection-state reader",
    createdAt: now()
  });
  const rotatedTokens = ["A", "B", "C", "D"].map((value) => value.repeat(43));
  const secrets = new Set([
    writerToken,
    readerToken,
    initialWriterCsrf,
    initialReaderCsrf,
    ...rotatedTokens
  ]);
  let tokenIndex = 0;
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db, {
    generateCsrfToken() {
      const token = rotatedTokens[tokenIndex++];
      if (token === undefined) throw new Error("Connection-state CSRF entropy exhausted.");
      return token;
    }
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) => csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
    },
    now
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings.readHostLock(),
      transition: (input) => settings.transitionHostLock(input)
    },
    now
  });
  const audit = createSelectedAuditRepository(opened.db);
  let auditSequence = 0;
  const securityAudit = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => now().toISOString(),
    create_record_id: () => `audit:connection-state:${++auditSequence}`
  });
  const promptAudit = createHostDeckSelectedWriteAuditExecutor({
    repository: audit,
    now: () => now().toISOString(),
    create_record_id: () => `audit:connection-state:${++auditSequence}`
  });
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
    now
  });

  const health = createHostDeckHostHealthService({ now });
  for (const component of [
    "storage",
    "runtime",
    "compatibility",
    "projector",
    "fanout",
    "listener",
    "lease"
  ] as const) {
    health.updateLocal({
      component,
      source_generation: 1,
      state: "ready",
      reasons: []
    });
  }
  let remoteGeneration = 31;
  let remoteSourceGeneration = 0;
  let compatibilitySourceGeneration = 1;
  const updateRemoteHealth = () => {
    health.updateRemote({
      source_generation: ++remoteSourceGeneration,
      state: remoteIngressPublicStateSchema.parse({
        generation: remoteGeneration,
        availability: "ready",
        reason: null,
        external_origin: externalOrigin,
        laptop_action_required: false,
        observed_at: now().toISOString()
      })
    });
  };
  updateRemoteHealth();

  const item = sessionReadItem();
  let getCalls = 0;
  let listCalls = 0;
  const sessions = Object.freeze({
    get(candidate: string) {
      getCalls += 1;
      return candidate === sessionId ? item : null;
    },
    list(_input: SelectedSessionListInput): SelectedSessionListPage {
      listCalls += 1;
      return selectedSessionListPageSchema.parse({
        sessions: [item],
        order_snapshot: "a".repeat(64),
        next_after: null,
        has_more: false
      });
    }
  });

  const handoff = new MemoryHandoffService([projectionEvent(1, "retained")]);
  const streamFailures: unknown[] = [];
  const subscribers = createProjectionSubscriberStreamService({
    handoff: Object.freeze({ open: (candidate: unknown) => handoff.open(candidate) }),
    observe_failure: (failure) => streamFailures.push(failure),
    resource_budget: resourceBudget
  });
  const routePlugins = [
    createHostDeckHostLockRouteRegistration({ audit: securityAudit, csrf, lock }),
    createHostDeckCsrfRouteRegistration({ audit: securityAudit, csrf }),
    createHostDeckHealthRouteRegistration({ health }),
    createHostDeckSessionReadRouteRegistration({ sessions }),
    createHostDeckProjectionStreamRouteRegistration({
      observe_error: (failure) => streamFailures.push(failure),
      subscribers
    }),
    createHostDeckPromptRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget,
        now: () => performance.now()
      }),
      audit: promptAudit,
      csrf,
      lock,
      prompts: {
        dispatch: promptService.dispatch,
        snapshot: promptService.snapshot
      },
      runtime: { read: () => connectionPromptRuntime() },
      sessions: { read: (candidate) => states.require(candidate) }
    })
  ];

  const app = mode === "loopback"
    ? createHostDeckFastifyApp({
        observeInternalError: () => undefined,
        requestAuthenticationPolicy: authentication,
        requestTrustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigin: localOrigin
        }),
        resourceBudget,
        routePlugins
      })
    : (() => {
        const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
        return createHostDeckTailscaleServeFastifyApp({
          observeInternalError: () => undefined,
          requestAuthenticationPolicy: authentication,
          resourceBudget,
          routePlugins,
          remoteIngressRequestAuthority: authority,
          tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
            localOrigin,
            readRemoteAdmission: () =>
              authority.synchronize({
                admission: "open",
                external_origin: externalOrigin,
                generation: remoteGeneration
              })
          })
        });
      })();
  await app.listen({ host: "127.0.0.1", port });

  const requestPaths: string[] = [];
  let operationSequence = 0;
  let closed = false;
  const pages = new Set<BrowserConnectionStateCoordinator>();
  const harness: ConnectionServerHarness = {
    app,
    audit,
    handoff,
    requestPaths,
    secrets,
    subscribers,
    async advancePromptTurn(state, turnId, cursor) {
      replacePromptAdmissionState(states, state, now);
      await promptService.observeEvent(
        connectionPromptRuntimeEvent(state, turnId, cursor)
      );
      handoff.publish(connectionPromptProjectionEvent(cursor, state, turnId));
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const page of pages) page.close();
      pages.clear();
      await app.close();
      opened.db.close();
      rmSync(root, { force: true, recursive: true });
    },
    createPage(token) {
      const origin = mode === "loopback" ? localOrigin : externalOrigin;
      const httpFetch = mode === "loopback"
        ? loopbackHttpFetch(localOrigin, token, requestPaths)
        : serveHttpFetch(localOrigin, token, requestPaths);
      const httpClient = createBrowserHttpClient({ origin, fetch: httpFetch });
      const csrfClient = createBrowserCsrfClient({
        httpClient,
        createOperationId: () =>
          `op_connection_integration_csrf_${String(++operationSequence).padStart(4, "0")}`
      });
      const sseFetch = mode === "loopback"
        ? loopbackSseFetch(localOrigin, token)
        : serveSseFetch(localOrigin, token);
      const sseClient = createBrowserSseClient({
        origin,
        fetch: sseFetch,
        limits: {
          connectTimeoutMs: 35_000,
          idleTimeoutMs: 45_000,
          errorResponseMaxBytes: 65_536,
          eventMaxBytes: 65_536,
          reconnectInitialDelayMs: 500,
          reconnectMaxDelayMs: 1_000,
          maxReconnectAttempts: 3,
          maxConcurrentStreams: 2
        }
      });
      const coordinator = createBrowserConnectionStateCoordinator({
        httpClient,
        sseClient,
        csrfClient,
        origin
      });
      pages.add(coordinator);
      return Object.freeze({ coordinator });
    },
    promptStartCalls: () => Object.freeze([...promptTurns.startCalls]),
    rawAuditText(operationId) {
      const rows = operationId === undefined
        ? opened.db
            .prepare("SELECT record_json FROM selected_audit_events ORDER BY operation_id, phase")
            .all()
        : opened.db
            .prepare(
              "SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase"
            )
            .all(operationId);
      return (rows as readonly { readonly record_json: string }[])
        .map((row) => row.record_json)
        .join("\n");
    },
    revokeWriter() {
      createDeviceRevocationRepository(opened.db).revoke({
        deviceId: writerDeviceId,
        now: now()
      });
    },
    sessionPortCounts: () => Object.freeze({ get: getCalls, list: listCalls }),
    setCompatibilityHealth(state) {
      health.updateLocal({
        component: "compatibility",
        source_generation: ++compatibilitySourceGeneration,
        state,
        reasons: state === "degraded" ? ["compatibility_degraded"] : []
      });
    },
    setPromptAdmissionState(state) {
      replacePromptAdmissionState(states, state, now);
    },
    setRemoteGeneration(generation) {
      remoteGeneration = generation;
      updateRemoteHealth();
    }
  };
  harnesses.push(harness);
  return harness;
}

class ConnectionPromptTurnClient implements CodexTurnClient {
  readonly runtime_version = "0.144.0";
  readonly startCalls: CodexTurnStartInput[] = [];
  readonly steerCalls: CodexTurnSteerInput[] = [];
  readonly interruptCalls: CodexTurnInterruptInput[] = [];

  async startTurn(input: CodexTurnStartInput): ReturnType<CodexTurnClient["startTurn"]> {
    this.startCalls.push(input);
    const turnId = `turn-connection-prompt-${String(this.startCalls.length).padStart(3, "0")}`;
    return {
      thread_id: codexThreadIdSchema.parse(input.thread_id),
      turn_id: codexTurnIdSchema.parse(turnId),
      state: "accepted" as const
    };
  }

  async steerTurn(input: CodexTurnSteerInput): ReturnType<CodexTurnClient["steerTurn"]> {
    this.steerCalls.push(input);
    throw new Error("Connection prompt integration must not steer.");
  }

  async interruptTurn(
    input: CodexTurnInterruptInput
  ): ReturnType<CodexTurnClient["interruptTurn"]> {
    this.interruptCalls.push(input);
    throw new Error("Connection prompt integration must not interrupt.");
  }
}

function noPendingPromptModels() {
  return Object.freeze({
    readPendingSettings: () => Object.freeze([]),
    async dispatchPendingTurn() {
      throw new Error("Connection prompt integration has no pending model selection.");
    }
  });
}

function noPendingPromptPlans() {
  return Object.freeze({
    readPendingSettings: () => Object.freeze([]),
    async dispatchPendingTurn() {
      throw new Error("Connection prompt integration has no pending Plan selection.");
    }
  });
}

function connectionPromptState() {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "connection-integration",
    codex_thread_id: promptThreadId,
    cwd: "/workspace/hostdeck",
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null
  });
  const projection: SelectedSessionProjectionRecord =
    selectedSessionProjectionRecordSchema.parse({
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
        updated_at: timestamp,
        last_activity_at: timestamp,
        branch: "main",
        model: "gpt-5.5-codex",
        settings: null,
        goal: null,
        recent_summary: "Real selected coordinator fixture.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    });
  return Object.freeze({ mapping, projection });
}

function replacePromptAdmissionState(
  states: ReturnType<typeof createSelectedStateRepository>,
  turnState: "in_progress" | "completed" | "waiting_for_approval",
  now: () => Date
): void {
  const current = states.require(sessionId);
  const updatedAt = now().toISOString();
  states.replace(
    {
      mapping: { ...current.mapping, updated_at: updatedAt },
      projection: {
        ...current.projection,
        session: {
          ...current.projection.session,
          turn_state: turnState,
          attention: turnState === "waiting_for_approval" ? "needs_approval" : "none",
          updated_at: updatedAt,
          last_activity_at: updatedAt
        }
      }
    },
    {
      mapping_updated_at: current.mapping.updated_at,
      projection_updated_at: current.projection.session.updated_at,
      last_event_cursor: current.projection.session.last_event_cursor
    }
  );
}

function connectionPromptRuntimeEvent(
  state: "in_progress" | "completed",
  turnId: string,
  sequence: number
): NormalizedCodexEvent {
  return {
    sequence,
    method: state === "in_progress" ? "turn/started" : "turn/completed",
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: promptThreadId,
    turn_id: turnId,
    status: state,
    ...(state === "completed" ? { error_message: null } : {})
  } as NormalizedCodexEvent;
}

function connectionPromptProjectionEvent(
  cursor: number,
  state: "in_progress" | "completed",
  turnId: string
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: `connection-prompt-event-${cursor}`,
    codex_event_type: state === "in_progress" ? "turn/started" : "turn/completed",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: turnId,
    state,
    error: null
  });
}

function connectionPromptRuntime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: "0.144.0",
    binding_id: "binding-connection-prompt-001",
    capabilities: [
      "thread_lifecycle",
      "turn_input",
      "turn_steer",
      "turn_interrupt",
      "model",
      "goal",
      "plan",
      "usage",
      "compact",
      "skills",
      "approvals",
      "multi_client"
    ].map((name) => ({ name, state: "available", reason: null })),
    checked_at: timestamp,
    reason: null
  });
}

function requiredShift<Value>(values: Value[]): Value {
  const value = values.shift();
  if (value === undefined) throw new TypeError("Required integration value is unavailable.");
  return value;
}

class MemoryHandoffService implements ProjectionReplayLiveHandoffService {
  readonly openInputs: OpenProjectionReplayLiveHandoffInput[] = [];
  private readonly events: SelectedProjectionEvent[];
  private readonly live = new Map<
    string,
    {
      readonly sink: (event: SelectedProjectionEvent) => void;
      readonly controller: AbortController;
    }
  >();

  constructor(events: readonly SelectedProjectionEvent[]) {
    this.events = [...events];
  }

  get activeSinkCount(): number {
    return this.live.size;
  }

  append(event: SelectedProjectionEvent): void {
    this.events.push(event);
  }

  publish(event: SelectedProjectionEvent): void {
    this.append(event);
    for (const entry of [...this.live.values()]) entry.sink(event);
  }

  disconnectAll(): void {
    for (const entry of [...this.live.values()]) entry.controller.abort();
  }

  open(candidate: unknown): ProjectionReplayLiveHandoff {
    const input = candidate as OpenProjectionReplayLiveHandoffInput;
    this.openInputs.push(input);
    if (input.session_id !== sessionId) {
      throw new HostDeckProjectionHandoffError(
        "session_not_found",
        "Connection-state integration session was not found."
      );
    }
    const replay = Object.freeze(
      this.events.filter(
        (event) => input.after === null || event.cursor > input.after
      )
    );
    const highWater = (this.events.at(-1)?.cursor ?? input.after) as
      | OutputCursor
      | null;
    const controller = new AbortController();
    let claimed = false;
    let closed = false;
    let activated = false;
    const service = this;
    const replayBytes = replay.reduce(
      (total, event) => total + selectedProjectionSseWireByteLength(event),
      0
    );
    return Object.freeze({
      activate(candidateActivation: unknown) {
        const activation = candidateActivation as {
          readonly on_event: (event: SelectedProjectionEvent) => void;
        };
        service.live.set(input.subscriber_id, {
          sink: activation.on_event,
          controller
        });
        activated = true;
        return Object.freeze({
          drained_event_count: 0,
          live_after_cursor: highWater
        });
      },
      after: input.after as OutputCursor | null,
      claim_replay() {
        if (claimed) throw new Error("Connection-state replay was already claimed.");
        claimed = true;
        return Object.freeze({
          event_count: replay.length,
          events: replay,
          wire_bytes: replayBytes
        });
      },
      close() {
        if (closed) return false;
        closed = true;
        service.live.delete(input.subscriber_id);
        controller.abort();
        return true;
      },
      get failure(): ProjectionHandoffFailure | null {
        return null;
      },
      high_water_cursor: highWater,
      observed_fanout_cursor: null,
      get paused_event_count() {
        return 0;
      },
      get paused_wire_bytes() {
        return 0;
      },
      replay_event_count: replay.length,
      replay_wire_bytes: replayBytes,
      session_id: input.session_id,
      signal: controller.signal,
      get state() {
        return closed ? "closed" : activated ? "live" : "paused";
      },
      subscriber_id: input.subscriber_id,
      truncated: false
    });
  }
}

function sessionReadItem(): SelectedSessionReadItem {
  return selectedSessionReadItemSchema.parse({
    event_window: {
      state: "bounded",
      retained_event_count: 1,
      earliest_retained_cursor: 1,
      boundary_cursor: 0
    },
    session: {
      id: sessionId,
      name: "connection-integration",
      codex_thread_id: "thread-connection-integration",
      cwd: "/workspace/hostdeck",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      created_at: timestamp,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "gpt-5.5-codex",
      settings: {
        collaboration_mode: "default",
        runtime_model: "gpt-5.5-codex",
        reasoning_effort: "high",
        observed_at: timestamp
      },
      goal: { objective: "Complete connection-state integration.", state: "active" },
      recent_summary: "Real selected coordinator fixture.",
      last_event_cursor: 1
    }
  });
}

function projectionEvent(cursor: number, text: string): SelectedProjectionEvent {
  return Object.freeze(
    selectedProjectionEventSchema.parse({
      session_id: sessionId,
      cursor,
      captured_at: timestamp,
      upstream_at: null,
      codex_event_id: `connection-integration-event-${cursor}`,
      codex_event_type: "item/agentMessage/delta",
      content_state: "complete",
      content_notice: null,
      type: "message",
      role: "agent",
      phase: "delta",
      item_id: null,
      text
    })
  );
}

function loopbackHttpFetch(
  origin: string,
  token: string | null,
  paths: string[]
): BrowserHttpFetchPort {
  return async (path, init) => {
    paths.push(path);
    const headers: Record<string, string> = { ...init.headers, origin };
    if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
    return (await fetch(new URL(path, origin), {
      ...init,
      headers
    } as RequestInit)) as never;
  };
}

function serveHttpFetch(
  proxyOrigin: string,
  token: string | null,
  paths: string[]
): BrowserHttpFetchPort {
  return async (path, init) => {
    paths.push(path);
    const authority = new URL(externalOrigin).host;
    const headers: Record<string, string> = {
      ...init.headers,
      host: authority,
      origin: externalOrigin,
      "x-forwarded-for": "100.91.82.75",
      "x-forwarded-host": authority,
      "x-forwarded-proto": "https"
    };
    if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
    if (init.body !== undefined) {
      headers["content-length"] = String(
        new TextEncoder().encode(init.body).byteLength
      );
    }
    return await bufferedHttpFetch(proxyOrigin, path, init, headers);
  };
}

function bufferedHttpFetch(
  targetOrigin: string,
  path: string,
  init: Parameters<BrowserHttpFetchPort>[1],
  headers: Readonly<Record<string, string>>
): ReturnType<BrowserHttpFetchPort> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, targetOrigin),
      { method: init.method, headers },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          const status = response.statusCode;
          if (status === undefined) {
            reject(new Error("Connection-state response has no status code."));
            return;
          }
          const responseHeaders = responseHeadersFrom(response.rawHeaders);
          resolve(
            new Response(Buffer.concat(chunks), {
              status,
              headers: responseHeaders
            }) as never
          );
        });
      }
    );
    const abort = () => request.destroy(new Error("Connection-state request aborted."));
    init.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => init.signal.removeEventListener("abort", abort));
    request.once("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

function loopbackSseFetch(
  origin: string,
  token: string | null
): BrowserSseFetchPort {
  const headers: Record<string, string> = { origin };
  if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
  return (path, init) => streamingHttpFetch(origin, path, init, headers);
}

function serveSseFetch(
  proxyOrigin: string,
  token: string | null
): BrowserSseFetchPort {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    origin: externalOrigin,
    "x-forwarded-for": "100.91.82.75",
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
  return (path, init) => streamingHttpFetch(proxyOrigin, path, init, headers);
}

function streamingHttpFetch(
  targetOrigin: string,
  path: string,
  init: Parameters<BrowserSseFetchPort>[1],
  extraHeaders: Readonly<Record<string, string>>
): ReturnType<BrowserSseFetchPort> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, targetOrigin),
      { method: init.method, headers: { ...init.headers, ...extraHeaders } },
      (response) => {
        const status = response.statusCode;
        if (status === undefined) {
          response.destroy();
          reject(new Error("Connection-state SSE response has no status code."));
          return;
        }
        const headers = responseHeadersFrom(response.rawHeaders);
        const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => headers.get(name) },
          body: {
            getReader: () => {
              const reader = stream.getReader();
              return {
                async read() {
                  const result = await reader.read();
                  return result.done
                    ? { done: true as const }
                    : { done: false as const, value: result.value };
                },
                async cancel() {
                  await reader.cancel();
                },
                releaseLock() {
                  reader.releaseLock();
                }
              };
            }
          }
        });
      }
    );
    const abort = () => request.destroy(new Error("Connection-state SSE aborted."));
    init.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => init.signal.removeEventListener("abort", abort));
    request.once("error", reject);
    request.end();
  });
}

function responseHeadersFrom(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_500
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Connection-state integration condition timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
