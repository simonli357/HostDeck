// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveControlController,
  ArchiveControlTone,
  ArchiveControlView,
  ArchiveResultView
} from "./archive-control-state.js";
import { SessionActionsSheet } from "./interrupt-control.js";
import type {
  InterruptControlController,
  InterruptControlView
} from "./interrupt-control-state.js";
import type {
  LaptopResumeControlController,
  LaptopResumeControlView
} from "./laptop-resume-control-state.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("archive Session actions", () => {
  it("keeps exact Interrupt, Archive, Resume, Host order and focuses the enabled idle action", async () => {
    const user = userEvent.setup();
    const harness = archiveUiController();
    renderSheet(harness.controller);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));
    const dialog = screen.getByRole("dialog", { name: "Session actions" });
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
    const archive = within(dialog).getByRole("button", {
      name: "Open Archive session"
    });
    const archiveDetailId = archive.getAttribute("aria-describedby");
    expect(archiveDetailId).not.toBeNull();
    expect(document.getElementById(archiveDetailId as string)?.textContent).toBe(
      "Idle session - retained history stays available"
    );
    expect((within(dialog).getByRole("button", {
      name: /Interrupt active turn/iu
    }) as HTMLButtonElement).disabled).toBe(true);
    expect((archive as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(archive));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Archive session?" })).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("names the exact session and every no-delete/no-interrupt/no-undo consequence", async () => {
    const user = userEvent.setup();
    const harness = archiveUiController();
    renderSheet(harness.controller);
    await user.click(screen.getByRole("button", { name: "Open session actions" }));
    await user.click(screen.getByRole("button", { name: /Archive session/iu }));

    let dialog = screen.getByRole("dialog", { name: "Archive session?" });
    expect(within(dialog).getByText("android-release")).toBeTruthy();
    expect(within(dialog).getByText("Archive this managed session")).toBeTruthy();
    expect(within(dialog).getByText(
      "After laptop confirmation, it leaves active sessions without deleting files or the Codex thread."
    )).toBeTruthy();
    expect(within(dialog).getByText("Idle - no turn will be interrupted")).toBeTruthy();
    expect(within(dialog).getByText("Preserved - not deleted or erased")).toBeTruthy();
    expect(within(dialog).getByText("Not available in HostDeck V1")).toBeTruthy();
    expect(harness.confirm).not.toHaveBeenCalled();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    await user.click(cancel);
    dialog = screen.getByRole("dialog", { name: "Session actions" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: /Archive session/iu })
      )
    );
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  it("locks pending dismissal, sends one UI command, and exposes no premature success", async () => {
    const user = userEvent.setup();
    const harness = archiveUiController();
    renderSheet(harness.controller);
    await openConfirmation(user);

    await user.click(screen.getByRole("button", { name: "Archive session" }));
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    const pending = screen.getByRole("dialog", { name: "Archive session" });
    expect(within(pending).getAllByText("Waiting for laptop confirmation").length)
      .toBeGreaterThan(0);
    expect(pending.textContent).not.toMatch(/accepted|success|deleted|retry/iu);
    expect((within(pending).getByRole("button", {
      name: "Close session actions"
    }) as HTMLButtonElement).disabled).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Archive session" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog", { name: "Archive session" })).toBeTruthy();
  });

  it("keeps proven success until Back to sessions and invokes only its route handoff", async () => {
    const user = userEvent.setup();
    const onArchiveSucceeded = vi.fn();
    const harness = archiveUiController();
    renderSheet(harness.controller, onArchiveSucceeded);
    await openConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Archive session" }));

    harness.settle(result("succeeded"), "connected");
    const dialog = await screen.findByRole("dialog", { name: "Session archived" });
    expect(within(dialog).getByText(
      "The laptop confirmed the Codex thread is archived and HostDeck saved the local archive state."
    )).toBeTruthy();
    expect(within(dialog).getByText("Retained conversation history was not deleted."))
      .toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /retry|restore|delete/iu })).toBeNull();
    expect((within(dialog).getByRole("button", {
      name: "Close session actions"
    }) as HTMLButtonElement).disabled).toBe(true);
    const backToSessions = within(dialog).getByRole("button", { name: "Back to sessions" });
    await waitFor(() => expect(document.activeElement).toBe(backToSessions));

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Session archived" })).toBeTruthy();
    await user.click(backToSessions);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onArchiveSucceeded).toHaveBeenCalledTimes(1);
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["blocked", "Archive blocked", "danger"],
    ["not_completed", "Archive not completed", "attention"],
    ["outcome_unknown", "Archive outcome not confirmed", "danger"],
    ["inconsistent", "Archive state inconsistent", "danger"]
  ] as const)("keeps %s settled on Session Detail with no resend", async (kind, label, tone) => {
    const user = userEvent.setup();
    const onArchiveSucceeded = vi.fn();
    const harness = archiveUiController({ openResult: result(kind), resultTone: tone });
    renderSheet(harness.controller, onArchiveSucceeded);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));
    const dialog = screen.getByRole("dialog", { name: label });
    expect(within(dialog).getByRole("heading", { name: label })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /retry|back to sessions/iu })).toBeNull();
    expect(dialog.classList.contains(`hostdeck-session-actions-sheet--${tone}`)).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onArchiveSucceeded).not.toHaveBeenCalled();
  });

  it.each([
    "Finish or interrupt the active turn before archiving.",
    "Read-only access cannot archive a session.",
    "Remote writes are locked on the laptop.",
    "Live session state is reconnecting. Wait before archiving.",
    "Session activity continuity is not proven yet.",
    "An archive was already submitted for this session."
  ])("keeps unavailable archive visible and disabled: %s", async (reason) => {
    const user = userEvent.setup();
    const harness = archiveUiController({ disabledReason: reason });
    renderSheet(harness.controller);
    await user.click(screen.getByRole("button", { name: "Open session actions" }));

    const archive = screen.getByRole("button", { name: /Archive session/iu });
    expect((archive as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(harness.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Resume on laptop/iu })
      )
    );
  });
});

