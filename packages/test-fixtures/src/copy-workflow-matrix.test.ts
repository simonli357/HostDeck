import { describe, expect, it } from "vitest";
import {
  canonicalSessionStatusLabels,
  copyOutcomeSemanticsIds,
  copyWorkflowInteractionCoverageLedger,
  copyWorkflowStateCoverageLedger,
  forbiddenProductSurfaceIds,
  interactionCopyPolicies,
  mobileWorkflowPathIds,
  mobileWorkflowPaths,
  stateOutcomeSemanticsById
} from "./copy-workflow-matrix.js";
import {
  mobileInteractionIds,
  mobileInteractionTraces,
  mobileJourneyIds,
  mobileStateTraceIds,
  mobileStateTraces,
  mobileSurfaceIds
} from "./mobile-design-contract.js";

describe("FE-V1-018 copy and workflow matrix", () => {
  it("classifies every canonical state exactly once without changing source order", () => {
    expect(copyWorkflowStateCoverageLedger.map(({ id }) => id)).toEqual(mobileStateTraceIds);
    expect(Object.keys(stateOutcomeSemanticsById).sort()).toEqual([...mobileStateTraceIds].sort());
    expect(new Set(copyWorkflowStateCoverageLedger.map(({ id }) => id)).size).toBe(
      mobileStateTraceIds.length
    );
    expect(covered(copyWorkflowStateCoverageLedger.map(({ surface }) => surface))).toEqual(
      covered(mobileSurfaceIds)
    );
    expect(covered(copyWorkflowStateCoverageLedger.flatMap(({ journeys }) => journeys))).toEqual(
      covered(mobileJourneyIds)
    );
    expect(covered(copyWorkflowStateCoverageLedger.map(({ outcomeSemantics }) => outcomeSemantics))).toEqual(
      covered(copyOutcomeSemanticsIds)
    );
  });

  it("keeps accepted, running, terminal, interrupted, failed, and unknown outcomes distinct", () => {
    expect(semantics("composer_accepted")).toBe("accepted");
    expect(semantics("composer_running")).toBe("running");
    expect(semantics("composer_completed")).toBe("terminal_success");
    expect(semantics("compact_accepted")).toBe("accepted");
    expect(semantics("compact_running")).toBe("running");
    expect(semantics("compact_completed")).toBe("terminal_success");
    expect(semantics("detail_interrupted")).toBe("terminal_interrupted");
    expect(semantics("detail_failed")).toBe("terminal_failure");
    expect(semantics("detail_unknown")).toBe("unknown");

    for (const id of ["composer_accepted", "composer_running", "compact_accepted", "compact_running"] as const) {
      const entry = stateEntry(id);
      expect(entry.recoveryOwner).toBe("hostdeck_observation");
      expect(entry.attemptPolicy).toBe("wait_for_observation");
    }
  });

  it("assigns every interaction one explicit copy, result, retry, and recovery policy", () => {
    expect(copyWorkflowInteractionCoverageLedger.map(({ id }) => id)).toEqual(mobileInteractionIds);
    expect(Object.keys(interactionCopyPolicies).sort()).toEqual([...mobileInteractionIds].sort());
    expect(new Set(copyWorkflowInteractionCoverageLedger.map(({ id }) => id)).size).toBe(
      mobileInteractionIds.length
    );

    for (const entry of copyWorkflowInteractionCoverageLedger) {
      expect(entry.automaticRetry, entry.id).toBe(false);
      expect(entry.journeys.length, entry.id).toBeGreaterThan(0);
      if (entry.mutation && entry.surface !== "local_only") {
        expect(
          ["mutation_no_resend_until_observed", "local_action_only"],
          entry.id
        ).toContain(entry.attemptPolicy);
      }
      if (entry.technicalLanguagePolicy === "local_handoff") {
        expect(
          entry.surface === "local_only" ||
            entry.id === "read_resume_metadata" ||
            entry.id === "copy_resume_command"
        ).toBe(true);
      }
      if (entry.technicalLanguagePolicy === "bounded_diagnostic") {
        expect(entry.id).toBe("read_event_details");
      }
    }
  });

  it("defines ordered success and recovery paths for all twelve journeys", () => {
    expect(mobileWorkflowPaths.map(({ id }) => id)).toEqual(mobileWorkflowPathIds);
    expect(covered(mobileWorkflowPaths.map(({ journey }) => journey))).toEqual(covered(mobileJourneyIds));
    expect(covered(mobileWorkflowPaths.flatMap(({ interactionIds }) => interactionIds))).toEqual(
      covered(mobileInteractionIds)
    );

    const traceById = new Map(mobileStateTraces.map((trace) => [trace.id, trace] as const));
    for (const path of mobileWorkflowPaths) {
      expect(path.interactionIds.length, path.id).toBeGreaterThan(0);
      expect(path.successStateIds.length, path.id).toBeGreaterThan(0);
      expect(path.recoveryStateIds.length, path.id).toBeGreaterThan(0);
      expect(new Set(path.interactionIds).size, path.id).toBe(path.interactionIds.length);
      for (const id of [...path.successStateIds, ...path.recoveryStateIds]) {
        const trace = traceById.get(id);
        expect(trace, `${path.id}:${id}`).toBeDefined();
        if (path.successStateIds.includes(id)) {
          expect(trace?.journeys, `${path.id}:${id}`).toContain(path.journey);
        } else {
          expect(
            trace?.journeys.some(
              (journey) => journey === path.journey || journey === "UX-009"
            ),
            `${path.id}:${id}`
          ).toBe(true);
        }
      }
    }
  });

  it("freezes phone-first product vocabulary and bounded technical exceptions", () => {
    expect(canonicalSessionStatusLabels).toEqual([
      "Needs approval",
      "Needs input",
      "Running",
      "Quiet",
      "Interrupted",
      "Failed",
      "Unknown",
      "Stale"
    ]);
    expect(new Set(canonicalSessionStatusLabels).size).toBe(canonicalSessionStatusLabels.length);
    expect(forbiddenProductSurfaceIds).toEqual([
      "desktop_console",
      "terminal_emulator",
      "arbitrary_shell",
      "editor",
      "file_tree",
      "git_review",
      "storage_console",
      "raw_protocol_viewer",
      "tailscale_profile_switcher",
      "direct_app_server_client"
    ]);

    for (const entry of copyWorkflowStateCoverageLedger) {
      if (entry.technicalLanguagePolicy === "external_browser") {
        expect(entry.evidenceBoundary).toBe("browser_preload");
      }
      if (entry.technicalLanguagePolicy === "bounded_diagnostic") {
        expect(entry.surface).toBe("event_details");
      }
    }
  });

  it("keeps dangerous actions exact, confirmed, and non-retrying", () => {
    const traceById = new Map(mobileInteractionTraces.map((trace) => [trace.id, trace] as const));
    const expectations = {
      interrupt_turn: "turn",
      archive_session: "session",
      revoke_device: "device",
      lock_host: "host"
    } as const;
    for (const [id, target] of Object.entries(expectations)) {
      const trace = traceById.get(id as keyof typeof expectations);
      const entry = interactionEntry(id as keyof typeof expectations);
      expect(trace?.confirmation).toBe("always");
      expect(entry.exactTarget).toBe(target);
      expect(entry.attemptPolicy).toBe("mutation_no_resend_until_observed");
      expect(entry.resultSemantics).toBe("terminal_decision");
    }
  });

  it("keeps browser-preload and local-laptop recovery outside app authority", () => {
    for (const id of ["preload_phone_network_unavailable", "preload_remote_origin_unreachable"] as const) {
      const entry = stateEntry(id);
      expect(entry.evidenceBoundary).toBe("browser_preload");
      expect(entry.technicalLanguagePolicy).toBe("external_browser");
      expect(entry.recoveryOwner).toBe("browser_or_tailscale");
    }
    for (const id of [
      "create_pairing_link",
      "enable_remote_local",
      "disable_remote_local",
      "switch_tailscale_profile_local",
      "unlock_host_local"
    ] as const) {
      const entry = interactionEntry(id);
      expect(entry.surface).toBe("local_only");
      expect(entry.recoveryOwner).toBe("local_laptop");
      expect(entry.attemptPolicy).toBe("local_action_only");
    }
  });
});

function semantics(id: (typeof mobileStateTraceIds)[number]) {
  return stateOutcomeSemanticsById[id];
}

function stateEntry(id: (typeof mobileStateTraceIds)[number]) {
  const entry = copyWorkflowStateCoverageLedger.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new TypeError(`Missing copy/workflow state ${id}.`);
  return entry;
}

function interactionEntry(id: (typeof mobileInteractionIds)[number]) {
  const entry = copyWorkflowInteractionCoverageLedger.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new TypeError(`Missing copy/workflow interaction ${id}.`);
  return entry;
}

function covered<Value extends string>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)].sort();
}
