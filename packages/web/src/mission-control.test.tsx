// @vitest-environment jsdom

import {
  managedSessionProjectionSchema,
  type SelectedAccessStateResponse,
  type SelectedHostAccessMode,
  type SelectedHostLocalHealthCause,
  type SelectedHostLocalHealthComponent,
  type SelectedHostLocalHealthState,
  type SelectedHostStatusResponse,
  type SelectedSessionReadItem,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import {
  attentionLevels,
  managedSessionStates,
  projectionFreshnessStates,
  turnStates
} from "@hostdeck/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostDeckBrowserApp } from "./app-shell.js";
import type {
  BrowserConnectionFailure,
  BrowserConnectionPhase,
  BrowserConnectionResourceState,
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  ConnectedMissionControl,
  MissionControlScreen,
  projectMissionControl,
  projectSessionRow
} from "./mission-control.js";

const remoteOrigin = "https://hostdeck-laptop.tail295ac2.ts.net";
const timestamp = "2026-07-22T18:00:00.000Z";
const nowMs = Date.parse("2026-07-22T18:05:00.000Z");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Mission Control projection", () => {
  it("groups every session state without changing canonical source order", () => {
    const sessions = [
      sessionItem("sess_mission_approval", "approval", {
        attention: "needs_approval",
        turnState: "waiting_for_approval"
      }),
      sessionItem("sess_mission_input", "input", {
        attention: "needs_input",
        turnState: "waiting_for_input"
      }),
      sessionItem("sess_mission_failed", "failed", {
        attention: "failed",
        turnState: "failed"
      }),
      sessionItem("sess_mission_interrupt", "interrupted", {
        attention: "stuck",
        turnState: "interrupted"
      }),
      sessionItem("sess_mission_running", "running", {
        attention: "watch",
        turnState: "in_progress"
      }),
      sessionItem("sess_mission_quiet", "quiet", {
        attention: "none",
        turnState: "completed"
      })
    ];
    const projection = projectMissionControl(currentSnapshot({ sessions }), nowMs);

    expect(projection.sections.map((section) => section.id)).toEqual([
      "act_now",
      "in_progress",
      "quiet"
    ]);
    expect(projection.sections[0]?.rows.map((row) => row.item.session.id)).toEqual(
      sessions.slice(0, 4).map((item) => item.session.id)
    );
    expect(projection.sections.flatMap((section) => section.rows.map((row) => row.stateLabel))).toEqual([
      "Needs approval",
      "Needs input",
      "Failed",
      "Interrupted",
      "Running",
      "Quiet"
    ]);
    expect(projection.metaLabel).toBe("6 sessions");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.sections)).toBe(true);
  });

  it("derives bounded row cues, fallback copy, and deterministic activity age", () => {
    const item = sessionItem("sess_mission_cue", "cue", {
      cwd: "/private/company/hostdeck-mobile",
      branch: null,
      summary: "",
      goal: "Prepare phone release",
      activityAt: "2026-07-22T16:00:00.000Z"
    });

    const row = projectSessionRow(item, nowMs);

    expect(row.projectCue).toBe("hostdeck-mobile");
    expect(row.branch).toBeNull();
    expect(row.summary).toBe("Prepare phone release");
    expect(row.activityLabel).toBe("2h");
    renderScreen(currentSnapshot({ sessions: [item] }));
    expect(screen.getByRole("region", { name: "Mission Control" }).textContent).not.toContain(
      "/private/company"
    );
    cleanup();
    expect(() => projectMissionControl(currentSnapshot({ sessions: [item] }), Number.NaN)).toThrow(
      TypeError
    );
  });

  it("classifies every valid selected session-state combination", () => {
    const observedLabels = new Set<string>();
    let validCombinationCount = 0;

    for (const freshness of projectionFreshnessStates) {
      for (const sessionState of managedSessionStates) {
        for (const turnState of turnStates) {
          if (
            sessionState === "archived" &&
            ["in_progress", "waiting_for_input", "waiting_for_approval"].includes(
              turnState
            )
          ) {
            continue;
          }
          for (const attention of attentionLevels) {
            const row = projectSessionRow(
              sessionItem(`sess_mission_matrix_${validCombinationCount}`, "matrix", {
                attention,
                freshness,
                sessionState,
                turnState
              }),
              nowMs
            );

            expect(["act_now", "in_progress", "quiet"]).toContain(row.group);
            expect(row.stateLabel.length).toBeGreaterThan(0);
            expect(["attention", "connected", "danger", "muted"]).toContain(
              row.tone
            );
            observedLabels.add(row.stateLabel);
            validCombinationCount += 1;
          }
        }
      }
    }

    expect(validCombinationCount).toBe(1_260);
    expect([...observedLabels].sort()).toEqual(
      [
        "Archived",
        "Failed",
        "Incompatible",
        "Interrupted",
        "Needs approval",
        "Needs attention",
        "Needs input",
        "Quiet",
        "Running",
        "Stale",
        "Starting",
        "Unknown"
      ].sort()
    );
  });

  it.each([
    ["unpaired", "Pair this phone"],
    ["invalid_device", "Device access is invalid"],
    ["expired_device", "Pairing expired"],
    ["revoked_device", "Device access was revoked"]
  ] as const)("keeps %s authority session-data-free", (state, title) => {
    const secret = sessionItem("sess_mission_authority_secret", "authority-secret");
    const snapshot = currentSnapshot({
      access: deniedAccess(state),
      phase: "access_limited",
      sessions: [secret]
    });

    expect(projectMissionControl(snapshot, nowMs).sections).toEqual([]);
    renderScreen(snapshot);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText("authority-secret")).toBeNull();
  });

  it("suppresses all protected values when current access cannot read", () => {
    const secret = sessionItem("sess_mission_secret", "private-session", {
      cwd: "/private/customer/acquisition-secret",
      summary: "Confidential projection"
    });
    const snapshot = currentSnapshot({
      access: deniedAccess("unpaired"),
      phase: "access_limited",
      sessions: [secret],
      targetState: "current"
    });
    const projection = projectMissionControl(snapshot, nowMs);

    expect(projection.sections).toEqual([]);
    expect(projection.metaLabel).toBe("Access required");
    expect(projection.notice?.title).toBe("Pair this phone");

    renderScreen(snapshot);
    const main = screen.getByRole("region", { name: "Mission Control" });
    expect(main.textContent).not.toContain("private-session");
    expect(main.textContent).not.toContain("acquisition-secret");
    expect(main.textContent).not.toContain("Confidential projection");
    expect(main.textContent).not.toContain("1 session");
  });

  it("retains authorized same-target data only with explicit stale truth", () => {
    const snapshot = currentSnapshot({
      accessState: "stale",
      hostState: "stale",
      targetState: "stale",
      phase: "degraded",
      sessions: [sessionItem("sess_mission_stale", "stale-session")]
    });
    const projection = projectMissionControl(snapshot, nowMs);

    expect(projection.stale).toBe(true);
    expect(projection.notice?.title).toBe("Showing stale session state");
    expect(projection.statusCells.map((cell) => cell.value)).toEqual([
      "Reconnecting",
      "Access stale",
      "Stale"
    ]);

    renderScreen(snapshot);
    expect(screen.getAllByText("stale-session")).toHaveLength(2);
    expect(screen.getByText("Showing stale session state")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });
});

