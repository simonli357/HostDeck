// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAppStartupPhase,
  BrowserAppStartupSnapshot
} from "./app-startup.js";
import {
  PairingStartupScreen,
  projectPairingStartup
} from "./pairing-screen.js";

afterEach(() => cleanup());

describe("pairing startup screen", () => {
  it("projects every bounded startup state without fake actions", () => {
    const phases: readonly BrowserAppStartupPhase[] = [
      "checking",
      "claiming",
      "paired",
      "invalid_link",
      "secure_entry_failed",
      "link_not_accepted",
      "origin_rejected",
      "rate_limited",
      "claim_unavailable",
      "claim_unknown",
      "paired_csrf_unavailable",
      "startup_failed",
      "reloading",
      "closed"
    ];
    for (const phase of phases) {
      const projection = projectPairingStartup(snapshot(phase));
      expect(Object.isFrozen(projection), phase).toBe(true);
      expect(Object.isFrozen(projection.stages), phase).toBe(true);
      expect(projection.stages.map(({ label }) => label), phase).toEqual([
        "Secure link",
        "Pair phone",
        "Ready"
      ]);
      expect(projection.stages, phase).toHaveLength(3);
    }

    expect(projectPairingStartup(snapshot("claim_unknown")).action).toBe("reload");
    expect(projectPairingStartup(snapshot("paired_csrf_unavailable")).action).toBe("reload");
    expect(projectPairingStartup(snapshot("paired")).action).toBe("continue");
    expect(projectPairingStartup(snapshot("link_not_accepted")).action).toBeNull();
    expect(() => projectPairingStartup(snapshot("ready"))).toThrow(TypeError);
    expect(() => projectPairingStartup({ phase: "claiming", pairing: null })).toThrow(TypeError);
  });

  it("renders a sanitized paired confirmation and continues only on command", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(
      <PairingStartupScreen
        snapshot={snapshot("paired", {
          permission: "write",
          clientLabel: "Android phone",
          deviceExpiresAt: "2026-10-20T12:00:00.000Z"
        })}
        onContinue={onContinue}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { level: 1, name: "Phone paired" })).toBeTruthy();
    expect(screen.getByText("Read & write")).toBeTruthy();
    expect(screen.getByText("Android phone")).toBeTruthy();
    expect(screen.getByText("Private HTTPS", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("Oct 20, 2026")).toBeTruthy();
    expect(screen.queryByText(/client_/u)).toBeNull();
    expect(screen.getByRole("main").textContent).not.toContain("csrf");

    await user.click(screen.getByRole("button", { name: "Open Mission Control" }));

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("renders progress and only offers reload for an ambiguous outcome", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const view = render(
      <PairingStartupScreen
        snapshot={snapshot("claiming")}
        onContinue={vi.fn()}
        onReload={onReload}
      />
    );

    expect(screen.getByRole("heading", { level: 1, name: "Pairing this phone" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Pairing progress" })).toBeTruthy();
    expect(screen.getByText("Pair phone").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(
      <PairingStartupScreen
        snapshot={snapshot("claim_unknown")}
        onContinue={vi.fn()}
        onReload={onReload}
      />
    );
    await user.click(screen.getByRole("button", { name: "Reload to check" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("keeps invalid and rejected links non-enumerating and non-retryable", () => {
    for (const phase of ["invalid_link", "link_not_accepted", "rate_limited"] as const) {
      const view = render(
        <PairingStartupScreen
          snapshot={snapshot(phase)}
          onContinue={vi.fn()}
          onReload={vi.fn()}
        />
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByRole("main").textContent).not.toContain("#pair=");
      expect(screen.getByRole("main").textContent).not.toContain("device_id");
      view.unmount();
    }
  });
});

function snapshot(
  phase: BrowserAppStartupPhase,
  pairing: BrowserAppStartupSnapshot["pairing"] = null
): BrowserAppStartupSnapshot {
  return Object.freeze({
    phase,
    pairing: pairing === null ? null : Object.freeze(pairing)
  });
}
