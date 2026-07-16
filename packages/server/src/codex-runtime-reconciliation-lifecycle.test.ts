import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessCodexCompatibility,
  type CodexEventNormalizerReconciliation,
  type CodexReconnectResubscribeRequestInput,
  HostDeckCodexAdapterError
} from "@hostdeck/codex-adapter";
import { type RuntimeCompatibility, resolveResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline, type OperationDeadline } from "@hostdeck/core";
import {
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  createSelectedStateRepository,
  openMigratedDatabase,
  type SelectedStateRepository,
  type StartupAuditOrphanReconciliationResult,
  selectedStateRevision
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexRuntimeReconciliationLifecycle,
  type CodexRuntimeReconciliationLifecycleOptions,
  createCodexRuntimeReconciliationLifecycle
} from "./codex-runtime-reconciliation-lifecycle.js";

const tempDirs: string[] = [];
const createdAt = "2026-07-16T12:00:00.000Z";
const checkedAt = "2026-07-16T12:30:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Codex runtime crash reconciliation lifecycle", () => {
  it("reconciles an initial restart across active, interrupted, missing, archived, and unmanaged threads", async () => {
    const harness = createHarness();
    try {
      harness.repository.create(stateCandidate("sess_reconcile_a", "thread-reconcile-a", {
        turn_state: "waiting_for_approval",
        attention: "needs_approval",
        settings: settings("plan", "runtime-a", "high"),
        model: "runtime-a"
      }));
      harness.repository.create(stateCandidate("sess_reconcile_b", "thread-reconcile-b", {
        turn_state: "in_progress",
        attention: "watch",
        settings: settings("default", "runtime-b", "high"),
        model: "runtime-b"
      }));
      harness.repository.create(stateCandidate("sess_reconcile_missing", "thread-reconcile-missing", {
        settings: settings("plan", "runtime-missing", "medium"),
        model: "runtime-missing"
      }));
      harness.repository.create(stateCandidate("sess_reconcile_archived", "thread-reconcile-archived", {
        archived_at: "2026-07-16T12:10:00.000Z"
      }));

      const runtime = scriptedRuntime([
        runtimeThread("thread-reconcile-a", "/tmp/sess_reconcile_a", {
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
          latest: rawTurn("turn-reconcile-a", "inProgress"),
          goal: rawGoal("thread-reconcile-a", "Continue approved work.", "active"),
          resume_model: "runtime-a",
          resume_effort: "high"
        }),
        runtimeThread("thread-reconcile-b", "/tmp/sess_reconcile_b", {
          status: { type: "idle" },
          latest: null,
          resume_model: "runtime-b",
          resume_effort: "low"
        }),
        runtimeThread("thread-reconcile-archived", "/tmp/sess_reconcile_archived", {
          list: "archived",
          status: { type: "idle" },
          latest: rawTurn("turn-reconcile-archived", "completed")
        }),
        runtimeThread("thread-unmanaged", "/tmp/unmanaged", {
          source: "cli",
          status: { type: "idle" }
        })
      ], 7);
      const deadline = testDeadline();
      try {
        const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 7, null);
        expect(reconciliation).toEqual({ continuity: "boundary_required" });
        await resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 7, null);
        await ready(harness.lifecycle, runtime, deadline, reconciliation, 7, null);
      } finally {
        deadline.dispose();
      }

      expect(runtime.requests.filter((request) => request.method === "thread/resume").map(threadIdFromRequest)).toEqual([
        "thread-reconcile-a",
        "thread-reconcile-b"
      ]);
      expect(harness.repository.require("sess_reconcile_a").projection.session).toMatchObject({
        session_state: "active",
        turn_state: "waiting_for_approval",
        attention: "needs_approval",
        freshness: "current",
        freshness_reason: null,
        model: "runtime-a",
        settings: {
          collaboration_mode: "plan",
          runtime_model: "runtime-a",
          reasoning_effort: "high"
        },
        goal: { objective: "Continue approved work.", state: "active" }
      });
      expect(harness.repository.require("sess_reconcile_b").projection.session).toMatchObject({
        turn_state: "interrupted",
        attention: "stuck",
        freshness: "current",
        model: "runtime-b",
        settings: null
      });
      expect(harness.repository.require("sess_reconcile_missing")).toMatchObject({
        mapping: { disposition: "recovery_required", archived_at: null },
        projection: {
          session: {
            session_state: "unknown",
            turn_state: "unknown",
            freshness: "stale",
            model: null,
            settings: null
          }
        }
      });
      expect(harness.repository.require("sess_reconcile_archived")).toMatchObject({
        mapping: { archived_at: "2026-07-16T12:10:00.000Z" },
        projection: { session: { session_state: "archived", freshness: "current" } }
      });

      expect(streamShape(harness.repository, "sess_reconcile_a")).toEqual([
        { type: "replay_boundary", cursor: 2, after: 1, reason: "restart" },
        { type: "runtime", cursor: 3, state: "ready" }
      ]);
      expect(streamShape(harness.repository, "sess_reconcile_b")).toEqual([
        { type: "replay_boundary", cursor: 2, after: 1, reason: "restart" },
        { type: "runtime", cursor: 3, state: "ready" }
      ]);
      expect(streamShape(harness.repository, "sess_reconcile_missing")).toEqual([
        { type: "replay_boundary", cursor: 2, after: 1, reason: "restart" }
      ]);
      expect(harness.repository.listEvents("sess_reconcile_archived").events).toEqual([]);

      expect(harness.lifecycle.snapshot()).toEqual({
        phase: "ready",
        generation: 7,
        continuity: "boundary_required",
        gap_reason: "restart",
        cycle_count: 1,
        durable_session_count: 4,
        recoverable_session_count: 2,
        unmanaged_runtime_count: 1,
        boundary_count: 3,
        resumed_count: 2,
        ready_count: 2,
        approvals_superseded: 0,
        audits_reconciled: 2,
        issues: { archived: 0, contradictions: 0, missing: 1, stale: 1, unavailable: 0 },
        last_failure: null
      });
      const snapshotJson = JSON.stringify(harness.lifecycle.snapshot());
      for (const privateValue of ["sess_reconcile", "thread-reconcile", "/tmp/", "runtime-a", "approved work"]) {
        expect(snapshotJson).not.toContain(privateValue);
      }
      expect(harness.order[0]).toBe("audit");
      expect(harness.reconciliations).toEqual([{
        generation: 7,
        threads: [
          { thread_id: "thread-reconcile-a", active_turn_id: "turn-reconcile-a" },
          { thread_id: "thread-reconcile-b", active_turn_id: null }
        ]
      }]);
      expect(harness.order.indexOf("barrier:7")).toBeGreaterThan(harness.order.lastIndexOf("boundary"));
      expect(harness.order.filter((entry) => entry === "plan")).toHaveLength(2);
    } finally {
      harness.close();
    }
  });

  it("keeps coarse and skewed runtime activity inside monotonic durable chronology", async () => {
    const harness = createHarness();
    const coarseCreatedAt = "2026-07-16T12:40:00.335Z";
    const existingActivityAt = "2026-07-16T12:40:00.750Z";
    const futureActivityAt = "2026-07-16T14:00:00.000Z";
    try {
      harness.repository.create(stateCandidate("sess_coarse_activity", "thread-coarse-activity", {
        created_at: coarseCreatedAt,
        updated_at: coarseCreatedAt
      }));
      harness.repository.create(stateCandidate("sess_existing_activity", "thread-existing-activity", {
        created_at: coarseCreatedAt,
        updated_at: existingActivityAt,
        last_activity_at: existingActivityAt
      }));
      harness.repository.create(stateCandidate("sess_future_activity", "thread-future-activity"));

      const coarseTurn = {
        ...rawTurn("turn-coarse-activity", "inProgress"),
        startedAt: unixSeconds("2026-07-16T12:40:00.000Z")
      };
      const runtime = scriptedRuntime([
        runtimeThread("thread-coarse-activity", "/tmp/sess_coarse_activity", {
          status: { type: "active", activeFlags: [] },
          latest: coarseTurn
        }),
        runtimeThread("thread-existing-activity", "/tmp/sess_existing_activity", {
          status: { type: "active", activeFlags: [] },
          latest: { ...coarseTurn, id: "turn-existing-activity" }
        }),
        runtimeThread("thread-future-activity", "/tmp/sess_future_activity", {
          status: { type: "active", activeFlags: [] },
          latest: {
            ...rawTurn("turn-future-activity", "inProgress"),
            startedAt: unixSeconds(futureActivityAt)
          }
        })
      ], 17);
      const deadline = testDeadline();
      try {
        const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 17, null);
        await resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 17, null);
        await ready(harness.lifecycle, runtime, deadline, reconciliation, 17, null);
      } finally {
        deadline.dispose();
      }

      expect(harness.repository.require("sess_coarse_activity").projection.session.last_activity_at).toBe(
        coarseCreatedAt
      );
      expect(harness.repository.require("sess_existing_activity").projection.session.last_activity_at).toBe(
        existingActivityAt
      );
      const future = harness.repository.require("sess_future_activity").projection.session;
      expect(future.last_activity_at).toBe(futureActivityAt);
      expect(future.updated_at > futureActivityAt).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("supersedes approvals and persists disconnected truth before read-only reconnect inspection", async () => {
    const harness = createHarness({ approvalsSuperseded: 2 });
    try {
      harness.repository.create(stateCandidate("sess_disconnect_a", "thread-disconnect-a", {
        turn_state: "waiting_for_approval",
        attention: "needs_approval",
        settings: settings("plan", "runtime-a", "high"),
        model: "runtime-a"
      }));
      const deadline = testDeadline();
      const runtime = scriptedRuntime([
        runtimeThread("thread-disconnect-a", "/tmp/sess_disconnect_a", {
          status: { type: "idle" },
          latest: null,
          resume_model: "runtime-a",
          resume_effort: "high"
        })
      ], 8);
      try {
        await harness.lifecycle.disconnected({
          generation: 7,
          previous_admitted_generation: 7,
          deadline
        });
        expect(harness.repository.require("sess_disconnect_a").projection.session).toMatchObject({
          turn_state: "waiting_for_approval",
          attention: "needs_approval",
          freshness: "disconnected"
        });
        expect(harness.order.slice(0, 3)).toEqual(["approval:7", "audit", "projection:runtime:disconnected"]);

        const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 8, 7);
        await resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 8, 7);
        await ready(harness.lifecycle, runtime, deadline, reconciliation, 8, 7);
      } finally {
        deadline.dispose();
      }

      expect(harness.repository.require("sess_disconnect_a").projection.session).toMatchObject({
        turn_state: "interrupted",
        attention: "stuck",
        freshness: "current",
        settings: settings("plan", "runtime-a", "high")
      });
      expect(streamShape(harness.repository, "sess_disconnect_a")).toEqual([
        { type: "replay_boundary", cursor: 2, after: 1, reason: "disconnect" },
        { type: "runtime", cursor: 3, state: "ready" }
      ]);
      expect(harness.lifecycle.snapshot()).toMatchObject({
        phase: "ready",
        generation: 8,
        gap_reason: "disconnect",
        approvals_superseded: 2,
        recoverable_session_count: 1,
        resumed_count: 1,
        ready_count: 1
      });
    } finally {
      harness.close();
    }
  });

  it("persists every recoverable active and idle turn category before exact resubscription", async () => {
    const harness = createHarness();
    const cases = [
      {
        id: "active",
        status: { type: "active", activeFlags: [] },
        latest: rawTurn("turn-recoverable-active", "inProgress"),
        expected: { turn_state: "in_progress", attention: "watch" }
      },
      {
        id: "waiting_input",
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        latest: rawTurn("turn-recoverable-waiting-input", "inProgress"),
        expected: { turn_state: "waiting_for_input", attention: "needs_input" }
      },
      {
        id: "idle",
        status: { type: "idle" },
        latest: null,
        expected: { turn_state: "idle", attention: "none" }
      },
      {
        id: "completed",
        status: { type: "idle" },
        latest: rawTurn("turn-recoverable-completed", "completed"),
        expected: { turn_state: "completed", attention: "none" }
      },
      {
        id: "interrupted",
        status: { type: "idle" },
        latest: rawTurn("turn-recoverable-interrupted", "interrupted"),
        expected: { turn_state: "interrupted", attention: "stuck" }
      },
      {
        id: "failed",
        status: { type: "idle" },
        latest: rawTurn("turn-recoverable-failed", "failed"),
        expected: { turn_state: "failed", attention: "failed" }
      }
    ] as const;
    try {
      for (const testCase of cases) {
        harness.repository.create(
          stateCandidate(`sess_recoverable_${testCase.id}`, `thread-recoverable-${testCase.id}`)
        );
      }
      const runtime = scriptedRuntime(
        cases.map((testCase) =>
          runtimeThread(
            `thread-recoverable-${testCase.id}`,
            `/tmp/sess_recoverable_${testCase.id}`,
            { status: testCase.status, latest: testCase.latest }
          )
        ),
        12
      );
      const deadline = testDeadline();
      try {
        const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 12, null);
        await resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 12, null);
        await ready(harness.lifecycle, runtime, deadline, reconciliation, 12, null);
      } finally {
        deadline.dispose();
      }

      expect(
        runtime.requests
          .filter((request) => request.method === "thread/resume")
          .map(threadIdFromRequest)
          .sort()
      ).toEqual(cases.map((testCase) => `thread-recoverable-${testCase.id}`).sort());
      for (const testCase of cases) {
        const sessionId = `sess_recoverable_${testCase.id}`;
        expect(harness.repository.require(sessionId).projection.session).toMatchObject({
          ...testCase.expected,
          session_state: "active",
          freshness: "current",
          model: "runtime-default"
        });
        expect(streamShape(harness.repository, sessionId)).toEqual([
          { type: "replay_boundary", cursor: 2, after: 1, reason: "restart" },
          { type: "runtime", cursor: 3, state: "ready" }
        ]);
      }
      expect(harness.lifecycle.snapshot()).toMatchObject({
        recoverable_session_count: cases.length,
        boundary_count: cases.length,
        resumed_count: cases.length,
        ready_count: cases.length,
        issues: { archived: 0, contradictions: 0, missing: 0, stale: 0, unavailable: 0 }
      });
      expect(JSON.stringify(harness.repository.require("sess_recoverable_failed"))).not.toContain("private failure");
    } finally {
      harness.close();
    }
  });

  it("isolates every nonrecoverable state-matrix row and resumes only the exact idle mapping", async () => {
    const harness = createHarness();
    try {
      const ids = ["active_terminal", "idle_active", "not_loaded", "wrong_cwd", "runtime_archived", "exact_idle"];
      for (const id of ids) {
        harness.repository.create(stateCandidate(`sess_matrix_${id}`, `thread-matrix-${id}`, {
          turn_state: id === "runtime_archived" ? "waiting_for_input" : "idle",
          attention: id === "runtime_archived" ? "needs_input" : "none"
        }));
      }
      const runtime = scriptedRuntime([
        runtimeThread("thread-matrix-active_terminal", "/tmp/sess_matrix_active_terminal", {
          status: { type: "active", activeFlags: [] },
          latest: rawTurn("turn-matrix-active-terminal", "completed")
        }),
        runtimeThread("thread-matrix-idle_active", "/tmp/sess_matrix_idle_active", {
          status: { type: "idle" },
          latest: rawTurn("turn-matrix-idle-active", "inProgress")
        }),
        runtimeThread("thread-matrix-not_loaded", "/tmp/sess_matrix_not_loaded", {
          status: { type: "notLoaded" },
          latest: null
        }),
        runtimeThread("thread-matrix-wrong_cwd", "/tmp/different-cwd", {
          status: { type: "idle" },
          latest: null
        }),
        runtimeThread("thread-matrix-runtime_archived", "/tmp/sess_matrix_runtime_archived", {
          list: "archived",
          status: { type: "idle" },
          latest: null
        }),
        runtimeThread("thread-matrix-exact_idle", "/tmp/sess_matrix_exact_idle", {
          status: { type: "idle" },
          latest: rawTurn("turn-matrix-exact-idle", "completed"),
          resume_model: "runtime-exact",
          resume_effort: "medium"
        })
      ], 3);
      const deadline = testDeadline();
      try {
        const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 3, null);
        await resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 3, null);
        await ready(harness.lifecycle, runtime, deadline, reconciliation, 3, null);
      } finally {
        deadline.dispose();
      }

      expect(runtime.requests.filter((request) => request.method === "thread/resume").map(threadIdFromRequest)).toEqual([
        "thread-matrix-exact_idle"
      ]);
      expect(harness.repository.require("sess_matrix_exact_idle").projection.session).toMatchObject({
        turn_state: "completed",
        freshness: "current",
        model: "runtime-exact"
      });
      for (const id of ["active_terminal", "idle_active", "not_loaded", "wrong_cwd"]) {
        expect(harness.repository.require(`sess_matrix_${id}`).projection.session).toMatchObject({
          session_state: "unknown",
          turn_state: "unknown",
          freshness: "stale",
          model: null,
          settings: null
        });
      }
      expect(harness.repository.require("sess_matrix_wrong_cwd").mapping.disposition).toBe("recovery_required");
      expect(harness.repository.require("sess_matrix_runtime_archived")).toMatchObject({
        mapping: { archived_at: expect.stringMatching(/^2026-07-16T13:/u) },
        projection: {
          session: {
            session_state: "archived",
            turn_state: "interrupted",
            attention: "stuck",
            freshness: "current"
          }
        }
      });
      expect(harness.lifecycle.snapshot()).toMatchObject({
        recoverable_session_count: 1,
        boundary_count: 6,
        resumed_count: 1,
        ready_count: 1,
        issues: { archived: 1, contradictions: 3, missing: 0, stale: 4, unavailable: 1 }
      });
    } finally {
      harness.close();
    }
  });

  it("does not resume after a reconciled mapping is moved or archived", async () => {
    for (const race of ["cwd", "archive"] as const) {
      const harness = createHarness();
      try {
        const sessionId = `sess_resume_race_${race}`;
        const threadId = `thread-resume-race-${race}`;
        harness.repository.create(stateCandidate(sessionId, threadId));
        const runtime = scriptedRuntime([runtimeThread(threadId, `/tmp/${sessionId}`)], 14);
        const deadline = testDeadline();
        try {
          const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 14, null);
          const current = harness.repository.require(sessionId);
          const changedAt = new Date(
            Math.max(Date.parse(current.mapping.updated_at), Date.parse(current.projection.session.updated_at)) + 1_000
          ).toISOString();
          const archivedAt = race === "archive" ? changedAt : null;
          const cwd = race === "cwd" ? `/tmp/${sessionId}-moved` : current.mapping.cwd;
          harness.repository.replace(
            {
              mapping: {
                ...current.mapping,
                cwd,
                updated_at: changedAt,
                archived_at: archivedAt
              },
              projection: {
                ...current.projection,
                session: {
                  ...current.projection.session,
                  cwd,
                  updated_at: changedAt,
                  archived_at: archivedAt,
                  session_state: race === "archive" ? "archived" : "active"
                }
              }
            },
            selectedStateRevision(current)
          );

          await expect(
            resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 14, null)
          ).rejects.toMatchObject({ code: "state_conflict" });
        } finally {
          deadline.dispose();
        }
        expect(runtime.requests.filter((request) => request.method === "thread/resume")).toEqual([]);
      } finally {
        harness.close();
      }
    }
  });

  it("blocks admission on incomplete audit, event barrier failure, or Plan rehydration failure", async () => {
    const auditFailure = createHarness({ auditStatus: "degraded" });
    try {
      auditFailure.repository.create(stateCandidate("sess_audit_fail", "thread-audit-fail"));
      const deadline = testDeadline();
      try {
        await expect(
          reconcile(
            auditFailure.lifecycle,
            scriptedRuntime([runtimeThread("thread-audit-fail", "/tmp/sess_audit_fail")], 1),
            deadline,
            1,
            null
          )
        ).rejects.toMatchObject({ code: "audit_incomplete" });
      } finally {
        deadline.dispose();
      }
      expect(auditFailure.lifecycle.snapshot()).toMatchObject({ phase: "failed", last_failure: "audit_incomplete" });
      expect(auditFailure.repository.listEvents("sess_audit_fail").events).toEqual([]);
    } finally {
      auditFailure.close();
    }

    const cutoffFailure = createHarness({ auditCutoffMismatch: true });
    try {
      cutoffFailure.repository.create(stateCandidate("sess_audit_cutoff", "thread-audit-cutoff"));
      const deadline = testDeadline();
      try {
        await expect(
          reconcile(
            cutoffFailure.lifecycle,
            scriptedRuntime([runtimeThread("thread-audit-cutoff", "/tmp/sess_audit_cutoff")], 2),
            deadline,
            2,
            null
          )
        ).rejects.toMatchObject({ code: "audit_incomplete" });
      } finally {
        deadline.dispose();
      }
      expect(cutoffFailure.repository.listEvents("sess_audit_cutoff").events).toEqual([]);
    } finally {
      cutoffFailure.close();
    }

    const eventFailure = createHarness({ failure: "event_reconcile" });
    try {
      eventFailure.repository.create(stateCandidate("sess_event_reconcile_fail", "thread-event-reconcile-fail"));
      const deadline = testDeadline();
      try {
        await expect(
          reconcile(
            eventFailure.lifecycle,
            scriptedRuntime([
              runtimeThread("thread-event-reconcile-fail", "/tmp/sess_event_reconcile_fail")
            ], 3),
            deadline,
            3,
            null
          )
        ).rejects.toMatchObject({ code: "event_reconciliation_failed" });
      } finally {
        deadline.dispose();
      }
      expect(eventFailure.lifecycle.snapshot()).toMatchObject({
        phase: "failed",
        last_failure: "event_reconciliation_failed"
      });
      expect(eventFailure.reconciliations).toHaveLength(1);
    } finally {
      eventFailure.close();
    }

    for (const failure of ["barrier", "plan", "final_barrier"] as const) {
      const harness = createHarness({ failure });
      try {
        harness.repository.create(stateCandidate(`sess_${failure}_fail`, `thread-${failure}-fail`));
        const runtime = scriptedRuntime([
          runtimeThread(`thread-${failure}-fail`, `/tmp/sess_${failure}_fail`, {
            resume_model: "runtime-a",
            resume_effort: "high"
          })
        ], 4);
        const deadline = testDeadline();
        try {
          const reconciliation = await reconcile(harness.lifecycle, runtime, deadline, 4, null);
          await resubscribe(harness.lifecycle, runtime, deadline, reconciliation, 4, null);
          await expect(ready(harness.lifecycle, runtime, deadline, reconciliation, 4, null)).rejects.toBeInstanceOf(Error);
        } finally {
          deadline.dispose();
        }
        expect(harness.lifecycle.snapshot()).toMatchObject({
          phase: "failed",
          last_failure: failure === "plan" ? "plan_rehydration_failed" : "projection_failed"
        });
        if (failure === "barrier") {
          expect(streamShape(harness.repository, `sess_${failure}_fail`)).toEqual([
            { type: "replay_boundary", cursor: 2, after: 1, reason: "restart" }
          ]);
        } else {
          expect(streamShape(harness.repository, `sess_${failure}_fail`)).toEqual([
            { type: "replay_boundary", cursor: 2, after: 1, reason: "restart" },
            { type: "runtime", cursor: 3, state: "ready" }
          ]);
        }
      } finally {
        harness.close();
      }
    }
  });

  it("rejects archived resurrection, repeated stages, invalid construction, and pre-aborted work", async () => {
    const archived = createHarness();
    try {
      archived.repository.create(stateCandidate("sess_archived_conflict", "thread-archived-conflict", {
        archived_at: "2026-07-16T12:10:00.000Z"
      }));
      const deadline = testDeadline();
      try {
        await expect(
          reconcile(
            archived.lifecycle,
            scriptedRuntime([
              runtimeThread("thread-archived-conflict", "/tmp/sess_archived_conflict", { list: "active" })
            ], 2),
            deadline,
            2,
            null
          )
        ).rejects.toMatchObject({ code: "mapping_contradiction" });
      } finally {
        deadline.dispose();
      }
      expect(archived.repository.require("sess_archived_conflict").mapping.archived_at).not.toBeNull();
      expect(archived.repository.listEvents("sess_archived_conflict").events).toEqual([]);
    } finally {
      archived.close();
    }

    const empty = createHarness();
    try {
      const runtime = scriptedRuntime([], 5);
      const deadline = testDeadline();
      try {
        const reconciliation = await reconcile(empty.lifecycle, runtime, deadline, 5, null);
        await expect(reconcile(empty.lifecycle, runtime, deadline, 5, null)).rejects.toMatchObject({
          code: "lifecycle_conflict"
        });
        await resubscribe(empty.lifecycle, runtime, deadline, reconciliation, 5, null);
        await ready(empty.lifecycle, runtime, deadline, reconciliation, 5, null);
        await expect(ready(empty.lifecycle, runtime, deadline, reconciliation, 5, null)).rejects.toMatchObject({
          code: "lifecycle_conflict"
        });
      } finally {
        deadline.dispose();
      }
    } finally {
      empty.close();
    }

    const invalid = createHarness();
    try {
      const options = { ...invalid.options, extra: true };
      expect(() => createCodexRuntimeReconciliationLifecycle(options as never)).toThrow(TypeError);
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      const deadline = createOperationDeadline({ timeoutMs: 5_000, parentSignal: controller.signal });
      try {
        await expect(reconcile(invalid.lifecycle, scriptedRuntime([], 9), deadline, 9, null)).rejects.toThrow("cancelled");
      } finally {
        deadline.dispose();
      }
      expect(invalid.order).toEqual([]);
    } finally {
      invalid.close();
    }

    const invalidApprovalCount = createHarness({ approvalsSuperseded: -1 });
    try {
      const deadline = testDeadline();
      try {
        await expect(
          invalidApprovalCount.lifecycle.disconnected({
            generation: 1,
            previous_admitted_generation: 1,
            deadline
          })
        ).rejects.toMatchObject({ code: "invalid_contract" });
      } finally {
        deadline.dispose();
      }
      expect(invalidApprovalCount.order).toEqual(["approval:1"]);
    } finally {
      invalidApprovalCount.close();
    }
  });
});

