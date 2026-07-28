// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveControlController,
  ArchiveControlView
} from "./archive-control-state.js";
import { SessionActionsSheet } from "./interrupt-control.js";
import type {
  InterruptControlController,
  InterruptControlTone,
  InterruptControlView,
  InterruptResultView
} from "./interrupt-control-state.js";
import type {
  LaptopResumeControlController,
  LaptopResumeControlView
} from "./laptop-resume-control-state.js";

const turnId = "turn-interrupt-ui-001";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionActionsSheet", () => {
  it("owns exact Interrupt, Archive, Resume, Host access in one focus-restoring sheet", async () => {
    const user = userEvent.setup();
    const harness = uiController();
    renderSheet(harness.controller);
    const trigger = screen.getByRole("button", { name: "Open session actions" });

    await user.click(trigger);

    let dialog = screen.getByRole("dialog", { name: "Session actions" });
    expect(
      Array.from(dialog.querySelectorAll(".hostdeck-utility-menu__item strong"), (item) =>
        item.textContent
      )
    ).toEqual([
      "Interrupt active turn",
      "Archive session",
      "Resume on laptop",
      "Host & access"
    ]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const interrupt = within(dialog).getByRole("button", { name: /Interrupt active turn/iu });
    await waitFor(() => expect(document.activeElement).toBe(interrupt));

    await user.click(within(dialog).getByRole("button", { name: /Host & access/iu }));
    dialog = screen.getByRole("dialog", { name: "Host & access" });
    expect(within(dialog).getByText("Paired Xiaomi fixture")).toBeTruthy();
    const back = within(dialog).getByRole("button", { name: "Back to session actions" });
    await waitFor(() => expect(document.activeElement).toBe(back));

    await user.click(back);
    dialog = screen.getByRole("dialog", { name: "Session actions" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: /Interrupt active turn/iu })
      )
    );
    await user.click(within(dialog).getByRole("button", { name: "Close session actions" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("requires exact confirmation, locks pending dismissal, and exposes no resend", async () => {
    const user = userEvent.setup();
    const harness = uiController();
    renderSheet(harness.controller);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));
    await user.click(screen.getByRole("button", { name: /Interrupt active turn/iu }));

    let dialog = screen.getByRole("dialog", { name: "Interrupt active turn?" });
    expect(within(dialog).getByText("android-release")).toBeTruthy();
    expect(within(dialog).getByText(turnId)).toBeTruthy();
    expect(within(dialog).getByText("In progress")).toBeTruthy();
    expect(within(dialog).getByText("Stop only this active turn")).toBeTruthy();
    expect(within(dialog).getByText("Not archived, deleted, or erased")).toBeTruthy();
    expect(harness.confirm).not.toHaveBeenCalled();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    await user.click(within(dialog).getByRole("button", { name: "Interrupt turn" }));
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    dialog = screen.getByRole("dialog", { name: "Interrupt active turn" });
    expect(within(dialog).getAllByText("Waiting for terminal proof").length).toBeGreaterThan(0);
    expect(dialog.textContent).not.toMatch(/accepted|request completed|retry/iu);
    expect(
      (within(dialog).getByRole("button", { name: "Close session actions" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Interrupt active turn" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog", { name: "Interrupt active turn" })).toBeTruthy();

    harness.settle(result("confirmed_interrupted", "interrupted"), "connected");
    dialog = await screen.findByRole("dialog", { name: "Turn interrupted" });
    expect(within(dialog).getByText("HostDeck confirmed this exact turn ended as interrupted.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /retry/iu })).toBeNull();
    const done = within(dialog).getByRole("button", { name: "Done" });
    await waitFor(() => expect(document.activeElement).toBe(done));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["confirmed_interrupted", "interrupted", "Turn interrupted", "connected"],
    ["feed_interrupted", "interrupted", "Turn ended as interrupted", "attention"],
    ["not_interrupted", "completed", "Turn completed", "attention"],
    ["not_interrupted", "failed", "Turn failed", "attention"],
    ["blocked", null, "Interrupt blocked", "danger"],
    ["outcome_unknown", null, "Outcome not confirmed", "danger"],
    ["inconsistent", null, "Interrupt state inconsistent", "danger"]
  ] as const)(
    "renders %s/%s as a distinct settled no-retry result",
    async (kind, terminalState, label, tone) => {
      const user = userEvent.setup();
      const harness = uiController({ openResult: result(kind, terminalState) , resultTone: tone });
      renderSheet(harness.controller);

      await user.click(screen.getByRole("button", { name: "Open session actions" }));

      const dialog = screen.getByRole("dialog", { name: label });
      expect(within(dialog).getByRole("heading", { name: label })).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: /retry/iu })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
      expect(dialog.classList.contains(`hostdeck-session-actions-sheet--${tone}`)).toBe(true);
    }
  );

  it.each([
    "There is no active turn to interrupt.",
    "Read-only access cannot interrupt a turn.",
    "Remote writes are locked.",
    "Live session activity is reconnecting.",
    "Session activity continuity is not proven yet.",
    "An interrupt was already submitted for this exact turn."
  ])("keeps an unavailable interrupt row visible and disabled: %s", async (reason) => {
    const user = userEvent.setup();
    const harness = uiController({ disabledReason: reason });
    renderSheet(harness.controller);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));

    const interrupt = screen.getByRole("button", { name: /Interrupt active turn/iu });
    expect((interrupt as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(harness.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Resume on laptop/iu })
      )
    );
  });

  it("keeps Host access reachable without disclosing a retained interrupt target", async () => {
    const user = userEvent.setup();
    const harness = uiController({ hidden: true });
    renderSheet(harness.controller);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));

    expect(screen.getAllByText("Session details are not available.")).toHaveLength(3);
    expect(document.body.textContent).not.toContain(turnId);
    expect(document.body.textContent).not.toContain("android-release");
    await user.click(screen.getByRole("button", { name: /Host & access/iu }));
    expect(screen.getByText("Paired Xiaomi fixture")).toBeTruthy();
  });
});