async function openConfirmation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open session actions" }));
  await user.click(screen.getByRole("button", { name: /Archive session/iu }));
  await screen.findByRole("dialog", { name: "Archive session?" });
}

function renderSheet(
  archive: ArchiveControlController,
  onArchiveSucceeded = vi.fn()
) {
  return render(
    <SessionActionsSheet
      archive={archive}
      controller={unavailableInterruptController()}
      hostAccess={<p>Paired Xiaomi fixture</p>}
      laptopResume={laptopResumeController()}
      onArchiveSucceeded={onArchiveSucceeded}
    />
  );
}

function laptopResumeController(): LaptopResumeControlController {
  const current = laptopResumeView();
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

function laptopResumeView(): LaptopResumeControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "muted",
    status: "Laptop resume closed",
    statusDetail: null,
    sessionId: "session-archive-ui-001" as LaptopResumeControlView["sessionId"],
    targetLabel: "android-release",
    actionEnabled: true,
    actionDisabledReason: null,
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

function archiveUiController(options: Readonly<{
  disabledReason?: string;
  openResult?: ArchiveResultView;
  resultTone?: ArchiveControlTone;
}> = {}) {
  const listeners = new Set<() => void>();
  const disabled = options.disabledReason !== undefined;
  let current = archiveView({
    actionEnabled: !disabled,
    actionDisabledReason: options.disabledReason ?? null
  });
  let pendingResolve: ((value: ArchiveControlView) => void) | null = null;
  const publish = (next: ArchiveControlView) => {
    current = next;
    for (const listener of [...listeners]) listener();
    return current;
  };
  const openView = () => options.openResult === undefined
    ? archiveView({
        ...current,
        sheetOpen: true,
        phase: disabled ? "unavailable" : "ready",
        status: disabled ? "Archive unavailable" : "Idle session ready",
        statusDetail: current.actionDisabledReason
      })
    : archiveView({
        sheetOpen: true,
        phase: options.openResult.kind,
        tone: options.resultTone ?? "danger",
        title: options.openResult.label,
        status: options.openResult.label,
        statusDetail: options.openResult.detail,
        actionEnabled: false,
        actionDisabledReason: "An archive was already submitted for this session.",
        closeDisabled: options.openResult.returnToSessions,
        resultOpen: true,
        result: options.openResult
      });
  const confirm = vi.fn(() => {
    publish(archiveView({
      ...current,
      phase: "submitting",
      tone: "attention",
      title: "Archive session?",
      status: "Waiting for laptop confirmation",
      statusDetail: "HostDeck sent one archive request and is waiting for the laptop result.",
      confirmationOpen: false,
      confirmEnabled: false,
      busy: true,
      closeDisabled: true
    }));
    return new Promise<ArchiveControlView>((resolve) => {
      pendingResolve = resolve;
    });
  });
  const controller: ArchiveControlController = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateContext: () => current,
    open: () => publish(openView()),
    beginConfirmation: () => current.actionEnabled
      ? publish(archiveView({
          ...current,
          phase: "confirming",
          tone: "danger",
          title: "Archive session?",
          status: "Confirmation required",
          statusDetail: "No request is sent until you confirm this exact session.",
          confirmationOpen: true,
          confirmEnabled: true
        }))
      : current,
    cancelConfirmation: () => publish(archiveView({
      ...current,
      phase: "ready",
      tone: "focus",
      status: "Idle session ready",
      statusDetail: "Archive requires explicit confirmation.",
      confirmationOpen: false,
      confirmEnabled: false
    })),
    confirm,
    acknowledgeResult: () => publish(archiveView({
      ...current,
      resultOpen: false,
      result: null,
      closeDisabled: false
    })),
    dismiss: () => current.closeDisabled
      ? current
      : publish(archiveView({
          ...current,
          sheetOpen: false,
          phase: "closed",
          resultOpen: false,
          result: null,
          confirmationOpen: false,
          confirmEnabled: false
        })),
    close: () => publish(archiveView({ visible: false, phase: "hidden", result: null }))
  });
  return Object.freeze({
    controller,
    confirm,
    settle(settled: ArchiveResultView, tone: ArchiveControlTone) {
      const next = publish(archiveView({
        ...current,
        phase: settled.kind,
        tone,
        title: settled.label,
        status: settled.label,
        statusDetail: settled.detail,
        busy: false,
        closeDisabled: settled.returnToSessions,
        resultOpen: true,
        result: settled
      }));
      pendingResolve?.(next);
      pendingResolve = null;
    }
  });
}

