// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveControlController,
  ArchiveControlView
} from "./archive-control-state.js";
import { SessionActionsSheet } from "./interrupt-control.js";
import type {
  InterruptControlController,
  InterruptControlView
} from "./interrupt-control-state.js";
import { LaptopResumeSheetBody } from "./laptop-resume-control.js";
import type {
  LaptopResumeClipboardInput,
  LaptopResumeControlController,
  LaptopResumeControlView
} from "./laptop-resume-control-state.js";

const command =
  "codex resume 019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("laptop-resume Session actions UI", () => {
  it("loads and copies the exact local command in the existing focus-restoring sheet", async () => {
    const user = userEvent.setup();
    const harness = resumeHarness();
    renderActions(harness.controller);
    const trigger = screen.getByRole("button", { name: "Open session actions" });

    await user.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Session actions" });
    expect(menuLabels(dialog)).toEqual([
      "Interrupt active turn",
      "Archive session",
      "Resume on laptop",
      "Host & access"
    ]);

    const resumeAction = within(dialog).getByRole("button", {
      name: "Open Resume on laptop"
    });
    const resumeDetailId = resumeAction.getAttribute("aria-describedby");
    expect(resumeDetailId).not.toBeNull();
    expect(document.getElementById(resumeDetailId as string)?.textContent).toBe(
      "Copy exact local TUI command"
    );
    await user.click(resumeAction);
    dialog = screen.getByRole("dialog", { name: "Resume on laptop" });
    expect(within(dialog).getByText("Laptop terminal only")).toBeTruthy();
    expect(within(dialog).getAllByText("Reading laptop command")).toHaveLength(2);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog.querySelector("input, textarea, [contenteditable='true']")).toBeNull();
    expect(dialog.querySelector("[class*='terminal']")).toBeNull();
    expect(harness.open).toHaveBeenCalledTimes(1);
    expect(harness.writeClipboard).not.toHaveBeenCalled();

    await act(async () => harness.resolveRead());
    dialog = await screen.findByRole("dialog", { name: "Resume on laptop" });
    expect(within(dialog).getByText("Exact laptop command ready")).toBeTruthy();
    const code = within(dialog).getByText(command, { selector: "code" });
    expect(code.getAttribute("contenteditable")).toBeNull();
    expect(within(dialog).getByText("Nothing has run from this phone.")).toBeTruthy();
    const copy = within(dialog).getByRole("button", { name: "Copy command" });
    await waitFor(() => expect(document.activeElement).toBe(copy));

    await user.click(copy);
    expect(await within(dialog).findByText("Command copied")).toBeTruthy();
    expect(within(dialog).getByText(
      "Nothing ran here. Use it only in a terminal on the HostDeck laptop."
    )).toBeTruthy();
    expect(harness.writeClipboard).toHaveBeenCalledTimes(1);
    expect(harness.writeClipboard).toHaveBeenCalledWith(Object.freeze({ text: command }));
    expect(harness.copy).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Back to session actions" }));
    dialog = screen.getByRole("dialog", { name: "Session actions" });
    const resume = within(dialog).getByRole("button", { name: /Resume on laptop/iu });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    expect(harness.dismiss).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Close session actions" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a failed clipboard write visible and retries only after explicit activation", async () => {
    const user = userEvent.setup();
    const harness = resumeHarness({ clipboardFailures: 1 });
    renderActions(harness.controller);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));
    await user.click(screen.getByRole("button", { name: /Resume on laptop/iu }));
    await act(async () => harness.resolveRead());
    const dialog = await screen.findByRole("dialog", { name: "Resume on laptop" });

    await user.click(within(dialog).getByRole("button", { name: "Copy command" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Copy failed");
    expect(within(dialog).getByText(command, { selector: "code" })).toBeTruthy();
    expect(harness.writeClipboard).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(harness.writeClipboard).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Try copy again" }));
    expect(await within(dialog).findByText("Command copied")).toBeTruthy();
    expect(harness.writeClipboard).toHaveBeenCalledTimes(2);
    expect(harness.writeClipboard.mock.calls).toEqual([
      [{ text: command }],
      [{ text: command }]
    ]);
    expect(dialog.querySelector("textarea, [contenteditable='true']")).toBeNull();
  });

  it.each([
    [
      "unavailable",
      "attention",
      "Laptop resume unavailable",
      "The selected Codex runtime cannot provide a local command.",
      null
    ],
    [
      "not_found",
      "attention",
      "Managed session not found",
      "This managed session no longer exists.",
      null
    ],
    [
      "stale_session",
      "attention",
      "Session not eligible",
      "This managed session is not current and eligible for laptop resume.",
      null
    ],
    [
      "runtime_unavailable",
      "attention",
      "Laptop runtime unavailable",
      "The selected Codex runtime is not available for laptop resume.",
      null
    ],
    [
      "access_denied",
      "danger",
      "Laptop command access blocked",
      "Secure read access to laptop resume metadata was rejected.",
      null
    ],
    [
      "failure",
      "danger",
      "Laptop command could not be loaded",
      "Laptop resume metadata failed strict validation.",
      null
    ],
    [
      "stale",
      "attention",
      "Laptop command stale",
      "Check again before copying this command.",
      command
    ]
  ] as const)(
    "renders %s as a bounded non-executing state with an explicit refresh",
    (phase, tone, status, detail, retainedCommand) => {
      const view = resumeView({
        sheetOpen: true,
        phase,
        tone,
        status,
        statusDetail: detail,
        refreshEnabled: true,
        available: phase === "unavailable" ? false : null,
        unavailableReason: phase === "unavailable" ? detail : null,
        command: retainedCommand,
        commandFreshness: retainedCommand === null ? null : "stale"
      });
      const controller = staticResumeController(view);
      render(
        <LaptopResumeSheetBody
          copyButtonRef={createRef<HTMLButtonElement>()}
          controller={controller}
          view={view}
        />
      );

      expect(screen.getByText(status)).toBeTruthy();
      expect(screen.getByText(detail)).toBeTruthy();
      expect(screen.getByText("Not available from this phone")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /copy/iu })).toBeNull();
      if (retainedCommand === null) {
        expect(document.querySelector("code")).toBeNull();
      } else {
        expect(screen.getByText(retainedCommand, { selector: "code" })).toBeTruthy();
      }
    }
  );

  it("disables an ineligible resume row before any read and leaves Host access focusable", async () => {
    const user = userEvent.setup();
    const harness = resumeHarness({
      disabledReason: "Archived sessions cannot resume through HostDeck."
    });
    renderActions(harness.controller);

    await user.click(screen.getByRole("button", { name: "Open session actions" }));
    const dialog = screen.getByRole("dialog", { name: "Session actions" });
    const resume = within(dialog).getByRole("button", { name: /Resume on laptop/iu });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText("Archived sessions cannot resume through HostDeck."))
      .toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Open Host and access" })
      )
    );
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.writeClipboard).not.toHaveBeenCalled();
  });
});

