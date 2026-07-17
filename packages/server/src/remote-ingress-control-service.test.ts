import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  remoteIngressObservationSnapshotSchema,
  remoteIngressStateSchema
} from "@hostdeck/contracts";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRemoteIngressControlService,
  createRemoteIngressControlService,
  type RemoteIngressControlService
} from "./remote-ingress-control-service.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import type { TailscaleObserver } from "./tailscale-observer.js";
import type {
  TailscaleServeManager,
  TailscaleServeManagerResult,
  TailscaleServeMutationInput
} from "./tailscale-serve-manager.js";

const roots: string[] = [];
const origin = "https://hostdeck-control.fixture-tailnet.ts.net";
const localOrigin = "http://127.0.0.1:3777";
const profileKey = `sha256:${"1".repeat(64)}`;
const otherProfileKey = `sha256:${"2".repeat(64)}`;
const observedAt = "2026-07-13T18:00:00.000Z";
const baseWallTime = Date.parse("2026-07-13T19:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("remote ingress control service", () => {
  it("starts closed, validates construction, and reports an unconfigured host without subprocess work", async () => {
    const harness = createHarness();
    assertRemoteIngressControlService(harness.service);
    expect(() =>
      assertRemoteIngressControlService({ ...harness.service })
    ).toThrow(TypeError);
    expect(() =>
      createRemoteIngressControlService({
        ...harness.options,
        localOrigin: "http://0.0.0.0:3777"
      })
    ).toThrow(TypeError);

    expect(harness.service.readAdmission()).toEqual({
      admission: "closed",
      external_origin: null,
      generation: 0
    });
    expect(harness.service.readAdmissionLease()).toEqual({
      admission: "closed",
      external_origin: null,
      generation: 0,
      valid_until: null
    });
    expect(harness.service.observation_interval_ms).toBe(5_000);
    await expect(harness.service.readStatus()).resolves.toEqual({
      generation: 0,
      availability: "disabled",
      reason: "remote_disabled",
      external_origin: null,
      laptop_action_required: true,
      observed_at: null
    });
    expect(harness.calls).toMatchObject({
      candidate: 0,
      configured: 0,
      disable: 0,
      enable: 0
    });
    expect(harness.service.snapshot()).toMatchObject({
      active_operation: null,
      status_reads: 1
    });
  });

  it("enables from one current candidate, proves terminal audit, and restarts closed until exact re-observation", async () => {
    const harness = createHarness();
    const response = await harness.service.enable(enableRequest(1));

    expect(response).toMatchObject({
      generation: 2,
      availability: "ready",
      reason: null,
      external_origin: origin,
      laptop_action_required: false
    });
    expect(harness.calls.candidate).toBe(1);
    expect(harness.calls.enable).toBe(1);
    expect(harness.lastEnableInput).toEqual({
      expected_profile_key: profileKey,
      expected_serve: descriptor()
    });
    expect(harness.states.read()).toMatchObject({
      generation: 2,
      intent: "enabled",
      availability: "ready",
      admission: "open",
      profile: {
        state: "dedicated",
        comparison: {
          expected_profile_key: profileKey,
          active_profile_key: profileKey
        }
      },
      serve: "exact"
    });
    expect(harness.proofs.read()).toMatchObject({
      operation_id: enableRequest(1).operation_id,
      generation: 2
    });
    expect(harness.audit.require(enableRequest(1).operation_id)).toMatchObject({
      state: "terminal",
      records: [
        { action: "remote_enable", phase: "accepted", outcome: "accepted" },
        { action: "remote_enable", phase: "terminal", outcome: "succeeded" }
      ]
    });
    expect(harness.service.readAdmission()).toEqual({
      admission: "open",
      external_origin: origin,
      generation: 2
    });
    expect(harness.service.readAdmissionLease()).toEqual({
      admission: "open",
      external_origin: origin,
      generation: 2,
      valid_until: 5_000
    });

    const restarted = harness.restart();
    expect(restarted.readAdmission()).toEqual({
      admission: "closed",
      external_origin: null,
      generation: 2
    });
    await expect(restarted.readStatus()).resolves.toMatchObject({
      generation: 2,
      availability: "ready",
      external_origin: origin
    });
    expect(harness.states.read()?.generation).toBe(2);
    expect(restarted.readAdmission()).toMatchObject({
      admission: "open",
      generation: 2
    });
  });

  it("expires and renews the process lease without generation or audit churn", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(2));
    const auditCount = auditRecordCount(harness.db);
    const generation = harness.states.read()?.generation;

    harness.setMonotonic(5_000);
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
    expect(harness.service.readAdmissionLease()).toMatchObject({
      admission: "closed",
      valid_until: null
    });
    await expect(harness.service.readStatus()).resolves.toMatchObject({
      availability: "ready",
      generation
    });
    expect(harness.states.read()?.generation).toBe(generation);
    expect(auditRecordCount(harness.db)).toBe(auditCount);
    expect(harness.service.readAdmission()).toMatchObject({
      admission: "open",
      generation
    });
    expect(harness.service.readAdmissionLease()).toMatchObject({
      admission: "open",
      valid_until: 10_000
    });
  });

  it("advances generation on material drift and carries an existing proof only after exact recovery", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(3));
    harness.queueConfigured(
      snapshot({ serve: "drifted" }),
      snapshot({ serve: "exact" })
    );

    await expect(harness.service.readStatus()).resolves.toMatchObject({
      generation: 3,
      availability: "unavailable",
      reason: "serve_drifted"
    });
    expect(harness.proofs.read()?.generation).toBe(2);
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });

    await expect(harness.service.readStatus()).resolves.toMatchObject({
      generation: 4,
      availability: "ready",
      reason: null
    });
    expect(harness.proofs.read()?.generation).toBe(4);
    expect(harness.service.readAdmission()).toMatchObject({
      admission: "open",
      generation: 4
    });
  });

  it("does not reconstruct a missing proof from exact persisted state", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(4));
    harness.db
      .prepare("DELETE FROM selected_remote_ingress_admission_proof")
      .run();

    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
    await expect(harness.service.readStatus()).resolves.toMatchObject({
      generation: 2,
      availability: "unavailable",
      reason: "observation_failed",
      external_origin: null
    });
    expect(harness.proofs.read()).toBeNull();
    expect(harness.states.read()).toMatchObject({
      generation: 2,
      availability: "ready",
      admission: "open"
    });
  });

  it("audits and rejects a conflicting candidate without selecting state or invoking the manager", async () => {
    const harness = createHarness();
    harness.queueCandidate(snapshot({ serve: "foreign" }));
    const request = enableRequest(5);

    await expect(harness.service.enable(request)).rejects.toMatchObject({
      code: "selection_conflict",
      api_code: "operation_conflict"
    });
    expect(harness.calls.enable).toBe(0);
    expect(harness.states.read()).toBeNull();
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [
        {
          phase: "terminal",
          outcome: "rejected",
          payload_summary: {
            action: "remote_enable",
            serve_state: "foreign",
            reason: "serve_foreign"
          }
        }
      ]
    });
  });

  it("re-proves an explicit enable over already-exact owned Serve without command work", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(21));
    harness.setEnableHandler(() =>
      Promise.resolve({
        action: "enable",
        outcome: "succeeded",
        serve_result: "unchanged",
        reason: null,
        command_attempted: false,
        before: snapshot({ serve: "exact" }),
        after: snapshot({ serve: "exact" })
      })
    );
    const repeated = enableRequest(22);

    await expect(harness.service.enable(repeated)).resolves.toMatchObject({
      generation: 4,
      availability: "ready"
    });
    expect(harness.calls.enable).toBe(2);
    expect(harness.proofs.read()).toMatchObject({
      operation_id: repeated.operation_id,
      generation: 4
    });
    expect(harness.service.readAdmission()).toMatchObject({
      admission: "open",
      generation: 4
    });
    expect(harness.audit.require(repeated.operation_id)).toMatchObject({
      state: "terminal",
      records: [
        {},
        { outcome: "succeeded", payload_summary: { serve_result: "unchanged" } }
      ]
    });
  });

  it("persists a profile switch and rejects before a second manager call", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(23));
    harness.queueConfigured(snapshot({ profile: "other", serve: null }));
    const request = enableRequest(24);

    await expect(harness.service.enable(request)).rejects.toMatchObject({
      code: "selection_conflict",
      api_code: "operation_conflict"
    });
    expect(harness.calls.enable).toBe(1);
    expect(harness.states.read()).toMatchObject({
      generation: 3,
      availability: "unavailable",
      admission: "closed",
      profile: { state: "other" },
      operation_failure: null,
      reason: "profile_other"
    });
    expect(harness.proofs.read()?.generation).toBe(2);
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [
        {
          outcome: "rejected",
          payload_summary: { profile_state: "other", reason: "profile_other" }
        }
      ]
    });
  });

  it("coalesces identical status reads and rejects mutation overlap without a queue", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(6));
    const deferred = createDeferred<RemoteIngressObservationSnapshot>();
    harness.setConfiguredHandler(() => deferred.promise);

    const first = harness.service.readStatus();
    const second = harness.service.readStatus();
    expect(first).toBe(second);
    await expect(harness.service.enable(enableRequest(7))).rejects.toMatchObject({
      code: "operation_busy",
      api_code: "service_overloaded"
    });
    expect(harness.calls.enable).toBe(1);
    deferred.resolve(snapshot({ serve: "exact" }));
    await expect(first).resolves.toMatchObject({ availability: "ready" });
    expect(harness.service.snapshot()).toMatchObject({
      active_operation: null,
      busy_rejections: 1
    });
  });

  it("invalidates proof and latches disabled before a single cleanup call", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(8));
    const deferred = createDeferred<TailscaleServeManagerResult>();
    harness.setDisableHandler(() => deferred.promise);
    const request = disableRequest(8);

    const disabling = harness.service.disable(request);
    await eventually(() =>
      expect(harness.states.read()).toMatchObject({
        generation: 3,
        intent: "disabled",
        availability: "disabled",
        operation_failure: "cleanup_incomplete",
        reason: "cleanup_incomplete"
      })
    );
    expect(harness.proofs.read()).toBeNull();
    expect(harness.service.readAdmission()).toMatchObject({
      admission: "closed",
      generation: 3
    });
    expect(harness.calls.disable).toBe(1);

    deferred.resolve(disableSuccess());
    await expect(disabling).resolves.toMatchObject({
      generation: 4,
      availability: "disabled",
      reason: "remote_disabled"
    });
    expect(harness.states.read()).toMatchObject({
      generation: 4,
      intent: "disabled",
      profile: {
        state: "absent",
        comparison: { relation: "unconfigured" }
      },
      serve: null,
      expected_serve: null,
      operation_failure: null,
      reason: null
    });
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [
        { phase: "accepted", outcome: "accepted" },
        {
          phase: "terminal",
          outcome: "succeeded",
          payload_summary: { serve_result: "removed", admission: "closed" }
        }
      ]
    });
  });

  it("releases a verified selection so a different dedicated profile can be enabled", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(13));
    await harness.service.disable(disableRequest(13));
    expect(harness.states.read()).toMatchObject({
      intent: "disabled",
      expected_serve: null,
      profile: {
        state: "absent",
        comparison: { relation: "unconfigured" }
      }
    });

    harness.queueCandidate(
      snapshot({ selectedProfileKey: otherProfileKey, serve: "absent" })
    );
    await expect(harness.service.enable(enableRequest(14))).resolves.toMatchObject({
      generation: 6,
      availability: "ready"
    });
    expect(harness.states.read()).toMatchObject({
      generation: 6,
      intent: "enabled",
      profile: {
        comparison: {
          expected_profile_key: otherProfileKey,
          active_profile_key: otherProfileKey
        }
      }
    });
    expect(harness.lastEnableInput?.expected_profile_key).toBe(otherProfileKey);
  });

  it("keeps failed cleanup disabled and status cannot clear the durable marker", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(9));
    harness.setDisableHandler(() =>
      Promise.resolve({
        action: "disable",
        outcome: "rejected",
        serve_result: "not_attempted",
        reason: "profile_other",
        command_attempted: false,
        before: snapshot({ profile: "other", serve: null }),
        after: null
      })
    );
    const request = disableRequest(9);

    await expect(harness.service.disable(request)).rejects.toMatchObject({
      code: "mutation_incomplete",
      api_code: "operation_conflict"
    });
    expect(harness.states.read()).toMatchObject({
      intent: "disabled",
      operation_failure: "cleanup_incomplete",
      reason: "cleanup_incomplete"
    });
    expect(harness.proofs.read()).toBeNull();
    harness.queueConfigured(snapshot({ serve: "absent" }));
    await expect(harness.service.readStatus()).resolves.toMatchObject({
      availability: "disabled",
      reason: "cleanup_incomplete"
    });
    expect(harness.states.read()).toMatchObject({
      operation_failure: "cleanup_incomplete",
      reason: "cleanup_incomplete"
    });
    harness.queueConfigured(missingClientSnapshot());
    await expect(harness.service.readStatus()).resolves.toMatchObject({
      availability: "disabled",
      reason: "cleanup_incomplete"
    });
    expect(harness.states.read()).toMatchObject({
      client: "error",
      operation_failure: "cleanup_incomplete",
      reason: "cleanup_incomplete"
    });
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [
        {},
        {
          outcome: "incomplete",
          payload_summary: {
            reason: "cleanup_incomplete",
            intent_persisted: true,
            serve_result: "unknown"
          }
        }
      ]
    });
  });

  it("audits an unconfigured disable as a successful no-op without manager work", async () => {
    const harness = createHarness();
    const request = disableRequest(10);
    await expect(harness.service.disable(request)).resolves.toMatchObject({
      generation: 1,
      availability: "disabled",
      reason: "remote_disabled"
    });
    expect(harness.calls.disable).toBe(0);
    expect(harness.states.read()).toMatchObject({
      generation: 1,
      intent: "disabled",
      expected_serve: null
    });
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [
        {},
        {
          outcome: "succeeded",
          payload_summary: {
            profile_state: "absent",
            serve_state: null,
            serve_result: "unchanged"
          }
        }
      ]
    });
  });

  it("withholds enable success and admission when terminal audit is unavailable", async () => {
    const harness = createHarness({ failTerminalAudit: true });
    const request = enableRequest(11);

    await expect(harness.service.enable(request)).rejects.toMatchObject({
      code: "audit_unavailable"
    });
    expect(harness.states.read()).toMatchObject({
      intent: "enabled",
      availability: "ready",
      admission: "open",
      serve: "exact"
    });
    expect(harness.proofs.read()).toBeNull();
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "pending"
    });
  });

  it("rejects a cross-handle state race after accepted audit without manager dispatch", async () => {
    const harness = createHarness();
    harness.setAfterAccepted(() => {
      harness.states.compareAndSet({
        expected_generation: null,
        state: unconfiguredPersistedState(1)
      });
    });
    const request = enableRequest(15);

    await expect(harness.service.enable(request)).rejects.toMatchObject({
      code: "mutation_failed",
      api_code: "operation_conflict"
    });
    expect(harness.calls.enable).toBe(0);
    expect(harness.proofs.read()).toBeNull();
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [{}, { outcome: "failed" }]
    });
  });

  it("withholds success when terminal audit commits but proof storage is write-locked", async () => {
    const harness = createHarness();
    const lock = openMigratedDatabase(harness.databasePath, {
      now: () => new Date(baseWallTime)
    }).db;
    harness.db.pragma("busy_timeout = 1");
    harness.setAfterTerminal(() => {
      lock.exec("BEGIN IMMEDIATE");
    });
    const request = enableRequest(16);
    try {
      await expect(harness.service.enable(request)).rejects.toMatchObject({
        code: "proof_unavailable"
      });
      expect(harness.states.read()).toMatchObject({
        availability: "ready",
        admission: "open"
      });
      expect(harness.proofs.read()).toBeNull();
      expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
      expect(harness.audit.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [{}, { outcome: "succeeded" }]
      });
    } finally {
      if (lock.inTransaction) lock.exec("ROLLBACK");
      lock.close();
    }
  });

  it("closes an existing lease when a fresh observer call fails", async () => {
    const harness = createHarness();
    await harness.service.enable(enableRequest(17));
    harness.setConfiguredHandler(() => Promise.reject(new Error("private observer cause")));

    await expect(harness.service.readStatus()).rejects.toMatchObject({
      code: "observation_unavailable",
      api_code: "runtime_unavailable"
    });
    expect(harness.service.readAdmission()).toMatchObject({
      admission: "closed",
      generation: 2
    });
    const serialized = JSON.stringify(harness.service.snapshot());
    expect(serialized).not.toContain(profileKey);
    expect(serialized).not.toContain(origin);
    expect(serialized).not.toContain("private observer cause");
  });

  it("treats an operation id as an audit boundary and never redispatches it", async () => {
    const harness = createHarness();
    const request = enableRequest(18);
    await harness.service.enable(request);
    await expect(harness.service.enable(request)).rejects.toMatchObject({
      code: "audit_unavailable"
    });
    expect(harness.calls.enable).toBe(1);
    expect(harness.audit.require(request.operation_id)).toMatchObject({
      state: "terminal",
      records: [{}, {}]
    });
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });
  });

  it("fails closed on invalid clocks, malformed requests, and malformed manager results", async () => {
    const harness = createHarness();
    await expect(
      harness.service.enable({ confirmed: true } as never)
    ).rejects.toMatchObject({ code: "invalid_input", api_code: "validation_error" });

    harness.setEnableHandler(() =>
      Promise.resolve({ outcome: "succeeded", unexpected: true })
    );
    await expect(harness.service.enable(enableRequest(12))).rejects.toMatchObject({
      code: "mutation_incomplete"
    });
    expect(harness.proofs.read()).toBeNull();
    expect(harness.service.readAdmission()).toMatchObject({ admission: "closed" });

    const clockHarness = createHarness();
    await clockHarness.service.enable(enableRequest(19));
    clockHarness.setMonotonic(Number.NaN);
    expect(clockHarness.service.readAdmission()).toEqual({
      admission: "closed",
      external_origin: null,
      generation: 2
    });
    expect(clockHarness.service.snapshot().clock_failures).toBe(1);

    const wallHarness = createHarness();
    await wallHarness.service.enable(enableRequest(20));
    wallHarness.setWall(baseWallTime);
    wallHarness.queueConfigured(snapshot({ serve: "drifted" }));
    await expect(wallHarness.service.readStatus()).rejects.toMatchObject({
      code: "clock_invalid"
    });
    expect(wallHarness.service.readAdmission()).toMatchObject({
      admission: "closed",
      generation: 2
    });
  });
});

