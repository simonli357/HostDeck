import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexConnectionNotification,
  type CodexLoadedThreadClient,
  type CodexLoadedThreadSnapshot,
  HostDeckCodexLoadedThreadError
} from "@hostdeck/codex-adapter";
import {
  codexTurnIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type LoadedThreadCandidate,
  loadedThreadCandidateSchema,
  nativeCodexHistoryTurnSchema,
  type ResourceBudget,
  type SharedSessionEnrollment
} from "@hostdeck/contracts";
import {
  createProductionProjectionAppendPort,
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAutomaticSessionEnrollmentService
} from "./automatic-session-enrollment-service.js";
import { createCodexEventPipeline } from "./codex-event-pipeline.js";

const threadA = "019f489a-1f9d-7402-ae00-eac6ea322f64";
const threadB = "019f489a-1f9d-7402-ae00-eac6ea322f65";
const createdAt = "2026-08-14T14:00:00.000Z";
const updatedAt = "2026-08-14T15:00:00.000Z";
const enrolledAt = "2026-08-14T16:00:00.000Z";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("automatic shared-session enrollment", () => {
  it("reconciles every loaded root, imports bounded history, and leaves ineligible threads absent", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA, { source: "vscode" });
      const ineligible = candidate(threadB, {
        source: "exec",
        eligibility: { state: "ineligible", reason: "non_interactive_source" }
      });
      const loaded = fakeLoaded({
        ids: [threadA, threadB],
        candidates: new Map([[threadA, eligible], [threadB, ineligible]]),
        snapshot: snapshot(eligible, {
          truncated_before: true,
          turns: [{
            turn_id: "turn-history",
            status: "completed",
            started_at: "2026-08-14T14:30:00.000Z",
            completed_at: "2026-08-14T14:31:00.000Z",
            messages: [{ item_id: "item-history", role: "agent", text: "Retained answer." }]
          }]
        })
      });
      const service = createService(harness, loaded);

      const report = await service.reconcileLoaded("loaded_before", 1);

      expect(report).toMatchObject({
        origin: "loaded_before",
        endpoint_generation: 1,
        loaded_thread_count: 2,
        outcomes: [
          {
            state: "enrolled",
            subscribed: true,
            history: { turns_loaded: 1, events_loaded: 2, truncated_before: true, boundary_cursor: 1 },
            session: {
              native_thread_id: threadA,
              internal_session_id: "sess_019f489a1f9d7402ae00eac6ea322f64",
              alias: "side-cue-app-019f489a1f9d7402ae00eac6ea322f64"
            }
          },
          { state: "ineligible", candidate: { native_thread_id: threadB } }
        ]
      });
      expect(harness.repository.getByThreadId(threadB)).toBeNull();
      expect(harness.repository.getByThreadId(threadA)).toMatchObject({
        mapping: { runtime_version: "0.148.0", cwd: "/tmp/side-cue-app" },
        projection: { session: { model: "gpt-5.5-codex", turn_state: "completed" } }
      });
      expect(harness.repository.listEvents("sess_019f489a1f9d7402ae00eac6ea322f64").events).toMatchObject([
        { type: "replay_boundary", reason: "enrollment", cursor: 1 },
        { type: "message", cursor: 2, text: "Retained answer." },
        { type: "turn", cursor: 3, turn_id: "turn-history" }
      ]);
      expect(loaded.snapshotCalls).toEqual([threadA]);
      expect(harness.audit.require("op_session_enroll_test_0001")).toMatchObject({
        state: "terminal",
        records: [
          {
            action: "session_enroll",
            phase: "accepted",
            outcome: "accepted",
            payload_summary: { schema_version: 1, enrollment_origin: "loaded_before" }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: {
              schema_version: 1,
              enrolled: true,
              created: true,
              refreshed: false
            }
          }
        ]
      });
      expect(service.pending).toEqual([]);
      expect(service.background_failure).toBeNull();
      service.close();
    } finally {
      harness.close();
    }
  });

  it("enrolls an unmapped loaded thread in the background without blocking reconciliation or notifications", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const gate = deferred<CodexLoadedThreadSnapshot>();
      const outcomes: SharedSessionEnrollment[] = [];
      const loaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        snapshot: () => gate.promise
      });
      const service = createAutomaticSessionEnrollmentService({
        loaded,
        states: harness.repository,
        audit: harness.audit,
        events: harness.pipeline,
        now: () => new Date(enrolledAt),
        create_operation_id: harness.createOperationId,
        create_record_id: harness.createRecordId,
        capture_branch: () => "main",
        background_unmapped_enrollment: true,
        on_background_outcome: (outcome) => outcomes.push(outcome)
      });

      const reconciliation = service.reconcileLoaded("loaded_before", 1);
      await expect(reconciliation).resolves.toMatchObject({
        outcomes: [{ state: "pending", pending: { native_thread_id: threadA } }]
      });
      await expect(service.observeNotification(selected("thread/status/changed", {
        threadId: threadA,
        status: { type: "idle" }
      }), 1)).resolves.toMatchObject({
        kind: "enrollment",
        enrollment: { state: "pending" }
      });
      expect(loaded.snapshotCalls).toEqual([]);
      expect(service.startPendingBackgroundEnrollment()).toBe(1);
      await waitFor(() => loaded.snapshotCalls.length === 1);

      gate.resolve(snapshot(eligible));
      await waitFor(() => outcomes.length === 1);
      expect(outcomes).toMatchObject([{ state: "enrolled", session: { native_thread_id: threadA } }]);
      expect(harness.repository.getByThreadId(threadA)).not.toBeNull();
      expect(service.pending).toEqual([]);
      service.close();
    } finally {
      harness.close();
    }
  });

  it("grants subscription a fresh bounded phase after metadata materializes", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const gate = deferred<CodexLoadedThreadSnapshot>();
      let now = Date.parse(enrolledAt);
      const budget: ResourceBudget = {
        ...defaultResourceBudget,
        protocol_enrollment_pending_timeout_ms: 1_000
      };
      const loaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map(),
        readCandidate: () => {
          now += 900;
          return eligible;
        },
        snapshot: () => gate.promise
      });
      const service = createService(harness, loaded, budget, () => new Date(now));

      const enrollment = service.reconcileLoaded("loaded_before", 1);
      await waitFor(() => loaded.snapshotCalls.length === 1);
      expect(service.pending[0]?.deadline_at).toBe("2026-08-14T16:00:01.900Z");
      now += 600;
      gate.resolve(snapshot(eligible));

      await expect(enrollment).resolves.toMatchObject({
        outcomes: [{ state: "enrolled", session: { native_thread_id: threadA } }]
      });
      service.close();
    } finally {
      harness.close();
    }
  });

  it("leaves current mapped sessions to the production reconciliation lifecycle", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const initialLoaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        snapshot: snapshot(eligible)
      });
      const initialService = createService(harness, initialLoaded);
      await initialService.reconcileLoaded("loaded_before", 1);
      initialService.close();

      const restartLoaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        snapshot: snapshot(eligible)
      });
      const restartService = createAutomaticSessionEnrollmentService({
        loaded: restartLoaded,
        states: harness.repository,
        audit: harness.audit,
        events: harness.pipeline,
        now: () => new Date(enrolledAt),
        create_operation_id: harness.createOperationId,
        create_record_id: harness.createRecordId,
        capture_branch: () => "main",
        reconcile_mapped_sessions: false
      });

      await expect(restartService.reconcileLoaded("reconciliation", 2)).resolves.toMatchObject({
        loaded_thread_count: 1,
        outcomes: []
      });
      expect(restartLoaded.snapshotCalls).toEqual([]);
      restartService.close();
    } finally {
      harness.close();
    }
  });

  it("buffers notification-before-mapping and replays one active turn in receive order", async () => {
    const harness = storageHarness();
    try {
      const active = candidate(threadA, {
        status: "active",
        active_flags: []
      });
      const gate = deferred<CodexLoadedThreadSnapshot>();
      const loaded = fakeLoaded({ ids: [], candidates: new Map(), snapshot: () => gate.promise, startedCandidate: active });
      const service = createService(harness, loaded);

      const enrollment = service.observeNotification(startedNotification(threadA), 7);
      await waitFor(() => loaded.snapshotCalls.length === 1);
      const turn = service.observeNotification(selected("turn/started", {
        threadId: threadA,
        turn: rawTurn("turn-live", "inProgress")
      }), 7);
      gate.resolve(snapshot(active, {
        active_turn_id: "turn-live",
        active_turn_started_at: "2026-08-14T15:30:00.000Z"
      }));

      await expect(enrollment).resolves.toMatchObject({ kind: "enrollment", enrollment: { state: "enrolled" } });
      await expect(turn).resolves.toMatchObject({ kind: "enrollment", enrollment: { state: "enrolled" } });
      expect(loaded.snapshotCalls).toEqual([threadA]);
      expect(harness.pipeline.last_sequence).toBe(1);
      expect(harness.repository.listEvents("sess_019f489a1f9d7402ae00eac6ea322f64").events).toMatchObject([
        { type: "replay_boundary", cursor: 1 },
        { type: "turn", cursor: 2, turn_id: "turn-live", state: "in_progress" }
      ]);
      expect(harness.repository.getByThreadId(threadA)?.projection.session).toMatchObject({
        turn_state: "in_progress",
        attention: "watch"
      });
      service.close();
    } finally {
      harness.close();
    }
  });

  it("refreshes an exact recovery-required mapping when its native thread starts on the shared broker", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA, { source: "vscode" });
      const initialLoaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        snapshot: snapshot(eligible)
      });
      const initialService = createService(harness, initialLoaded);
      await initialService.reconcileLoaded("loaded_before", 1);
      initialService.close();

      harness.db
        .prepare(
          "UPDATE selected_sessions SET runtime_version = '0.144.0', disposition = 'recovery_required', updated_at = ? WHERE codex_thread_id = ?"
        )
        .run("2026-08-14T16:05:00.000Z", threadA);
      harness.db
        .prepare(
          `
            UPDATE selected_session_projections SET
              session_state = 'unknown', turn_state = 'unknown', attention = 'unknown',
              freshness = 'stale', freshness_reason = 'Managed Codex runtime version changed.',
              updated_at = ?, model = NULL, settings_json = NULL,
              recent_summary = 'Managed Codex runtime version changed.'
            WHERE session_id = ?
          `
        )
        .run("2026-08-14T16:05:00.000Z", "sess_019f489a1f9d7402ae00eac6ea322f64");

      const refreshedPipeline = createCodexEventPipeline({
        repository: harness.repository,
        append_port: createProductionProjectionAppendPort({
          repository: harness.repository,
          publish() {}
        }),
        normalizer: { now: advancingClock("2026-08-14T16:10:00.000Z") }
      });
      const refreshedLoaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        startedCandidate: eligible,
        snapshot: snapshot(eligible, {
          turns: [
            {
              turn_id: "turn-after-upgrade",
              status: "completed",
              started_at: "2026-08-14T15:20:00.000Z",
              completed_at: "2026-08-14T15:21:00.000Z",
              messages: []
            }
          ]
        })
      });
      const refreshedService = createAutomaticSessionEnrollmentService({
        loaded: refreshedLoaded,
        states: harness.repository,
        audit: harness.audit,
        events: refreshedPipeline,
        now: () => new Date("2026-08-14T16:10:00.000Z"),
        create_operation_id: harness.createOperationId,
        create_record_id: harness.createRecordId,
        capture_branch: () => "main"
      });

      await expect(
        refreshedService.observeNotification(startedNotification(threadA), 2)
      ).resolves.toMatchObject({
        kind: "enrollment",
        enrollment: {
          state: "enrolled",
          history: { events_loaded: 1, turns_loaded: 1 },
          session: {
            native_thread_id: threadA,
            internal_session_id: "sess_019f489a1f9d7402ae00eac6ea322f64",
            runtime_version: "0.148.0"
          }
        }
      });
      expect(harness.repository.getByThreadId(threadA)).toMatchObject({
        mapping: { disposition: "selected", runtime_version: "0.148.0" },
        projection: { session: { freshness: "current", session_state: "active" } }
      });
      expect(
        harness.repository.listEvents("sess_019f489a1f9d7402ae00eac6ea322f64").events
      ).toMatchObject([
        { after: 1, cursor: 2, reason: "enrollment", type: "replay_boundary" },
        { cursor: 3, turn_id: "turn-after-upgrade", type: "turn" }
      ]);
      expect(harness.audit.require("op_session_enroll_test_0002")).toMatchObject({
        records: [
          { outcome: "accepted" },
          {
            outcome: "succeeded",
            payload_summary: { created: false, refreshed: true }
          }
        ],
        state: "terminal"
      });
      refreshedService.close();
    } finally {
      harness.close();
    }
  });

  it("keeps an unmaterialized root pending, then enrolls it idempotently on retry", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      let attempts = 0;
      const loaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        snapshot: () => {
          attempts += 1;
          if (attempts === 1) {
            throw new HostDeckCodexLoadedThreadError(
              "pending_materialization",
              "Loaded Codex thread has not materialized durable history yet.",
              true
            );
          }
          return snapshot(eligible);
        }
      });
      const service = createService(harness, loaded);

      const first = await service.reconcileLoaded("loaded_before", 1);
      expect(first.outcomes).toMatchObject([{ state: "pending", pending: { phase: "pending_materialization", attempt_count: 1 } }]);
      expect(service.pending).toHaveLength(1);
      await expect(service.retryPending(threadA)).resolves.toMatchObject({ state: "enrolled", subscribed: true });
      expect(attempts).toBe(2);
      expect(service.pending).toEqual([]);
      expect(harness.repository.listSharedMemberships()).toHaveLength(1);

      const restarted = await service.reconcileLoaded("reconciliation", 2);
      expect(restarted.outcomes).toMatchObject([{ state: "enrolled", session: { native_thread_id: threadA } }]);
      expect(harness.repository.listSharedMemberships()).toHaveLength(1);
      expect(harness.repository.list()).toHaveLength(1);
      service.close();
    } finally {
      harness.close();
    }
  });

  it("fails bounded overflow before storage commit even when subscription is already in flight", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const gate = deferred<CodexLoadedThreadSnapshot>();
      const loaded = fakeLoaded({ ids: [], candidates: new Map(), snapshot: () => gate.promise, startedCandidate: eligible });
      const budget: ResourceBudget = {
        ...defaultResourceBudget,
        protocol_enrollment_pending_events_per_thread: 1
      };
      const service = createService(harness, loaded, budget);

      const first = service.observeNotification(startedNotification(threadA), 3);
      await waitFor(() => loaded.snapshotCalls.length === 1);
      const overflow = await service.observeNotification(selected("thread/status/changed", {
        threadId: threadA,
        status: { type: "idle" }
      }), 3);
      expect(overflow).toMatchObject({
        kind: "enrollment",
        enrollment: { state: "failed", failure: "pending_overflow", boundary_required: true }
      });
      gate.resolve(snapshot(eligible));
      await expect(first).resolves.toEqual(overflow);
      expect(harness.repository.getByThreadId(threadA)).toBeNull();
      expect(harness.audit.require("op_session_enroll_test_0001")).toMatchObject({
        state: "terminal",
        records: [{ outcome: "accepted" }, { outcome: "failed", error_code: "service_overloaded" }]
      });
      expect(service.pending).toEqual([]);
      service.close();
    } finally {
      harness.close();
    }
  });

  it("makes a connection-generation change terminal instead of replaying cross-runtime events", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const gate = deferred<CodexLoadedThreadSnapshot>();
      const loaded = fakeLoaded({ ids: [], candidates: new Map(), snapshot: () => gate.promise, startedCandidate: eligible });
      const service = createService(harness, loaded);

      const first = service.observeNotification(startedNotification(threadA), 4);
      await waitFor(() => loaded.snapshotCalls.length === 1);
      const crossed = await service.observeNotification(selected("thread/status/changed", {
        threadId: threadA,
        status: { type: "idle" }
      }), 5);
      expect(crossed).toMatchObject({
        enrollment: { state: "failed", failure: "runtime_boundary", boundary_required: true }
      });
      gate.resolve(snapshot(eligible));
      await expect(first).resolves.toEqual(crossed);
      expect(harness.repository.getByThreadId(threadA)).toBeNull();
      service.close();
    } finally {
      harness.close();
    }
  });

  it("cannot commit a mapping after an in-flight metadata subscription crosses its deadline", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const gate = deferred<CodexLoadedThreadSnapshot>();
      const loaded = fakeLoaded({
        ids: [],
        candidates: new Map([[threadA, eligible]]),
        snapshot: () => gate.promise,
        startedCandidate: eligible
      });
      let now = Date.parse(enrolledAt);
      const budget: ResourceBudget = {
        ...defaultResourceBudget,
        protocol_enrollment_pending_timeout_ms: 1_000
      };
      const service = createService(harness, loaded, budget, () => new Date(now));

      const enrollment = service.observeNotification(startedNotification(threadA), 6);
      await waitFor(() => loaded.snapshotCalls.length === 1);
      now += 1_000;
      gate.resolve(snapshot(eligible, {
        turns: [{
          turn_id: "turn-after-timeout",
          status: "completed",
          started_at: "2026-08-14T15:30:00.000Z",
          completed_at: "2026-08-14T15:31:00.000Z",
          messages: []
        }]
      }));

      await expect(enrollment).resolves.toMatchObject({
        kind: "enrollment",
        enrollment: { state: "failed", failure: "pending_timeout", boundary_required: true }
      });
      expect(harness.repository.getByThreadId(threadA)).toBeNull();
      expect(harness.audit.require("op_session_enroll_test_0001")).toMatchObject({
        records: [{ outcome: "accepted" }, { outcome: "failed", error_code: "operation_timeout" }]
      });

      await expect(service.observeNotification(selected("turn/completed", {
        threadId: threadA,
        turn: rawTurn("turn-after-timeout", "completed")
      }), 6)).resolves.toMatchObject({
        kind: "enrollment",
        enrollment: { state: "enrolled", session: { native_thread_id: threadA } }
      });
      expect(harness.repository.getByThreadId(threadA)).not.toBeNull();
      expect(harness.audit.require("op_session_enroll_test_0002")).toMatchObject({
        records: [{ outcome: "accepted" }, { outcome: "succeeded" }]
      });
      service.close();
    } finally {
      harness.close();
    }
  });

  it("keeps a post-commit replay failure terminal instead of projecting later activity", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA, { status: "active" });
      const gate = deferred<CodexLoadedThreadSnapshot>();
      const loaded = fakeLoaded({ ids: [], candidates: new Map(), snapshot: () => gate.promise, startedCandidate: eligible });
      let consumeCalls = 0;
      const service = createAutomaticSessionEnrollmentService({
        loaded,
        states: harness.repository,
        audit: harness.audit,
        events: {
          transitionMembership: harness.pipeline.transitionMembership,
          reconcile: harness.pipeline.reconcile,
          async consume() {
            consumeCalls += 1;
            throw new Error("Injected replay failure.");
          }
        },
        now: () => new Date(enrolledAt),
        create_operation_id: harness.createOperationId,
        create_record_id: harness.createRecordId,
        capture_branch: () => "main"
      });

      const enrollment = service.observeNotification(startedNotification(threadA), 10);
      await waitFor(() => loaded.snapshotCalls.length === 1);
      const buffered = service.observeNotification(selected("turn/started", {
        threadId: threadA,
        turn: rawTurn("turn-replay-fails", "inProgress")
      }), 10);
      gate.resolve(snapshot(eligible, {
        active_turn_id: "turn-replay-fails",
        active_turn_started_at: "2026-08-14T15:30:00.000Z"
      }));

      const expected = {
        kind: "enrollment",
        enrollment: { state: "failed", failure: "runtime_boundary", boundary_required: true }
      } as const;
      await expect(enrollment).resolves.toMatchObject(expected);
      await expect(buffered).resolves.toMatchObject(expected);
      expect(harness.repository.getByThreadId(threadA)).not.toBeNull();
      expect(consumeCalls).toBe(1);

      await expect(service.observeNotification(selected("thread/status/changed", {
        threadId: threadA,
        status: { type: "idle" }
      }), 10)).resolves.toMatchObject(expected);
      expect(consumeCalls).toBe(1);
      expect(harness.audit.require("op_session_enroll_test_0001")).toMatchObject({
        records: [{ outcome: "accepted" }, { outcome: "failed", error_code: "runtime_unavailable" }]
      });
      service.close();
    } finally {
      harness.close();
    }
  });

  it("fails the service loudly when a committed enrollment cannot close its audit trail", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const loaded = fakeLoaded({
        ids: [threadA],
        candidates: new Map([[threadA, eligible]]),
        snapshot: snapshot(eligible)
      });
      const service = createAutomaticSessionEnrollmentService({
        loaded,
        states: harness.repository,
        audit: {
          get: harness.audit.get,
          require: harness.audit.require,
          recordAccepted: harness.audit.recordAccepted,
          recordRejected: harness.audit.recordRejected,
          recordTerminal() {
            throw new Error("Injected terminal audit failure.");
          }
        },
        events: harness.pipeline,
        now: () => new Date(enrolledAt),
        create_operation_id: harness.createOperationId,
        create_record_id: harness.createRecordId,
        capture_branch: () => "main"
      });

      await expect(service.reconcileLoaded("loaded_before", 11)).resolves.toMatchObject({
        outcomes: [{ state: "failed", failure: "storage_failure", boundary_required: true }]
      });
      expect(harness.repository.getByThreadId(threadA)).not.toBeNull();
      expect(harness.audit.require("op_session_enroll_test_0001")).toMatchObject({ state: "pending" });
      expect(service.background_failure).toEqual(expect.any(Error));
      await expect(service.observeNotification(selected("thread/status/changed", {
        threadId: threadA,
        status: { type: "idle" }
      }), 11)).rejects.toThrow("unresolved background failure");
      service.close();
    } finally {
      harness.close();
    }
  });

  it("converges concurrent clients and suppresses live events already covered by imported history", async () => {
    const harness = storageHarness();
    try {
      const eligible = candidate(threadA);
      const imported = snapshot(eligible, {
        turns: [{
          turn_id: "turn-terminal",
          status: "completed",
          started_at: "2026-08-14T15:20:00.000Z",
          completed_at: "2026-08-14T15:21:00.000Z",
          messages: []
        }]
      });
      const gateA = deferred<CodexLoadedThreadSnapshot>();
      const loadedA = fakeLoaded({ ids: [], candidates: new Map(), snapshot: () => gateA.promise, startedCandidate: eligible });
      const serviceA = createService(harness, loadedA);
      const enrollmentA = serviceA.observeNotification(startedNotification(threadA), 8);
      await waitFor(() => loadedA.snapshotCalls.length === 1);
      const duplicateCompletion = serviceA.observeNotification(selected("turn/completed", {
        threadId: threadA,
        turn: rawTurn("turn-terminal", "completed")
      }), 8);
      gateA.resolve(imported);
      await enrollmentA;
      await duplicateCompletion;

      const secondHarnessPipeline = createCodexEventPipeline({
        repository: harness.repository,
        append_port: createProductionProjectionAppendPort({ repository: harness.repository, publish() {} }),
        normalizer: { now: advancingClock("2026-08-14T16:10:00.000Z") }
      });
      const loadedB = fakeLoaded({ ids: [threadA], candidates: new Map([[threadA, eligible]]), snapshot: imported });
      const serviceB = createAutomaticSessionEnrollmentService({
        loaded: loadedB,
        states: harness.repository,
        audit: harness.audit,
        events: secondHarnessPipeline,
        now: () => new Date("2026-08-14T16:10:00.000Z"),
        create_operation_id: harness.createOperationId,
        create_record_id: harness.createRecordId,
        capture_branch: () => "main"
      });
      await expect(serviceB.reconcileLoaded("reconciliation", 9)).resolves.toMatchObject({
        outcomes: [{ state: "enrolled", session: { native_thread_id: threadA } }]
      });

      expect(harness.repository.list()).toHaveLength(1);
      expect(harness.repository.listSharedMemberships()).toHaveLength(1);
      expect(harness.repository.listEvents("sess_019f489a1f9d7402ae00eac6ea322f64").events).toMatchObject([
        { type: "replay_boundary", cursor: 1 },
        { type: "turn", cursor: 2, turn_id: "turn-terminal" }
      ]);
      expect(harness.pipeline.last_sequence).toBe(0);
      serviceA.close();
      serviceB.close();
    } finally {
      harness.close();
    }
  });
});

