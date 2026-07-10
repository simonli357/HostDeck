import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";

const reportFiles = [
  "../../../artifacts/int-v1-006-goal-activation-observation.json",
  "../../../artifacts/int-v1-006-plan-approval-observation.json",
  "../../../artifacts/int-v1-006-control-observation.json"
] as const;

describe("INT-V1-006 redacted exact-Codex evidence", () => {
  const reports = reportFiles.map((path) => readReport(path));

  it("is pinned, bounded, redacted, structurally valid, and fully cleaned", () => {
    expect(reports).toHaveLength(3);
    expect(reports.reduce((total, report) => total + report.wire.total_frames, 0)).toBe(612);
    expect(reports.reduce((total, report) => total + report.wire.malformed_frames, 0)).toBe(0);

    for (const report of reports) {
      expect(report).toMatchObject({
        task: "INT-V1-006",
        codex_version: "0.144.0",
        binding_id: codexBindingDescriptor.binding_id,
        isolation: {
          copied_auth_file_only: true,
          codex_home_temporary: true,
          private_unix_socket: true,
          repositories: 2,
          report_contains_prompt_or_output_content: false
        },
        cleanup: {
          connection_closed: true,
          recorder_disposed: true,
          app_server_stopped: true,
          temporary_root_removed: true
        }
      });
      const serialized = JSON.stringify(report);
      for (const forbidden of [
        "Complete the bounded HostDeck semantic probe",
        "Produce a concise two-step plan",
        "private prompt body",
        "hostdeck-codex-semantics-",
        "sleep 45"
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it("covers every selected operation and the exact observed event catalog", () => {
    const methods = aggregateMethods(reports);
    expect(methods).toEqual(
      expect.arrayContaining([
        "account/usage/read",
        "collaborationMode/list",
        "item/agentMessage/delta",
        "item/commandExecution/requestApproval",
        "item/completed",
        "item/plan/delta",
        "item/started",
        "model/list",
        "serverRequest/resolved",
        "skills/list",
        "thread/compact/start",
        "thread/goal/clear",
        "thread/goal/get",
        "thread/goal/set",
        "thread/resume",
        "thread/settings/updated",
        "thread/tokenUsage/updated",
        "turn/completed",
        "turn/interrupt",
        "turn/start",
        "turn/started",
        "turn/steer"
      ])
    );
    expect(methods).not.toContain("hostdeck/unsupported-operation");
  });

  it("proves plan and exactly-once real approval semantics", () => {
    const report = reports[1];
    expect(report?.failure).toMatchObject({ stage: "steer_tui_disconnect_interrupt_turn", code: "remote_error" });
    expect(report?.facts).toMatchObject({
      plan_mode_observed: true,
      default_mode_after_plan_observed: true,
      approval_declined_once: true,
      approval_accepted_once: true,
      duplicate_approval_rejected_locally: true,
      approved_side_effect_present: true,
      denied_side_effect_absent: true
    });
    expect(operation(report, "stale_steer")).toMatchObject({ outcome: "remote_rejected" });
    expect(operation(report, "completed_turn_interrupt")).toMatchObject({ outcome: "remote_rejected" });
    expect(operation(report, "unknown_method")).toMatchObject({ outcome: "local_rejected" });
    expect(report?.actual).toMatchObject({ model_turns_started: 4, observed_turns_started: 4, no_automatic_model_retry: true });
  });

  it("proves event-gated steer, model persistence, TUI coexistence, reconnect, and interrupt", () => {
    const report = reports[2];
    expect(report?.failure).toMatchObject({ stage: "manual_compaction", message_redacted: true });
    expect(report?.facts).toMatchObject({
      model_override_read_back: false,
      turn_model_override_read_back: true,
      tui_and_hostdeck_concurrent: true,
      reconnect_generation_advanced: true,
      interrupted_not_archived: true,
      second_thread_unchanged_by_thread_a_turn: true
    });
    expect(operation(report, "turn_steer_tui_disconnect_interrupt")).toMatchObject({
      outcome: "supported",
      details: {
        steer_same_turn_id: true,
        second_turn_started_by_steer: false,
        accepted_turn_survived_client_disconnect: true,
        final_status: "interrupted",
        archived: false
      }
    });
    expect(report?.actual).toMatchObject({ model_turns_started: 1, observed_turns_started: 2, compactions_started: 1 });
  });

  it("proves active goals are agentic and compact acceptance is not completion", () => {
    const goalReport = reports[0];
    const controlReport = reports[2];
    expect(countMethod(goalReport, "turn/started")).toBe(2);
    expect(goalReport?.actual.model_turns_started).toBe(1);
    expect(countMethod(controlReport, "thread/compact/start", "client_response")).toBe(1);
    expect(countMethod(controlReport, "item/started", "server_notification", "contextCompaction")).toBe(1);
    expect(countMethod(controlReport, "item/completed", "server_notification", "contextCompaction")).toBe(0);
    expect(countMethod(controlReport, "turn/started")).toBe(2);
    expect(countMethod(controlReport, "turn/completed")).toBe(1);
  });
});

interface EvidenceReport {
  readonly task: string;
  readonly codex_version: string;
  readonly binding_id: string;
  readonly isolation: Record<string, unknown>;
  readonly actual: Record<string, unknown>;
  readonly facts: Record<string, unknown>;
  readonly operations: ReadonlyArray<Record<string, unknown>>;
  readonly cleanup: Record<string, unknown>;
  readonly failure: Record<string, unknown> | null;
  readonly wire: {
    readonly total_frames: number;
    readonly malformed_frames: number;
    readonly aggregates: readonly WireAggregate[];
  };
}

interface WireAggregate {
  readonly kind: string;
  readonly method: string | null;
  readonly count: number;
  readonly sample: { readonly tags: Readonly<Record<string, readonly string[]>> };
}

function readReport(path: string): EvidenceReport {
  const candidate = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as unknown;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Semantic evidence ${path} must be an object.`);
  }
  return candidate as EvidenceReport;
}

function aggregateMethods(reports: readonly EvidenceReport[]): readonly string[] {
  return [
    ...new Set(
      reports.flatMap((report) =>
        report.wire.aggregates.flatMap((aggregate) => (aggregate.method === null ? [] : [aggregate.method]))
      )
    )
  ].sort();
}

function operation(report: EvidenceReport | undefined, name: string): Record<string, unknown> | undefined {
  return report?.operations.find((candidate) => candidate.operation === name);
}

function countMethod(
  report: EvidenceReport | undefined,
  method: string,
  kind?: string,
  requiredTypeTag?: string
): number {
  return (
    report?.wire.aggregates
      .filter(
        (aggregate) =>
          aggregate.method === method &&
          (kind === undefined || aggregate.kind === kind) &&
          (requiredTypeTag === undefined || aggregate.sample.tags.type?.includes(requiredTypeTag) === true)
      )
      .reduce((total, aggregate) => total + aggregate.count, 0) ?? 0
  );
}
