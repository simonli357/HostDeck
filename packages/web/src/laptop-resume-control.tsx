import type { SessionId } from "@hostdeck/core";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleX,
  Copy,
  Laptop,
  LoaderCircle,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createLaptopResumeControlController,
  type LaptopResumeClipboardInput,
  type LaptopResumeControlController,
  type LaptopResumeControlView
} from "./laptop-resume-control-state.js";

export interface UseLaptopResumeControlControllerOptions {
  readonly writeClipboard?: ((input: LaptopResumeClipboardInput) => Promise<void>) | undefined;
}

export function useLaptopResumeControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  options: UseLaptopResumeControlControllerOptions = {}
): LaptopResumeControlController {
  const writeClipboard = options.writeClipboard ?? writeBrowserClipboard;
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createLaptopResumeControlController({
        sessionId,
        context: contextRef.current,
        port: Object.freeze({
          async read(input: Readonly<{
            sessionId: SessionId;
            signal: AbortSignal;
          }>) {
            const response = await coordinator.requestSelectedSessionRead(
              "session_resume_metadata",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          },
          writeClipboard
        })
      }),
    [coordinator, sessionId, writeClipboard]
  );
  const activeOwner = useRef<Readonly<{
    controller: LaptopResumeControlController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({ snapshot }));
  }, [owner, snapshot]);

  useEffect(() => {
    const token = Object.freeze({});
    activeOwner.current = Object.freeze({ controller: owner, token });
    return () => {
      queueMicrotask(() => {
        const active = activeOwner.current;
        if (active?.controller === owner && active.token !== token) return;
        owner.close();
      });
    };
  }, [owner]);

  return owner;
}

export function useLaptopResumeControlView(
  controller: LaptopResumeControlController
): LaptopResumeControlView {
  return useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
}