function storageHarness() {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-auto-enrollment-"));
  tempDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => new Date(enrolledAt)
  });
  const repository = createSelectedStateRepository(open.db);
  const audit = createSelectedAuditRepository(open.db);
  const pipeline = createCodexEventPipeline({
    repository,
    append_port: createProductionProjectionAppendPort({ repository, publish() {} }),
    normalizer: { now: advancingClock("2026-08-14T16:00:00.000Z") }
  });
  let operationOrdinal = 0;
  let recordOrdinal = 0;
  return {
    db: open.db,
    repository,
    audit,
    pipeline,
    createOperationId() {
      operationOrdinal += 1;
      return `op_session_enroll_test_${String(operationOrdinal).padStart(4, "0")}`;
    },
    createRecordId() {
      recordOrdinal += 1;
      return `audit_session_enroll_test_${String(recordOrdinal).padStart(4, "0")}`;
    },
    close() {
      open.db.close();
    }
  };
}

function createService(
  harness: ReturnType<typeof storageHarness>,
  loaded: FakeLoadedClient,
  budget = defaultResourceBudget,
  now: () => Date = () => new Date(enrolledAt)
) {
  return createAutomaticSessionEnrollmentService({
    loaded,
    states: harness.repository,
    audit: harness.audit,
    events: harness.pipeline,
    resource_budget: budget,
    now,
    create_operation_id: harness.createOperationId,
    create_record_id: harness.createRecordId,
    capture_branch: () => "main"
  });
}

