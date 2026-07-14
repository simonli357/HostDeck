import {
  apiErrorEnvelopeSchema,
  goalControlSnapshotSchema,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  pendingApprovalSchema,
  planControlSnapshotSchema,
  projectRemoteIngressPublicState,
  remoteIngressPublicStateSchema,
  remoteIngressStateSchema,
  remotePairingLinkIntentSchema,
  requestIngressProvenanceSchema,
  selectedAccessStateResponseSchema,
  selectedControlStateSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedDeviceListResponseSchema,
  selectedDeviceRevokeResponseSchema,
  selectedEventDiagnosticsSchema,
  selectedHostAccessSchema,
  selectedHostLockStateResponseSchema,
  selectedLaptopResumeSchema,
  selectedMissionControlViewModelSchema,
  selectedOperationDispatchSchema,
  selectedOperationProgressSchema,
  selectedOperationTerminalOutcomeSchema,
  selectedPairClaimResponseSchema,
  selectedPairRequestResponseSchema,
  selectedPromptControlSchema,
  selectedSessionDetailViewModelSchema,
  selectedSessionEventStreamSchema,
  skillsSnapshotSchema,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  type MobileContractId,
  type MobileFixtureReference,
  mobileContractIds,
  mobileDownstreamTaskIds,
  mobileInteractionIds,
  mobileInteractionTraces,
  mobileJourneyIds,
  mobileReferenceViewports,
  mobileRouteIds,
  mobileStateTraceIds,
  mobileStateTraces,
  mobileSurfaceIds
} from "./mobile-design-contract.js";
import {
  remoteIngressFixtureById,
  remotePairingLinkFixture,
  requiredRemoteIngressFixtureIds
} from "./remote-ingress.js";
import {
  requiredSelectedMobileFixtureIds,
  requiredStructuredRuntimeFixtureIds,
  selectedMobileFixtureById,
  structuredRuntimeFixtureById
} from "./structured-runtime.js";

interface SafeParser {
  safeParse(value: unknown): { readonly success: boolean };
}

const contractRegistry: Record<MobileContractId, SafeParser> = {
  apiErrorEnvelopeSchema,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  goalControlSnapshotSchema,
  planControlSnapshotSchema,
  pendingApprovalSchema,
  remoteIngressPublicStateSchema,
  remotePairingLinkIntentSchema,
  requestIngressProvenanceSchema,
  selectedAccessStateResponseSchema,
  selectedControlStateSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedDeviceListResponseSchema,
  selectedDeviceRevokeResponseSchema,
  selectedEventDiagnosticsSchema,
  selectedHostAccessSchema,
  selectedHostLockStateResponseSchema,
  selectedLaptopResumeSchema,
  selectedMissionControlViewModelSchema,
  selectedOperationDispatchSchema,
  selectedOperationProgressSchema,
  selectedOperationTerminalOutcomeSchema,
  selectedPairClaimResponseSchema,
  selectedPairRequestResponseSchema,
  selectedPromptControlSchema,
  selectedSessionDetailViewModelSchema,
  selectedSessionEventStreamSchema,
  skillsSnapshotSchema,
  usageSnapshotSchema
};