interface RuntimeFixture {
  readonly thread_id: string;
  readonly cwd: string;
  readonly list: "active" | "archived" | "missing";
  readonly status: Record<string, unknown>;
  readonly source: unknown;
  readonly goal: Record<string, unknown> | null;
  readonly latest: Record<string, unknown> | null;
  readonly resume_model: string;
  readonly resume_effort: string | null;
}

interface ScriptedRuntime {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
  readonly requests: CodexReconnectResubscribeRequestInput[];
  readonly request: (input: CodexReconnectResubscribeRequestInput) => Promise<unknown>;
}

interface Harness {
  readonly repository: SelectedStateRepository;
  readonly lifecycle: CodexRuntimeReconciliationLifecycle;
  readonly order: string[];
  readonly reconciliations: Array<{
    readonly generation: number;
    readonly threads: readonly CodexEventNormalizerReconciliation[];
  }>;
  readonly options: CodexRuntimeReconciliationLifecycleOptions;
  readonly close: () => void;
}

function createHarness(overrides: {
  readonly approvalsSuperseded?: number;
  readonly auditCutoffMismatch?: boolean;
  readonly auditStatus?: "complete" | "degraded";
  readonly failure?: "barrier" | "event_reconcile" | "final_barrier" | "plan";
} = {}): Harness {
  const path = tempDbPath();
  const open = openMigratedDatabase(path, { now: () => new Date(createdAt) });
  const repository = createSelectedStateRepository(open.db);
  const order: string[] = [];
  const reconciliations: Harness["reconciliations"] = [];
  let barrierCount = 0;
  let clockMs = Date.parse("2026-07-16T13:00:00.000Z");
  const projection = createProductionProjectionAppendPort({
    repository,
    publish(committed) {
      order.push(`projection:${committed.event.event.type}:${
        committed.event.event.type === "runtime" ? committed.event.event.state : "other"
      }`);
    }
  });
  const continuity = createProductionProjectionContinuityPort({
    repository,
    publish() {
      order.push("boundary");
    }
  });
  const options: CodexRuntimeReconciliationLifecycleOptions = {
    approvals: {
      async disconnect(generation) {
        order.push(`approval:${String(generation)}`);
        return overrides.approvalsSuperseded ?? 0;
      }
    },
    audit: {
      reconcile(input) {
        order.push("audit");
        const cutoff = overrides.auditCutoffMismatch
          ? new Date(Date.parse(input.eligible_before) + 1_000).toISOString()
          : input.eligible_before;
        return auditResult(cutoff, overrides.auditStatus ?? "complete");
      }
    },
    continuity,
    events: {
      async barrier(input) {
        barrierCount += 1;
        order.push(`barrier:${input.generation}`);
        if (
          overrides.failure === "barrier" ||
          (overrides.failure === "final_barrier" && barrierCount === 2)
        ) {
          throw new Error("private barrier detail");
        }
      },
      async reconcile(input) {
        order.push(`reconcile-events:${input.generation}`);
        reconciliations.push({
          generation: input.generation,
          threads: Object.freeze(input.threads.map((entry) => Object.freeze({ ...entry })))
        });
        if (overrides.failure === "event_reconcile") {
          throw new Error("private event reconciliation detail");
        }
      }
    },
    now: () => {
      const value = new Date(clockMs).toISOString();
      clockMs += 1;
      return value;
    },
    plans: {
      async rehydrate() {
        order.push("plan");
        if (overrides.failure === "plan") throw new Error("private Plan detail");
      }
    },
    projection,
    repository,
    resource_budget: resolveResourceBudget({})
  };
  return {
    repository,
    lifecycle: createCodexRuntimeReconciliationLifecycle(options),
    order,
    reconciliations,
    options,
    close: () => open.db.close()
  };
}

