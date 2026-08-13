// @vitest-environment jsdom

import {
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostDeckBrowserApp,
  HostDeckRoutes,
  missionControlPath,
  SessionRouteLink,
  sessionDetailPath,
  sessionDetailPathPattern
} from "./app-shell.js";
import { createBrowserAppStartupController } from "./app-startup.js";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";

const sessionId = "sess_shell_001";

afterEach(() => {
  cleanup();
});

describe("HostDeck phone shell", () => {
  it("renders the truthful Mission Control loading shell at the only default route", () => {
    renderShell([missionControlPath]);

    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Mission Control" })).toBeTruthy();
    expect(screen.getByText("Loading sessions").textContent).toBe("Loading sessions");
    expect(screen.getByRole("button", { name: "Open Host and access" })).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText("Remote ready")).toBeNull();
  });

  it("builds only validated session paths and retains the server route shape", () => {
    expect(sessionDetailPathPattern).toBe("/sessions/:session_id");
    expect(sessionDetailPath(sessionId)).toBe(`/sessions/${sessionId}`);

    for (const value of [null, undefined, "", "session_01", "sess_short", {}, [sessionId]]) {
      expect(() => sessionDetailPath(value)).toThrow();
    }
    expect(() => sessionDetailPath(`sess_${"a".repeat(65)}`)).toThrow();
  });

  it("opens a validated session and restores the same Mission Control history entry", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[missionControlPath]}>
        <LocationProbe />
        <HostDeckRoutes
          outlets={{
            missionControl: (
              <section>
                <h1>Mission Control fixture</h1>
                <SessionRouteLink sessionId={sessionId}>Open api-refactor</SessionRouteLink>
              </section>
            ),
            sessionDetail: (selectedSessionId) => (
              <section>
                <h1>Selected session</h1>
                <output>{selectedSessionId}</output>
              </section>
            )
          }}
        />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("link", { name: "Open api-refactor" }));

    expect(screen.getByTestId("location-path").textContent).toBe(`/sessions/${sessionId}`);
    expect(screen.getByRole("heading", { level: 1, name: "Selected session" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(document.title).toBe("Session Detail | HostDeck");
    expect(screen.getAllByText(sessionId)).toHaveLength(1);
    expect(screen.getByRole("banner").textContent).not.toContain(sessionId);

    await user.click(screen.getByRole("button", { name: "Back to Mission Control" }));

    expect(screen.getByTestId("location-path").textContent).toBe(missionControlPath);
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Open api-refactor" })
    );
    expect(document.title).toBe("Mission Control | HostDeck");
  });

  it("returns a direct detail entry to Mission Control without adding a back loop", async () => {
    const user = userEvent.setup();
    renderShell([sessionDetailPath(sessionId)]);

    expect(screen.getByRole("heading", { level: 1, name: "Session Detail" })).toBeTruthy();
    const retainedNavigation = screen.getByRole("navigation", {
      name: "Mission Control sessions"
    });
    expect(within(retainedNavigation).getByText("No retained session list")).toBeTruthy();
    expect(within(retainedNavigation).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(retainedNavigation).getAllByRole("link")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Back to Mission Control" }));

    expect(screen.getByTestId("location-path").textContent).toBe(missionControlPath);
    expect(screen.getByRole("heading", { level: 1, name: "Mission Control" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to Mission Control" })).toBeNull();
  });

  it("retains Mission context across a detail target and purges it on authority loss", async () => {
    const user = userEvent.setup();
    const harness = createResponsiveContextCoordinatorHarness();
    render(
      <MemoryRouter initialEntries={[missionControlPath]}>
        <HostDeckRoutes
          coordinator={harness.coordinator}
          outlets={{
            hostAccess: <p>Access fixture</p>,
            missionControl: (
              <section>
                <h1>Mission Control responsive fixture</h1>
                <SessionRouteLink sessionId={sessionId}>Open responsive session</SessionRouteLink>
              </section>
            ),
            sessionDetail: () => <h1>Session Detail responsive fixture</h1>
          }}
        />
      </MemoryRouter>
    );

    act(() => harness.publishDetail());
    await user.click(screen.getByRole("link", { name: "Open responsive session" }));

    const retainedNavigation = screen.getByRole("navigation", {
      name: "Mission Control sessions"
    });
    expect(within(retainedNavigation).getByText(/^Retained list/u)).toBeTruthy();
    expect(within(retainedNavigation).getByText("No retained sessions")).toBeTruthy();
    expect(harness.setTarget).not.toHaveBeenCalled();
    expect(harness.loadMoreSessions).not.toHaveBeenCalled();

    act(() => harness.publishAuthorityLoss());
    expect(within(retainedNavigation).getByText("No retained session list")).toBeTruthy();
    expect(within(retainedNavigation).queryByText(/^Retained list/u)).toBeNull();
  });

  it("rejects invalid and unknown paths without reflecting hostile input", () => {
    for (const path of [
      "/sessions/private-secret",
      "/sessions/%2Fprivate-secret",
      `/sessions/sess_${"a".repeat(65)}`,
      "/settings",
      "/assets/private-secret"
    ]) {
      const view = renderShell([path]);

      expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Mission Control" })).toBeTruthy();
      expect(screen.getByRole("main").textContent).not.toContain("private-secret");

      view.unmount();
    }
  });

  it("does not interpret query or fragment material as navigation or control state", () => {
    renderShell(["/?session_id=private-secret#route=/sessions/private-secret"]);

    expect(screen.getByRole("heading", { level: 1, name: "Mission Control" })).toBeTruthy();
    expect(screen.getByRole("main").textContent).not.toContain("private-secret");
    expect(screen.queryByRole("button", { name: "Back to Mission Control" })).toBeNull();
  });

  it("keeps Host and access in a labelled modal sheet and restores trigger focus", async () => {
    const user = userEvent.setup();
    renderShell([missionControlPath], {
      hostAccess: <button type="button">Access action</button>
    });
    const trigger = screen.getByRole("button", { name: "Open Host and access" });

    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Host & access" });
    const scrollOwner = screen.getByRole("region", { name: "Host and access content" });
    expect(screen.getByTestId("location-path").textContent).toBe(missionControlPath);
    expect(dialog.contains(screen.getByRole("button", { name: "Access action" }))).toBe(true);
    expect(scrollOwner.getAttribute("tabindex")).toBe("0");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps one page-security recovery owner across sheet dismissal and reopening", async () => {
    const user = userEvent.setup();
    const harness = createRecoveryCoordinatorHarness();
    render(
      <MemoryRouter initialEntries={[missionControlPath]}>
        <HostDeckRoutes
          coordinator={harness.coordinator}
          outlets={{ missionControl: <h1>Mission Control recovery fixture</h1> }}
        />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    const action = screen.getByRole("button", { name: "Secure this page" });
    await user.click(action);
    await waitFor(() => expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1));
    expect(action.getAttribute("aria-busy")).toBe("true");
    expect(action).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    expect(screen.getByRole("button", { name: "Secure this page" })).toHaveProperty(
      "disabled",
      true
    );
    expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1);

    harness.completeBootstrap();
    expect(
      await screen.findByText("Page security recovered")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Secure this page" })).toBeNull();
    expect(harness.bootstrapCsrf).toHaveBeenCalledTimes(1);
  });

  it("keeps one remote-check owner across sheet and route lifetimes", async () => {
    const user = userEvent.setup();
    const harness = createRemoteRecoveryCoordinatorHarness();
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[missionControlPath]}>
          <HostDeckRoutes
            coordinator={harness.coordinator}
            outlets={{
              missionControl: (
                <section>
                  <h1>Mission Control remote fixture</h1>
                  <SessionRouteLink sessionId={sessionId}>Open remote session</SessionRouteLink>
                </section>
              ),
              sessionDetail: () => <h1>Session Detail remote fixture</h1>
            }}
          />
        </MemoryRouter>
      </StrictMode>
    );

    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(harness.requestRemoteStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Check remote access" })).toHaveProperty(
      "disabled",
      true
    );

    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await user.click(screen.getByRole("link", { name: "Open remote session" }));
    expect(await screen.findByText("Session Detail remote fixture")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    expect(screen.getByRole("heading", { name: "Checking remote access" })).toBeTruthy();
    expect(harness.requestRemoteStatus).toHaveBeenCalledTimes(1);

    await act(async () => harness.completeStatus());
    await waitFor(() => expect(harness.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "Checking remote access" })).toBeTruthy();
    expect(harness.requestRemoteStatus).toHaveBeenCalledTimes(1);

    await act(async () => harness.completeRefresh());
    expect(await screen.findByRole("heading", { name: "HostDeck profile is not active" }))
      .toBeTruthy();
    expect(harness.requestRemoteStatus).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await user.click(screen.getByRole("button", { name: "Back to Mission Control" }));
    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    expect(screen.getByRole("heading", { name: "HostDeck profile is not active" })).toBeTruthy();
    expect(harness.requestRemoteStatus).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps one device-list owner across Host and access sheet dismissal", async () => {
    const user = userEvent.setup();
    const harness = createDeviceCoordinatorHarness();
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[missionControlPath]}>
          <HostDeckRoutes
            coordinator={harness.coordinator}
            outlets={{
              missionControl: (
                <section>
                  <h1>Mission Control device fixture</h1>
                  <SessionRouteLink sessionId={sessionId}>Open device session</SessionRouteLink>
                </section>
              ),
              sessionDetail: () => <h1>Session Detail device fixture</h1>
            }}
          />
        </MemoryRouter>
      </StrictMode>
    );

    expect(harness.requestDeviceList).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    await waitFor(() => expect(harness.requestDeviceList).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Checking paired devices.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    expect(screen.getByText("Checking paired devices.")).toBeTruthy();
    expect(harness.requestDeviceList).toHaveBeenCalledTimes(1);

    await act(async () => harness.completeList());
    expect(await screen.findByText("Xiaomi 15 Pro")).toBeTruthy();
    expect(harness.requestDeviceList).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await user.click(screen.getByRole("link", { name: "Open device session" }));
    expect(await screen.findByText("Session Detail device fixture")).toBeTruthy();
    expect(harness.requestDeviceList).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    expect(screen.getByText("Xiaomi 15 Pro")).toBeTruthy();
    expect(harness.requestDeviceList).toHaveBeenCalledTimes(1);
  });

  it("keeps one host-lock owner across confirmation, route navigation, and sheet reopening", async () => {
    const user = userEvent.setup();
    const harness = createHostLockCoordinatorHarness();
    render(
      <MemoryRouter initialEntries={[missionControlPath]}>
        <HostDeckRoutes
          coordinator={harness.coordinator}
          outlets={{
            missionControl: (
              <section>
                <h1>Mission Control lock fixture</h1>
                <SessionRouteLink sessionId={sessionId}>Open locked session</SessionRouteLink>
              </section>
            ),
            sessionDetail: () => <h1>Session Detail lock fixture</h1>
          }}
        />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    await user.click(screen.getByRole("button", { name: "Lock writes" }));
    const confirmation = screen.getByRole("dialog", { name: "Lock remote writes?" });
    await user.click(within(confirmation).getByRole("button", { name: "Lock writes" }));

    await waitFor(() => expect(harness.requestHostLock).toHaveBeenCalledTimes(1));
    expect(harness.requestHostLock.mock.calls[0]?.[0]).toMatchObject({
      body: { confirmed: true }
    });
    expect(harness.requestHostLock.mock.calls[0]?.[0].body.operation_id).toMatch(
      /^op_browser_host_lock_/u
    );

    await act(async () => harness.completeLock());
    expect(await screen.findByRole("heading", { name: "Remote writes locked" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Host and access" }));
    await user.click(screen.getByRole("link", { name: "Open locked session" }));
    expect(await screen.findByRole("heading", { name: "Session Detail lock fixture" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open Host and access" }));
    expect(screen.getByRole("heading", { name: "Remote writes locked" })).toBeTruthy();
    expect(screen.getByText("codexdeck unlock")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /unlock/u })).toBeNull();
    expect(harness.requestHostLock).toHaveBeenCalledTimes(1);
  });

  it("holds production routes behind one external pairing owner even under StrictMode", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<ReturnType<typeof pairedResult>>();
    const bootstrapPairing = vi.fn(() => deferred.promise);
    const adoptCsrfBootstrap = vi.fn();
    const coordinatorSnapshot = recoveryConnectionSnapshot("ready");
    const coordinator = Object.freeze({
      snapshot: vi.fn(() => coordinatorSnapshot),
      subscribe: vi.fn(() => () => undefined),
      setTarget: vi.fn(),
      refresh: vi.fn(),
      loadMoreSessions: vi.fn(),
      connectSessionStream: vi.fn(),
      disconnectSessionStream: vi.fn(),
      bootstrapCsrf: vi.fn(),
      adoptCsrfBootstrap,
      requestProtected: vi.fn(),
      requestDeviceList: vi.fn(),
      requestRemoteStatus: vi.fn(),
      requestDeviceRevoke: vi.fn(),
      requestHostLock: vi.fn(),
      requestSelectedSessionRead: vi.fn(),
      close: vi.fn()
    }) as never;
    const createCoordinator = vi.fn(() => coordinator);
    const startup = createBrowserAppStartupController({
      bootstrapPairing,
      createCoordinator,
      reload: vi.fn()
    });

    render(
      <StrictMode>
        <HostDeckBrowserApp
          startup={startup}
          outlets={{
            missionControl: <h1>Mission Control protected fixture</h1>,
            sessionDetail: () => <h1>Session Detail protected fixture</h1>,
            hostAccess: <p>Access fixture</p>
          }}
        />
      </StrictMode>
    );

    expect(bootstrapPairing).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Mission Control protected fixture")).toBeNull();
    deferred.resolve(pairedResult());

    expect(await screen.findByRole("heading", { level: 1, name: "Phone paired" })).toBeTruthy();
    expect(adoptCsrfBootstrap).toHaveBeenCalledTimes(1);
    expect(createCoordinator).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Mission Control protected fixture")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open Mission Control" }));

    expect(await screen.findByText("Mission Control protected fixture")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(bootstrapPairing).toHaveBeenCalledTimes(1);
    expect(adoptCsrfBootstrap).toHaveBeenCalledTimes(1);
  });
});

function renderShell(
  initialEntries: readonly string[],
  outlets: Parameters<typeof HostDeckRoutes>[0]["outlets"] = {}
) {
  return render(
    <MemoryRouter initialEntries={[...initialEntries]}>
      <LocationProbe />
      <HostDeckRoutes outlets={outlets} />
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-path">{location.pathname}</output>;
}

function pairedResult() {
  return Object.freeze({
    state: "paired" as const,
    device_id: "client_abcdefghijklmnopqrstuvwx",
    permission: "write" as const,
    client_label: "Android phone",
    device_expires_at: "2026-10-20T12:00:00.000Z",
    csrf_token: "C".repeat(43),
    csrf_generation: 3,
    csrf_rotated_at: "2026-07-22T12:00:00.000Z"
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createResponsiveContextCoordinatorHarness(): Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  setTarget: ReturnType<typeof vi.fn>;
  loadMoreSessions: ReturnType<typeof vi.fn>;
  publishDetail: () => void;
  publishAuthorityLoss: () => void;
}> {
  let current = recoveryConnectionSnapshot("ready");
  const listeners = new Set<() => void>();
  const setTarget = vi.fn();
  const loadMoreSessions = vi.fn();
  const publish = (next: BrowserConnectionSnapshot): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const coordinator = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTarget,
    refresh: vi.fn(),
    loadMoreSessions,
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList: vi.fn(),
    requestRemoteStatus: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock: vi.fn(),
    requestSelectedSessionRead: vi.fn(),
    close: vi.fn()
  }) as unknown as BrowserConnectionStateCoordinator;
  return Object.freeze({
    coordinator,
    setTarget,
    loadMoreSessions,
    publishDetail: () => publish(responsiveDetailConnectionSnapshot(true)),
    publishAuthorityLoss: () => publish(responsiveDetailConnectionSnapshot(false))
  });
}

function createRecoveryCoordinatorHarness(): Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  bootstrapCsrf: ReturnType<typeof vi.fn>;
  completeBootstrap: () => void;
}> {
  let current = recoveryConnectionSnapshot("idle");
  const listeners = new Set<() => void>();
  const bootstrap = createDeferred<BrowserConnectionSnapshot>();
  const publish = (next: BrowserConnectionSnapshot) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const bootstrapCsrf = vi.fn(() => {
    publish(recoveryConnectionSnapshot("bootstrapping"));
    return bootstrap.promise.then((next) => {
      publish(next);
      return next;
    });
  });
  const coordinator = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTarget: vi.fn(),
    refresh: vi.fn(),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf,
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList: vi.fn(async () => ({
      status: 200,
      data: { devices: [], next_cursor: null, has_more: false }
    })),
    requestRemoteStatus: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock: vi.fn(),
    requestSelectedSessionRead: vi.fn(),
    close: vi.fn()
  }) as unknown as BrowserConnectionStateCoordinator;
  return Object.freeze({
    coordinator,
    bootstrapCsrf,
    completeBootstrap: () => bootstrap.resolve(recoveryConnectionSnapshot("ready"))
  });
}

