import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexReconnectLifecyclePort,
  type CodexTextTransport,
  type CodexTransportEvent,
  type CodexTransportListener,
  type CodexTransportState,
  createCodexRuntimeReconnectController,
  HostDeckCodexAdapterError
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  selectedAuditActorSchema,
  selectedAuditTargetSchema,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  acquireHostDeckDaemonLease,
  createSelectedAuditRepository,
  openMigratedDatabase,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPathsAfterLease,
  reconcileSelectedAuditOrphansBatch,
  resolveHostDeckLocalPaths
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostDeckApplicationShutdown,
  createHostDeckSelectedWriteShutdownPort
} from "./application-shutdown.js";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import {
  type HostDeckFastifyLifecycle,
  startHostDeckFastifyLifecycle
} from "./fastify-host-lifecycle.js";
import { createHostDeckSseTransportRegistration } from "./fastify-sse-transport.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";
import { testRequestAuthenticationPolicy } from "./test-request-authentication.js";

describe("real HostDeck application shutdown", () => {
  it("drains an accepted mutation and SSE before closing SQLite and releasing the lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-application-shutdown-"));
    const runtimeParent = mkdtempSync(
      join(tmpdir(), "hostdeck-application-shutdown-runtime-")
    );
    const paths = resolveHostDeckLocalPaths({
      config_dir: join(root, "config"),
      database_path: join(root, "state", "hostdeck.sqlite"),
      runtime_dir: join(runtimeParent, "hostdeck"),
      state_dir: join(root, "state")
    });
    prepareHostDeckDaemonLeasePath(paths);
    const lease = acquireHostDeckDaemonLease({
      lease_path: paths.lease_path,
      now: fixedNow
    });
    prepareHostDeckLocalPathsAfterLease(paths);
    const opened = openMigratedDatabase(paths.database_path, { now: fixedNow });
    const repository = createSelectedAuditRepository(opened.db);
    const transport = new ShutdownCodexTransport();
    const reconnect = createCodexRuntimeReconnectController({
      transport,
      observed_version: "0.144.0",
      resource_budget: defaultResourceBudget,
      lifecycle: reconnectLifecycle(),
      on_background_error: () => undefined
    });
    const admission = createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget: defaultResourceBudget,
      now: () => performance.now()
    });
    const selectedWrites = createHostDeckSelectedWriteShutdownPort({ admission });
    let auditRecord = 0;
    let auditTime = fixedNow().getTime();
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository,
      now: () => new Date(auditTime++).toISOString(),
      create_record_id: () => `audit_shutdown_real_${++auditRecord}`
    });
    const actor = selectedAuditActorSchema.parse({
      type: "cli",
      device_id: null,
      permission: "local_admin",
      origin: null
    });
    const target = selectedAuditTargetSchema.parse({
      type: "managed_session",
      session_id: "sess_shutdown_real_01",
      codex_thread_id: "thread-shutdown-real-01"
    });
    const sseOpened = deferred<void>();
    const sseReceived = deferred<void>();
    const sseRelease = deferred<void>();
    const events: string[] = [];
    const source = {
      async *open() {
        try {
          sseOpened.resolve();
          yield projectionEvent();
          await sseRelease.promise;
        } finally {
          events.push("sse-source-closed");
        }
      }
    };
    const shutdown = createHostDeckApplicationShutdown({
      approvals: {
        close() {
          events.push("approvals");
        }
      },
      audit: {
        barrier(deadline) {
          deadline.throwIfAborted();
          events.push("audit");
          const result = reconcileSelectedAuditOrphansBatch(opened.db, {
            eligible_before: "2026-07-17T00:00:00.000Z",
            max_reconciled_operations: 10,
            reconciled_at: "2026-07-17T00:00:00.000Z"
          });
          return Object.freeze({
            pending_operations: result.total_pending_operation_count as 0,
            reconciled_operations: result.reconciled_operation_count
          });
        }
      },
      lease: {
        release(deadline) {
          deadline.throwIfAborted();
          events.push("lease");
          lease.release();
        }
      },
      projection: {
        barrier(deadline) {
          deadline.throwIfAborted();
          events.push("projection");
          return Object.freeze({
            last_sequence: 1,
            pending_notifications: 0 as const
          });
        }
      },
      reconnect: {
        close(deadline) {
          deadline.throwIfAborted();
          events.push("reconnect");
          return reconnect.close();
        }
      },
      resource_budget: defaultResourceBudget,
      storage: {
        close(deadline) {
          deadline.throwIfAborted();
          events.push("storage");
          opened.db.close();
        }
      },
      subscribers: {
        close(deadline) {
          deadline.throwIfAborted();
          events.push("subscribers");
          sseRelease.resolve();
        }
      },
      supervisor: {
        close(deadline) {
          deadline.throwIfAborted();
          events.push("supervisor");
        }
      },
      writes: {
        beginDrain() {
          events.push("admission");
          return selectedWrites.beginDrain();
        },
        drain(deadline) {
          events.push("writes");
          return selectedWrites.drain(deadline);
        }
      }
    });

    let lifecycle: HostDeckFastifyLifecycle<object> | null = null;
    let sse: ReturnType<typeof openSse> | null = null;
    try {
      const port = await getAvailablePort();
      lifecycle = await startHostDeckFastifyLifecycle({
        createRequestAuthenticationPolicy: () => testRequestAuthenticationPolicy,
        createRoutePlugins: () => [
          mutationRegistration({ admission, audit, actor, reconnect, target }),
          createHostDeckSseTransportRegistration({
            id: "shutdown-real-sse",
            observeError: () => undefined,
            path: "/api/events",
            source
          }),
          appCloseRegistration(events)
        ],
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: {
          beginDrain: shutdown.beginDrain,
          closeRuntime: shutdown.closeRuntime,
          closeSse: shutdown.closeSse,
          closeStartup: shutdown.closeStartup,
          async start(input) {
            await reconnect.start(input.deadline.signal);
            return {
              bind: { host: "127.0.0.1", port, transport: "http" },
              context: {}
            } as const;
          }
        }
      });

      sse = openSse(lifecycle.baseUrl, sseReceived);
      await sseOpened.promise;
      await sseReceived.promise;
      const mutation = fetch(new URL("/api/shutdown-mutation", lifecycle.baseUrl), {
        method: "POST",
        headers: { origin: lifecycle.baseUrl.origin }
      });
      await transport.mutationSent.promise;

      const firstClose = lifecycle.close();
      expect(lifecycle.close()).toBe(firstClose);
      await expect(mutation).resolves.toMatchObject({ status: 200 });
      await firstClose;
      await sse.ended;

      expect(shutdown.snapshot()).toMatchObject({
        phase: "closed",
        completed_stage_count: 10,
        failed_stage_count: 0,
        active_write_operations: 0,
        pending_audit_operations: 0,
        pending_projection_notifications: 0,
        projection_last_sequence: 1
      });
      expect(events.filter((event) => event !== "sse-source-closed")).toEqual([
        "admission",
        "subscribers",
        "approvals",
        "reconnect",
        "writes",
        "audit",
        "projection",
        "supervisor",
        "app",
        "storage",
        "lease"
      ]);
      expect(opened.db.open).toBe(false);
      expect(lease.released).toBe(true);
      expect(transport.state).toBe("closed");
      expect(transport.sentMethods.filter((method) => method === "turn/start")).toEqual([
        "turn/start"
      ]);

      const reopened = openMigratedDatabase(paths.database_path, { now: fixedNow });
      try {
        expect(
          createSelectedAuditRepository(reopened.db)
            .require("op_shutdown_real_mutation_001")
            .records.map((record) => record.outcome)
        ).toEqual(["accepted", "incomplete"]);
      } finally {
        reopened.db.close();
      }
      const reacquired = acquireHostDeckDaemonLease({
        lease_path: paths.lease_path,
        now: () => new Date("2026-07-16T12:01:00.000Z")
      });
      reacquired.release();
    } finally {
      await lifecycle?.close().catch(() => undefined);
      await reconnect.close().catch(() => undefined);
      if (opened.db.open) opened.db.close();
      lease.release();
      rmSync(root, { force: true, recursive: true });
      rmSync(runtimeParent, { force: true, recursive: true });
    }
  }, 15_000);
});