describe("FE-V1-004 mobile state and interaction design contract", () => {
  it("contains every required state and interaction exactly once in deliberate order", () => {
    expect(mobileStateTraces.map((trace) => trace.id)).toEqual(mobileStateTraceIds);
    expect(mobileInteractionTraces.map((trace) => trace.id)).toEqual(mobileInteractionIds);
    expect(new Set(mobileStateTraceIds).size).toBe(mobileStateTraceIds.length);
    expect(new Set(mobileInteractionIds).size).toBe(mobileInteractionIds.length);
  });

  it("binds every named contract to an exported executable schema", () => {
    expect(Object.keys(contractRegistry).sort()).toEqual([...mobileContractIds].sort());
    for (const trace of mobileStateTraces) {
      for (const contract of trace.contracts) {
        expect(contractRegistry[contract], `${trace.id}:${contract}`).toBeDefined();
      }
    }
    for (const trace of mobileInteractionTraces) {
      for (const contract of trace.resultContracts) {
        expect(contractRegistry[contract], `${trace.id}:${contract}`).toBeDefined();
      }
    }
  });

  it("resolves every source fixture through its exact selected contract family", () => {
    for (const trace of mobileStateTraces) {
      for (const fixtureRef of trace.fixtureRefs) resolveFixture(fixtureRef, trace.id);
    }
  });

  it("covers every V1 journey, surface, reference viewport, and downstream frontend leaf", () => {
    expect(covered(mobileStateTraces.flatMap((trace) => trace.journeys))).toEqual(covered(mobileJourneyIds));
    expect(covered(mobileStateTraces.map((trace) => trace.surface))).toEqual(covered(mobileSurfaceIds));
    expect(covered(mobileStateTraces.flatMap((trace) => trace.viewports))).toEqual(covered(mobileReferenceViewports));
    expect(covered(mobileInteractionTraces.flatMap((trace) => (trace.routeId === null ? [] : [trace.routeId])))).toEqual(
      covered(mobileRouteIds)
    );

    const taskCoverage = covered([
      ...mobileStateTraces.flatMap((trace) => trace.downstreamTasks),
      ...mobileInteractionTraces.map((trace) => trace.downstreamTask)
    ]);
    expect(taskCoverage).toEqual(covered(mobileDownstreamTaskIds));
  });

  it("separates fresh-browser network failures from states the HostDeck app can render", () => {
    const preload = mobileStateTraces.filter((trace) => trace.renderBoundary === "browser_preload");
    expect(preload.map((trace) => trace.id)).toEqual([
      "preload_phone_network_unavailable",
      "preload_remote_origin_unreachable"
    ]);
    for (const trace of preload) {
      expect(trace.surface).toBe("browser_preload");
      expect(trace.diagnosisSource).toBe("browser_network_only");
      expect(trace.dataDisclosure).toBe("none");
      expect(trace.contracts).toEqual([]);
      expect(trace.fixtureRefs).toEqual([]);
      expect(trace.firstViewport).toEqual(["browser_error_only"]);
    }

    for (const trace of mobileStateTraces.filter((candidate) => candidate.renderBoundary === "hostdeck_app")) {
      expect(trace.surface).not.toBe("browser_preload");
      expect(trace.diagnosisSource).not.toBe("browser_network_only");
      expect(trace.contracts.length, trace.id).toBeGreaterThan(0);
      expect(trace.firstViewport, trace.id).not.toContain("browser_error_only");
    }
  });

  it("keeps inaccessible and untrusted states from disclosing session data", () => {
    for (const id of [
      "mission_unpaired",
      "mission_expired",
      "mission_revoked",
      "mission_remote_disabled",
      "mission_tailscale_unavailable",
      "mission_profile_mismatch",
      "mission_serve_conflict",
      "access_unpaired",
      "access_expired",
      "access_revoked",
      "pair_fragment_ready",
      "pair_claiming",
      "pair_paired"
    ] as const) {
      expect(state(id).dataDisclosure).toBe("access_only");
    }
    expect(state("preload_remote_origin_unreachable").dataDisclosure).toBe("none");
    expect(state("mission_mixed_attention").dataDisclosure).toBe("session_list");
    expect(state("detail_active_writable").dataDisclosure).toBe("session_detail");
  });

  it("freezes phone-first hierarchy before visual exploration", () => {
    expect(state("mission_mixed_attention").firstViewport).toEqual([
      "host_access_strip",
      "page_title",
      "session_rows_two"
    ]);
    expect(state("detail_active_writable").firstViewport).toEqual([
      "session_identity",
      "project_and_status",
      "structured_feed",
      "sticky_composer",
      "primary_controls"
    ]);
    expect(state("detail_approval").firstViewport).toContain("inline_approval");
    expect(state("detail_replay_boundary").firstViewport).toContain("boundary_notice");

    for (const trace of mobileStateTraces.filter(
      (candidate) => candidate.mockupRequired && !candidate.id.endsWith("desktop_expansion")
    )) {
      expect(covered(trace.viewports), trace.id).toEqual(covered(mobileReferenceViewports));
      expect(trace.downstreamTasks, trace.id).toContain("FE-V1-002");
    }
    expect(state("mission_desktop_expansion").viewports).toEqual(["desktop_1280x800"]);
    expect(state("detail_desktop_expansion").viewports).toEqual(["desktop_1280x800"]);
  });

  it("covers the exact required control and approval state families", () => {
    expect(statesFor("composer")).toEqual([
      "empty",
      "composing",
      "keyboard_open",
      "submitting",
      "accepted",
      "running",
      "completed",
      "failed_retryable",
      "failed_nonretryable",
      "disabled_unpaired",
      "disabled_read_only",
      "disabled_locked",
      "disabled_runtime",
      "disabled_session",
      "disabled_stream"
    ]);
    expect(statesFor("model")).toEqual(["current", "loading", "unsupported", "conflict", "accepted", "success", "failure"]);
    expect(statesFor("goal")).toEqual(["current", "loading", "unsupported", "conflict", "accepted", "success", "failure"]);
    expect(statesFor("plan")).toEqual(["current", "loading", "unsupported", "conflict", "accepted", "success", "failure"]);
    expect(statesFor("usage")).toEqual(["loading", "content", "empty", "stale", "unsupported", "failure"]);
    expect(statesFor("compact")).toEqual([
      "confirmation",
      "accepted",
      "running",
      "completed",
      "conflict",
      "unsupported",
      "failure"
    ]);
    expect(statesFor("skills")).toEqual(["loading", "content", "empty", "partial", "unsupported", "failure"]);
    expect(statesFor("approval")).toEqual([
      "pending one-time request",
      "elevated or broad request awaiting confirmation",
      "exact request decision in flight; duplicate disabled",
      "approved with exact audit result",
      "denied with exact audit result",
      "expired and read-only",
      "superseded and read-only",
      "decision outcome unresolved while stream reconnects"
    ]);
  });

  it("covers remote disabled, laptop client/profile states, Serve conflicts, and generic pre-load failure", () => {
    const remoteRefs = new Set(
      mobileStateTraces.flatMap((trace) =>
        trace.fixtureRefs.flatMap((fixtureRef) => (fixtureRef.family === "remote_ingress" ? [fixtureRef.id] : []))
      )
    );
    for (const id of [
      "disabled",
      "client_not_installed",
      "profile_stopped",
      "profile_signed_out",
      "profile_other",
      "serve_absent",
      "serve_colliding",
      "ready"
    ] as const) {
      expect(remoteRefs.has(id), id).toBe(true);
    }
    expect(requiredRemoteIngressFixtureIds).toContain("serve_foreign");
    expect(requiredRemoteIngressFixtureIds).toContain("serve_drifted");
    expect(requiredRemoteIngressFixtureIds).toContain("serve_public");
    expect(state("preload_phone_network_unavailable").diagnosisSource).toBe("browser_network_only");
  });

  it("backs critical authority, remote, stream, and turn states with distinct parsed view models", () => {
    expect(missionFixture("mission_control_unpaired").viewModel.host_access.access).toBe("unpaired");
    expect(missionFixture("mission_control_expired").viewModel.host_access.access).toBe("expired");
    expect(missionFixture("mission_control_revoked").viewModel.host_access.access).toBe("revoked");
    expect(missionFixture("mission_control_remote_disabled").viewModel.host_access.remote_ingress).toMatchObject({
      availability: "disabled",
      reason: "remote_disabled"
    });
    expect(missionFixture("mission_control_tailscale_unavailable").viewModel.host_access.remote_ingress).toMatchObject({
      availability: "unavailable",
      reason: "client_stopped"
    });
    expect(missionFixture("mission_control_profile_mismatch").viewModel.host_access.remote_ingress?.reason).toBe(
      "profile_other"
    );
    expect(missionFixture("mission_control_serve_conflict").viewModel.host_access.remote_ingress?.reason).toBe(
      "serve_colliding"
    );
    expect(detailFixture("session_detail_locked").viewModel.host_access).toMatchObject({ locked: true, writes_enabled: false });
    expect(detailFixture("session_detail_stream_reconnecting").viewModel).toMatchObject({
      stream_state: "reconnecting",
      prompt: { enabled: false }
    });
    expect(detailFixture("session_detail_interrupted").viewModel.session?.turn_state).toBe("interrupted");
    expect(detailFixture("session_detail_failed").viewModel.session?.turn_state).toBe("failed");
    expect(detailFixture("session_detail_unknown").viewModel.session?.turn_state).toBe("unknown");
  });

  it("uses exact contract limits for long-content phone and feed stress fixtures", () => {
    const runtime = structuredRuntimeFixtureById("long_content");
    const event = runtime.stream.events[0];
    expect(runtime.session.name).toHaveLength(64);
    expect(runtime.session.cwd.split("/").at(-1)).toHaveLength(160);
    expect(runtime.session.branch).toHaveLength(240);
    expect(runtime.session.model).toHaveLength(160);
    expect(runtime.session.goal?.objective).toHaveLength(512);
    expect(runtime.session.recent_summary).toHaveLength(512);
    expect(event?.type).toBe("message");
    if (event?.type !== "message") throw new TypeError("Long-content fixture must contain one message event.");
    expect(event.text).toHaveLength(12_000);

    const mission = missionFixture("mission_control_long_content").viewModel;
    const detail = detailFixture("session_detail_long_content").viewModel;
    expect(mission.sessions.some((row) => row.session.id === runtime.session.id)).toBe(true);
    expect(detail.session?.id).toBe(runtime.session.id);
    expect(state("mission_long_content").viewports).toContain("phone_360x800");
    expect(state("detail_long_content").viewports).toContain("desktop_1280x800");
  });

  it("assigns exact execution authority and forbids automatic mutation retries", () => {
    for (const trace of mobileInteractionTraces) {
      expect(trace.automaticRetry, trace.id).toBe(false);
      if (trace.executionOwner === "hostdeck_api") expect(trace.routeId, trace.id).not.toBeNull();
      if (trace.executionOwner !== "hostdeck_api") expect(trace.routeId, trace.id).toBeNull();
      if (trace.mutation && trace.executionOwner !== "laptop_user") {
        expect(trace.operationIdRequired, trace.id).toBe(true);
        expect(trace.exactTarget, trace.id).not.toBe("none");
      }
    }

    for (const id of [
      "enable_remote_local",
      "disable_remote_local",
      "switch_tailscale_profile_local",
      "unlock_host_local"
    ] as const) {
      expect(interactionById(id).uiOwner).toBe("local_only");
    }
    expect(interactionById("switch_tailscale_profile_local")).toMatchObject({
      executionOwner: "laptop_user",
      authority: "external_user",
      routeId: null,
      operationIdRequired: false
    });
    expect(interactionById("claim_pairing")).toMatchObject({
      authority: "pairing_code",
      routeId: "pair_claim"
    });
    expect(interactionById("respond_approval")).toMatchObject({
      exactTarget: "approval",
      confirmation: "risk_dependent"
    });
  });

  it("references every interaction from at least one state and keeps prohibited controls absent", () => {
    const referenced = new Set(mobileStateTraces.flatMap((trace) => trace.interactions));
    expect(covered(referenced)).toEqual(covered(mobileInteractionIds));

    const serialized = JSON.stringify({ states: mobileStateTraces, interactions: mobileInteractionTraces }).toLowerCase();
    for (const prohibited of [
      "raw_input",
      "terminal_input",
      "certificate_enrollment",
      "custom_ca",
      "profile_switch_control",
      "desktop_only"
    ]) {
      expect(serialized, prohibited).not.toContain(prohibited);
    }
  });

  it("keeps the matrix and nested trace arrays immutable", () => {
    expect(Object.isFrozen(mobileStateTraces)).toBe(true);
    expect(Object.isFrozen(mobileInteractionTraces)).toBe(true);
    for (const trace of mobileStateTraces) {
      expect(Object.isFrozen(trace), trace.id).toBe(true);
      expect(Object.isFrozen(trace.contracts), trace.id).toBe(true);
      expect(Object.isFrozen(trace.fixtureRefs), trace.id).toBe(true);
      expect(Object.isFrozen(trace.firstViewport), trace.id).toBe(true);
      expect(Object.isFrozen(trace.interactions), trace.id).toBe(true);
    }
  });
});