function createDeviceCoordinatorHarness(): Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  requestDeviceList: ReturnType<typeof vi.fn>;
  completeList: () => Promise<void>;
}> {
  const current = recoveryConnectionSnapshot("ready");
  const response = createDeferred<unknown>();
  const requestDeviceList = vi.fn(() => response.promise);
  const coordinator = Object.freeze({
    snapshot: () => current,
    subscribe: () => () => undefined,
    setTarget: vi.fn(),
    refresh: vi.fn(),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList,
    requestRemoteStatus: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock: vi.fn(),
    requestSelectedSessionRead: vi.fn(),
    close: vi.fn()
  }) as unknown as BrowserConnectionStateCoordinator;
  return Object.freeze({
    coordinator,
    requestDeviceList,
    completeList: async () => {
      response.resolve({
        status: 200,
        data: {
          devices: [{
            device_id: "device_shell_recovery_private",
            client_label: "Xiaomi 15 Pro",
            permission: "write",
            created_at: "2026-07-01T05:00:00.000Z",
            last_used_at: "2026-07-26T05:00:00.000Z",
            expires_at: "2026-10-26T05:00:00.000Z",
            revoked_at: null
          }],
          next_cursor: null,
          has_more: false
        }
      });
      await response.promise;
    }
  });
}

function createRemoteRecoveryCoordinatorHarness(): Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  requestRemoteStatus: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  completeStatus: () => Promise<void>;
  completeRefresh: () => Promise<void>;
}> {
  let current = recoveryConnectionSnapshot("ready");
  const listeners = new Set<() => void>();
  const status = createDeferred<unknown>();
  const refreshed = createDeferred<BrowserConnectionSnapshot>();
  const publish = (next: BrowserConnectionSnapshot): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const requestRemoteStatus = vi.fn(() => status.promise);
  const refresh = vi.fn(() =>
    refreshed.promise.then((next) => {
      publish(next);
      return next;
    })
  );
  const coordinator = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTarget: vi.fn(),
    refresh,
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList: vi.fn(async () => ({
      status: 200 as const,
      data: Object.freeze({ devices: Object.freeze([]), next_cursor: null, has_more: false })
    })),
    requestRemoteStatus,
    requestDeviceRevoke: vi.fn(),
    requestHostLock: vi.fn(),
    requestSelectedSessionRead: vi.fn(),
    close: vi.fn()
  }) as unknown as BrowserConnectionStateCoordinator;
  return Object.freeze({
    coordinator,
    requestRemoteStatus,
    refresh,
    completeStatus: async () => {
      status.resolve(Object.freeze({
        status: 200,
        data: Object.freeze({
          generation: 4,
          availability: "ready",
          reason: null,
          external_origin: "https://hostdeck-shell-recovery.fixture-tailnet.ts.net",
          laptop_action_required: false,
          observed_at: "2026-07-26T05:00:00.000Z"
        })
      }));
      await status.promise;
    },
    completeRefresh: async () => {
      refreshed.resolve(remoteProfileOtherConnectionSnapshot());
      await refreshed.promise;
    }
  });
}

