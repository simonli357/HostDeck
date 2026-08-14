// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCompatibilityPanel } from "./runtime-compatibility.js";
import type { RuntimeCompatibilityView } from "./runtime-compatibility-state.js";

afterEach(() => {
  cleanup();
});

describe("runtime compatibility panel", () => {
  it("shows complete version, capability, evidence, and check truth", () => {
    render(
      <RuntimeCompatibilityPanel
        view={compatibilityView()}
        onCheck={vi.fn(async () => compatibilityView())}
      />
    );

    const region = screen.getByRole("region", { name: "Codex update required" });
    expect(region.textContent).toContain("CODEX RUNTIME");
    expect(region.textContent).toContain("Current laptop check");
    expect(region.textContent).toContain("Installed");
    expect(region.textContent).toContain("0.145.0");
    expect(region.textContent).toContain("HostDeck supports");
    expect(region.textContent).toContain("0.147.0");
    expect(region.textContent).toContain("Controls");
    expect(region.textContent).toContain("Blocked");
    expect(region.textContent).toContain("Evidence");
    expect(region.textContent).toContain("Current");
    expect(region.textContent).toContain("Checked Jul 27, 2026, 3:00 PM UTC");
    expect(
      (screen.getByRole("button", { name: "Check compatibility" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(region.textContent).not.toMatch(
      /binding|capability inventory|\/home\/private|socket|operation_id|private reason/iu
    );
  });

  it("dispatches only the supplied owner and presents a specific supported label", async () => {
    const user = userEvent.setup();
    const supported = compatibilityView({
      phase: "supported",
      state: "supported",
      title: "Codex compatible",
      detail: "Installed Codex matches HostDeck.",
      tone: "connected",
      urgent: false,
      observedVersion: "0.147.0",
      observedVersionLabel: "0.147.0",
      capabilityState: "verified",
      capabilityLabel: "Verified",
      routeVisible: false,
      actionLabel: "Recheck compatibility"
    });
    const onCheck = vi.fn(async () => supported);
    render(<RuntimeCompatibilityPanel view={supported} onCheck={onCheck} />);

    await user.click(screen.getByRole("button", { name: "Recheck compatibility" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("Codex compatible");
  });

  it("keeps checking busy, disabled, atomic, and reduced-motion compatible", () => {
    const checking = compatibilityView({
      phase: "checking",
      title: "Checking Codex compatibility",
      detail: "Reading current laptop status.",
      tone: "muted",
      urgent: false,
      ownerLabel: "BROWSER",
      sourceLabel: "Read-only status check",
      actionLabel: "Check compatibility",
      actionEnabled: false,
      busy: true
    });
    render(
      <RuntimeCompatibilityPanel
        view={checking}
        onCheck={vi.fn(async () => checking)}
      />
    );

    const panel = screen.getByRole("region", { name: "Checking Codex compatibility" });
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").getAttribute("aria-atomic")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Check compatibility" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(panel.querySelector(".hostdeck-spin")).not.toBeNull();
  });

  it("does not render protected facts or an action while hidden", () => {
    render(
      <RuntimeCompatibilityPanel
        view={compatibilityView({
          phase: "hidden",
          state: null,
          evidence: null,
          capabilityState: null,
          title: "Codex compatibility unavailable",
          detail: "Current authority is required.",
          tone: "muted",
          ownerLabel: "HOSTDECK",
          sourceLabel: "Protected status hidden",
          observedVersion: null,
          supportedVersion: null,
          observedVersionLabel: "Not observed",
          supportedVersionLabel: "Hidden",
          capabilityLabel: "Hidden",
          evidenceLabel: "Hidden",
          checkedAt: null,
          recordedAt: null,
          checkedLabel: "Not checked",
          current: false,
          routeVisible: false,
          action: null,
          actionLabel: null,
          actionEnabled: false
        })}
      />
    );

    const panel = screen.getByRole("region", { name: "Codex compatibility unavailable" });
    expect(panel.querySelector("dl")).toBeNull();
    expect(panel.querySelector("button")).toBeNull();
    expect(panel.textContent).not.toMatch(/0\.14|installed|supports/iu);
  });

  it("fails loudly when an available action has no owner", () => {
    expect(() => render(<RuntimeCompatibilityPanel view={compatibilityView()} />)).toThrow(
      "HostDeck compatibility action is missing its owner."
    );
  });
});

function compatibilityView(
  overrides: Partial<RuntimeCompatibilityView> = {}
): RuntimeCompatibilityView {
  return Object.freeze({
    phase: "version_drift",
    state: "version_drift",
    evidence: "current",
    capabilityState: "blocked",
    title: "Codex update required",
    detail: "This laptop has Codex 0.145.0. HostDeck supports 0.147.0.",
    tone: "danger",
    urgent: true,
    ownerLabel: "CODEX RUNTIME",
    sourceLabel: "Current laptop check",
    observedVersion: "0.145.0",
    supportedVersion: "0.147.0",
    observedVersionLabel: "0.145.0",
    supportedVersionLabel: "0.147.0",
    capabilityLabel: "Blocked",
    evidenceLabel: "Current",
    checkedAt: "2026-07-27T15:00:00.000Z",
    recordedAt: "2026-07-27T15:00:00.000Z",
    checkedLabel: "Checked Jul 27, 2026, 3:00 PM UTC",
    current: true,
    routeVisible: true,
    action: "check_compatibility",
    actionLabel: "Check compatibility",
    actionEnabled: true,
    busy: false,
    ...overrides
  });
}