function renderSheet(controller: InterruptControlController) {
  return render(
    <SessionActionsSheet
      archive={unavailableArchiveController(!controller.snapshot().visible)}
      controller={controller}
      hostAccess={<p>Paired Xiaomi fixture</p>}
      laptopResume={laptopResumeController(!controller.snapshot().visible)}
      onArchiveSucceeded={vi.fn()}
    />
  );
}

function laptopResumeController(hidden = false): LaptopResumeControlController {
  const current = laptopResumeView(hidden);
  return Object.freeze({
    snapshot: () => current,
    subscribe: () => () => undefined,
    updateContext: () => current,
    open: async () => current,
    refresh: async () => current,
    copy: async () => current,
    dismiss: () => current,
    close: () => current
  });
}

function laptopResumeView(hidden = false): LaptopResumeControlView {
  return Object.freeze({
    visible: !hidden,
    sheetOpen: false,
    phase: hidden ? "hidden" : "closed",
    tone: "muted",
    status: hidden ? "Session details unavailable" : "Laptop resume closed",
    statusDetail: hidden ? "Session details are not available." : null,
    sessionId: "session-interrupt-ui-001" as LaptopResumeControlView["sessionId"],
    targetLabel: hidden ? null : "android-release",
    actionEnabled: !hidden,
    actionDisabledReason: hidden ? "Session details are not available." : null,
    busy: false,
    refreshEnabled: false,
    available: null,
    unavailableReason: null,
    command: null,
    commandFreshness: null,
    copyEnabled: false,
    copyPhase: "idle",
    copyStatus: null,
    copyStatusDetail: null
  });
}

function unavailableArchiveController(hidden = false): ArchiveControlController {
  const listeners = new Set<() => void>();
  let current = archiveView(hidden ? {
    visible: false,
    phase: "hidden",
    target: null,
    targetLabel: null,
    actionDisabledReason: "Session details are not available."
  } : {});
  const publish = (next: ArchiveControlView) => {
    current = next;
    for (const listener of [...listeners]) listener();
    return current;
  };
  return Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateContext: () => current,
    open: () => publish(archiveView({
      ...current,
      sheetOpen: true,
      phase: hidden ? "hidden" : "unavailable"
    })),
    beginConfirmation: () => current,
    cancelConfirmation: () => current,
    confirm: async () => current,
    acknowledgeResult: () => current,
    dismiss: () => publish(archiveView({ ...current, sheetOpen: false, phase: "closed" })),
    close: () => publish(archiveView({ visible: false, phase: "hidden", targetLabel: null }))
  });
}

function archiveView(overrides: Partial<ArchiveControlView> = {}): ArchiveControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "attention",
    title: "Archive session",
    status: "Session actions closed",
    statusDetail: "Finish or interrupt the active turn before archiving.",
    targetLabel: "android-release",
    target: Object.freeze({ sessionLabel: "android-release" }),
    actionEnabled: false,
    actionDisabledReason: "Finish or interrupt the active turn before archiving.",
    confirmationOpen: false,
    confirmEnabled: false,
    busy: false,
    closeDisabled: false,
    resultOpen: false,
    result: null,
    ...overrides
  });
}

