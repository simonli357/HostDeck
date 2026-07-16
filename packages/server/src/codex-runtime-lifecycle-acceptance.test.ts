import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeLifecycleAcceptanceEvidence,
  lifecycleIntegrationTests,
  parseRuntimeLifecycleAcceptanceEvidence,
  parseSupervisorScenarioEvidence
} from "./codex-runtime-lifecycle-acceptance.js";

const commit = "a".repeat(40);
const observedAt = "2026-07-16T18:00:00.000Z";

describe("selected runtime lifecycle acceptance evidence", () => {
  it("accepts only the fixed coherent scenario map and freezes the aggregate", () => {
    const evidence = createRuntimeLifecycleAcceptanceEvidence(validInput());

    expect(evidence).toMatchObject({
      task: "INT-V1-032",
      hostdeck_commit: commit,
      runtime: {
        version: "0.144.0",
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
      cleanup: {
        process_groups_remaining: 0,
        app_servers_remaining: 0,
        tui_processes_remaining: 0,
        tmux_sockets_remaining: 0,
        unix_sockets_remaining: 0,
        temporary_roots_remaining: 0,
        child_reports_remaining: 0
      }
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.lifecycle)).toBe(true);
    expect(parseRuntimeLifecycleAcceptanceEvidence(evidence)).toEqual(evidence);
  });

  it("rejects extra, missing, and contradictory supervisor facts", () => {
    const extra = { ...supervisorReport(), private_detail: "forbidden" };
    expect(() => parseSupervisorScenarioEvidence(extra, commit)).toThrow(
      "Invalid supervisor lifecycle evidence."
    );

    const missing = supervisorReport() as Record<string, unknown>;
    delete missing.cleanup;
    expect(() => parseSupervisorScenarioEvidence(missing, commit)).toThrow(
      "Invalid supervisor lifecycle evidence."
    );

    const signaled = supervisorReport();
    signaled.service_owned.hostdeck_signal_count = 1 as never;
    expect(() => parseSupervisorScenarioEvidence(signaled, commit)).toThrow(
      "Invalid supervisor lifecycle evidence."
    );
  });

  it.each(["supervisor_report", "restart_report", "coexistence_report"] as const)(
    "rejects a stale commit in %s",
    (key) => {
      const input = validInput();
      (input[key] as { hostdeck_commit: string }).hostdeck_commit = "b".repeat(40);
      expect(() => createRuntimeLifecycleAcceptanceEvidence(input)).toThrow(
        "report is from a different commit"
      );
    }
  );

  it("rejects changed deterministic files, tests, or counts", () => {
    const changedFile = validInput();
    const firstFile = changedFile.vitest_report.testResults.at(0);
    if (firstFile === undefined) throw new Error("Missing fixture file.");
    firstFile.name = resolve(
      "tests/substitute.integration.test.ts"
    );
    expect(() => createRuntimeLifecycleAcceptanceEvidence(changedFile)).toThrow(
      "fixed files"
    );

    const changedTitle = validInput();
    const firstAssertion = changedTitle.vitest_report.testResults
      .at(0)
      ?.assertionResults.at(0);
    if (firstAssertion === undefined) throw new Error("Missing fixture assertion.");
    firstAssertion.title = "substitute test";
    expect(() => createRuntimeLifecycleAcceptanceEvidence(changedTitle)).toThrow(
      "fixed tests"
    );

    const changedCount = validInput();
    changedCount.vitest_report.numPassedTests = 1 as never;
    expect(() => createRuntimeLifecycleAcceptanceEvidence(changedCount)).toThrow(
      "Invalid Vitest lifecycle evidence."
    );
  });

  it("rejects coexistence publication drift and unsafe message bounds", () => {
    const publicationDrift = validInput();
    publicationDrift.coexistence_report.integrity.retained_event_count = 36;
    expect(() =>
      createRuntimeLifecycleAcceptanceEvidence(publicationDrift)
    ).toThrow("Invalid coexistence lifecycle evidence.");

    const oversized = validInput();
    oversized.coexistence_report.runtime.maximum_inbound_message_bytes =
      8_388_609;
    expect(() => createRuntimeLifecycleAcceptanceEvidence(oversized)).toThrow(
      "Invalid coexistence lifecycle evidence."
    );

    const retried = validInput();
    retried.restart_report.service_owned.mutation_retry_count = 1 as never;
    expect(() => createRuntimeLifecycleAcceptanceEvidence(retried)).toThrow(
      "Invalid restart lifecycle evidence."
    );
  });

  it("rejects incomplete outer cleanup and malformed final evidence", () => {
    const dirty = validInput();
    dirty.outer_cleanup.temporary_roots_remaining = 1 as never;
    expect(() => createRuntimeLifecycleAcceptanceEvidence(dirty)).toThrow(
      "Invalid cleanup lifecycle evidence."
    );

    const evidence = createRuntimeLifecycleAcceptanceEvidence(validInput());
    expect(() =>
      parseRuntimeLifecycleAcceptanceEvidence({
        ...evidence,
        retained_private_path: "/private"
      })
    ).toThrow("Invalid aggregate lifecycle evidence.");
  });
});

function validInput() {
  return {
    observed_at: observedAt,
    hostdeck_commit: commit,
    repository_root: process.cwd(),
    vitest_report: vitestReport(),
    supervisor_report: supervisorReport(),
    restart_report: restartReport(),
    coexistence_report: coexistenceReport(),
    outer_cleanup: {
      process_groups_remaining: 0 as const,
      special_files_remaining: 0 as const,
      temporary_roots_remaining: 0 as const,
      child_reports_remaining: 0 as const
    }
  };
}

function vitestReport() {
  const titles = [
    "orders real approval supersession, read-only reconciliation, resubscription, and write readmission",
    "reconciles audit, turn, approval, boundary, held-event, model, mode, and write-admission truth"
  ];
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 4,
    numPassedTests: 2,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 4,
    numTotalTests: 2,
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
    testResults: lifecycleIntegrationTests.map((path, index) => ({
      assertionResults: [
        {
          ancestorTitles: ["fixed integration"],
          duration: 1,
          failureMessages: [],
          fullName: `fixed integration ${titles[index]}`,
          meta: {},
          status: "passed" as const,
          tags: [],
          title: titles[index] as string
        }
      ],
      endTime: 2.75,
      message: "" as const,
      name: resolve(path),
      startTime: 1.25,
      status: "passed" as const
    }))
  };
}