interface FakeLoadedClient extends CodexLoadedThreadClient {
  readonly snapshotCalls: string[];
}

function fakeLoaded(options: {
  readonly ids: readonly string[];
  readonly candidates: ReadonlyMap<string, LoadedThreadCandidate>;
  readonly readCandidate?: () => LoadedThreadCandidate | Promise<LoadedThreadCandidate>;
  readonly snapshot: CodexLoadedThreadSnapshot | (() => CodexLoadedThreadSnapshot | Promise<CodexLoadedThreadSnapshot>);
  readonly startedCandidate?: LoadedThreadCandidate;
}): FakeLoadedClient {
  const snapshotCalls: string[] = [];
  return {
    runtime_version: "0.148.0",
    snapshotCalls,
    async listLoadedThreadIds() {
      return options.ids as never;
    },
    async readCandidate(threadId) {
      if (options.readCandidate !== undefined) return options.readCandidate();
      const value = options.candidates.get(String(threadId));
      if (value === undefined) throw new Error("Missing fake candidate.");
      return value;
    },
    candidateFromStartedNotification() {
      if (options.startedCandidate === undefined) throw new Error("Missing fake started candidate.");
      return options.startedCandidate;
    },
    async subscribeAndReadSnapshot(value) {
      snapshotCalls.push(String(value.native_thread_id));
      return typeof options.snapshot === "function" ? options.snapshot() : options.snapshot;
    }
  };
}

