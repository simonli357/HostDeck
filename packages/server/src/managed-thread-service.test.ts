import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexThreadClient,
  type CodexThreadListInput,
  type CodexThreadMaterializeInput,
  type CodexThreadPage,
  type CodexThreadRecord,
  type CodexThreadStartInput,
  type CodexThreadStartResult,
  codexThreadOperationMarker,
  HostDeckCodexAdapterError
} from "@hostdeck/codex-adapter";
import {
  absoluteCwdSchema,
  codexThreadIdSchema,
  isoTimestampSchema,
  selectedSessionStartRecoveryRecordSchema
} from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import {
  createSelectedStateRepository,
  openMigratedDatabase,
  type SelectedStateRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedCodexThreadService,
  HostDeckManagedCodexThreadServiceError,
  type ManagedCodexThreadService,
  type ManagedCodexThreadServiceErrorCode
} from "./managed-thread-service.js";

const cleanup: Array<() => void> = [];
const now = new Date("2026-07-09T22:00:00.000Z");
const request = {
  operation_id: "op_managed_start_0001",
  name: "managed-one",
  cwd: "/tmp/project-a"
} as const;

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("managed Codex thread start saga", () => {
  it("reserves, starts, maps, finalizes recovery, and exposes only durable managed state", async () => {
    const fixture = createFixture();
    const state = await fixture.service.start(request);

    expect(state).toMatchObject({
      mapping: {
        id: "sess_managed_001",
        name: "managed-one",
        codex_thread_id: "thread-managed-1",
        cwd: "/tmp/project-a",
        runtime_source: "codex_app_server",
        runtime_version: "0.144.0",
        disposition: "selected",
        archived_at: null
      },
      projection: {
        session: {
          session_state: "active",
          turn_state: "idle",
          freshness: "current",
          model: "gpt-5.5-codex",
          branch: "main"
        }
      }
    });
    expect(fixture.threads.start_calls).toBe(1);
    expect(fixture.states.listRecoveries()).toEqual([]);
    expect(fixture.service.list()).toHaveLength(1);
    expect(fixture.service.read("sess_managed_001").mapping.codex_thread_id).toBe("thread-managed-1");
  });

  it("rejects duplicate aliases before dispatching another Codex thread", async () => {
    const fixture = createFixture();
    await fixture.service.start(request);

    await expectServiceError(
      fixture.service.start({ ...request, operation_id: "op_managed_start_0002" }),
      "duplicate_session_name"
    );
    expect(fixture.threads.start_calls).toBe(1);
    expect(fixture.states.list()).toHaveLength(1);
  });

  it("records a provably unsent failure and requires explicit cleanup before retry", async () => {
    const fixture = createFixture();
    fixture.threads.start_error = new HostDeckCodexAdapterError("transport_not_open", "runtime unavailable", {
      outcome: "not_sent",
      retry_safe: true
    });

    await expectServiceError(fixture.service.start(request), "runtime_unavailable");
    expect(fixture.states.getRecovery(request.operation_id)).toMatchObject({
      state: "failed",
      codex_thread_id: null,
      error_code: "runtime_unavailable"
    });
    await expectServiceError(fixture.service.start(request), "recovery_required");
    expect(fixture.threads.start_calls).toBe(1);

    expect(fixture.service.clearFailedStartRecovery(request.operation_id)).toBe(true);
    fixture.threads.start_error = null;
    await fixture.service.start(request);
    expect(fixture.threads.start_calls).toBe(2);
  });

  it("rejects an invalid cwd before reservation or Codex dispatch", async () => {
    const fixture = createFixture();
    const service = createManagedCodexThreadService({
      threads: fixture.threads,
      states: fixture.states,
      now: () => now,
      create_session_id: () => "sess_managed_001" as SessionId,
      validate_cwd: async () => {
        throw new Error("private-invalid-cwd-sentinel");
      },
      capture_branch: () => "main"
    });

    await expectServiceError(service.start(request), "invalid_cwd", {
      outcome: "not_sent",
      thread_id: null
    });
    expect(fixture.states.listRecoveries()).toEqual([]);
    expect(fixture.threads.start_calls).toBe(0);
  });

  it("records a known remote rejection as a failed no-thread outcome", async () => {
    const fixture = createFixture();
    fixture.threads.start_error = new HostDeckCodexAdapterError(
      "remote_error",
      "private-remote-rejection-sentinel",
      {
        outcome: "remote_rejected",
        retry_safe: false,
        rpc_code: -32_600
      }
    );

    await expectServiceError(fixture.service.start(request), "runtime_unavailable", {
      outcome: "remote_rejected",
      thread_id: null
    });
    expect(fixture.states.getRecovery(request.operation_id)).toMatchObject({
      state: "failed",
      codex_thread_id: null,
      error_code: "runtime_unavailable"
    });
    expect(fixture.threads.start_calls).toBe(1);
  });

  it("preserves a known no-thread outcome when failed-recovery persistence fails", async () => {
    const base = createFixture();
    base.threads.start_error = new HostDeckCodexAdapterError(
      "remote_error",
      "private-remote-rejection-sentinel",
      {
        outcome: "remote_rejected",
        retry_safe: false,
        rpc_code: -32_600
      }
    );
    const failingStates: SelectedStateRepository = {
      ...base.states,
      putRecovery(candidate) {
        const parsed = selectedSessionStartRecoveryRecordSchema.parse(candidate);
        if (parsed.state === "failed") {
          throw new Error("injected failed-recovery persistence failure");
        }
        return base.states.putRecovery(parsed);
      }
    };

    await expectServiceError(
      serviceFor(base.threads, failingStates).start(request),
      "storage_error",
      { outcome: "remote_rejected", thread_id: null }
    );
    expect(base.states.getRecovery(request.operation_id)).toMatchObject({
      state: "reserved",
      codex_thread_id: null
    });
    expect(base.threads.start_calls).toBe(1);
  });

  it("leaves an unknown start reserved and never dispatches it a second time", async () => {
    const fixture = createFixture();
    fixture.threads.start_error = new HostDeckCodexAdapterError("unknown_outcome", "start outcome unknown", {
      outcome: "unknown",
      retry_safe: false
    });

    await expectServiceError(fixture.service.start(request), "unknown_outcome");
    expect(fixture.states.getRecovery(request.operation_id)).toMatchObject({ state: "reserved", codex_thread_id: null });
    fixture.threads.start_error = null;
    await expectServiceError(fixture.service.start(request), "recovery_required");
    expect(fixture.threads.start_calls).toBe(1);
    expect(fixture.states.list()).toEqual([]);
  });

  it("recovers a reserved start by its unique loaded-thread operation marker without redispatch", async () => {
    const fixture = createFixture();
    fixture.states.putRecovery(recoveryRecord());
    fixture.threads.records.push(
      threadRecord({
        id: "thread-recovered",
        thread_source: codexThreadOperationMarker(request.operation_id)
      })
    );

    const recovered = await fixture.service.start(request);
    expect(recovered.mapping).toMatchObject({ id: "sess_managed_001", codex_thread_id: "thread-recovered" });
    expect(fixture.threads.start_calls).toBe(0);
    expect(fixture.states.listRecoveries()).toEqual([]);
  });

  it("recovers after Codex creation when the first mapping write fails", async () => {
    const base = createFixture();
    let failCreate = true;
    const failingStates: SelectedStateRepository = {
      ...base.states,
      create(candidate) {
        if (failCreate) throw new Error("injected mapping failure");
        return base.states.create(candidate);
      }
    };
    const failingService = serviceFor(base.threads, failingStates);

    await expectServiceError(failingService.start(request), "storage_error", {
      outcome: "remote_succeeded",
      thread_id: "thread-managed-1"
    });
    expect(base.states.getRecovery(request.operation_id)).toMatchObject({
      state: "thread_created",
      codex_thread_id: "thread-managed-1"
    });
    expect(base.threads.start_calls).toBe(1);

    failCreate = false;
    const recovered = await failingService.start(request);
    expect(recovered.mapping.codex_thread_id).toBe("thread-managed-1");
    expect(base.threads.start_calls).toBe(1);
    expect(base.states.listRecoveries()).toEqual([]);
  });

  it("rejects conflicting recovery input and duplicate operation markers", async () => {
    const fixture = createFixture();
    fixture.states.putRecovery(recoveryRecord());
    await expectServiceError(fixture.service.start({ ...request, name: "different" }), "thread_conflict");

    fixture.threads.records.push(
      threadRecord({ id: "thread-a", thread_source: codexThreadOperationMarker(request.operation_id) }),
      threadRecord({ id: "thread-b", thread_source: codexThreadOperationMarker(request.operation_id), archived: true })
    );
    await expectServiceError(fixture.service.start(request), "thread_conflict", {
      outcome: "remote_succeeded",
      thread_id: null
    });
    expect(fixture.threads.start_calls).toBe(0);
  });

  it("reports a recovered concrete thread with contradictory cwd as remotely created", async () => {
    const fixture = createFixture();
    fixture.states.putRecovery(recoveryRecord());
    fixture.threads.records.push(
      threadRecord({
        id: "thread-recovered-wrong-cwd",
        cwd: "/tmp/other-project",
        thread_source: codexThreadOperationMarker(request.operation_id)
      })
    );

    await expectServiceError(fixture.service.start(request), "identity_mismatch", {
      outcome: "remote_succeeded",
      thread_id: "thread-recovered-wrong-cwd"
    });
    expect(fixture.threads.start_calls).toBe(0);
  });

  it("reports contradictory thread-created and persisted recovery markers as remotely created", async () => {
    for (const state of ["thread_created", "persisted"] as const) {
      const base = createFixture();
      const malformedRecovery = { ...recoveryRecord(), state };
      const states: SelectedStateRepository = {
        ...base.states,
        getRecovery: () => malformedRecovery
      };

      await expectServiceError(serviceFor(base.threads, states).start(request), "identity_mismatch", {
        outcome: "remote_succeeded",
        thread_id: null
      });
      expect(base.threads.start_calls).toBe(0);
    }
  });

  it("persists the returned thread id before materialization and resumes that phase without another start", async () => {
    const fixture = createFixture();
    fixture.threads.materialize_error = new HostDeckCodexAdapterError("unknown_outcome", "materialization disconnected", {
      outcome: "unknown",
      retry_safe: false
    });

    await expectServiceError(fixture.service.start(request), "unknown_outcome", {
      outcome: "remote_succeeded",
      thread_id: "thread-managed-1"
    });
    expect(fixture.states.getRecovery(request.operation_id)).toMatchObject({
      state: "thread_created",
      codex_thread_id: "thread-managed-1"
    });
    expect(fixture.threads.start_calls).toBe(1);
    expect(fixture.threads.materialize_calls).toBe(1);

    fixture.threads.materialize_error = null;
    await expect(fixture.service.start(request)).resolves.toMatchObject({
      mapping: { codex_thread_id: "thread-managed-1" }
    });
    expect(fixture.threads.start_calls).toBe(1);
    expect(fixture.threads.materialize_calls).toBe(2);
    expect(fixture.states.getRecovery(request.operation_id)).toBeNull();
  });

  it("routes a rejected post-id materialization to explicit recovery without redispatch", async () => {
    const fixture = createFixture();
    fixture.threads.materialize_error = new HostDeckCodexAdapterError("remote_error", "goal mutation rejected", {
      outcome: "remote_rejected",
      retry_safe: false,
      rpc_code: -32_600
    });

    await expectServiceError(fixture.service.start(request), "recovery_required", {
      outcome: "remote_succeeded",
      thread_id: "thread-managed-1"
    });
    expect(fixture.states.getRecovery(request.operation_id)).toMatchObject({
      state: "thread_created",
      codex_thread_id: "thread-managed-1"
    });
    expect(fixture.threads.start_calls).toBe(1);
    await expectServiceError(fixture.service.start(request), "recovery_required");
    expect(fixture.threads.start_calls).toBe(1);
  });

  it("reports confirmed remote creation when its thread-created recovery write fails", async () => {
    const base = createFixture();
    const failingStates: SelectedStateRepository = {
      ...base.states,
      putRecovery(candidate) {
        const parsed = selectedSessionStartRecoveryRecordSchema.parse(candidate);
        if (parsed.state === "thread_created") throw new Error("injected recovery identity failure");
        return base.states.putRecovery(parsed);
      }
    };

    await expectServiceError(serviceFor(base.threads, failingStates).start(request), "storage_error", {
      outcome: "remote_succeeded",
      thread_id: "thread-managed-1"
    });
    expect(base.states.getRecovery(request.operation_id)).toMatchObject({ state: "reserved", codex_thread_id: null });
    expect(base.threads.start_calls).toBe(1);
  });

  it("reports a contradictory materialized thread as remotely created", async () => {
    const fixture = createFixture();
    fixture.threads.ensureMaterialized = async () =>
      threadRecord({ id: "thread-materialized-contradiction" });

    await expectServiceError(fixture.service.start(request), "identity_mismatch", {
      outcome: "remote_succeeded",
      thread_id: "thread-materialized-contradiction"
    });
    expect(fixture.states.getRecovery(request.operation_id)).toMatchObject({
      state: "thread_created",
      codex_thread_id: "thread-managed-1"
    });
    expect(fixture.threads.start_calls).toBe(1);
  });

  it("reports confirmed remote creation when recovery finalization fails", async () => {
    const base = createFixture();
    const failingStates: SelectedStateRepository = {
      ...base.states,
      deleteRecovery() {
        throw new Error("injected recovery finalization failure");
      }
    };

    await expectServiceError(serviceFor(base.threads, failingStates).start(request), "storage_error", {
      outcome: "remote_succeeded",
      thread_id: "thread-managed-1"
    });
    expect(base.states.require("sess_managed_001").mapping.codex_thread_id).toBe("thread-managed-1");
    expect(base.states.getRecovery(request.operation_id)).toMatchObject({
      state: "persisted",
      codex_thread_id: "thread-managed-1"
    });
  });
});