function resolveFixture(fixtureRef: MobileFixtureReference, traceId: string): void {
  switch (fixtureRef.family) {
    case "selected_mobile": {
      expect(requiredSelectedMobileFixtureIds, traceId).toContain(fixtureRef.id);
      const fixture = selectedMobileFixtureById(fixtureRef.id);
      const parser = fixture.surface === "mission_control"
        ? selectedMissionControlViewModelSchema
        : selectedSessionDetailViewModelSchema;
      expect(parser.safeParse(fixture.viewModel).success, `${traceId}:${fixtureRef.id}`).toBe(true);
      return;
    }
    case "structured_runtime": {
      expect(requiredStructuredRuntimeFixtureIds, traceId).toContain(fixtureRef.id);
      const fixture = structuredRuntimeFixtureById(fixtureRef.id);
      expect(managedSessionProjectionSchema.safeParse(fixture.session).success, `${traceId}:${fixtureRef.id}`).toBe(true);
      expect(selectedSessionEventStreamSchema.safeParse(fixture.stream).success, `${traceId}:${fixtureRef.id}`).toBe(true);
      if (fixture.pendingApproval !== null) {
        expect(pendingApprovalSchema.safeParse(fixture.pendingApproval).success, `${traceId}:${fixtureRef.id}`).toBe(true);
      }
      return;
    }
    case "remote_ingress": {
      expect(requiredRemoteIngressFixtureIds, traceId).toContain(fixtureRef.id);
      const fixture = remoteIngressFixtureById(fixtureRef.id);
      expect(remoteIngressStateSchema.safeParse(fixture.state).success, `${traceId}:${fixtureRef.id}`).toBe(true);
      expect(remoteIngressPublicStateSchema.safeParse(projectRemoteIngressPublicState(fixture.state)).success).toBe(true);
      return;
    }
    case "remote_pairing_link":
      expect(fixtureRef.id).toBe("fragment_link");
      expect(remotePairingLinkIntentSchema.safeParse(remotePairingLinkFixture).success, traceId).toBe(true);
      return;
  }
}