function renderActions(laptopResume: LaptopResumeControlController) {
  return render(
    <SessionActionsSheet
      archive={staticArchiveController()}
      controller={staticInterruptController()}
      hostAccess={<p>Paired Xiaomi fixture</p>}
      laptopResume={laptopResume}
      onArchiveSucceeded={vi.fn()}
    />
  );
}

function menuLabels(dialog: HTMLElement): Array<string | null> {
  return Array.from(
    dialog.querySelectorAll(".hostdeck-utility-menu__item strong"),
    (item) => item.textContent
  );
}

function resumeHarness(options: Readonly<{
  clipboardFailures?: number;
  disabledReason?: string;
}> = {}) {
  const listeners = new Set<() => void>();
  const read = deferred<void>();
  let failuresRemaining = options.clipboardFailures ?? 0;
  let current = resumeView({
    actionEnabled: options.disabledReason === undefined,
    actionDisabledReason: options.disabledReason ?? null,
    tone: options.disabledReason === undefined ? "focus" : "attention",
    statusDetail: options.disabledReason ?? null
  });
  const publish = (next: LaptopResumeControlView) => {
    current = next;
    for (const listener of [...listeners]) listener();
    return current;
  };
  const writeClipboard = vi.fn(async (_input: LaptopResumeClipboardInput) => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new DOMException("Clipboard fixture denied", "NotAllowedError");
    }
  });
  const open = vi.fn(() => {
    if (!current.actionEnabled) return Promise.resolve(current);
    publish(resumeView({
      sheetOpen: true,
      phase: "loading",
      tone: "attention",
      status: "Reading laptop command",
      statusDetail: "HostDeck is checking one exact managed session.",
      busy: true
    }));
    return read.promise.then(() => publish(availableResumeView()));
  });
  const copy = vi.fn(async () => {
    if (!current.copyEnabled || current.command === null) return current;
    const exactCommand = current.command;
    publish(resumeView({
      ...current,
      copyEnabled: false,
      copyPhase: "copying",
      copyStatus: "Copying command",
      copyStatusDetail: "Nothing is being executed on this phone.",
      busy: true
    }));
    try {
      await writeClipboard(Object.freeze({ text: exactCommand }));
      return publish(resumeView({
        ...current,
        copyEnabled: true,
        copyPhase: "copied",
        copyStatus: "Command copied",
        copyStatusDetail: "Nothing ran here. Use it only in a terminal on the HostDeck laptop.",
        busy: false
      }));
    } catch {
      return publish(resumeView({
        ...current,
        copyEnabled: true,
        copyPhase: "failed",
        copyStatus: "Copy failed",
        copyStatusDetail: "The command remains selectable, or you can try copying it again.",
        busy: false
      }));
    }
  });
  const dismiss = vi.fn(() => publish(resumeView({
    actionEnabled: options.disabledReason === undefined,
    actionDisabledReason: options.disabledReason ?? null,
    statusDetail: options.disabledReason ?? null
  })));
  const controller: LaptopResumeControlController = Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateContext: () => current,
    open,
    refresh: async () => current,
    copy,
    dismiss,
    close: () => publish(resumeView({ visible: false, phase: "hidden" }))
  });
  return Object.freeze({
    controller,
    copy,
    dismiss,
    open,
    resolveRead: () => read.resolve(),
    writeClipboard
  });
}