interface HarnessOptions {
  readonly failTerminalAudit?: boolean;
}

interface Harness {
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly calls: {
    candidate: number;
    configured: number;
    disable: number;
    enable: number;
  };
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly databasePath: string;
  readonly lastEnableInput: TailscaleServeMutationInput | null;
  readonly options: Parameters<typeof createRemoteIngressControlService>[0];
  readonly proofs: ReturnType<typeof createRemoteIngressAdmissionProofRepository>;
  readonly queueCandidate: (...values: RemoteIngressObservationSnapshot[]) => void;
  readonly queueConfigured: (...values: RemoteIngressObservationSnapshot[]) => void;
  readonly restart: () => RemoteIngressControlService;
  readonly service: RemoteIngressControlService;
  readonly setConfiguredHandler: (
    handler: () => Promise<RemoteIngressObservationSnapshot>
  ) => void;
  readonly setAfterAccepted: (callback: (() => void) | null) => void;
  readonly setAfterTerminal: (callback: (() => void) | null) => void;
  readonly setDisableHandler: (
    handler: (
      input: TailscaleServeMutationInput
    ) => Promise<unknown>
  ) => void;
  readonly setEnableHandler: (
    handler: (
      input: TailscaleServeMutationInput
    ) => Promise<unknown>
  ) => void;
  readonly setMonotonic: (value: number) => void;
  readonly setWall: (value: number) => void;
  readonly states: ReturnType<typeof createRemoteIngressStateRepository>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-remote-control-"));
  roots.push(root);
  const databasePath = join(root, "hostdeck.sqlite");
  const opened = openMigratedDatabase(databasePath, {
    now: () => new Date(baseWallTime)
  });
  const db = opened.db;
  const states = createRemoteIngressStateRepository(db);
  const proofs = createRemoteIngressAdmissionProofRepository(db);
  const audit = createSelectedAuditRepository(db);
  const calls = { candidate: 0, configured: 0, disable: 0, enable: 0 };
  const candidateQueue: RemoteIngressObservationSnapshot[] = [];
  const configuredQueue: RemoteIngressObservationSnapshot[] = [];
  let configuredHandler: (() => Promise<RemoteIngressObservationSnapshot>) | null = null;
  let disableHandler: (input: TailscaleServeMutationInput) => Promise<unknown> =
    () => Promise.resolve(disableSuccess());
  let enableHandler: (input: TailscaleServeMutationInput) => Promise<unknown> =
    (input) => Promise.resolve(enableSuccess(input.expected_profile_key));
  let lastEnableInput: TailscaleServeMutationInput | null = null;
  let afterAccepted: (() => void) | null = null;
  let afterTerminal: (() => void) | null = null;
  let wallTime = baseWallTime;
  let monotonicTime = 0;
  let auditId = 0;
  const nextDate = () => {
    wallTime += 1_000;
    return new Date(wallTime);
  };