function supervisorReport() {
  return {
    schema_version: 1,
    scenario: "exact_supervisor",
    observed_at: observedAt,
    hostdeck_commit: commit,
    runtime: {
      version: "0.144.0",
      exact_binding: true,
      app_server_process_count: 2
    },
    foreground_child: {
      compatibility_ready: true,
      runtime_process_count: 1,
      owned_runtime_exit_count: 1,
      owned_socket_cleanup_count: 1
    },
    service_owned: {
      compatibility_ready: true,
      runtime_process_count: 1,
      hostdeck_spawn_count: 0,
      hostdeck_signal_count: 0,
      sibling_survived_hostdeck_close: true,
      outer_owner_stopped_runtime: true,
      owned_socket_cleanup_count: 1
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_socket_identity: false,
      contains_thread_or_turn_id: false,
      contains_model_prompt_output_or_auth: false
    },
    cleanup: {
      app_server_processes_remaining: 0,
      unix_sockets_remaining: 0,
      temporary_roots_remaining: 0
    }
  };
}

function restartReport() {
  return {
    schema_version: 1,
    task: "INT-V1-030",
    observed_at: observedAt,
    hostdeck_commit: commit,
    process_boundary: {
      hostdeck_process_count: 4,
      hostdeck_processes_distinct: true
    },
    runtime: {
      version: "0.144.0",
      exact_binding: true,
      service_runtime_pid_stable: true,
      service_socket_identity_stable: true,
      foreground_runtime_pid_replaced: true,
      foreground_socket_identity_replaced: true
    },
    service_owned: {
      hostdeck_process_count: 2,
      hostdeck_processes_distinct: true,
      lease_contention_proven: true,
      lease_reacquired: true,
      runtime_spawn_count_by_hostdeck: 0,
      runtime_signal_count_by_hostdeck: 0,
      managed_thread_identity_stable: true,
      active_turn_identity_stable: true,
      active_turn_observed_after_restart: true,
      completion_observed_after_restart: true,
      restart_boundary_count: 1,
      no_override_resume_count: 1,
      ready_count: 1,
      turn_start_request_count: 1,
      model_turn_count: 1,
      mutation_retry_count: 0
    },
    foreground_child: {
      hostdeck_process_count: 2,
      hostdeck_processes_distinct: true,
      lease_contention_proven: true,
      lease_reacquired: true,
      runtime_process_count: 2,
      runtime_processes_distinct: true,
      owned_runtime_exit_count: 2,
      owned_socket_cleanup_count: 2
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_socket_identity: false,
      contains_thread_or_turn_id: false,
      contains_model_prompt_output_or_auth: false
    },
    cleanup: {
      workers_remaining: 0,
      foreground_runtimes_remaining: 0,
      foreground_sockets_remaining: 0,
      service_runtime_stopped_by_outer_owner: true,
      service_socket_remaining: false,
      temporary_root_removed: true
    }
  };
}

function coexistenceReport() {
  return {
    schema_version: 1,
    task: "INT-V1-031",
    observed_at: observedAt,
    hostdeck_commit: commit,
    runtime: {
      version: "0.144.0",
      exact_binding: true,
      app_server_process_count: 1,
      app_server_identity_stable: true,
      private_unix_socket_stable: true,
      maximum_inbound_message_bytes: 2_951_421
    },
    clients: {
      hostdeck_connection_count: 2,
      tui_process_count: 2,
      tui_processes_distinct: true,
      managed_thread_identity_stable: true,
      managed_cwd_identity_stable: true
    },
    shared_turn: {
      model_turn_count: 1,
      turn_start_request_count: 1,
      normalized_start_count: 1,
      normalized_completion_count: 1,
      durable_turn_event_count: 2,
      started_while_tui_alive: true,
      tui_rendered_shared_turn: true,
      completed_after_tui_close: true,
      marker_start_and_finish_observed: true
    },
    teardown: {
      tui_close_preserved_hostdeck_generation: true,
      tui_close_preserved_hostdeck_pipeline: true,
      hostdeck_close_preserved_tui: true,
      hostdeck_close_preserved_runtime: true,
      replacement_hostdeck_read_same_thread: true,
      second_tui_close_preserved_hostdeck: true
    },
    integrity: {
      pipeline_failure_count: 0,
      replay_boundary_count: 0,
      duplicate_turn_event_count: 0,
      unmanaged_observation_count: 4,
      durable_mapping_count: 1,
      foreign_mapping_count: 0,
      publication_count: 37,
      retained_event_count: 37
    },
    privacy: {
      contains_pid: false,
      contains_path: false,
      contains_socket_identity: false,
      contains_thread_or_turn_id: false,
      contains_model_prompt_tui_output_or_auth: false
    },
    cleanup: {
      tui_processes_remaining: 0,
      tmux_sockets_remaining: 0,
      hostdeck_connections_closed: 2,
      runtime_threads_archived: 2,
      database_closed: true,
      app_server_stopped_by_outer_owner: true,
      app_server_socket_remaining: false,
      temporary_root_removed: true
    }
  };
}