function createHostLockCoordinatorHarness(): Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  requestHostLock: ReturnType<typeof vi.fn>;
  completeLock: () => Promise<void>;
}> {
  let current = hostLockConnectionSnapshot();
  const listeners = new Set<() => void>();
  const response = createDeferred<void>();
  const publish = (next: BrowserConnectionSnapshot): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const requestHostLock = vi.fn(async () => {
    publish(hostLockConnectionSnapshot({ pending: true }));
    await response.promise;
    const locked = hostLockConnectionSnapshot({ epoch: 2, locked: true });
    publish(locked);
    if (locked.access.data === null) {
      throw new TypeError("Host-lock fixture is missing paired access data.");
    }
    return Object.freeze({ status: 200 as const, data: locked.access.data });
  });
  const coordinator = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTarget: vi.fn(),
    refresh: vi.fn(async () => current),
    loadMoreSessions: vi.fn(),
    connectSessionStream: vi.fn(),
    disconnectSessionStream: vi.fn(),
    bootstrapCsrf: vi.fn(),
    adoptCsrfBootstrap: vi.fn(),
    requestProtected: vi.fn(),
    requestDeviceList: vi.fn(async () => ({
      status: 200 as const,
      data: Object.freeze({ devices: Object.freeze([]), next_cursor: null, has_more: false })
    })),
    requestRemoteStatus: vi.fn(),
    requestDeviceRevoke: vi.fn(),
    requestHostLock,
    requestSelectedSessionRead: vi.fn(),
    close: vi.fn()
  }) as unknown as BrowserConnectionStateCoordinator;
  return Object.freeze({
    coordinator,
    requestHostLock,
    completeLock: async () => {
      response.resolve();
      await response.promise;
    }
  });
}