export function LaptopResumeActionItem({
  itemRef,
  onResume,
  view
}: Readonly<{
  itemRef: RefObject<HTMLButtonElement | null>;
  onResume: () => void;
  view: LaptopResumeControlView;
}>) {
  const detail = view.actionEnabled
    ? "Copy exact local TUI command"
    : view.actionDisabledReason ?? "Session details are not available.";
  return (
    <button
      ref={itemRef}
      type="button"
      className="hostdeck-utility-menu__item hostdeck-session-actions__resume"
      disabled={!view.actionEnabled}
      onClick={onResume}
    >
      <Laptop size={22} strokeWidth={2} aria-hidden="true" />
      <span>
        <strong>Resume on laptop</strong>
        <small className={view.actionEnabled ? undefined : "hostdeck-utility-menu__reason"}>
          {detail}
        </small>
      </span>
      <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export function LaptopResumeSheetBody({
  copyButtonRef,
  controller,
  view
}: Readonly<{
  copyButtonRef: RefObject<HTMLButtonElement | null>;
  controller: LaptopResumeControlController;
  view: LaptopResumeControlView;
}>) {
  const commandLabelId = useId();
  return (
    <div className="hostdeck-session-actions__panel">
      <div className="hostdeck-session-actions__scroller">
        <div className="hostdeck-laptop-resume-boundary">
          <Laptop size={23} strokeWidth={2} aria-hidden="true" />
          <span>
            <strong>Laptop terminal only</strong>
            <small>This phone can copy the command. It cannot run or attach to the TUI.</small>
          </span>
        </div>
        <LaptopResumeStatus view={view} />
        {view.command === null ? null : (
          <section className="hostdeck-laptop-resume-command" aria-labelledby={commandLabelId}>
            <span id={commandLabelId}>Exact local command</span>
            <code>{view.command}</code>
            <small>
              Use only in a terminal on the HostDeck laptop. This command targets the selected
              managed session.
            </small>
          </section>
        )}
        <dl className="hostdeck-laptop-resume-facts">
          <div>
            <dt>Session</dt>
            <dd>{view.targetLabel ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Execution</dt>
            <dd>Not available from this phone</dd>
          </div>
          <div>
            <dt>Destination</dt>
            <dd>HostDeck laptop - local Codex TUI</dd>
          </div>
          {view.commandFreshness === null ? null : (
            <div>
              <dt>Command</dt>
              <dd>{view.commandFreshness === "current" ? "Current" : "Stale - check again"}</dd>
            </div>
          )}
        </dl>
        <LaptopResumeCopyStatus view={view} />
      </div>
      <div className="hostdeck-session-actions__footer hostdeck-session-actions__footer--single">
        <LaptopResumeFooterAction
          buttonRef={copyButtonRef}
          controller={controller}
          view={view}
        />
      </div>
    </div>
  );
}

function LaptopResumeFooterAction({
  buttonRef,
  controller,
  view
}: Readonly<{
  buttonRef: RefObject<HTMLButtonElement | null>;
  controller: LaptopResumeControlController;
  view: LaptopResumeControlView;
}>) {
  if (view.phase === "loading") {
    return (
      <button ref={buttonRef} type="button" className="hostdeck-primary-button" disabled>
        <LoaderCircle className="hostdeck-spin" size={19} strokeWidth={2} aria-hidden="true" />
        Reading laptop command
      </button>
    );
  }
  if (view.copyPhase === "copying") {
    return (
      <button ref={buttonRef} type="button" className="hostdeck-primary-button" disabled>
        <LoaderCircle className="hostdeck-spin" size={19} strokeWidth={2} aria-hidden="true" />
        Copying command
      </button>
    );
  }
  if (view.command !== null && view.commandFreshness === "current") {
    const label = view.copyPhase === "copied"
      ? "Copy again"
      : view.copyPhase === "failed"
        ? "Try copy again"
        : "Copy command";
    return (
      <button
        ref={buttonRef}
        type="button"
        className="hostdeck-primary-button"
        disabled={!view.copyEnabled}
        onClick={() => void controller.copy()}
      >
        {view.copyPhase === "copied" ? (
          <Check size={19} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Copy size={19} strokeWidth={2} aria-hidden="true" />
        )}
        {label}
      </button>
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className="hostdeck-secondary-button"
      disabled={!view.refreshEnabled}
      onClick={() => void controller.refresh()}
    >
      <RefreshCw size={19} strokeWidth={2} aria-hidden="true" />
      Check again
    </button>
  );
}

function LaptopResumeStatus({ view }: Readonly<{ view: LaptopResumeControlView }>) {
  const Icon = view.phase === "loading"
    ? LoaderCircle
    : view.tone === "connected"
      ? ShieldCheck
      : view.tone === "danger"
        ? AlertTriangle
        : Laptop;
  return (
    <div
      className={`hostdeck-laptop-resume-status hostdeck-laptop-resume-status--${view.tone}`}
      role={view.tone === "danger" ? "alert" : "status"}
      aria-live={view.phase === "loading" ? "polite" : undefined}
    >
      <Icon
        className={view.phase === "loading" ? "hostdeck-spin" : undefined}
        size={23}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span>
        <strong>{view.status}</strong>
        {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
      </span>
    </div>
  );
}

function LaptopResumeCopyStatus({ view }: Readonly<{ view: LaptopResumeControlView }>) {
  if (view.copyStatus === null) return null;
  const failed = view.copyPhase === "failed";
  const copied = view.copyPhase === "copied";
  const Icon = failed ? CircleX : copied ? Check : Copy;
  return (
    <div
      className={`hostdeck-laptop-resume-copy hostdeck-laptop-resume-copy--${view.copyPhase}`}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <Icon size={21} strokeWidth={2} aria-hidden="true" />
      <span>
        <strong>{view.copyStatus}</strong>
        {view.copyStatusDetail === null ? null : <small>{view.copyStatusDetail}</small>}
      </span>
    </div>
  );
}

async function writeBrowserClipboard(input: LaptopResumeClipboardInput): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  const writeText = clipboard?.writeText;
  if (typeof writeText !== "function") {
    throw new TypeError("HostDeck browser clipboard is unavailable.");
  }
  await Reflect.apply(writeText, clipboard, [input.text]);
}