function candidate(
  nativeThreadId: string,
  overrides: Partial<LoadedThreadCandidate> = {}
): LoadedThreadCandidate {
  return loadedThreadCandidateSchema.parse({
    native_thread_id: nativeThreadId,
    root_thread_id: nativeThreadId,
    parent_thread_id: null,
    forked_from_id: null,
    name: "Side Cue",
    project_cue: "side-cue-app",
    cwd: "/tmp/side-cue-app",
    source: "cli",
    ephemeral: false,
    archived: false,
    runtime_version: "0.148.0",
    created_at: createdAt,
    updated_at: updatedAt,
    status: "idle",
    active_flags: [],
    eligibility: { state: "eligible", reason: null },
    ...overrides
  });
}

function snapshot(
  value: LoadedThreadCandidate,
  overrides: {
    readonly turns?: readonly unknown[];
    readonly active_turn_id?: string | null;
    readonly active_turn_started_at?: string | null;
    readonly truncated_before?: boolean;
    readonly runtime_model?: string;
    readonly reasoning_effort?: string | null;
  } = {}
): CodexLoadedThreadSnapshot {
  return {
    candidate: value,
    turns: (overrides.turns ?? []).map((turn) => nativeCodexHistoryTurnSchema.parse(turn)),
    active_turn_id: overrides.active_turn_id === undefined || overrides.active_turn_id === null
      ? null
      : codexTurnIdSchema.parse(overrides.active_turn_id),
    active_turn_started_at:
      overrides.active_turn_started_at === undefined || overrides.active_turn_started_at === null
        ? null
        : isoTimestampSchema.parse(overrides.active_turn_started_at),
    truncated_before: overrides.truncated_before ?? false,
    runtime_model: overrides.runtime_model ?? "gpt-5.5-codex",
    reasoning_effort: overrides.reasoning_effort === undefined ? "high" : overrides.reasoning_effort
  };
}

function startedNotification(threadId: string): CodexConnectionNotification {
  return selected("thread/started", { thread: { id: threadId } });
}

function selected(method: string, params: unknown): CodexConnectionNotification {
  return { kind: "notification", classification: "selected", method, params } as CodexConnectionNotification;
}

function rawTurn(id: string, status: "completed" | "inProgress") {
  return {
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: Date.parse("2026-08-14T15:30:00.000Z") / 1_000,
    completedAt: status === "completed" ? Date.parse("2026-08-14T15:31:00.000Z") / 1_000 : null,
    durationMs: status === "completed" ? 60_000 : null
  };
}

function advancingClock(start: string): () => string {
  let milliseconds = Date.parse(start);
  return () => new Date(milliseconds++).toISOString();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition.");
}