function scriptedRuntime(fixtures: readonly RuntimeFixture[], generation = 7): ScriptedRuntime {
  const compatibility = readyCompatibility();
  const requests: CodexReconnectResubscribeRequestInput[] = [];
  const byThread = new Map(fixtures.map((fixture) => [fixture.thread_id, fixture]));
  return {
    compatibility,
    generation,
    requests,
    async request(input) {
      requests.push(input);
      if (input.method === "thread/list") {
        const archived = (input.params as { readonly archived: boolean }).archived;
        const selected = fixtures
          .filter((fixture) => fixture.list === (archived ? "archived" : "active"))
          .map((fixture) => rawThread(fixture));
        return {
          data: selected,
          nextCursor: null,
          backwardsCursor: selected.length === 0 ? null : `back-${archived ? "archived" : "active"}`
        };
      }
      const threadId = threadIdFromRequest(input);
      const fixture = byThread.get(threadId);
      if (fixture === undefined || fixture.list === "missing") {
        throw new HostDeckCodexAdapterError("remote_error", "private not-found detail", {
          outcome: "remote_rejected",
          rpc_code: -32_000
        });
      }
      if (input.method === "thread/read") return { thread: rawThread(fixture) };
      if (input.method === "thread/goal/get") return { goal: fixture.goal };
      if (input.method === "thread/turns/list") {
        return {
          data: fixture.latest === null ? [] : [fixture.latest],
          nextCursor: null,
          backwardsCursor: fixture.latest === null ? null : `turn-back-${threadId}`
        };
      }
      if (input.method === "thread/resume") {
        return rawResume(fixture);
      }
      throw new Error(`Unexpected method ${input.method}`);
    }
  };
}