describe("Mission Control screen states and interaction", () => {
  it("renders bounded loading and remote-unavailable states without fake rows", () => {
    const loading = Object.freeze({
      ...currentSnapshot({
        access: null,
        accessState: "loading",
        host: null,
        hostState: "idle",
        phase: "loading",
        sessions: [],
        targetState: "loading"
      }),
      target: null
    });
    const loadingView = renderScreen(loading);
    expect(screen.getByText("Loading sessions")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    loadingView.unmount();

    renderScreen(
      currentSnapshot({
        access: null,
        accessState: "failed",
        host: null,
        hostState: "blocked",
        phase: "remote_unavailable",
        sessions: [],
        targetState: "blocked"
      })
    );
    expect(screen.getByText("Remote access is unavailable")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the approved mixed queue as semantic whole-row navigation", async () => {
    const sessions = [
      sessionItem("sess_mission_route_a", "approval", {
        attention: "needs_approval",
        turnState: "waiting_for_approval"
      }),
      sessionItem("sess_mission_route_b", "input", {
        attention: "needs_input",
        turnState: "waiting_for_input"
      }),
      sessionItem("sess_mission_route_c", "running", {
        attention: "watch",
        turnState: "in_progress"
      }),
      sessionItem("sess_mission_route_d", "quiet", {
        turnState: "completed"
      })
    ];
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <MissionControlScreen snapshot={currentSnapshot({ sessions })} nowMs={nowMs} />
            }
          />
          <Route path="/sessions/:session_id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Mission Control" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "ACT NOW" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "IN PROGRESS" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "QUIET" })).toBeTruthy();
    expect(screen.getByLabelText("Host and access status")).toBeTruthy();
    expect(screen.getByText("Remote ready")).toBeTruthy();
    expect(screen.getByText("Write")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(4);

    fireEvent.click(screen.getByRole("link", { name: /approval/i }));
    expect((await screen.findByTestId("selected-location")).textContent).toBe(
      "/sessions/sess_mission_route_a"
    );
  });

  it("renders empty and all-quiet inventories without fabricating attention", () => {
    const emptyView = renderScreen(currentSnapshot({ sessions: [] }));
    expect(screen.getByRole("heading", { level: 2, name: "No active sessions" })).toBeTruthy();
    expect(screen.queryByText("ACT NOW")).toBeNull();
    emptyView.unmount();

    renderScreen(
      currentSnapshot({
        sessions: [
          sessionItem("sess_mission_quiet_a", "quiet-a", { turnState: "completed" }),
          sessionItem("sess_mission_quiet_b", "quiet-b")
        ]
      })
    );
    const disclosure = document.querySelector("details.hostdeck-queue-disclosure");
    expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
    expect((disclosure as HTMLDetailsElement).open).toBe(true);
    fireEvent.click((disclosure as HTMLDetailsElement).querySelector("summary") as HTMLElement);
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByText("ACT NOW")).toBeNull();
  });

  it.each([
    {
      label: "read only",
      snapshot: () => currentSnapshot({ access: pairedAccess("read") }),
      expected: "Read-only access"
    },
    {
      label: "locked",
      snapshot: () => currentSnapshot({ access: pairedAccess("write", true) }),
      expected: "Remote writes are locked"
    },
    {
      label: "runtime offline",
      snapshot: () =>
        currentSnapshot({
          host: hostStatus({ localCause: "runtime_disconnected" }),
          phase: "offline"
        }),
      expected: "Codex runtime is offline"
    },
    {
      label: "incompatible",
      snapshot: () =>
        currentSnapshot({
          host: hostStatus({ localCause: "runtime_incompatible" }),
          phase: "incompatible"
        }),
      expected: "Codex is incompatible"
    },
    {
      label: "degraded",
      snapshot: () =>
        currentSnapshot({
          host: hostStatus({ localCause: "runtime_reconciling" }),
          phase: "degraded"
        }),
      expected: "Host health is degraded"
    },
    {
      label: "fatal",
      snapshot: () => currentSnapshot({ phase: "fatal", sessions: [], targetState: "failed" }),
      expected: "Mission Control is unavailable"
    },
    {
      label: "remote unreachable",
      snapshot: () =>
        currentSnapshot({
          access: null,
          accessState: "failed",
          host: null,
          hostState: "blocked",
          phase: "unreachable",
          sessions: [],
          targetState: "blocked"
        }),
      expected: "HostDeck is unreachable"
    }
  ])("renders $label with bounded source-aware copy", ({ snapshot, expected }) => {
    renderScreen(snapshot());
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Mission Control" }).textContent).not.toContain(
      remoteOrigin
    );
  });

  it("shows precise laptop remote causes only from current host truth", () => {
    const snapshot = currentSnapshot({
      host: hostStatus({ remoteCause: "profile_other" }),
      phase: "ready"
    });
    renderScreen(snapshot);
    expect(screen.getByText("Remote access needs attention")).toBeTruthy();
    expect(screen.getByText(/saved HostDeck Tailscale profile/)).toBeTruthy();

    cleanup();
    renderScreen(
      currentSnapshot({
        access: null,
        accessState: "failed",
        host: null,
        hostState: "blocked",
        phase: "unreachable",
        sessions: [],
        targetState: "blocked"
      })
    );
    const region = screen.getByRole("region", { name: "Mission Control" });
    expect(region.textContent).not.toContain("profile");
    expect(region.textContent).not.toContain("Serve");
  });

  it("guards refresh and pagination as explicit one-call operations", async () => {
    const refresh = deferred<BrowserConnectionSnapshot>();
    const loadMore = deferred<BrowserConnectionSnapshot>();
    const harness = coordinatorHarness(
      currentSnapshot({
        sessions: [sessionItem("sess_mission_commands", "commands")],
        hasMore: true
      }),
      { refresh: refresh.promise, loadMore: loadMore.promise }
    );
    const view = render(
      <MemoryRouter>
        <ConnectedMissionControl coordinator={harness.coordinator} now={() => nowMs} />
      </MemoryRouter>
    );
    await waitFor(() => expect(harness.setTarget).toHaveBeenCalledTimes(1));

    const refreshButton = screen.getByRole("button", { name: "Refresh sessions" });
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true);
    refresh.resolve(harness.snapshot());
    await waitFor(() => expect((refreshButton as HTMLButtonElement).disabled).toBe(false));

    const loadButton = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadButton);
    fireEvent.click(loadButton);
    expect(harness.loadMore).toHaveBeenCalledTimes(1);
    loadMore.reject(new Error("private transport detail"));
    expect(
      await screen.findByText("More sessions could not be loaded. The current list is unchanged.")
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Mission Control" }).textContent).not.toContain(
      "private transport detail"
    );

    view.unmount();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("Mission Control production owner", () => {
  it("creates a fresh coordinator after StrictMode cleanup and closes each owner once", async () => {
    const first = coordinatorHarness(currentSnapshot());
    const second = coordinatorHarness(currentSnapshot());
    const factory = vi
      .fn<() => BrowserConnectionStateCoordinator>()
      .mockReturnValueOnce(first.coordinator)
      .mockReturnValueOnce(second.coordinator);

    const view = render(
      <StrictMode>
        <HostDeckBrowserApp createCoordinator={factory} />
      </StrictMode>
    );

    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    expect(first.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(second.setTarget).toHaveBeenCalledTimes(2));
    expect(second.close).not.toHaveBeenCalled();

    view.unmount();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("never re-exposes a closed owner after injected authority is removed", async () => {
    const first = coordinatorHarness(currentSnapshot());
    const injected = coordinatorHarness(currentSnapshot());
    const second = coordinatorHarness(currentSnapshot());
    const factory = vi
      .fn<() => BrowserConnectionStateCoordinator>()
      .mockReturnValueOnce(first.coordinator)
      .mockReturnValueOnce(second.coordinator);

    const view = render(<HostDeckBrowserApp createCoordinator={factory} />);
    await waitFor(() => expect(first.setTarget).toHaveBeenCalledTimes(1));

    view.rerender(
      <HostDeckBrowserApp coordinator={injected.coordinator} createCoordinator={factory} />
    );
    await waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(injected.setTarget).toHaveBeenCalledTimes(1));

    view.rerender(<HostDeckBrowserApp createCoordinator={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.setTarget).toHaveBeenCalledTimes(1));
    expect(first.setTarget).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(injected.close).not.toHaveBeenCalled();
  });

  it("renders a bounded fatal surface when secure runtime construction fails", async () => {
    render(
      <HostDeckBrowserApp
        createCoordinator={() => {
          throw new Error("private constructor detail");
        }}
      />
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Mission Control unavailable" })
    ).toBeTruthy();
    expect(screen.getByRole("main").textContent).not.toContain("private constructor detail");
  });
});

function renderScreen(snapshot: BrowserConnectionSnapshot) {
  return render(
    <MemoryRouter>
      <MissionControlScreen snapshot={snapshot} nowMs={nowMs} />
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="selected-location">{location.pathname}</output>;
}

function currentSnapshot(
  options: {
    readonly phase?: BrowserConnectionPhase;
    readonly access?: SelectedAccessStateResponse | null;
    readonly accessState?: BrowserConnectionResourceState;
    readonly host?: SelectedHostStatusResponse | null;
    readonly hostState?: BrowserConnectionResourceState;
    readonly targetState?: BrowserConnectionResourceState;
    readonly sessions?: readonly SelectedSessionReadItem[];
    readonly hasMore?: boolean;
  } = {}
): BrowserConnectionSnapshot {
  const access = options.access === undefined ? pairedAccess("write") : options.access;
  const host = options.host === undefined ? hostStatus() : options.host;
  const sessions = options.sessions ?? [sessionItem("sess_mission_default", "default")];
  const targetState = options.targetState ?? "current";
  const accessState = options.accessState ?? (access === null ? "loading" : "current");
  const hostState = options.hostState ?? (host === null ? "loading" : "current");
  const failure = targetState === "failed" ? browserFailure("session_list") : null;
  return Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "mission_control" as const }),
    phase: options.phase ?? "ready",
    access: resource(accessState, access, accessState === "failed" ? browserFailure("access") : null),
    host: resource(hostState, host, hostState === "failed" ? browserFailure("host_status") : null),
    targetState: resource(
      targetState,
      targetState === "blocked" || targetState === "not_found"
        ? null
        : Object.freeze({
            kind: "mission_control" as const,
            access: Object.freeze({
              mode: access?.permission === "read" ? "paired_read" as const : "paired_write" as const,
              network_mode: "remote" as const,
              transport: "https" as const
            }),
            sessions: Object.freeze([...sessions]),
            nextCursor: options.hasMore === true ? "opaque-selected-cursor" : null,
            hasMore: options.hasMore === true,
            pageCount: 1
          }),
      failure
    ),
    stream: Object.freeze({
      state: "not_applicable" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: "ready" as const,
      generation: 1,
      rotatedAt: timestamp,
      failure: null,
      invalidationReason: null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: true,
      causes: Object.freeze([])
    }),
    lastFailure: failure
  });
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null,
  failure: BrowserConnectionFailure | null
) {
  return Object.freeze({
    state,
    data,
    failure,
    observedAt: data === null ? null : timestamp
  });
}

