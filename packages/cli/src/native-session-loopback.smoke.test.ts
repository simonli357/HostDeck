import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexNativeSessionClient } from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  nativeCodexAdoptionSnapshotSchema,
  nativeCodexThreadIdentitySchema,
  nativeSessionDiscoveryResponseSchema
} from "@hostdeck/contracts";
import {
  createCodexEventPipeline,
  createHostDeckBoundFunctionView,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckNativeSessionRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createNativeSessionAdministrationService,
  hostDeckLocalHealthComponents
} from "@hostdeck/server";
import {
  createProductionProjectionAppendPort,
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import { runCli } from "./shell.js";

const fixedTime = "2026-08-12T19:00:00.000Z";
const threadId = "019c6ef5-3ad7-7b20-b0a7-6c138cd2a63e";
const sessionId = "sess_native_loopback_001";
const name = "native-loopback";
const adoptOperationId = "op_native_loopback_adopt_001";
const unmanageOperationId = "op_native_loopback_unmanage_001";

describe("native Codex session real loopback CLI smoke", () => {
  it("discovers, adopts, persists, audits, and unmanages through the listening HTTP server", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-native-loopback-"));
    const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
      now: () => new Date(fixedTime)
    });
    const states = createSelectedStateRepository(opened.db);
    const auditRepository = createSelectedAuditRepository(opened.db);
    const upstreamCalls: string[] = [];
    const native = nativeFixture(upstreamCalls);
    const events = createCodexEventPipeline({
      repository: states,
      append_port: createProductionProjectionAppendPort({
        repository: states,
        publish() {}
      })
    });
    const service = createNativeSessionAdministrationService({
      native,
      states,
      events,
      now: () => new Date(fixedTime),
      create_session_id: () => sessionId as never,
      capture_branch: () => "main"
    });
    const nativeService = createHostDeckBoundFunctionView(service, [
      "adopt",
      "discover",
      "unmanage"
    ]);
    const health = createHostDeckHostHealthService({
      now: () => new Date(fixedTime)
    });
    for (const component of hostDeckLocalHealthComponents) {
      health.updateLocal({
        component,
        state: "ready",
        reasons: [],
        source_generation: 1
      });
    }
    const admission = createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget: defaultResourceBudget,
      now: () => 1,
      health
    });
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => fixedTime,
      create_record_id: (() => {
        let sequence = 0;
        return () => `audit:native-loopback:${++sequence}`;
      })()
    });
    const lock = createHostDeckHostLockPolicy({
      now: () => new Date(fixedTime),
      settings: {
        read: () => Object.freeze({ locked: false, settings_updated_at: fixedTime }),
        transition: () => {
          throw new Error("Native loopback smoke does not mutate host lock state.");
        }
      }
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite: () => {
          throw new Error("Native loopback smoke must use local CLI authority.");
        },
        rotateBootstrap: () => {
          throw new Error("Native loopback smoke does not rotate CSRF state.");
        }
      },
      now: () => new Date(fixedTime)
    });
    const authentication = createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => ({
        trusted: false,
        readOnly: false,
        device: null
      }),
      now: () => new Date(fixedTime)
    });
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const internalErrors: unknown[] = [];
    const app = createHostDeckFastifyApp({
      observeInternalError: (observation) => internalErrors.push(observation),
      requestAuthenticationPolicy: authentication,
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: origin
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [
        createHostDeckNativeSessionRouteRegistration({
          admission,
          audit,
          csrf,
          health,
          lock,
          native: nativeService,
          state: createHostDeckBoundFunctionView(states, ["require"])
        })
      ]
    });

    try {
      await app.listen({
        host: "127.0.0.1",
        port,
        listenTextResolver: () => ""
      });

      const discovered = await runCli(
        ["--api-url", origin, "discover", "--limit", "5", "--json"],
        { env: {} }
      );
      expect(discovered).toMatchObject({
        exitCode: cliExitCodes.ok,
        stderr: ""
      });
      expect(JSON.parse(discovered.stdout)).toMatchObject({
        limit: 5,
        threads: [{ thread_id: threadId }],
        truncated: false
      });

      const adopted = await runCli(
        [
          "--api-url",
          origin,
          "adopt",
          threadId,
          "--name",
          name,
          "--confirm-handoff",
          "--json"
        ],
        {
          env: {},
          createNativeAdoptOperationId: () => adoptOperationId
        }
      );
      expect(adopted).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(adopted.stdout)).toMatchObject({
        operation_id: adoptOperationId,
        session: {
          id: sessionId,
          name,
          codex_thread_id: threadId,
          session_state: "active"
        }
      });
      expect(states.require(sessionId).mapping).toMatchObject({
        id: sessionId,
        name,
        codex_thread_id: threadId,
        disposition: "selected"
      });
      expect(states.getNativeMembership(sessionId)).toMatchObject({
        session_id: sessionId,
        codex_thread_id: threadId,
        origin: "adopted"
      });

      const unmanaged = await runCli(
        ["--api-url", origin, "unmanage", sessionId, "--confirm", "--json"],
        {
          env: {},
          createNativeUnmanageOperationId: () => unmanageOperationId
        }
      );
      expect(unmanaged).toMatchObject({
        exitCode: cliExitCodes.ok,
        stderr: ""
      });
      expect(JSON.parse(unmanaged.stdout)).toMatchObject({
        operation_id: unmanageOperationId,
        session_id: sessionId,
        codex_thread_id: threadId
      });
      expect(states.get(sessionId)).toBeNull();
      expect(states.getNativeMembership(sessionId)).toBeNull();
      expect(upstreamCalls).toEqual([
        "discover:100",
        `snapshot:${threadId}`,
        `resume:${threadId}`
      ]);
      expect(auditRepository.require(adoptOperationId)).toMatchObject({
        state: "terminal",
        records: [
          { action: "session_adopt", phase: "accepted" },
          { action: "session_adopt", phase: "terminal", outcome: "succeeded" }
        ]
      });
      expect(auditRepository.require(unmanageOperationId)).toMatchObject({
        state: "terminal",
        records: [
          { action: "session_unmanage", phase: "accepted" },
          { action: "session_unmanage", phase: "terminal", outcome: "succeeded" }
        ]
      });
      expect(internalErrors).toEqual([]);
    } finally {
      await app.close();
      opened.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function nativeFixture(calls: string[]): CodexNativeSessionClient {
  const thread = nativeCodexThreadIdentitySchema.parse({
    thread_id: threadId,
    cwd: "/tmp/native-loopback-project",
    source: "cli",
    runtime_version: "0.144.0",
    created_at: "2026-08-12T18:00:00.000Z",
    updated_at: "2026-08-12T18:30:00.000Z",
    status: "idle",
    archived: false,
    ephemeral: false,
    parent_thread_id: null,
    forked_from_id: null,
    history_mode: "paginated"
  });
  const snapshot = nativeCodexAdoptionSnapshotSchema.parse({
    thread,
    turns: [],
    truncated_before: false
  });
  const client: CodexNativeSessionClient = {
    runtime_version: "0.144.0",
    async discover(input = {}) {
      const limit = input.limit ?? 50;
      calls.push(`discover:${limit}`);
      return nativeSessionDiscoveryResponseSchema.parse({
        limit,
        threads: [thread],
        truncated: false
      });
    },
    async readIdentity(candidate) {
      return candidate === threadId ? thread : null;
    },
    async readAdoptionSnapshot(candidate) {
      calls.push(`snapshot:${candidate}`);
      return snapshot;
    },
    async resume(candidate) {
      calls.push(`resume:${candidate}`);
      return {
        thread,
        runtime_model: "gpt-5.5-codex",
        reasoning_effort: "high"
      };
    }
  };
  return Object.freeze(client);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    throw new Error("Native-session smoke could not reserve a loopback port.");
  }
  const port = address.port;
  await close(server);
  return port;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