function runtimeThread(
  threadId: string,
  cwd: string,
  overrides: Partial<Omit<RuntimeFixture, "thread_id" | "cwd">> = {}
): RuntimeFixture {
  return {
    thread_id: threadId,
    cwd,
    list: "active",
    status: { type: "idle" },
    source: "appServer",
    goal: null,
    latest: null,
    resume_model: "runtime-default",
    resume_effort: null,
    ...overrides
  };
}

function rawThread(fixture: RuntimeFixture): Record<string, unknown> {
  return {
    id: fixture.thread_id,
    extra: null,
    sessionId: `runtime-${fixture.thread_id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: unixSeconds("2026-07-16T12:00:00.000Z"),
    updatedAt: unixSeconds("2026-07-16T12:45:00.000Z"),
    recencyAt: unixSeconds("2026-07-16T12:45:00.000Z"),
    status: fixture.status,
    path: `/tmp/${fixture.thread_id}.jsonl`,
    cwd: fixture.cwd,
    cliVersion: "0.144.0",
    source: fixture.source,
    threadSource: "hostdeck:managed",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: fixture.thread_id,
    turns: []
  };
}

function rawTurn(turnId: string, status: "completed" | "failed" | "inProgress" | "interrupted") {
  const terminal = status !== "inProgress";
  return {
    id: turnId,
    items: [],
    itemsView: "notLoaded",
    status,
    error: status === "failed"
      ? { message: "private failure", codexErrorInfo: "other", additionalDetails: null }
      : null,
    startedAt: unixSeconds("2026-07-16T12:40:00.000Z"),
    completedAt: terminal ? unixSeconds("2026-07-16T12:41:00.000Z") : null,
    durationMs: terminal ? 60_000 : null
  };
}

function rawGoal(threadId: string, objective: string, status: string) {
  return {
    threadId,
    objective,
    status,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 2,
    createdAt: unixSeconds("2026-07-16T12:20:00.000Z"),
    updatedAt: unixSeconds("2026-07-16T12:45:00.000Z")
  };
}

function rawResume(fixture: RuntimeFixture): Record<string, unknown> {
  return {
    thread: { id: fixture.thread_id, cwd: fixture.cwd, turns: [] },
    model: fixture.resume_model,
    modelProvider: "openai",
    serviceTier: null,
    cwd: fixture.cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    activePermissionProfile: null,
    reasoningEffort: fixture.resume_effort,
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null
  };
}

function stateCandidate(
  sessionId: string,
  threadId: string,
  overrides: {
    readonly archived_at?: string | null;
    readonly attention?: string;
    readonly created_at?: string;
    readonly last_activity_at?: string | null;
    readonly model?: string | null;
    readonly settings?: ReturnType<typeof settings> | null;
    readonly turn_state?: string;
    readonly updated_at?: string;
  } = {}
) {
  const archivedAt = overrides.archived_at ?? null;
  const durableCreatedAt = overrides.created_at ?? createdAt;
  const durableUpdatedAt = overrides.updated_at ?? archivedAt ?? durableCreatedAt;
  const lastActivityAt = overrides.last_activity_at === undefined ? null : overrides.last_activity_at;
  const mapping = {
    id: sessionId,
    name: sessionId.replace("sess_", "session-"),
    codex_thread_id: threadId,
    cwd: `/tmp/${sessionId}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    disposition: "selected",
    created_at: durableCreatedAt,
    updated_at: durableUpdatedAt,
    archived_at: archivedAt
  };
  return {
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: mapping.archived_at,
        session_state: archivedAt === null ? "active" : "archived",
        turn_state: archivedAt === null ? (overrides.turn_state ?? "idle") : "idle",
        attention: archivedAt === null ? (overrides.attention ?? "none") : "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: mapping.updated_at,
        last_activity_at: lastActivityAt,
        branch: "main",
        model: overrides.model ?? null,
        settings: overrides.settings ?? null,
        goal: null,
        recent_summary: "Managed projection created.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    }
  };
}