function hostLockConnectionSnapshot(
  options: Readonly<{ epoch?: number; locked?: boolean; pending?: boolean }> = {}
): BrowserConnectionSnapshot {
  const base = recoveryConnectionSnapshot("ready");
  if (base.access.data === null) {
    throw new TypeError("Host-lock fixture requires paired access data.");
  }
  const locked = options.locked ?? false;
  const pending = options.pending ?? false;
  const causes = locked
    ? Object.freeze(["host_locked" as const])
    : pending
      ? Object.freeze(["host_lock_pending" as const])
      : Object.freeze([]);
  return Object.freeze({
    ...base,
    epoch: options.epoch ?? base.epoch,
    access: Object.freeze({
      ...base.access,
      data: Object.freeze({
        ...base.access.data,
        locked,
        can_write_sessions: !locked
      })
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: causes.length === 0,
      causes
    })
  });
}

function recoveryConnectionSnapshot(
  phase: "idle" | "bootstrapping" | "ready"
): BrowserConnectionSnapshot {
  const timestamp = "2026-07-26T05:00:00.000Z";
  const origin = "https://hostdeck-shell-recovery.fixture-tailnet.ts.net";
  const access = Object.freeze({
    authentication_state: "paired_device" as const,
    device_id: "device_shell_recovery_private",
    permission: "write" as const,
    device_expires_at: "2026-10-26T05:00:00.000Z",
    configured_origin: origin,
    network_mode: "remote" as const,
    transport: "https" as const,
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: false
  });
  const host = selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: "ready",
      readiness: "ready",
      updated_at: timestamp,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      })),
      mutation_admission: "open"
    },
    compatibility: {
      state: "supported",
      evidence: "current",
      observed_version: "0.144.0",
      supported_version: "0.144.0",
      capability_state: "verified",
      checked_at: timestamp,
      recorded_at: timestamp
    },
    remote: {
      generation: 1,
      state_generation: 1,
      availability: "ready",
      cause: null,
      external_origin: origin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode: "paired_write",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: true,
        causes: []
      }
    }
  });
  const resource = <Data,>(data: Data) => Object.freeze({
    state: "current" as const,
    data,
    failure: null,
    observedAt: timestamp
  });
  return Object.freeze({
    epoch: 1,
    target: Object.freeze({ kind: "mission_control" as const }),
    phase: phase === "ready" ? "ready" as const : "degraded" as const,
    access: resource(access),
    host: resource(host),
    targetState: resource(Object.freeze({
      kind: "mission_control" as const,
      access: Object.freeze({
        mode: "paired_write" as const,
        network_mode: "remote" as const,
        transport: "https" as const
      }),
      sessions: Object.freeze([]),
      nextCursor: null,
      hasMore: false,
      pageCount: 1
    })),
    stream: Object.freeze({
      state: "not_applicable" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase,
      generation: phase === "ready" ? 2 : null,
      rotatedAt: phase === "ready" ? timestamp : null,
      failure: null,
      invalidationReason: phase === "idle" ? "pairing_replaced" as const : null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: phase === "ready",
      causes: Object.freeze(phase === "ready" ? [] : ["csrf_not_ready" as const])
    }),
    lastFailure: null
  }) as unknown as BrowserConnectionSnapshot;
}

