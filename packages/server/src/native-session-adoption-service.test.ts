import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexNativeSessionClient,
  CodexNativeSessionResumeResult
} from "@hostdeck/codex-adapter";
import { HostDeckCodexAdapterError } from "@hostdeck/codex-adapter";
import type {
  NativeCodexAdoptionSnapshot,
  NativeCodexThreadIdentity,
  NativeSessionDiscoveryResponse
} from "@hostdeck/contracts";
import { createOperationDeadline, type OperationDeadline } from "@hostdeck/core";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  openMigratedDatabase,
  type ProjectionAppendPublisher,
  type SelectedStateRepository,
  selectedStateRevision
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexEventPipeline } from "./codex-event-pipeline.js";
import {
  createNativeSessionAdministrationService,
  HostDeckNativeSessionAdministrationError,
  type NativeSessionAdministrationErrorCode,
  type NativeSessionAdministrationService
} from "./native-session-adoption-service.js";

const cleanup: Array<() => void> = [];
const threadId = "0198a001-native-thread-a";
const now = new Date("2026-08-12T16:00:00.000Z");
const adoptRequest = {
  operation_id: "op_native_adopt_0001",
  thread_id: threadId,
  name: "existing-work",
  confirm_handoff: true
} as const;

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("native session administration service", () => {
  it("discovers only unmanaged bounded identity without reading history", async () => {
    const fixture = createFixture();
    await fixture.service.adopt(adoptRequest, deadline());
    fixture.native.identities.push(identity("0198a002-native-thread-b", "/tmp/project-b"));

    const result = await fixture.service.discover({ limit: 1 }, deadline());

    expect(result).toEqual({
      limit: 1,
      threads: [expect.objectContaining({ thread_id: "0198a002-native-thread-b" })],
      truncated: false
    });
    expect(fixture.native.snapshotCalls).toEqual([threadId]);
    expect(JSON.stringify(result)).not.toContain("retained-native-message");
    expect(Object.isFrozen(result.threads)).toBe(true);
  });

  it("atomically bootstraps a visible bounded history and resumes the exact id once", async () => {
    const fixture = createFixture();

    const adopted = await fixture.service.adopt(adoptRequest, deadline());

    expect(adopted).toMatchObject({
      mapping: {
        id: "sess_native_001",
        name: "existing-work",
        codex_thread_id: threadId,
        disposition: "selected"
      },
      projection: {
        session: {
          session_state: "active",
          turn_state: "idle",
          freshness: "current",
          last_event_cursor: 4
        },
        retained_event_count: 4,
        earliest_retained_cursor: 1
      }
    });
    expect(fixture.native.resumeCalls).toEqual([threadId]);
    expect(fixture.states.getNativeMembership("sess_native_001")).toMatchObject({
      codex_thread_id: threadId,
      origin: "adopted"
    });
    expect(fixture.states.listEvents("sess_native_001").events).toMatchObject([
      { type: "replay_boundary", reason: "adoption", cursor: 1 },
      { type: "message", role: "user", text: "retained-native-message", cursor: 2 },
      { type: "message", role: "agent", text: "bounded-native-reply", cursor: 3 },
      { type: "turn", state: "completed", cursor: 4 }
    ]);
  });

  it("serializes adoption races so one exact thread mapping wins without duplicate resume", async () => {
    const fixture = createFixture();
    const second = { ...adoptRequest, operation_id: "op_native_adopt_0002", name: "other-alias" };

    const results = await Promise.allSettled([
      fixture.service.adopt(adoptRequest, deadline()),
      fixture.service.adopt(second, deadline())
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ code: "thread_already_managed", outcome: "not_sent" })
    });
    expect(fixture.native.snapshotCalls).toEqual([threadId]);
    expect(fixture.native.resumeCalls).toEqual([threadId]);
    expect(fixture.states.list()).toHaveLength(1);
  });

  it("does not commit an adoption that aborts while queued behind the event pipeline", async () => {
    const fixture = createFixture();
    const blockerEntered = deferred<void>();
    const blockerGate = deferred<void>();
    const blocker = fixture.events.transitionMembership(async () => {
      blockerEntered.resolve();
      await blockerGate.promise;
    });
    await blockerEntered.promise;
    const controller = new AbortController();
    const adoption = fixture.service.adopt(
      adoptRequest,
      createOperationDeadline({
        timeoutMs: 10_000,
        parentSignal: controller.signal
      })
    );
    await waitFor(() => fixture.native.snapshotCalls.length === 1);

    controller.abort(new Error("request ended"));
    await expectServiceError(adoption, "operation_timeout");
    expect(fixture.states.list()).toEqual([]);
    expect(fixture.native.resumeCalls).toEqual([]);

    blockerGate.resolve();
    await blocker;
    await fixture.events.barrier();
    expect(fixture.states.list()).toEqual([]);
  });

  it("leaves no mapping when identity validation changes before commit", async () => {
    const fixture = createFixture();
    fixture.native.snapshotError = new HostDeckCodexAdapterError(
      "protocol_violation",
      "private changed identity",
      { outcome: "not_sent", retry_safe: false }
    );

    await expectServiceError(
      fixture.service.adopt(adoptRequest, deadline()),
      "protocol_error"
    );
    expect(fixture.states.list()).toEqual([]);
    expect(fixture.native.resumeCalls).toEqual([]);
  });

  it("durably latches recovery-required truth when exact resume fails after commit", async () => {
    const fixture = createFixture();
    fixture.native.resumeError = new HostDeckCodexAdapterError(
      "transport_closed",
      "private activation failure",
      { outcome: "not_sent", retry_safe: true }
    );

    const error = await expectServiceError(
      fixture.service.adopt(adoptRequest, deadline()),
      "recovery_required"
    );
    expect(error).toMatchObject({
      outcome: "committed",
      retry_safe: false,
      session_id: "sess_native_001",
      thread_id: threadId
    });
    expect(fixture.states.require("sess_native_001")).toMatchObject({
      mapping: { disposition: "recovery_required" },
      projection: {
        session: {
          session_state: "stale",
          turn_state: "unknown",
          attention: "unknown",
          freshness: "stale"
        }
      }
    });
    expect(fixture.native.resumeCalls).toEqual([threadId]);
  });

  it("preserves a managed event that commits while post-adoption activation is in flight", async () => {
    const fixture = createFixture();
    const activation = deferred<CodexNativeSessionResumeResult>();
    fixture.native.resumeOperation = () => activation.promise;
    const adoption = fixture.service.adopt(adoptRequest, deadline());
    await waitFor(() => fixture.native.resumeCalls.length === 1);

    await expect(
      fixture.events.consume({
        kind: "notification",
        method: "thread/status/changed",
        params: { threadId, status: { type: "idle" } },
        classification: "selected"
      })
    ).resolves.toMatchObject({ kind: "committed" });

    activation.reject(
      new HostDeckCodexAdapterError(
        "transport_closed",
        "private activation failure after event",
        { outcome: "not_sent", retry_safe: true }
      )
    );
    await expectServiceError(adoption, "recovery_required");
    const retained = fixture.states.listEvents("sess_native_001").events;
    expect(retained).toHaveLength(5);
    expect(retained.at(-1)).toMatchObject({
      type: "activity",
      activity: "thread",
      state: "updated",
      cursor: 5
    });
    expect(fixture.states.require("sess_native_001")).toMatchObject({
      mapping: { disposition: "recovery_required" },
      projection: {
        retained_event_count: 5,
        session: { freshness: "stale", last_event_cursor: 5 }
      }
    });
  });

  it("rejects active or uncertain unmanage and sends no Codex request", async () => {
    const fixture = createFixture();
    await fixture.service.adopt(adoptRequest, deadline());
    const current = fixture.states.require("sess_native_001");
    fixture.states.replace(
      {
        mapping: { ...current.mapping, updated_at: "2026-08-12T16:00:00.001Z" },
        projection: {
          ...current.projection,
          session: {
            ...current.projection.session,
            turn_state: "in_progress",
            attention: "watch",
            updated_at: "2026-08-12T16:00:00.001Z"
          }
        }
      },
      selectedStateRevision(current)
    );

    await expectServiceError(
      fixture.service.unmanage(
        "sess_native_001",
        { operation_id: "op_native_unmanage_0001", confirm: true },
        deadline()
      ),
      "session_not_quiet"
    );
    expect(fixture.states.require("sess_native_001").mapping.codex_thread_id).toBe(threadId);
    expect(fixture.native.mutationCalls).toBe(0);
  });

  it("unmanages a quiet adopted session without any Codex request or history mutation", async () => {
    const fixture = createFixture();
    await fixture.service.adopt(adoptRequest, deadline());
    const snapshotBefore = fixture.native.snapshot;

    const response = await fixture.service.unmanage(
      "sess_native_001",
      { operation_id: "op_native_unmanage_0001", confirm: true },
      deadline()
    );

    expect(response).toMatchObject({
      operation_id: "op_native_unmanage_0001",
      session_id: "sess_native_001",
      codex_thread_id: threadId
    });
    expect(fixture.states.get("sess_native_001")).toBeNull();
    expect(() => fixture.states.listEvents("sess_native_001")).toThrow(
      "does not exist"
    );
    expect(fixture.native.snapshot).toBe(snapshotBefore);
    expect(fixture.native.mutationCalls).toBe(0);
  });

  it("orders unmanage after in-flight publication and permits clean re-adoption", async () => {
    const publicationGate = deferred<void>();
    const publisherEntered = deferred<void>();
    const fixture = createFixture({
      async publish(committed) {
        if (committed.event.event.cursor === 5) {
          publisherEntered.resolve();
          await publicationGate.promise;
        }
      }
    });
    await fixture.service.adopt(adoptRequest, deadline());

    const event = fixture.events.consume({
      kind: "notification",
      method: "thread/status/changed",
      params: { threadId, status: { type: "idle" } },
      classification: "selected"
    });
    await publisherEntered.promise;
    let unmanageSettled = false;
    const unmanage = fixture.service
      .unmanage(
        "sess_native_001",
        { operation_id: "op_native_unmanage_0001", confirm: true },
        deadline()
      )
      .finally(() => {
        unmanageSettled = true;
      });
    await Promise.resolve();
    expect(unmanageSettled).toBe(false);

    publicationGate.resolve();
    await expect(event).resolves.toMatchObject({ kind: "committed" });
    await expect(unmanage).resolves.toMatchObject({ session_id: "sess_native_001" });
    await expect(
      fixture.events.consume({
        kind: "notification",
        method: "thread/status/changed",
        params: { threadId, status: { type: "idle" } },
        classification: "selected"
      })
    ).resolves.toMatchObject({ kind: "unmanaged_observation" });

    const readopted = await fixture.service.adopt(
      {
        ...adoptRequest,
        operation_id: "op_native_adopt_0002",
        name: "existing-work-again"
      },
      deadline()
    );
    expect(readopted.mapping.id).toBe("sess_native_002");
    await expect(
      fixture.events.consume({
        kind: "notification",
        method: "thread/status/changed",
        params: { threadId, status: { type: "idle" } },
        classification: "selected"
      })
    ).resolves.toMatchObject({ kind: "committed" });
    expect(fixture.states.listEvents("sess_native_002").events.at(-1)).toMatchObject({
      cursor: 5,
      type: "activity"
    });
  });

  it("fails duplicate alias before reading native history", async () => {
    const fixture = createFixture();
    await fixture.service.adopt(adoptRequest, deadline());
    fixture.native.identities.push(identity("0198a002-native-thread-b", "/tmp/project-b"));

    await expectServiceError(
      fixture.service.adopt(
        {
          ...adoptRequest,
          operation_id: "op_native_adopt_0002",
          thread_id: "0198a002-native-thread-b"
        },
        deadline()
      ),
      "duplicate_session_name"
    );
    expect(fixture.native.snapshotCalls).toEqual([threadId]);
  });
});