function settings(mode: "default" | "plan", model: string, effort: string | null) {
  return {
    collaboration_mode: mode,
    runtime_model: model,
    reasoning_effort: effort,
    observed_at: createdAt
  } as const;
}

function readyCompatibility(): RuntimeCompatibility {
  return assessCodexCompatibility({
    observed_version: "0.144.0",
    checked_at: checkedAt,
    handshake: {
      state: "initialized",
      user_agent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
      platform_family: "unix",
      platform_os: "linux",
      collaboration_modes: ["Plan", "Default"]
    }
  });
}

function auditResult(
  timestamp: string,
  status: "complete" | "degraded"
): StartupAuditOrphanReconciliationResult {
  const complete = status === "complete";
  return Object.freeze({
    actionable_remaining: !complete,
    batch_count: 1,
    duration_ms: 1,
    eligible_before: timestamp,
    eligible_pending_operation_count: complete ? 0 : 1,
    failure: null,
    protected_recent_operation_count: 0,
    reasons: complete ? Object.freeze([]) : Object.freeze(["batch_limit" as const]),
    reconciled_at: timestamp,
    reconciled_operation_count: complete ? 2 : 0,
    scan_complete: complete,
    status,
    total_pending_operation_count: complete ? 0 : 1
  });
}

async function reconcile(
  lifecycle: CodexRuntimeReconciliationLifecycle,
  runtime: ScriptedRuntime,
  deadline: OperationDeadline,
  generation: number,
  previous: number | null
) {
  return lifecycle.reconcile({
    generation,
    previous_admitted_generation: previous,
    compatibility: runtime.compatibility,
    deadline,
    runtime
  });
}