describe("managed Codex archive and reconciliation", () => {
  it("archives the exact mapped thread once and persists immutable archive state", async () => {
    const fixture = createFixture();
    await fixture.service.start(request);

    const archived = await fixture.service.archive("sess_managed_001");
    expect(archived).toMatchObject({
      mapping: { codex_thread_id: "thread-managed-1", archived_at: expect.any(String) },
      projection: { session: { session_state: "archived", turn_state: "idle", attention: "none" } }
    });
    await fixture.service.archive("sess_managed_001");
    expect(fixture.threads.archive_calls).toEqual(["thread-managed-1"]);
  });

  it("rejects a concurrent archive before a second Codex mutation is dispatched", async () => {
    const fixture = createFixture();
    await fixture.service.start(request);
    let release: (() => void) | undefined;
    fixture.threads.archive_gate = new Promise<void>((resolve) => (release = resolve));

    const first = fixture.service.archive("sess_managed_001");
    await waitFor(() => fixture.threads.archive_calls.length === 1);
    await expectServiceError(fixture.service.archive("sess_managed_001"), "thread_conflict");
    release?.();
    await first;
    expect(fixture.threads.archive_calls).toEqual(["thread-managed-1"]);
  });

  it("refuses to archive when the runtime identity no longer matches the durable mapping", async () => {
    const fixture = createFixture();
    const state = await fixture.service.start(request);
    const index = fixture.threads.records.findIndex((thread) => thread.id === state.mapping.codex_thread_id);
    const current = fixture.threads.records[index];
    if (current === undefined) throw new Error("Expected fake managed thread.");
    fixture.threads.records[index] = { ...current, source: "other" };

    await expectServiceError(fixture.service.archive(state.mapping.id), "identity_mismatch");
    expect(fixture.threads.archive_calls).toHaveLength(0);
  });

  it("reports confirmed remote archive plus local persistence failure and repairs on reconciliation", async () => {
    const base = createFixture();
    await base.service.start(request);
    let failReplace = true;
    const failingStates: SelectedStateRepository = {
      ...base.states,
      replace(candidate, revision) {
        if (failReplace) throw new Error("injected replace failure");
        return base.states.replace(candidate, revision);
      }
    };
    const service = serviceFor(base.threads, failingStates);

    try {
      await service.archive("sess_managed_001");
    } catch (error) {
      expect(error).toBeInstanceOf(HostDeckManagedCodexThreadServiceError);
      expect(error).toMatchObject({ code: "recovery_required", outcome: "remote_succeeded", retry_safe: false });
    }
    expect(base.states.require("sess_managed_001").mapping.archived_at).toBeNull();

    failReplace = false;
    await service.reconcile();
    expect(base.states.require("sess_managed_001").mapping.archived_at).not.toBeNull();
  });

  it("marks a missing managed thread stale and ignores unmanaged Codex threads", async () => {
    const fixture = createFixture();
    await fixture.service.start(request);
    fixture.threads.records.length = 0;
    fixture.threads.records.push(threadRecord({ id: "thread-unmanaged", thread_source: null }));

    const result = await fixture.service.reconcile();
    expect(result).toMatchObject({
      reconciled_sessions: 0,
      stale_sessions: 1,
      ignored_unmanaged_threads: 1,
      issues: []
    });
    expect(fixture.states.require("sess_managed_001")).toMatchObject({
      mapping: { disposition: "recovery_required" },
      projection: {
        session: {
          session_state: "stale",
          turn_state: "unknown",
          freshness: "stale",
          attention: "unknown"
        }
      }
    });
  });

  it("reconciles exact structured active status without importing unrelated threads", async () => {
    const fixture = createFixture();
    await fixture.service.start(request);
    fixture.threads.records[0] = threadRecord({
      id: "thread-managed-1",
      thread_source: codexThreadOperationMarker(request.operation_id),
      status: "active",
      active_flags: ["waiting_on_approval"]
    });
    fixture.threads.records.push(threadRecord({ id: "thread-unmanaged" }));

    const result = await fixture.service.reconcile();
    expect(result).toMatchObject({ reconciled_sessions: 1, ignored_unmanaged_threads: 1 });
    expect(fixture.states.require("sess_managed_001").projection.session).toMatchObject({
      session_state: "active",
      turn_state: "waiting_for_approval",
      attention: "needs_approval",
      freshness: "current"
    });
    expect(fixture.states.list()).toHaveLength(1);
  });
});

