import type { SessionId } from "@hostdeck/core";
import {
  AlertTriangle,
  CircleCheck,
  CircleDot,
  Clock3,
  Info,
  LoaderCircle,
  Minimize2,
  RefreshCw,
  ShieldAlert
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import {
  type CompactControlController,
  type CompactControlPhase,
  type CompactControlStartInput,
  type CompactControlTone,
  createCompactControlController,
  HostDeckCompactOutcomeUnknownError
} from "./compact-control-state.js";
import {
  type BrowserConnectionSnapshot,
  type BrowserConnectionStateCoordinator,
  HostDeckBrowserConnectionError
} from "./connection-state.js";

export interface UseCompactControlControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export interface CompactSheetBodyProps {
  readonly controller: CompactControlController;
  readonly view: ReturnType<CompactControlController["snapshot"]>;
  readonly statusId: string;
}

const terminalTurnStates = new Set(["idle", "completed", "interrupted", "failed"]);
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});
const createCompactOperationId = () => createSecureBrowserOperationId("compact");

export function useCompactControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  options: UseCompactControlControllerOptions = {}
): CompactControlController {
  const createOperationId = options.createOperationId ?? createCompactOperationId;
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createCompactControlController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "compact_read",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          },
          async start(input: CompactControlStartInput) {
            const requestEpoch = currentCompactWriteEpoch(
              coordinator.snapshot(),
              input.sessionId
            );
            const response = await coordinator.requestProtected(
              "compact_start",
              {
                params: { session_id: input.sessionId },
                body: input.request
              },
              { signal: input.signal }
            );
            if (
              currentCompactWriteEpoch(coordinator.snapshot(), input.sessionId) !==
              requestEpoch
            ) {
              throw new HostDeckCompactOutcomeUnknownError();
            }
            return response.data;
          }
        })
      }),
    [coordinator, createOperationId, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: CompactControlController;
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

export function CompactSheetBody({
  controller,
  view,
  statusId
}: CompactSheetBodyProps) {
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (view.confirmationOpen) confirmationHeadingRef.current?.focus();
  }, [view.confirmationOpen]);

  const showLoading = view.phase === "loading" && !view.hasCapture;
  const showUnavailable =
    !view.hasCapture &&
    (view.phase === "unsupported" || view.phase === "read_failure");
  return (
    <div className="hostdeck-compact-sheet__body">
      <div className="hostdeck-compact-sheet__scroller">
        {showLoading ? (
          <CompactLoading />
        ) : showUnavailable ? (
          <CompactUnavailable phase={view.phase} />
        ) : (
          <div className="hostdeck-compact-content">
            <CompactCurrentState view={view} />
            <CompactProofBoundary view={view} />
            {view.confirmationOpen ? (
              <CompactConfirmation
                controller={controller}
                headingId={`${statusId}-confirmation-title`}
                headingRef={confirmationHeadingRef}
                targetLabel={view.targetLabel}
              />
            ) : null}
          </div>
        )}
      </div>
      <CompactFooter controller={controller} view={view} statusId={statusId} />
    </div>
  );
}

function CompactCurrentState({
  view
}: Readonly<{ view: ReturnType<CompactControlController["snapshot"]> }>) {
  const progress = view.progress;
  const tone = progress?.tone ?? (view.captureFreshness === "stale" ? "attention" : "focus");
  const StateIcon = statusIcon(view.phase, tone);
  return (
    <section className={`hostdeck-compact-state hostdeck-tone--${tone}`}>
      <span className="hostdeck-compact-state__node" aria-hidden="true">
        <StateIcon size={19} strokeWidth={2} />
      </span>
      <span>
        <small>Current progress</small>
        <strong>{progress?.label ?? "No tracked compaction"}</strong>
        <span>
          {progress === null ? (
            view.captureFreshness === "stale" ? "Previous read is stale" : "Current laptop read"
          ) : (
            <>
              <CompactTime value={progress.updatedAt} />
              <span aria-hidden="true"> / </span>
              <span>{progress.freshness === "stale" ? "Stale" : "Current"}</span>
            </>
          )}
        </span>
      </span>
    </section>
  );
}

function CompactProofBoundary({
  view
}: Readonly<{ view: ReturnType<CompactControlController["snapshot"]> }>) {
  const progress = view.progress;
  const proof = progressProof(progress?.state ?? null);
  const ProofIcon = proof.tone === "danger"
    ? AlertTriangle
    : proof.tone === "connected"
      ? CircleCheck
      : proof.tone === "focus"
        ? Minimize2
        : Info;
  return (
    <section className={`hostdeck-compact-boundary hostdeck-tone--${proof.tone}`}>
      <div className="hostdeck-compact-boundary__heading">
        <ProofIcon size={19} strokeWidth={2} aria-hidden="true" />
        <span>
          <h2>{proof.label}</h2>
          <small>{proof.detail}</small>
        </span>
      </div>
      {progress === null ? null : (
        <p>{progress.detail}</p>
      )}
    </section>
  );
}