interface Fixture {
  readonly states: SelectedStateRepository;
  readonly native: FakeNativeClient;
  readonly events: ReturnType<typeof createCodexEventPipeline>;
  readonly service: NativeSessionAdministrationService;
}

interface FixtureOptions {
  readonly publish?: ProjectionAppendPublisher;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-native-service-"));
  const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => now
  });
  cleanup.push(() => {
    opened.db.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const states = createSelectedStateRepository(opened.db);
  const native = new FakeNativeClient();
  const events = createCodexEventPipeline({
    repository: states,
    append_port: createProductionProjectionAppendPort({
      repository: states,
      publish: options.publish ?? (() => {})
    }),
    normalizer: { now: () => "2026-08-12T16:00:00.001Z" }
  });
  let nextSessionId = 0;
  const service = createNativeSessionAdministrationService({
    native,
    states,
    events,
    now: () => now,
    create_session_id: () => {
      nextSessionId += 1;
      return `sess_native_${String(nextSessionId).padStart(3, "0")}` as never;
    },
    capture_branch: () => "main"
  });
  return { states, native, events, service };
}

class FakeNativeClient implements CodexNativeSessionClient {
  readonly runtime_version = "0.144.0";
  readonly identities: NativeCodexThreadIdentity[] = [identity(threadId, "/tmp/project-a")];
  readonly snapshotCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  mutationCalls = 0;
  snapshot: NativeCodexAdoptionSnapshot = adoptionSnapshot();
  snapshotError: Error | null = null;
  resumeError: Error | null = null;
  resumeOperation: (() => Promise<CodexNativeSessionResumeResult>) | null = null;

  async discover(): Promise<NativeSessionDiscoveryResponse> {
    return {
      limit: 100,
      threads: this.identities,
      truncated: false
    };
  }

  async readIdentity(candidate: string): Promise<NativeCodexThreadIdentity | null> {
    return this.identities.find((entry) => entry.thread_id === candidate) ?? null;
  }

  async readAdoptionSnapshot(candidate: string): Promise<NativeCodexAdoptionSnapshot> {
    this.snapshotCalls.push(candidate);
    if (this.snapshotError !== null) throw this.snapshotError;
    return this.snapshot;
  }

  async resume(candidate: string): Promise<CodexNativeSessionResumeResult> {
    this.resumeCalls.push(candidate);
    if (this.resumeError !== null) throw this.resumeError;
    if (this.resumeOperation !== null) return this.resumeOperation();
    return {
      thread: this.snapshot.thread,
      runtime_model: "gpt-5.5-codex",
      reasoning_effort: "high"
    };
  }
}

function identity(id: string, cwd: string): NativeCodexThreadIdentity {
  return {
    thread_id: id as never,
    cwd: cwd as never,
    source: "cli",
    runtime_version: "0.144.0",
    created_at: "2026-08-12T14:00:00.000Z" as never,
    updated_at: "2026-08-12T15:00:00.000Z" as never,
    status: "idle",
    archived: false,
    ephemeral: false,
    parent_thread_id: null,
    forked_from_id: null,
    history_mode: "paginated"
  };
}

function adoptionSnapshot(): NativeCodexAdoptionSnapshot {
  return {
    thread: identity(threadId, "/tmp/project-a"),
    truncated_before: false,
    turns: [
      {
        turn_id: "turn-native-001" as never,
        status: "completed",
        started_at: "2026-08-12T14:30:00.000Z" as never,
        completed_at: "2026-08-12T14:31:00.000Z" as never,
        messages: [
          {
            item_id: "item-user-001" as never,
            role: "user",
            text: "retained-native-message"
          },
          {
            item_id: "item-agent-001" as never,
            role: "agent",
            text: "bounded-native-reply"
          }
        ]
      }
    ]
  };
}

function deadline(): OperationDeadline {
  return createOperationDeadline({ timeoutMs: 10_000 });
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: NativeSessionAdministrationErrorCode
): Promise<HostDeckNativeSessionAdministrationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckNativeSessionAdministrationError);
    expect(error).toMatchObject({ code });
    return error as HostDeckNativeSessionAdministrationError;
  }
  throw new Error(`Expected native session administration error ${code}.`);
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition.");
}
