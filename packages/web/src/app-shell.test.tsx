// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getAllByText(sessionId)).toHaveLength(1);
    expect(screen.getByRole("banner").textContent).not.toContain(sessionId);

    await user.click(screen.getByRole("button", { name: "Back to Mission Control" }));

    expect(screen.getByTestId("location-path").textContent).toBe(missionControlPath);
    expect(screen.getByRole("link", { name: "Open api-refactor" })).toBeTruthy();
  });

  it("returns a direct detail entry to Mission Control without adding a back loop", async () => {
    const user = userEvent.setup();
    renderShell([sessionDetailPath(sessionId)]);

    expect(screen.getByRole("heading", { level: 1, name: "Session Detail" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to Mission Control" }));

    expect(screen.getByTestId("location-path").textContent).toBe(missionControlPath);
    expect(screen.getByRole("heading", { level: 1, name: "Mission Control" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to Mission Control" })).toBeNull();
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
    expect(screen.getByTestId("location-path").textContent).toBe(missionControlPath);
    expect(dialog.contains(screen.getByRole("button", { name: "Access action" }))).toBe(true);
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

  it("holds production routes behind one external pairing owner even under StrictMode", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<ReturnType<typeof pairedResult>>();
    const bootstrapPairing = vi.fn(() => deferred.promise);
    const adoptCsrfBootstrap = vi.fn();
    const coordinator = Object.freeze({
      snapshot: vi.fn(),
      subscribe: vi.fn(),
      setTarget: vi.fn(),
      refresh: vi.fn(),
      loadMoreSessions: vi.fn(),
      connectSessionStream: vi.fn(),
      disconnectSessionStream: vi.fn(),
      bootstrapCsrf: vi.fn(),
      adoptCsrfBootstrap,
      requestProtected: vi.fn(),
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