function archiveView(overrides: Partial<ArchiveControlView> = {}): ArchiveControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "focus",
    title: "Archive session",
    status: "Session actions closed",
    statusDetail: null,
    targetLabel: "android-release",
    target: Object.freeze({ sessionLabel: "android-release" }),
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

function unavailableInterruptController(): InterruptControlController {
  const listeners = new Set<() => void>();
  let current = interruptView();
  const publish = (next: InterruptControlView) => {
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
    open: () => publish(interruptView({ ...current, sheetOpen: true, phase: "unavailable" })),
    beginConfirmation: () => current,
    cancelConfirmation: () => current,
    confirm: async () => current,
    acknowledgeResult: () => current,
    dismiss: () => publish(interruptView({ ...current, sheetOpen: false, phase: "closed" })),
    close: () => publish(interruptView({ visible: false, phase: "hidden", targetLabel: null }))
  });
}

function interruptView(overrides: Partial<InterruptControlView> = {}): InterruptControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "attention",
    title: "Interrupt turn",
    status: "Session actions closed",
    statusDetail: "There is no active turn to interrupt.",
    targetLabel: "android-release",
    target: null,
    actionEnabled: false,
    actionDisabledReason: "There is no active turn to interrupt.",
    confirmationOpen: false,
    confirmEnabled: false,
    busy: false,
    closeDisabled: false,
    resultOpen: false,
    result: null,
    ...overrides
  });
}

function result(kind: ArchiveResultView["kind"]): ArchiveResultView {
  const succeeded = kind === "succeeded";
  const label = succeeded
    ? "Session archived"
    : kind === "blocked"
      ? "Archive blocked"
      : kind === "not_completed"
        ? "Archive not completed"
        : kind === "outcome_unknown"
          ? "Archive outcome not confirmed"
          : "Archive state inconsistent";
  const detail = succeeded
    ? "The laptop confirmed the Codex thread is archived and HostDeck saved the local archive state."
    : kind === "blocked"
      ? "Current secure archive access was rejected. HostDeck sent no retry."
      : kind === "not_completed"
        ? "The managed session was no longer current and idle for archive."
        : kind === "outcome_unknown"
          ? "The laptop may have archived the thread, or HostDeck may still need to check local archive state."
          : "The selected session identity changed while the archive result was settling.";
  return Object.freeze({
    kind,
    source: succeeded || kind === "not_completed" ? "api" : "browser",
    label,
    detail,
    consequence: succeeded
      ? "Retained conversation history was not deleted."
      : "This session remains on screen. HostDeck sent no retry.",
    returnToSessions: succeeded
  });
}