function browserFailure(
  source: BrowserConnectionFailure["source"]
): BrowserConnectionFailure {
  return Object.freeze({
    source,
    reason: "transport_unavailable",
    routeId:
      source === "access"
        ? "access_state"
        : source === "host_status"
          ? "host_status"
          : "session_list",
    transport: "https",
    status: null,
    apiError: null,
    epoch: 1,
    observedAt: timestamp
  });
}

function pairedAccess(permission: "read" | "write", locked = false): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_mission_phone",
    permission,
    device_expires_at: "2026-08-22T18:00:00.000Z",
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: true,
    can_write_sessions: permission === "write" && !locked,
    can_lock: permission === "write",
    can_unlock: false
  });
}

function deniedAccess(
  authenticationState: "unpaired" | "invalid_device" | "expired_device" | "revoked_device"
): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: authenticationState,
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: remoteOrigin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}

function hostStatus(
  options: {
    readonly mode?: SelectedHostAccessMode;
    readonly localCause?: "runtime_disconnected" | "runtime_incompatible" | "runtime_reconciling";
    readonly remoteCause?: "profile_other";
  } = {}
): SelectedHostStatusResponse {
  const override = localComponentOverride(options.localCause);
  const components = selectedHostLocalHealthComponents.map((component) => ({
    component,
    state: override?.component === component ? override.state : "ready",
    checked_at: timestamp,
    causes: override?.component === component ? [override.cause] : []
  }));
  const localState = override?.state ?? "ready";
  const localReady = localState === "ready";
  const mode = options.mode ?? "paired_write";
  const readOnly = mode === "paired_read" || mode === "loopback_read";
  const causes = [
    ...(readOnly ? ["read_only_access" as const] : []),
    ...(!localReady ? ["host_not_ready" as const] : [])
  ];
  const remoteUnavailable = options.remoteCause !== undefined;
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: localState,
      readiness: localReady ? "ready" : "not_ready",
      updated_at: timestamp,
      components,
      mutation_admission: localReady ? "open" : "closed"
    },
    remote: {
      generation: 1,
      state_generation: 1,
      availability: remoteUnavailable ? "unavailable" : "ready",
      cause: options.remoteCause ?? null,
      external_origin: remoteUnavailable ? null : remoteOrigin,
      laptop_action_required: remoteUnavailable,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode,
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: causes.length === 0,
        causes
      }
    }
  });
}