function CompactConfirmation({
  controller,
  headingId,
  headingRef,
  targetLabel
}: Readonly<{
  controller: CompactControlController;
  headingId: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  targetLabel: string | null;
}>) {
  return (
    <section className="hostdeck-compact-confirmation" aria-labelledby={headingId}>
      <div className="hostdeck-compact-confirmation__heading">
        <ShieldAlert size={20} strokeWidth={2} aria-hidden="true" />
        <span>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            Confirm context compaction
          </h2>
          <small>Target: {targetLabel}</small>
        </span>
      </div>
      <p>
        Codex may start one compaction operation for this session. Acceptance does not prove completion, and HostDeck will not resend an uncertain request.
      </p>
      <p>Compaction does not archive or delete this session.</p>
      <div className="hostdeck-compact-confirmation__actions">
        <button
          type="button"
          className="hostdeck-secondary-button"
          onClick={() => controller.cancelConfirmation()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="hostdeck-primary-button"
          onClick={() => void controller.confirm()}
        >
          Confirm compact
        </button>
      </div>
    </section>
  );
}

function CompactFooter({
  controller,
  view,
  statusId
}: Readonly<{
  controller: CompactControlController;
  view: ReturnType<CompactControlController["snapshot"]>;
  statusId: string;
}>) {
  const StatusIcon = statusIcon(view.phase, view.tone);
  const showStartDisabledReason =
    view.startDisabledReason !== null &&
    view.startDisabledReason !== view.statusDetail;
  return (
    <footer className="hostdeck-compact-footer">
      <div
        id={statusId}
        className={`hostdeck-compact-status hostdeck-tone--${view.tone}`}
        role="status"
        aria-live="polite"
        aria-busy={view.busy}
      >
        <StatusIcon
          className={view.busy ? "hostdeck-spin" : undefined}
          size={19}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span>
          <strong>{view.status}</strong>
          {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
        </span>
        <button
          type="button"
          className="hostdeck-icon-button hostdeck-compact-status__check"
          aria-label="Check Compact progress"
          title="Check Compact progress"
          disabled={!view.checkEnabled}
          onClick={() => void controller.check()}
        >
          <RefreshCw size={19} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {view.confirmationOpen || !view.startActionVisible ? null : (
        <button
          type="button"
          className="hostdeck-primary-button hostdeck-compact-footer__start"
          disabled={!view.startEnabled}
          aria-describedby={showStartDisabledReason ? `${statusId}-start-reason` : undefined}
          onClick={() => controller.beginConfirmation()}
        >
          <Minimize2 size={18} strokeWidth={2} aria-hidden="true" />
          {view.startLabel}
        </button>
      )}
      {!showStartDisabledReason ? null : (
        <p id={`${statusId}-start-reason`} className="hostdeck-compact-footer__reason">
          {view.startDisabledReason}
        </p>
      )}
    </footer>
  );
}

function CompactLoading() {
  return (
    <div className="hostdeck-compact-loading">
      <span />
      <span />
    </div>
  );
}

function CompactUnavailable({ phase }: Readonly<{ phase: CompactControlPhase }>) {
  return (
    <div className="hostdeck-compact-unavailable">
      {phase === "unsupported" ? (
        <Info size={26} strokeWidth={2} aria-hidden="true" />
      ) : (
        <AlertTriangle size={26} strokeWidth={2} aria-hidden="true" />
      )}
    </div>
  );
}

function CompactTime({ value }: Readonly<{ value: string }>) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("HostDeck Compact time is invalid.");
  }
  return <time dateTime={value}>{timestampFormatter.format(date)}</time>;
}

function progressProof(
  state: ReturnType<CompactControlController["snapshot"]>["progress"] extends infer Progress
    ? Progress extends { readonly state: infer State }
      ? State | null
      : never
    : never
): Readonly<{ label: string; detail: string; tone: CompactControlTone }> {
  switch (state) {
    case null:
      return Object.freeze({
        label: "Confirmation required",
        detail: "No compaction starts until the exact target is confirmed.",
        tone: "muted"
      });
    case "accepted":
      return Object.freeze({
        label: "Acceptance only",
        detail: "No event-proven compaction item or completion yet.",
        tone: "attention"
      });
    case "running":
      return Object.freeze({
        label: "Compaction evidence active",
        detail: "Context compaction started; completion confirmation is pending.",
        tone: "focus"
      });
    case "completed":
      return Object.freeze({
        label: "Completion proven",
        detail: "The exact compaction item and its turn both completed.",
        tone: "connected"
      });
    case "interrupted":
      return Object.freeze({
        label: "Interrupted result",
        detail: "The compaction turn ended as interrupted, not completed.",
        tone: "attention"
      });
    case "failed":
      return Object.freeze({
        label: "Failed result",
        detail: "The compaction turn failed; no context-reduction claim is made.",
        tone: "danger"
      });
    case "incomplete":
      return Object.freeze({
        label: "Completion unproven",
        detail: "Another attempt remains blocked until current progress is checked.",
        tone: "danger"
      });
  }
}

function statusIcon(phase: CompactControlPhase, tone: CompactControlTone) {
  if (phase === "loading" || phase === "submitting") return LoaderCircle;
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return CircleCheck;
  if (tone === "focus") return Minimize2;
  if (tone === "attention") return Clock3;
  return CircleDot;
}

function currentCompactWriteEpoch(
  snapshot: BrowserConnectionSnapshot,
  sessionId: SessionId
): number {
  const targetData = snapshot.targetState.data;
  const session = targetData?.kind === "session_detail"
    ? targetData.response.session.session
    : null;
  if (
    snapshot.target?.kind !== "session_detail" ||
    snapshot.target.sessionId !== sessionId ||
    snapshot.access.state !== "current" ||
    snapshot.access.data?.can_read_sessions !== true ||
    snapshot.targetState.state !== "current" ||
    session?.id !== sessionId ||
    session.session_state !== "active" ||
    session.archived_at !== null ||
    session.freshness !== "current" ||
    !terminalTurnStates.has(session.turn_state) ||
    !snapshot.writeEligibility.eligible
  ) {
    throw new HostDeckBrowserConnectionError("not_ready");
  }
  return snapshot.epoch;
}