function uiController(options: Readonly<{
  disabledReason?: string;
  hidden?: boolean;
  openResult?: InterruptResultView;
  resultTone?: InterruptControlTone;
}> = {}) {
  const listeners = new Set<() => void>();
  const disabled = options.disabledReason !== undefined || options.hidden === true;
  let current = options.hidden === true
    ? view({
        visible: false,
        phase: "hidden",
        target: null,
        targetLabel: null,
        actionEnabled: false,
        actionDisabledReason: "Session details are not available."
      })
    : view({
        actionEnabled: !disabled,
        actionDisabledReason: options.disabledReason ?? null
      });
  let pendingResolve: ((value: InterruptControlView) => void) | null = null;
  const publish = (next: InterruptControlView) => {
    current = next;
    for (const listener of [...listeners]) listener();
    return current;
  };
  const openView = () => options.openResult === undefined
    ? view({
        ...current,
        sheetOpen: true,
        phase: disabled ? options.hidden === true ? "hidden" : "unavailable" : "ready",
        status: disabled ? "Interrupt unavailable" : "Active turn ready",
        statusDetail: current.actionDisabledReason
      })
    : view({
        sheetOpen: true,
        phase: options.openResult.kind,
        tone: options.resultTone ?? "danger",
        title: options.openResult.label,
        status: options.openResult.label,
        statusDetail: options.openResult.detail,
        actionEnabled: false,
        actionDisabledReason: "An interrupt was already submitted for this exact turn.",
        resultOpen: true,
        result: options.openResult
      });
  const confirm = vi.fn(() => {
    publish(view({
      ...current,
      phase: "submitting",
      tone: "attention",
      title: "Interrupt active turn?",
      status: "Waiting for terminal proof",
      statusDetail: "HostDeck sent one interrupt request and is waiting for the exact turn result.",
      confirmationOpen: false,
      confirmEnabled: false,
      busy: true,
      closeDisabled: true
    }));
    return new Promise<InterruptControlView>((resolve) => {
      pendingResolve = resolve;
    });
  });
  const controller: InterruptControlController = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateContext: () => current,
    open: () => publish(openView()),
    beginConfirmation: () => current.actionEnabled
      ? publish(view({
          ...current,
          phase: "confirming",
          tone: "danger",
          title: "Interrupt active turn?",
          status: "Confirmation required",
          statusDetail: "No request is sent until you confirm this exact turn.",
          confirmationOpen: true,
          confirmEnabled: true
        }))
      : current,
    cancelConfirmation: () => publish(view({
      ...current,
      phase: "ready",
      tone: "focus",
      title: "Session actions",
      status: "Active turn ready",
      statusDetail: "Interrupt requires confirmation.",
      confirmationOpen: false,
      confirmEnabled: false
    })),
    confirm,
    acknowledgeResult: () => publish(view({
      ...current,
      resultOpen: false,
      result: null
    })),
    dismiss: () => publish(view({
      ...current,
      sheetOpen: false,
      phase: "closed",
      resultOpen: false,
      result: null,
      confirmationOpen: false,
      confirmEnabled: false
    })),
    close: () => publish(view({ visible: false, phase: "hidden", target: null, result: null }))
  });
  return Object.freeze({
    controller,
    confirm,
    settle(settled: InterruptResultView, tone: InterruptControlTone) {
      const next = publish(view({
        ...current,
        phase: settled.kind,
        tone,
        title: settled.label,
        status: settled.label,
        statusDetail: settled.detail,
        busy: false,
        closeDisabled: false,
        resultOpen: true,
        result: settled
      }));
      pendingResolve?.(next);
      pendingResolve = null;
    }
  });
}

function view(overrides: Partial<InterruptControlView> = {}): InterruptControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "focus",
    title: "Interrupt turn",
    status: "Session actions closed",
    statusDetail: null,
    targetLabel: "android-release",
    target: Object.freeze({
      sessionLabel: "android-release",
      turnId,
      state: "in_progress" as const,
      stateLabel: "In progress"
    }),
    actionEnabled: true,
    actionDisabledReason: null,
    confirmationOpen: false,
    confirmEnabled: false,
    busy: false,
    closeDisabled: false,
    resultOpen: false,
    result: null,
    ...overrides
  });
}

function result(
  kind: InterruptResultView["kind"],
  terminalState: InterruptResultView["terminalState"]
): InterruptResultView {
  const label = kind === "confirmed_interrupted"
    ? "Turn interrupted"
    : kind === "feed_interrupted"
      ? "Turn ended as interrupted"
      : kind === "not_interrupted"
        ? terminalState === "failed" ? "Turn failed" : "Turn completed"
        : kind === "blocked"
          ? "Interrupt blocked"
          : kind === "outcome_unknown"
            ? "Outcome not confirmed"
            : "Interrupt state inconsistent";
  const detail = kind === "confirmed_interrupted"
    ? "HostDeck confirmed this exact turn ended as interrupted."
    : kind === "feed_interrupted"
      ? "Session activity confirms interruption. The request receipt was not returned, and HostDeck did not resend it."
      : kind === "not_interrupted"
        ? `Session activity confirms this turn ${terminalState ?? "ended"} without a confirmed interrupt result.`
        : kind === "blocked"
          ? "Current secure interrupt authority was rejected. No retry was sent."
          : kind === "outcome_unknown"
            ? "HostDeck could not confirm this exact turn outcome and will not resend the interrupt request."
            : "The response and retained turn activity do not agree. HostDeck will not resend this request.";
  return Object.freeze({
    kind,
    source: kind === "confirmed_interrupted" ? "api" : kind.includes("interrupted") || kind === "not_interrupted" ? "feed" : "browser",
    label,
    detail,
    terminalState,
    updatedAt: terminalState === null ? null : "2026-07-27T20:00:00.000Z"
  });
}
