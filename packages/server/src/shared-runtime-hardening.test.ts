import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSharedRuntimeHardeningEvidence,
  parseSharedRuntimeHardeningEvidence,
  parseSharedRuntimeRealReport
} from "./shared-runtime-hardening.js";
import { sharedRuntimeHardeningDeterministicTests } from "./shared-runtime-hardening-manifest.js";

describe("shared runtime hardening evidence", () => {
  it("accepts only the exact deterministic inventory and strict real report", () => {
    const repositoryRoot = process.cwd();
    const commit = "a".repeat(40);
    const evidence = createSharedRuntimeHardeningEvidence({
      observed_at: "2026-08-15T18:00:00.000Z",
      hostdeck_commit: commit,
      repository_root: repositoryRoot,
      deterministic_report: deterministicReport(repositoryRoot),
      real_report: realReport(commit),
      cleanup: zeroCleanup()
    });

    expect(evidence.task).toBe("INT-V1-114");
    expect(evidence.execution).toMatchObject({
      deterministic_file_count: 32,
      deterministic_test_count: 32,
      project_count: 3,
      native_thread_count: 3,
      retry_count: 0
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(parseSharedRuntimeHardeningEvidence(evidence)).toEqual(evidence);
  });

  it("rejects commit, privacy, cleanup, count, and inventory drift", () => {
    const repositoryRoot = process.cwd();
    const commit = "b".repeat(40);
    const validReal = realReport(commit);
    expect(() =>
      createSharedRuntimeHardeningEvidence({
        observed_at: "2026-08-15T18:00:00.000Z",
        hostdeck_commit: "c".repeat(40),
        repository_root: repositoryRoot,
        deterministic_report: deterministicReport(repositoryRoot),
        real_report: validReal,
        cleanup: zeroCleanup()
      })
    ).toThrow("commit differs");
    expect(() =>
      parseSharedRuntimeRealReport({
        ...validReal,
        privacy: {
          ...validReal.privacy,
          contains_native_or_internal_id: true
        }
      })
    ).toThrow();
    expect(() =>
      parseSharedRuntimeRealReport({
        ...validReal,
        cleanup: {
          ...validReal.cleanup,
          tmux_servers_remaining: 1
        }
      })
    ).toThrow();
    const wrongCount = deterministicReport(repositoryRoot);
    wrongCount.numTotalTests += 1;
    expect(() =>
      createSharedRuntimeHardeningEvidence({
        observed_at: "2026-08-15T18:00:00.000Z",
        hostdeck_commit: commit,
        repository_root: repositoryRoot,
        deterministic_report: wrongCount,
        real_report: validReal,
        cleanup: zeroCleanup()
      })
    ).toThrow("counts differ");
    const wrongInventory = deterministicReport(repositoryRoot);
    const first = wrongInventory.testResults[0];
    if (first === undefined) throw new TypeError("Fixture is empty.");
    first.name = resolve(repositoryRoot, "packages/server/src/foreign.test.ts");
    expect(() =>
      createSharedRuntimeHardeningEvidence({
        observed_at: "2026-08-15T18:00:00.000Z",
        hostdeck_commit: commit,
        repository_root: repositoryRoot,
        deterministic_report: wrongInventory,
        real_report: validReal,
        cleanup: zeroCleanup()
      })
    ).toThrow("inventory differs");
  });
});

function deterministicReport(repositoryRoot: string) {
  const testResults = sharedRuntimeHardeningDeterministicTests.map((path, index) => ({
    assertionResults: [
      {
        ancestorTitles: ["shared runtime"],
        duration: 1,
        failureMessages: [],
        fullName: `shared runtime ${String(index)}`,
        meta: {},
        status: "passed",
        tags: [],
        title: `case ${String(index)}`
      }
    ],
    endTime: index + 2.875,
    message: "",
    name: resolve(repositoryRoot, path),
    startTime: index + 1.125,
    status: "passed"
  }));
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: testResults.length,
    numPassedTests: testResults.length,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: testResults.length,
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

function realReport(commit: string) {
  return {
    schema_version: 1,
    task: "INT-V1-114-real",
    hostdeck_commit: commit,
    runtime: {
      runtime_version: "0.148.0",
      standard_socket: true,
      socket_mode: 0o600
    },
    execution: {
      project_count: 3,
      loaded_before_count: 2,
      created_after_count: 1,
      resumed_existing_count: 1,
      enrolled_count: 3,
      reconnect_enrolled_count: 3,
      hostdeck_connection_count: 2,
      tui_lifetime_count: 4,
      turn_start_count: 0,
      retry_count: 0
    },
    continuity: {
      broker_pid_stable_after_hostdeck_detach: true,
      socket_inode_stable_after_hostdeck_detach: true,
      loaded_tui_survived_hostdeck_detach: true,
      native_resume_identity_preserved: true
    },
    integrity: {
      unique_mapping_count: 3,
      unique_native_identity_count: 3,
      catalog_session_count: 3,
      catalog_ordered: true,
      protocol_issue_count: 0,
      enrollment_failure_count: 0,
      desktop_window_process_count: 0,
      superseded_command_count: 0
    },
    privacy: {
      contains_native_or_internal_id: false,
      contains_path_or_socket: false,
      contains_pid_or_process_identity: false,
      contains_prompt_goal_or_transcript: false,
      contains_credential_or_raw_protocol: false
    },
    cleanup: zeroCleanup()
  };
}

function zeroCleanup() {
  return {
    app_servers_remaining: 0,
    browser_processes_remaining: 0,
    temporary_roots_remaining: 0,
    tmux_servers_remaining: 0,
    tui_processes_remaining: 0,
    unix_sockets_remaining: 0
  };
}
