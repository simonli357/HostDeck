import type { PlanMode } from "@hostdeck/contracts";
import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CircleCheck,
  CircleDot,
  Clock3,
  Gauge,
  Info,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  RefreshCw,
  Route,
  X
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import {
  type BrowserConnectionSnapshot,
  type BrowserConnectionStateCoordinator,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import {
  createPlanControlController,
  type PlanControlController,
  type PlanControlPhase,
  type PlanControlSelectInput,
  type PlanControlTone
} from "./plan-control-state.js";

export interface UsePlanControlControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export interface PlanControlProps {
  readonly controller: PlanControlController;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});
const createPlanOperationId = () => createSecureBrowserOperationId("plan");

export function usePlanControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  options: UsePlanControlControllerOptions = {}
): PlanControlController {
  const createOperationId = options.createOperationId ?? createPlanOperationId;
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createPlanControlController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "plan_read",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          },
          async select(input: PlanControlSelectInput) {
            const requestEpoch = currentPlanWriteEpoch(coordinator.snapshot(), input.sessionId);
            const response = await coordinator.requestProtected(
              "plan_select",
              {
                params: { session_id: input.sessionId },
                body: input.request
              },
              { signal: input.signal }
            );
            if (currentPlanWriteEpoch(coordinator.snapshot(), input.sessionId) !== requestEpoch) {
              throw new HostDeckBrowserConnectionError("not_ready");
            }
            return response.data;
          }
        })
      }),
    [coordinator, createOperationId, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: PlanControlController;
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

export function PlanControl({ controller }: PlanControlProps) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  if (!view.visible || view.targetLabel === null) return null;

  const statusId = `hostdeck-plan-status-${view.sessionId}`;
  const targetId = `hostdeck-plan-target-${view.sessionId}`;
  const stateId = `hostdeck-plan-state-${view.sessionId}`;
  const boundaryId = `hostdeck-plan-boundary-${view.sessionId}`;
  const selectionReasonId = `hostdeck-plan-selection-reason-${view.sessionId}`;
  const showSelectionReason =
    view.selectionDisabledReason !== null && view.selectionDisabledReason !== view.statusDetail;
  const StatusIcon = statusIcon(view.phase, view.tone);
  const setOpen = (open: boolean) => {
    if (open) void controller.open();
    else controller.dismiss();
  };

  return (
    <Dialog.Root open={view.sheetOpen} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="hostdeck-primary-action-dock__command"
          disabled={!view.actionEnabled}
          title={view.actionDisabledReason ?? "Change Plan mode for the next turn"}
          aria-label={`/plan for ${view.targetLabel}`}
        >
          <ListChecks size={18} strokeWidth={2} aria-hidden="true" />
          <span>/plan</span>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        <Dialog.Content
          className={`hostdeck-sheet hostdeck-plan-sheet hostdeck-plan-sheet--${view.tone}`}
          aria-describedby={`${targetId} ${statusId}`}
          onEscapeKeyDown={(event) => {
            if (view.closeDisabled) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (view.closeDisabled) event.preventDefault();
          }}
        >
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header hostdeck-plan-sheet__header">
            <span>
              <Dialog.Title className="hostdeck-sheet__title">/plan</Dialog.Title>
              <Dialog.Description className="hostdeck-plan-sheet__target" id={targetId}>
                Target: <strong>{view.targetLabel}</strong>
              </Dialog.Description>
            </span>
            <Dialog.Close asChild>
              <button
                type="button"
                className="hostdeck-icon-button"
                aria-label="Close Plan control"
                title="Close Plan control"
                disabled={view.closeDisabled}
              >
                <X size={22} strokeWidth={2} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <form
            className="hostdeck-plan-sheet__form"
            aria-label="Plan selection"
            onSubmit={(event) => {
              event.preventDefault();
              void controller.submit();
            }}
          >
          <section
            className="hostdeck-plan-sheet__body"
            aria-label="Plan settings"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The state-dependent overflow owner must always be keyboard-scrollable.
            tabIndex={0}
          >
            {view.current === null || view.execution === null ? (
              <PlanLoading phase={view.phase} />
            ) : (
              <section className="hostdeck-plan-state-rail" aria-labelledby={stateId}>
                <h2 id={stateId} className="hostdeck-visually-hidden">
                  Plan state
                </h2>
                <section className={`hostdeck-plan-state hostdeck-plan-state--${view.current.tone}`}>
                  <span className="hostdeck-plan-state__label">Current mode</span>
                  <div>
                    <Route size={20} strokeWidth={2} aria-hidden="true" />
                    <span>
                      <strong>{view.current.label}</strong>
                      {view.current.state === "unknown" ? (
                        <small>Not yet confirmed by this runtime process</small>
                      ) : (
                        <dl className="hostdeck-plan-facts">
                          <div>
                            <dt>Model</dt>
                            <dd title={view.current.runtimeModel ?? undefined}>{view.current.runtimeModel}</dd>
                          </div>
                          <div>
                            <dt>Effort</dt>
                            <dd>{view.current.effort ?? "Runtime default"}</dd>
                          </div>
                          <div>
                            <dt>Observed</dt>
                            <dd>
                              <PlanTime value={view.current.observedAt} />
                            </dd>
                          </div>
                        </dl>
                      )}
                    </span>
                  </div>
                </section>

                <section className={`hostdeck-plan-state hostdeck-plan-state--${view.pending?.tone ?? "muted"}`}>
                  <span className="hostdeck-plan-state__label">Next turn</span>
                  {view.pending === null ? (
                    <div>
                      <CircleDot size={20} strokeWidth={2} aria-hidden="true" />
                      <span>
                        <strong>No pending change</strong>
                        <small>Uses confirmed settings when known</small>
                      </span>
                    </div>
                  ) : (
                    <div>
                      <Gauge size={20} strokeWidth={2} aria-hidden="true" />
                      <span>
                        <strong>{view.pending.label}</strong>
                        <small className="hostdeck-plan-state__phase">
                          {view.pending.phaseLabel}: {view.pending.detail}
                        </small>
                        <dl className="hostdeck-plan-facts">
                          <div>
                            <dt>Selected</dt>
                            <dd><PlanTime value={view.pending.selectedAt} /></dd>
                          </div>
                          {view.pending.resolvedRuntimeModel === null ? null : (
                            <div>
                              <dt>Resolved model</dt>
                              <dd title={view.pending.resolvedRuntimeModel}>{view.pending.resolvedRuntimeModel}</dd>
                            </div>
                          )}
                          {view.pending.resolvedRuntimeModel === null ? null : (
                            <div>
                              <dt>Resolved effort</dt>
                              <dd>{view.pending.resolvedEffort ?? "Runtime default"}</dd>
                            </div>
                          )}
                        </dl>
                      </span>
                    </div>
                  )}
                </section>

                <section className={`hostdeck-plan-state hostdeck-plan-state--${view.execution.tone}`}>
                  <span className="hostdeck-plan-state__label">Current turn</span>
                  <div>
                    <Clock3 size={20} strokeWidth={2} aria-hidden="true" />
                    <span>
                      <strong>{view.execution.stateLabel}</strong>
                      <small>{view.execution.evidenceLabel}</small>
                      {view.execution.summary === null ? null : (
                        <p className="hostdeck-plan-state__summary">{view.execution.summary}</p>
                      )}
                      {view.execution.updatedAt === null ? null : (
                        <small>Observed <PlanTime value={view.execution.updatedAt} /></small>
                      )}
                    </span>
                  </div>
                </section>
              </section>
            )}

            {view.current === null ? null : (
              <p className="hostdeck-plan-sheet__boundary" id={boundaryId}>
                <Info size={17} strokeWidth={2} aria-hidden="true" />
                <span>Mode changes apply to the next turn. The current turn is unchanged.</span>
              </p>
            )}

            {view.current === null ? null : (
              <fieldset
                className="hostdeck-plan-options"
                disabled={!view.selectionEnabled}
                aria-describedby={`${boundaryId} ${statusId}${showSelectionReason ? ` ${selectionReasonId}` : ""}`}
              >
                <legend>Select next-turn mode</legend>
                <div className="hostdeck-plan-options__list">
                  {view.modes.map((mode) => (
                    <PlanModeOption
                      key={mode.mode}
                      mode={mode.mode}
                      name={mode.name}
                      description={mode.description}
                      current={mode.isCurrent}
                      pending={mode.isPending}
                      selected={view.selectedMode === mode.mode}
                      sessionId={view.sessionId}
                      onSelect={controller.selectMode}
                    />
                  ))}
                </div>
              </fieldset>
            )}

            {!showSelectionReason ? null : (
              <p id={selectionReasonId} className="hostdeck-plan-sheet__reason">
                {view.selectionDisabledReason}
              </p>
            )}

            <div
              className={`hostdeck-plan-sheet__status hostdeck-tone--${view.tone}`}
              id={statusId}
              role={view.tone === "danger" ? "alert" : "status"}
              aria-atomic="true"
            >
              <StatusIcon
                size={17}
                strokeWidth={2}
                className={view.phase === "loading" || view.phase === "submitting" ? "hostdeck-spin" : undefined}
                aria-hidden="true"
              />
              <span>
                <strong>{view.status}</strong>
                {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
              </span>
              <button
                type="button"
                className="hostdeck-icon-button hostdeck-plan-sheet__refresh"
                aria-label={view.phase === "outcome_unknown" ? "Check Plan state" : "Refresh Plan state"}
                title={view.phase === "outcome_unknown" ? "Check Plan state" : "Refresh Plan state"}
                disabled={!view.refreshEnabled}
                onClick={() => void controller.refresh()}
              >
                <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </section>

          <div className="hostdeck-plan-sheet__footer">
            <Dialog.Close asChild>
              <button
                type="button"
                className="hostdeck-secondary-button hostdeck-plan-sheet__cancel"
                disabled={view.closeDisabled}
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="submit"
              className="hostdeck-primary-button hostdeck-plan-sheet__submit"
              disabled={!view.submitEnabled}
              onClick={() => void controller.submit()}
            >
              {view.phase === "submitting" ? (
                <LoaderCircle className="hostdeck-spin" size={18} aria-hidden="true" />
              ) : null}
              {view.submitLabel}
            </button>
          </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PlanModeOption({
  mode,
  name,
  description,
  current,
  pending,
  selected,
  sessionId,
  onSelect
}: Readonly<{
  mode: PlanMode;
  name: string;
  description: string;
  current: boolean;
  pending: boolean;
  selected: boolean;
  sessionId: SessionId;
  onSelect: (mode: PlanMode) => unknown;
}>) {
  return (
    <label className="hostdeck-plan-option">
      <input
        type="radio"
        name={`hostdeck-plan-${sessionId}`}
        value={mode}
        aria-label={name}
        aria-describedby={`hostdeck-plan-option-${sessionId}-${mode}-description`}
        checked={selected}
        onChange={() => onSelect(mode)}
      />
      <span className="hostdeck-plan-option__indicator" aria-hidden="true" />
      <span className="hostdeck-plan-option__content">
        <strong>{name}</strong>
        <small id={`hostdeck-plan-option-${sessionId}-${mode}-description`}>
          {description}
        </small>
        <span className="hostdeck-plan-option__metadata">
          {current ? <span>Current</span> : null}
          {pending ? <span>Pending</span> : null}
        </span>
      </span>
    </label>
  );
}

function PlanTime({ value }: Readonly<{ value: string | null }>) {
  if (value === null) return <>Not observed</>;
  const date = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {Number.isNaN(date.valueOf()) ? "Unknown" : timestampFormatter.format(date)}
    </time>
  );
}

function PlanLoading({ phase }: Readonly<{ phase: PlanControlPhase }>) {
  if (phase !== "loading") return null;
  return (
    <div className="hostdeck-plan-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function statusIcon(phase: PlanControlPhase, tone: PlanControlTone): LucideIcon {
  if (phase === "loading" || phase === "submitting") return LoaderCircle;
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return CircleCheck;
  return CircleDot;
}

function currentPlanWriteEpoch(
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
    !snapshot.writeEligibility.eligible
  ) {
    throw new HostDeckBrowserConnectionError("not_ready");
  }
  return snapshot.epoch;
}