function localComponentOverride(
  cause: "runtime_disconnected" | "runtime_incompatible" | "runtime_reconciling" | undefined
): {
  readonly component: SelectedHostLocalHealthComponent;
  readonly state: SelectedHostLocalHealthState;
  readonly cause: SelectedHostLocalHealthCause;
} | null {
  switch (cause) {
    case "runtime_disconnected":
      return { component: "runtime", state: "degraded", cause };
    case "runtime_reconciling":
      return { component: "runtime", state: "degraded", cause };
    case "runtime_incompatible":
      return { component: "compatibility", state: "failed", cause };
    case undefined:
      return null;
  }
}

function sessionItem(
  id: string,
  name: string,
  options: {
    readonly attention?: "none" | "watch" | "needs_input" | "needs_approval" | "failed" | "stuck" | "unknown";
    readonly turnState?: "idle" | "in_progress" | "waiting_for_input" | "waiting_for_approval" | "completed" | "interrupted" | "failed" | "unknown";
    readonly sessionState?: "starting" | "active" | "archived" | "stale" | "incompatible" | "unknown";
    readonly freshness?: "current" | "stale" | "disconnected" | "incompatible";
    readonly cwd?: string;
    readonly branch?: string | null;
    readonly summary?: string;
    readonly goal?: string;
    readonly activityAt?: string;
  } = {}
): SelectedSessionReadItem {
  const freshness = options.freshness ?? "current";
  const sessionState =
    options.sessionState ?? (freshness === "incompatible" ? "incompatible" : "active");
  const session = managedSessionProjectionSchema.parse({
    id,
    name,
    codex_thread_id: `thread-${id}`,
    cwd: options.cwd ?? `/workspace/${name}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.144.0",
    created_at: timestamp,
    archived_at: sessionState === "archived" ? timestamp : null,
    session_state: sessionState,
    turn_state: options.turnState ?? "idle",
    attention: options.attention ?? "none",
    freshness,
    freshness_reason: freshness === "current" ? null : "Projection is not current.",
    updated_at: options.activityAt ?? timestamp,
    last_activity_at: options.activityAt ?? timestamp,
    branch: options.branch === undefined ? "main" : options.branch,
    model: "gpt-5.5-codex",
    settings: null,
    goal: options.goal === undefined ? null : { objective: options.goal, state: "active" },
    recent_summary: options.summary ?? `Current work for ${name}.`,
    last_event_cursor: null
  });
  return selectedSessionReadItemSchema.parse({
    session,
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  });
}

function coordinatorHarness(
  initial: BrowserConnectionSnapshot,
  pending: {
    readonly refresh?: Promise<BrowserConnectionSnapshot>;
    readonly loadMore?: Promise<BrowserConnectionSnapshot>;
  } = {}
) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const setTarget = vi.fn(async () => snapshot);
  const refresh = vi.fn(() => pending.refresh ?? Promise.resolve(snapshot));
  const loadMore = vi.fn(() => pending.loadMore ?? Promise.resolve(snapshot));
  const close = vi.fn(() => snapshot);
  const coordinator = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    setTarget,
    refresh,
    loadMoreSessions: loadMore,
    connectSessionStream: vi.fn(() => snapshot),
    disconnectSessionStream: vi.fn(() => snapshot),
    bootstrapCsrf: vi.fn(async () => snapshot),
    adoptCsrfBootstrap: vi.fn(() => snapshot),
    requestProtected: vi.fn(),
    close
  } as unknown as BrowserConnectionStateCoordinator;
  return {
    coordinator,
    setTarget,
    refresh,
    loadMore,
    close,
    unsubscribe,
    snapshot: () => snapshot,
    publish(next: BrowserConnectionSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