async function resubscribe(
  lifecycle: CodexRuntimeReconciliationLifecycle,
  runtime: ScriptedRuntime,
  deadline: OperationDeadline,
  reconciliation: Awaited<ReturnType<CodexRuntimeReconciliationLifecycle["reconcile"]>>,
  generation: number,
  previous: number | null
) {
  return lifecycle.resubscribe({
    generation,
    previous_admitted_generation: previous,
    compatibility: runtime.compatibility,
    deadline,
    runtime,
    reconciliation
  });
}

async function ready(
  lifecycle: CodexRuntimeReconciliationLifecycle,
  runtime: ScriptedRuntime,
  deadline: OperationDeadline,
  reconciliation: Awaited<ReturnType<CodexRuntimeReconciliationLifecycle["reconcile"]>>,
  generation: number,
  previous: number | null
) {
  return lifecycle.ready({
    generation,
    previous_admitted_generation: previous,
    compatibility: runtime.compatibility,
    deadline,
    runtime,
    reconciliation
  });
}

function streamShape(repository: SelectedStateRepository, sessionId: string): unknown[] {
  return repository.listEvents(sessionId).events.map((event) => {
    if (event.type === "replay_boundary") {
      return { type: event.type, cursor: event.cursor, after: event.after, reason: event.reason };
    }
    if (event.type === "runtime") return { type: event.type, cursor: event.cursor, state: event.state };
    return { type: event.type, cursor: event.cursor };
  });
}

function threadIdFromRequest(request: CodexReconnectResubscribeRequestInput): string {
  return (request.params as { readonly threadId: string }).threadId;
}

function testDeadline(): OperationDeadline {
  return createOperationDeadline({ timeoutMs: 10_000 });
}

function unixSeconds(value: string): number {
  return Date.parse(value) / 1_000;
}

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-reconcile-lifecycle-"));
  tempDirs.push(directory);
  return join(directory, "hostdeck.sqlite");
}