  const observer: TailscaleObserver = Object.freeze({
    poll_interval_ms: 5_000,
    async observeCandidate() {
      calls.candidate += 1;
      return candidateQueue.shift() ?? snapshot({ serve: "absent" });
    },
    async observeConfigured() {
      calls.configured += 1;
      if (configuredHandler !== null) return configuredHandler();
      return configuredQueue.shift() ?? snapshot({ serve: "exact" });
    }
  });
  const manager = Object.freeze({
    async disable(input: TailscaleServeMutationInput) {
      calls.disable += 1;
      return disableHandler(input);
    },
    async enable(input: TailscaleServeMutationInput) {
      calls.enable += 1;
      lastEnableInput = input;
      return enableHandler(input);
    },
    snapshot() {
      return Object.freeze({
        active: false,
        busy_rejections: 0,
        command_attempts: calls.disable + calls.enable,
        failed_operations: 0,
        incomplete_operations: 0,
        rejected_operations: 0,
        started_operations: calls.disable + calls.enable,
        succeeded_operations: calls.disable + calls.enable
      });
    }
  }) as TailscaleServeManager;

  const auditPort: SelectedAuditRepository = {
    ...audit,
    recordAccepted(record) {
      const trail = audit.recordAccepted(record);
      afterAccepted?.();
      return trail;
    },
    recordTerminal(record) {
      if (options.failTerminalAudit) {
          throw new HostDeckSelectedAuditRepositoryError(
            "audit_write_failed",
            "Terminal audit unavailable."
          );
      }
      const trail = audit.recordTerminal(record);
      afterTerminal?.();
      return trail;
    }
  };
  const executor = createSecurityMutationAuditExecutor({
    repository: auditPort,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit:remote-control:${++auditId}`
  });
  const serviceOptions = {
    admissionProofs: proofs,
    audit: executor,
    localOrigin,
    manager,
    monotonicNow: () => monotonicTime,
    now: nextDate,
    observer,
    states
  } as const;
  const service = createRemoteIngressControlService(serviceOptions);

  return {
    audit,
    calls,
    db,
    databasePath,
    get lastEnableInput() {
      return lastEnableInput;
    },
    options: serviceOptions,
    proofs,
    queueCandidate(...values) {
      candidateQueue.push(...values);
    },
    queueConfigured(...values) {
      configuredQueue.push(...values);
    },
    restart() {
      return createRemoteIngressControlService(serviceOptions);
    },
    service,
    setAfterAccepted(callback) {
      afterAccepted = callback;
    },
    setAfterTerminal(callback) {
      afterTerminal = callback;
    },
    setConfiguredHandler(handler) {
      configuredHandler = handler;
    },
    setDisableHandler(handler) {
      disableHandler = handler;
    },
    setEnableHandler(handler) {
      enableHandler = handler;
    },
    setMonotonic(value) {
      monotonicTime = value;
    },
    setWall(value) {
      wallTime = value;
    },
    states
  };
}

function enableSuccess(
  selectedProfileKey: string = profileKey
): TailscaleServeManagerResult {
  return Object.freeze({
    action: "enable",
    outcome: "succeeded",
    serve_result: "applied",
    reason: null,
    command_attempted: true,
    before: snapshot({ selectedProfileKey, serve: "absent" }),
    after: snapshot({ selectedProfileKey, serve: "exact" })
  });
}

function disableSuccess(): TailscaleServeManagerResult {
  return Object.freeze({
    action: "disable",
    outcome: "succeeded",
    serve_result: "removed",
    reason: null,
    command_attempted: true,
    before: snapshot({ serve: "exact" }),
    after: snapshot({ serve: "absent" })
  });
}

function snapshot(input: {
  readonly profile?: "dedicated" | "other";
  readonly selectedProfileKey?: string;
  readonly serve: RemoteIngressObservationSnapshot["serve"];
}): RemoteIngressObservationSnapshot {
  const other = input.profile === "other";
  const selectedProfileKey = input.selectedProfileKey ?? profileKey;
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "available",
    profile: {
      state: other ? "other" : "dedicated",
      comparison: {
        relation: other ? "different" : "match",
        expected_profile_key: selectedProfileKey,
        active_profile_key: other ? otherProfileKey : selectedProfileKey
      }
    },
    serve: other ? null : input.serve,
    external_origin: other ? null : origin,
    failure: null,
    observed_at: observedAt
  });
}

function descriptor(): RemoteServeDescriptor {
  return {
    external_origin: origin,
    https_port: 443,
    path: "/",
    proxy_origin: localOrigin,
    visibility: "private"
  } as RemoteServeDescriptor;
}

function missingClientSnapshot(): RemoteIngressObservationSnapshot {
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "not_installed",
    profile: {
      state: "absent",
      comparison: {
        relation: "missing",
        expected_profile_key: profileKey,
        active_profile_key: null
      }
    },
    serve: null,
    external_origin: null,
    failure: null,
    observed_at: observedAt
  });
}

function enableRequest(index: number): RemoteEnableRequest {
  return remoteEnableRequestSchema.parse({
    operation_id: `op_remote_control_enable_${index.toString().padStart(3, "0")}`,
    confirmed: true
  });
}

function disableRequest(index: number): RemoteDisableRequest {
  return remoteDisableRequestSchema.parse({
    operation_id: `op_remote_control_disable_${index.toString().padStart(3, "0")}`,
    confirmed: true
  });
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}

function auditRecordCount(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM selected_audit_events")
    .get() as { readonly count: number };
  return row.count;
}

function unconfiguredPersistedState(generation: number) {
  const at = "2026-07-13T19:00:01.000Z";
  return remoteIngressStateSchema.parse({
    schema_version: 1,
    generation,
    intent: "disabled",
    availability: "disabled",
    admission: "closed",
    observation: "failed",
    client: "available",
    profile: {
      state: "absent",
      comparison: {
        relation: "unconfigured",
        expected_profile_key: null,
        active_profile_key: null
      }
    },
    serve: null,
    expected_serve: null,
    external_origin: null,
    operation_failure: null,
    reason: null,
    observed_at: null,
    updated_at: at
  });
}