function state(id: (typeof mobileStateTraceIds)[number]) {
  const trace = mobileStateTraces.find((candidate) => candidate.id === id);
  if (trace === undefined) throw new TypeError(`Missing mobile state trace: ${id}`);
  return trace;
}

function interactionById(id: (typeof mobileInteractionIds)[number]) {
  const trace = mobileInteractionTraces.find((candidate) => candidate.id === id);
  if (trace === undefined) throw new TypeError(`Missing mobile interaction trace: ${id}`);
  return trace;
}

function statesFor(surface: (typeof mobileSurfaceIds)[number]): readonly string[] {
  return mobileStateTraces.filter((trace) => trace.surface === surface).map((trace) => trace.state);
}

function missionFixture(id: (typeof requiredSelectedMobileFixtureIds)[number]) {
  const fixture = selectedMobileFixtureById(id);
  if (fixture.surface !== "mission_control") throw new TypeError(`Expected Mission Control fixture: ${id}`);
  return fixture;
}

function detailFixture(id: (typeof requiredSelectedMobileFixtureIds)[number]) {
  const fixture = selectedMobileFixtureById(id);
  if (fixture.surface !== "session_detail") throw new TypeError(`Expected Session Detail fixture: ${id}`);
  return fixture;
}

function covered(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}