interface MutationRegistrationInput {
  readonly admission: ReturnType<
    typeof createHostDeckSelectedWriteAdmissionPolicy
  >;
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly actor: ReturnType<typeof selectedAuditActorSchema.parse>;
  readonly reconnect: ReturnType<typeof createCodexRuntimeReconnectController>;
  readonly target: ReturnType<typeof selectedAuditTargetSchema.parse>;
}

function mutationRegistration(
  input: MutationRegistrationInput
): HostDeckRoutePluginRegistration {
  return {
    id: "shutdown-real-mutation",
    surface: "api",
    register(app) {
      app.post(
        "/api/shutdown-mutation",
        {
          schema: {
            response: {
              200: z.strictObject({
                outcome: z.enum(["failed", "incomplete", "succeeded"])
              })
            }
          }
        },
        async (request) => {
          const owner = input.admission.begin<
            Readonly<{
              readonly outcome: "failed" | "incomplete" | "succeeded";
            }>
          >({
            operation_id: "op_shutdown_real_mutation_001",
            actor: input.actor,
            route_id: "shutdown_real_mutation",
            intent: Object.freeze({ action: "prompt" as const }),
            signal: request.signal
          });
          if (owner.state !== "owner") {
            throw new Error("Shutdown real mutation unexpectedly replayed.");
          }
          owner.bindTarget(input.target);
          try {
            const result = await input.audit.execute({
              operation_id: "op_shutdown_real_mutation_001",
              actor: input.actor,
              action: "prompt",
              target: input.target,
              accepted_summary: Object.freeze({
                schema_version: 1 as const,
                text_length: 18
              }),
              emergency_lock_on_audit_unavailable: false,
              async transition() {
                try {
                  await input.reconnect.request({
                    method: "turn/start",
                    params: { hold: true },
                    kind: "mutation"
                  });
                  return Object.freeze({
                    outcome: "succeeded" as const,
                    payload_summary: Object.freeze({
                      schema_version: 1 as const,
                      accepted: true as const
                    }),
                    response: Object.freeze({ accepted: true as const })
                  });
                } catch (cause) {
                  if (
                    cause instanceof HostDeckCodexAdapterError &&
                    cause.outcome === "unknown"
                  ) {
                    return Object.freeze({
                      outcome: "incomplete" as const,
                      error_code: "runtime_unavailable" as const,
                      payload_summary: Object.freeze({ schema_version: 1 as const })
                    });
                  }
                  throw cause;
                }
              },
              prepare_response: (response) => response
            });
            owner.complete(result);
            return { outcome: result.outcome };
          } catch (cause) {
            return owner.fail(
              cause instanceof Error
                ? cause
                : new Error("Shutdown real mutation failed without an Error.")
            );
          }
        }
      );
    }
  };
}