function availableResumeView(): LaptopResumeControlView {
  return resumeView({
    sheetOpen: true,
    phase: "available",
    tone: "connected",
    status: "Exact laptop command ready",
    statusDetail: "Nothing has run from this phone.",
    refreshEnabled: true,
    available: true,
    command,
    commandFreshness: "current",
    copyEnabled: true
  });
}

function staticResumeController(view: LaptopResumeControlView): LaptopResumeControlController {
  return Object.freeze({
    snapshot: () => view,
    subscribe: () => () => undefined,
    updateContext: () => view,
    open: async () => view,
    refresh: async () => view,
    copy: async () => view,
    dismiss: () => view,
    close: () => view
  });
}

function resumeView(overrides: Partial<LaptopResumeControlView> = {}): LaptopResumeControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "focus",
    status: "Resume on laptop",
    statusDetail: null,
    sessionId: "sess_laptop_resume_ui_001" as LaptopResumeControlView["sessionId"],
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
    copyStatusDetail: null,
    ...overrides
  });
}

function staticArchiveController(): ArchiveControlController {
  const view = archiveView();
  return Object.freeze({
    snapshot: () => view,
    subscribe: () => () => undefined,
    updateContext: () => view,
    open: () => view,
    beginConfirmation: () => view,
    cancelConfirmation: () => view,
    confirm: async () => view,
    acknowledgeResult: () => view,
    dismiss: () => view,
    close: () => view
  });
}

function archiveView(): ArchiveControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "attention",
    title: "Archive session",
    status: "Archive unavailable",
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
    result: null
  });
}

function staticInterruptController(): InterruptControlController {
  const view = interruptView();
  return Object.freeze({
    snapshot: () => view,
    subscribe: () => () => undefined,
    updateContext: () => view,
    open: () => view,
    beginConfirmation: () => view,
    cancelConfirmation: () => view,
    confirm: async () => view,
    acknowledgeResult: () => view,
    dismiss: () => view,
    close: () => view
  });
}

function interruptView(): InterruptControlView {
  return Object.freeze({
    visible: true,
    sheetOpen: false,
    phase: "closed",
    tone: "attention",
    title: "Interrupt turn",
    status: "Interrupt unavailable",
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
    result: null
  });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