interface Fixture {
  readonly states: SelectedStateRepository;
  readonly threads: FakeThreadClient;
  readonly service: ManagedCodexThreadService;
}

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-managed-thread-"));
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => now });
  cleanup.push(() => {
    open.db.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const states = createSelectedStateRepository(open.db);
  const threads = new FakeThreadClient();
  return { states, threads, service: serviceFor(threads, states) };
}

function serviceFor(threads: CodexThreadClient, states: SelectedStateRepository): ManagedCodexThreadService {
  return createManagedCodexThreadService({
    threads,
    states,
    now: () => now,
    create_session_id: () => "sess_managed_001" as SessionId,
    validate_cwd: async () => undefined,
    capture_branch: () => "main"
  });
}

class FakeThreadClient implements CodexThreadClient {
  readonly runtime_version = "0.144.0";
  readonly records: CodexThreadRecord[] = [];
  start_calls = 0;
  materialize_calls = 0;
  archive_calls: string[] = [];
  archive_gate: Promise<void> | null = null;
  start_error: HostDeckCodexAdapterError | null = null;
  materialize_error: HostDeckCodexAdapterError | null = null;

  async start(input: CodexThreadStartInput): Promise<CodexThreadStartResult> {
    this.start_calls += 1;
    if (this.start_error !== null) throw this.start_error;
    const thread = threadRecord({
      id: `thread-managed-${this.start_calls}`,
      cwd: input.cwd as string,
      thread_source: codexThreadOperationMarker(input.operation_id)
    });
    this.records.push(thread);
    return { thread, model: "gpt-5.5-codex" };
  }

  async ensureMaterialized(input: CodexThreadMaterializeInput): Promise<CodexThreadRecord> {
    this.materialize_calls += 1;
    if (this.materialize_error !== null) throw this.materialize_error;
    const index = this.records.findIndex((candidate) => candidate.id === input.thread_id);
    const thread = this.records[index];
    if (thread === undefined) throw new Error("Fake materialization thread is missing.");
    const materialized = { ...thread, name: input.name, thread_source: null, archived: false };
    this.records[index] = materialized;
    return materialized;
  }

  async list(input: CodexThreadListInput): Promise<CodexThreadPage> {
    return { data: this.records.filter((thread) => thread.archived === input.archived), next_cursor: null };
  }

  async listAll(): Promise<readonly CodexThreadRecord[]> {
    return [...this.records];
  }

  async findByOperationId(operationId: string): Promise<readonly CodexThreadRecord[]> {
    const marker = codexThreadOperationMarker(operationId);
    return this.records.filter((thread) => thread.thread_source === marker);
  }

  async read(threadId: string): Promise<CodexThreadRecord> {
    const thread = this.records.find((candidate) => candidate.id === threadId);
    if (thread === undefined) {
      throw new HostDeckCodexAdapterError("remote_error", "thread not found", {
        outcome: "remote_rejected",
        retry_safe: true,
        rpc_code: -32_004
      });
    }
    return thread;
  }

  async archive(threadId: string): Promise<void> {
    const index = this.records.findIndex((thread) => thread.id === threadId);
    const thread = this.records[index];
    if (thread === undefined) throw new Error("Fake thread is missing.");
    this.archive_calls.push(threadId);
    await this.archive_gate;
    this.records[index] = { ...thread, archived: true };
  }
}

function recoveryRecord() {
  return selectedSessionStartRecoveryRecordSchema.parse({
    operation_id: request.operation_id,
    session_id: "sess_managed_001",
    name: request.name,
    cwd: request.cwd,
    codex_thread_id: null,
    state: "reserved",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    error_code: null,
    error_message: null
  });
}

function threadRecord(overrides: Record<string, unknown> = {}): CodexThreadRecord {
  const candidate = {
    id: "thread-managed-1",
    cwd: "/tmp/project-a",
    created_at: "2026-07-09T20:00:00.000Z",
    updated_at: "2026-07-09T20:01:00.000Z",
    status: "idle",
    active_flags: [],
    source: "app_server",
    thread_source: null,
    model_provider: "openai",
    name: null,
    preview: "",
    archived: false,
    ...overrides
  };
  return {
    id: codexThreadIdSchema.parse(candidate.id),
    cwd: absoluteCwdSchema.parse(candidate.cwd),
    created_at: isoTimestampSchema.parse(candidate.created_at),
    updated_at: isoTimestampSchema.parse(candidate.updated_at),
    status: candidate.status as CodexThreadRecord["status"],
    active_flags: candidate.active_flags as CodexThreadRecord["active_flags"],
    source: candidate.source as CodexThreadRecord["source"],
    thread_source: candidate.thread_source as string | null,
    model_provider: candidate.model_provider as string,
    name: candidate.name as string | null,
    preview: candidate.preview as string,
    archived: candidate.archived as boolean | null
  };
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: ManagedCodexThreadServiceErrorCode,
  expected: Partial<HostDeckManagedCodexThreadServiceError> = {}
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckManagedCodexThreadServiceError);
    expect(error).toMatchObject({ code, ...expected });
    return;
  }
  throw new Error(`Expected HostDeckManagedCodexThreadServiceError ${code}.`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for managed-thread test state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