function appCloseRegistration(events: string[]): HostDeckRoutePluginRegistration {
  return {
    id: "shutdown-real-close",
    surface: "static",
    register(app) {
      app.addHook("onClose", async () => {
        events.push("app");
      });
    }
  };
}

function projectionEvent() {
  return selectedProjectionEventSchema.parse({
    captured_at: "2026-07-16T12:00:00.000Z",
    codex_event_id: "event-shutdown-real-1",
    codex_event_type: "item/agentMessage/delta",
    content_notice: null,
    content_state: "complete",
    cursor: 1,
    item_id: null,
    phase: "delta",
    role: "agent",
    session_id: "sess_shutdown_real_01",
    text: "shutdown real SSE event",
    type: "message",
    upstream_at: null
  });
}

function reconnectLifecycle(): CodexReconnectLifecyclePort {
  return {
    disconnected: () => undefined,
    reconcile: () => ({ continuity: "continuous" }),
    resubscribe: () => undefined,
    ready: () => undefined
  };
}

class ShutdownCodexTransport implements CodexTextTransport {
  readonly max_frame_bytes = defaultResourceBudget.protocol_max_frame_bytes;
  readonly mutationSent = deferred<void>();
  readonly sentMethods: string[] = [];
  private readonly listeners = new Set<CodexTransportListener>();
  private currentGeneration = 0;
  private currentState: CodexTransportState = "idle";

  get generation(): number {
    return this.currentGeneration;
  }

  get state(): CodexTransportState {
    return this.currentState;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw signal.reason;
    this.currentState = "open";
    this.currentGeneration += 1;
    this.emit({ type: "open", generation: this.currentGeneration });
  }

  async sendText(text: string): Promise<void> {
    if (this.currentState !== "open") {
      throw new Error("Shutdown transport is not open.");
    }
    const message = JSON.parse(text) as {
      readonly id?: number;
      readonly method?: string;
      readonly params?: Record<string, unknown>;
    };
    const method = message.method;
    if (method !== undefined) this.sentMethods.push(method);
    if (method === "initialize") {
      this.receive({
        id: message.id,
        result: {
          userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
          codexHome: "/tmp/hostdeck-shutdown-codex-home",
          platformFamily: "unix",
          platformOs: "linux"
        }
      });
      return;
    }
    if (method === "collaborationMode/list") {
      this.receive({
        id: message.id,
        result: { data: [{ name: "Default" }, { name: "Plan" }] }
      });
      return;
    }
    if (method === "thread/list" && message.params?.hold !== true) {
      this.receive({ id: message.id, result: { data: [] } });
      return;
    }
    if (method === "turn/start") this.mutationSent.resolve();
  }

  async close(reason: string): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    this.emit({
      type: "close",
      generation: this.currentGeneration,
      code: 1000,
      reason,
      clean: true
    });
  }

  terminate(error: HostDeckCodexAdapterError): void {
    this.emit({ type: "error", generation: this.currentGeneration, error });
    this.currentState = "closed";
    this.emit({
      type: "close",
      generation: this.currentGeneration,
      code: 1006,
      reason: error.message,
      clean: false
    });
  }

  subscribe(listener: CodexTransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(message: unknown): void {
    this.emit({
      type: "message",
      generation: this.currentGeneration,
      text: JSON.stringify(message)
    });
  }

  private emit(event: CodexTransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function openSse(
  baseUrl: URL,
  received: Deferred<void>
): { readonly ended: Promise<void> } {
  let resolveEnded!: () => void;
  let rejectEnded!: (cause: unknown) => void;
  const ended = new Promise<void>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  const request = httpRequest(
    new URL("/api/events", baseUrl),
    { headers: { accept: "text/event-stream" }, method: "GET" },
    (response) => {
      response.once("data", () => received.resolve());
      response.once("end", resolveEnded);
      response.once("error", rejectEnded);
      response.resume();
    }
  );
  request.once("error", rejectEnded);
  request.end();
  return { ended };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate shutdown test port."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function fixedNow(): Date {
  return new Date("2026-07-16T12:00:00.000Z");
}
