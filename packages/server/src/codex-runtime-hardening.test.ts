import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeHardeningEvidence,
  parseDeterministicRuntimeReport,
  parseRuntimeHardeningEvidence
} from "./codex-runtime-hardening.js";
import { runtimeHardeningDeterministicTests } from "./codex-runtime-hardening-manifest.js";
import { createStructuredVerticalReport } from "./codex-structured-vertical-report.js";

const commit = "a".repeat(40);
const observedAt = "2026-07-16T12:00:00.000Z";

describe("selected runtime hardening evidence", () => {
  it("accepts the exact deterministic inventory and builds frozen aggregate truth", () => {
    const evidence = createRuntimeHardeningEvidence(validInput());

    expect(evidence).toMatchObject({
      task: "INT-V1-091",
      execution: {
        scenario_count: 6,
        deterministic_file_count: runtimeHardeningDeterministicTests.length,
        total_test_file_count: runtimeHardeningDeterministicTests.length + 6,
        exact_app_server_lifetime_count: 7,
        model_turn_count: 5,
        retry_count: 0
      },
      structured_vertical: {
        managed_thread_count: 2,
        approval_interrupt_compact: true,
        tui_resume: true
      },
      cleanup: {
        process_groups_remaining: 0,
        app_servers_remaining: 0,
        temporary_roots_remaining: 0
      }
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.lifecycle)).toBe(true);
  });

  it("rejects changed files, skipped assertions, foreign paths, and count drift", () => {
    const changed = deterministicReport();
    firstTestResult(changed).name = resolve("packages/core/src/session.test.ts");
    expect(() =>
      parseDeterministicRuntimeReport(changed, process.cwd())
    ).toThrow("Deterministic runtime test inventory differs.");

    const skipped = deterministicReport();
    skipped.numPendingTests = 1 as never;
    expect(() =>
      parseDeterministicRuntimeReport(skipped, process.cwd())
    ).toThrow();

    const foreign = deterministicReport();
    firstTestResult(foreign).name = "/tmp/private.test.ts";
    expect(() =>
      parseDeterministicRuntimeReport(foreign, process.cwd())
    ).toThrow("Deterministic runtime report contains a foreign test path.");

    const drift = deterministicReport();
    drift.numPassedTests += 1;
    drift.numTotalTests += 1;
    expect(() =>
      parseDeterministicRuntimeReport(drift, process.cwd())
    ).toThrow();

    const suiteDrift = deterministicReport();
    suiteDrift.numPassedTestSuites += 1;
    suiteDrift.numTotalTestSuites += 1;
    expect(() =>
      parseDeterministicRuntimeReport(suiteDrift, process.cwd())
    ).toThrow("Deterministic Vitest suite or test counts differ.");
  });

  it("rejects stale child commits, cleanup residue, and malformed final evidence", () => {
    const stale = validInput();
    stale.structured_vertical_report = {
      ...stale.structured_vertical_report,
      hostdeck_commit: "b".repeat(40)
    };
    expect(() => createRuntimeHardeningEvidence(stale)).toThrow(
      "Structured vertical report commit does not match."
    );

    const dirty = validInput();
    dirty.outer_cleanup.process_groups_remaining = 1 as never;
    expect(() => createRuntimeHardeningEvidence(dirty)).toThrow();

    const evidence = createRuntimeHardeningEvidence(validInput());
    expect(() =>
      parseRuntimeHardeningEvidence({ ...evidence, private_path: "/tmp/x" })
    ).toThrow();
  });
});

function validInput() {
  return {
    observed_at: observedAt,
    hostdeck_commit: commit,
    repository_root: process.cwd(),
    deterministic_report: deterministicReport(),
    structured_vertical_report: createStructuredVerticalReport({
      observed_at: observedAt,
      hostdeck_commit: commit,
      duration_ms: 30_000,
      request_count: 58,
      notification_count: 137,
      observer_count: 121,
      durable_publication_count: 117
    }),
    lifecycle_evidence: lifecycleEvidence(),
    outer_cleanup: {
      process_groups_remaining: 0 as const,
      special_files_remaining: 0 as const,
      temporary_roots_remaining: 0 as const,
      child_reports_remaining: 0 as const
    }
  };
}

function deterministicReport() {
  const testResults = runtimeHardeningDeterministicTests.map((path) => ({
    assertionResults: [
      {
        ancestorTitles: ["runtime hardening"],
        duration: 1,
        failureMessages: [],
        fullName: `runtime hardening ${path}`,
        meta: {},
        status: "passed" as const,
        tags: [],
        title: path
      }
    ],
    endTime: 2.5,
    message: "" as const,
    name: resolve(path),
    startTime: 1.25,
    status: "passed" as const
  }));
  const suiteCount = testResults.length * 2;
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: suiteCount,
    numPassedTests: testResults.length,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: suiteCount,
    numTotalTests: testResults.length,
    snapshot: {
      added: 0,
      failure: false,
      filesAdded: 0,
      filesRemoved: 0,
      filesRemovedList: [],
      filesUnmatched: 0,
      filesUpdated: 0,
      matched: 0,
      total: 0,
      unchecked: 0,
      uncheckedKeysByFile: [],
      unmatched: 0,
      updated: 0,
      didUpdate: false
    },
    startTime: 1,
    success: true,
    testResults
  };
}

function firstTestResult(report: ReturnType<typeof deterministicReport>) {
  const result = report.testResults.at(0);
  if (result === undefined) {
    throw new Error("Deterministic test fixture must not be empty.");
  }
  return result;
}

function lifecycleEvidence() {
  return {
    schema_version: 1,
    task: "INT-V1-032",
    observed_at: observedAt,
    hostdeck_commit: commit,
    runtime: {
      version: "0.144.0",
      exact_binding: true,
      exact_scenario_count: 3,
      exact_app_server_lifetime_count: 6
    },
    execution: {
      scenario_count: 4,
      test_file_count: 5,
      deterministic_test_count: 2,
      model_turn_count: 2,
      retry_count: 0
    },
    clients: {
      hostdeck_os_process_count: 4,
      hostdeck_connection_count: 2,
      tui_process_count: 2,
      foreground_runtime_count: 3,
      service_runtime_count: 2
    },
    lifecycle: {
      foreground_ownership: true,
      service_nonownership: true,
      duplicate_owner_rejected: true,
      reconnect_backoff_and_cancellation: true,
      crash_reconciliation: true,
      hostdeck_restart_continuity: true,
      approval_and_incomplete_truth: true,
      continuity_boundaries: true,
      tui_multi_client_coexistence: true,
      mutation_replay_absent: true
    },
    integrity: {
      exact_restart_boundary_count: 1,
      exact_no_override_resume_count: 1,
      coexistence_pipeline_failure_count: 0,
      coexistence_duplicate_turn_event_count: 0,
      coexistence_foreign_mapping_count: 0,
      coexistence_publication_count: 37,
      coexistence_retained_event_count: 37,
      maximum_inbound_message_bytes: 2_951_421
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_socket_identity: false,
      contains_thread_or_turn_id: false,
      contains_process_command: false,
      contains_session_or_request_id: false,
      contains_model_prompt_tui_output_or_auth: false,
      contains_raw_protocol_audit_or_error: false
    },
    cleanup: {
      process_groups_remaining: 0,
      app_servers_remaining: 0,
      tui_processes_remaining: 0,
      tmux_sockets_remaining: 0,
      unix_sockets_remaining: 0,
      temporary_roots_remaining: 0,
      child_reports_remaining: 0
    }
  };
}