function responsiveDetailConnectionSnapshot(readable: boolean): BrowserConnectionSnapshot {
  const base = recoveryConnectionSnapshot("ready");
  const timestamp = "2026-07-26T05:02:00.000Z";
  const deniedAccess = base.access.data === null
    ? null
    : Object.freeze({
        ...base.access.data,
        authentication_state: "revoked_device" as const,
        device_id: null,
        permission: null,
        device_expires_at: null,
        can_read_sessions: false,
        can_write_sessions: false,
        can_lock: false,
        can_unlock: false
      });
  if (!readable && deniedAccess === null) {
    throw new TypeError("Responsive shell fixture requires access data.");
  }
  return Object.freeze({
    ...base,
    epoch: readable ? 2 : 3,
    target: Object.freeze({ kind: "session_detail" as const, sessionId }),
    phase: readable ? "ready" as const : "access_limited" as const,
    access: readable
      ? base.access
      : Object.freeze({
          state: "current" as const,
          data: deniedAccess,
          failure: null,
          observedAt: timestamp
        }),
    targetState: Object.freeze({
      state: readable ? "loading" as const : "blocked" as const,
      data: null,
      failure: null,
      observedAt: null
    }),
    stream: Object.freeze({
      state: "idle" as const,
      snapshot: null,
      continuity: "not_applicable" as const,
      boundary: null,
      failure: null
    }),
    csrf: readable
      ? base.csrf
      : Object.freeze({
          phase: "idle" as const,
          generation: null,
          rotatedAt: null,
          failure: null,
          invalidationReason: "device_revoked" as const
        }),
    writeEligibility: readable
      ? base.writeEligibility
      : Object.freeze({
          scope: "browser_shell" as const,
          eligible: false,
          causes: Object.freeze(["revoked_device" as const])
        })
  });
}

function remoteProfileOtherConnectionSnapshot(): BrowserConnectionSnapshot {
  const base = recoveryConnectionSnapshot("ready");
  if (base.host.data === null) {
    throw new TypeError("Remote-recovery fixture requires current host status.");
  }
  const timestamp = "2026-07-26T05:01:00.000Z";
  return Object.freeze({
    ...base,
    epoch: 2,
    host: Object.freeze({
      ...base.host,
      data: Object.freeze({
        ...base.host.data,
        remote: Object.freeze({
          generation: 2,
          state_generation: 2,
          availability: "unavailable" as const,
          cause: "profile_other" as const,
          external_origin: null,
          laptop_action_required: true,
          observed_at: timestamp,
          checked_at: timestamp,
          updated_at: timestamp
        })
      }),
      observedAt: timestamp
    })
  }) as unknown as BrowserConnectionSnapshot;
}
