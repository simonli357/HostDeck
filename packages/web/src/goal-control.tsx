import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CircleCheck,
  CircleDot,
  Flag,
  Gauge,
  LoaderCircle,
  type LucideIcon,
  Pause,
  Play,
  RefreshCw,
  Target,
  Trash2,
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
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createGoalControlController,
  type GoalControlActionView,
  type GoalControlController,
  type GoalControlMutateInput,
  type GoalControlPhase,
  type GoalControlTone
} from "./goal-control-state.js";

export interface UseGoalControlControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export interface GoalControlProps {
  readonly controller: GoalControlController;
}

const countFormatter = new Intl.NumberFormat("en-US");
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});
const createGoalOperationId = () => createSecureBrowserOperationId("goal");

export function useGoalControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  options: UseGoalControlControllerOptions = {}
): GoalControlController {
  const createOperationId = options.createOperationId ?? createGoalOperationId;
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createGoalControlController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "goal_read",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          },
          async mutate(input: GoalControlMutateInput) {
            const response = await coordinator.requestProtected(
              "goal_mutate",
              {
                params: { session_id: input.sessionId },
                body: input.request
              },
              { signal: input.signal }
            );
            return response.data;
          }
        })
      }),
    [coordinator, createOperationId, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: GoalControlController;
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

export function GoalControl({ controller }: GoalControlProps) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const confirmationAction = view.confirmation?.action ?? null;

  useLayoutEffect(() => {
    if (confirmationAction !== null) confirmationCancelRef.current?.focus();
  }, [confirmationAction]);

  if (!view.visible || view.targetLabel === null) return null;

  const statusId = `hostdeck-goal-status-${view.sessionId}`;
  const targetId = `hostdeck-goal-target-${view.sessionId}`;
  const objectiveHintId = `hostdeck-goal-objective-hint-${view.sessionId}`;
  const actionsId = `hostdeck-goal-actions-${view.sessionId}`;
  const confirmationId = `hostdeck-goal-confirmation-${view.sessionId}`;
  const StatusIcon = statusIcon(view.phase, view.tone);
  const showActionGuidance =
    view.actionGuidance !== view.draftDisabledReason &&
    view.actionGuidance !== view.statusDetail;
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
          title={view.actionDisabledReason ?? "Manage the selected session goal"}
          aria-label={`/goal for ${view.targetLabel}`}
        >
          <Flag size={18} strokeWidth={2} aria-hidden="true" />
          <span>/goal</span>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        <Dialog.Content
          className={`hostdeck-sheet hostdeck-goal-sheet hostdeck-goal-sheet--${view.tone}`}
          aria-describedby={`${targetId} ${statusId}`}
          onEscapeKeyDown={(event) => {
            if (view.closeDisabled) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (view.closeDisabled) event.preventDefault();
          }}
        >
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header hostdeck-goal-sheet__header">
            <span>
              <Dialog.Title className="hostdeck-sheet__title">/goal</Dialog.Title>
              <Dialog.Description className="hostdeck-goal-sheet__target" id={targetId}>
                Target: <strong>{view.targetLabel}</strong>
              </Dialog.Description>
            </span>
            <Dialog.Close asChild>
              <button
                type="button"
                className="hostdeck-icon-button"
                aria-label="Close goal control"
                disabled={view.closeDisabled}
              >
                <X size={22} strokeWidth={2} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="hostdeck-goal-sheet__body">
            {view.phase === "loading" ? (
              <GoalLoading />
            ) : (
              <section className="hostdeck-goal-state-rail" aria-label="Current goal state">
                <section className={`hostdeck-goal-state hostdeck-goal-state--${view.goal?.tone ?? "muted"}`}>
                  <span className="hostdeck-goal-state__label">Objective</span>
                  <div>
                    <Target size={20} strokeWidth={2} aria-hidden="true" />
                    <span>
                      {view.goal === null ? (
                        <>
                          <strong>No goal set</strong>
                          <small>Create a paused goal without starting a turn.</small>
                        </>
                      ) : (
                        <strong className="hostdeck-goal-state__objective">{view.goal.objective}</strong>
                      )}
                    </span>
                  </div>
                </section>

                <section className={`hostdeck-goal-state hostdeck-goal-state--${view.goal?.tone ?? "muted"}`}>
                  <span className="hostdeck-goal-state__label">State</span>
                  <div>
                    <Flag size={20} strokeWidth={2} aria-hidden="true" />
                    <span>
                      <strong>{view.goal?.statusLabel ?? "Not set"}</strong>
                      {view.goal === null ? null : (
                        <dl className="hostdeck-goal-facts">
                          <div>
                            <dt>Tokens</dt>
                            <dd>{countFormatter.format(view.goal.tokensUsed)}</dd>
                          </div>
                          <div>
                            <dt>Budget</dt>
                            <dd>
                              {view.goal.tokenBudget === null
                                ? "Not set"
                                : countFormatter.format(view.goal.tokenBudget)}
                            </dd>
                          </div>
                          <div>
                            <dt>Time</dt>
                            <dd>{formatSeconds(view.goal.timeUsedSeconds)}</dd>
                          </div>
                          <div>
                            <dt>Created</dt>
                            <dd>
                              <time dateTime={view.goal.createdAt} title={view.goal.createdAt}>
                                {formatTimestamp(view.goal.createdAt)}
                              </time>
                            </dd>
                          </div>
                          <div>
                            <dt>Updated</dt>
                            <dd>
                              <time dateTime={view.goal.updatedAt} title={view.goal.updatedAt}>
                                {formatTimestamp(view.goal.updatedAt)}
                              </time>
                            </dd>
                          </div>
                        </dl>
                      )}
                    </span>
                  </div>
                </section>
              </section>
            )}

            {view.uncertainty === null ? null : (
              <section
                className={`hostdeck-goal-uncertainty hostdeck-tone--${view.uncertainty.tone}`}
                aria-label="Uncertain goal action"
              >
                <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" />
                <span>
                  <strong>{view.uncertainty.phaseLabel}: {view.uncertainty.actionLabel}</strong>
                  <small>{view.uncertainty.detail}</small>
                  {view.uncertainty.requestedObjective === null ? null : (
                    <small className="hostdeck-goal-uncertainty__objective">
                      Attempted objective: {view.uncertainty.requestedObjective}
                    </small>
                  )}
                </span>
              </section>
            )}

            {view.phase === "loading" ? null : (
              <fieldset className="hostdeck-goal-objective" disabled={!view.draftEnabled}>
                <legend>Goal objective</legend>
                <textarea
                  aria-label="Goal objective"
                  value={view.draft}
                  maxLength={view.draftLimit}
                  rows={3}
                  aria-describedby={objectiveHintId}
                  onChange={(event) => controller.setDraft(event.currentTarget.value)}
                />
                <span className="hostdeck-goal-objective__meta" id={objectiveHintId}>
                  <small>
                    {view.observedObjectiveExceedsEditLimit
                      ? "The observed objective exceeds the phone edit limit. Enter a shorter replacement; it was not truncated."
                      : view.draftDisabledReason ?? "Saved goals remain paused until confirmed resume."}
                  </small>
                  <small>{view.draftLength}/{view.draftLimit}</small>
                </span>
              </fieldset>
            )}

            {view.phase === "loading" ? null : (
              <section className="hostdeck-goal-actions" aria-labelledby={actionsId}>
                <h2 id={actionsId}>Execution</h2>
                <div className="hostdeck-goal-actions__grid">
                  <GoalActionButton
                    label="Pause"
                    icon={Pause}
                    state={view.pause}
                    onClick={() => void controller.pause()}
                  />
                  <GoalActionButton
                    label="Resume"
                    icon={Play}
                    state={view.resume}
                    onClick={() => controller.beginConfirmation("resume")}
                  />
                  <GoalActionButton
                    label="Complete"
                    icon={CircleCheck}
                    state={view.complete}
                    onClick={() => controller.beginConfirmation("complete")}
                  />
                </div>
                <button
                  type="button"
                  className="hostdeck-goal-actions__clear"
                  disabled={!view.clear.enabled}
                  title={view.clear.disabledReason ?? "Clear this goal"}
                  onClick={() => controller.beginConfirmation("clear")}
                >
                  <Trash2 size={17} strokeWidth={2} aria-hidden="true" />
                  Clear goal
                </button>
                {showActionGuidance ? <p>{view.actionGuidance}</p> : null}
              </section>
            )}

            {view.confirmation === null ? null : (
              <section
                className={`hostdeck-goal-confirmation hostdeck-tone--${view.confirmation.tone}`}
                aria-labelledby={confirmationId}
                role="alert"
              >
                <AlertTriangle size={19} strokeWidth={2} aria-hidden="true" />
                <span>
                  <h2 id={confirmationId}>{view.confirmation.title}</h2>
                  <p>{view.confirmation.detail}</p>
                  {view.confirmation.disabledReason === null ? null : (
                    <small>{view.confirmation.disabledReason}</small>
                  )}
                </span>
                <div>
                  <button
                    ref={confirmationCancelRef}
                    type="button"
                    className="hostdeck-secondary-button"
                    onClick={() => controller.cancelConfirmation()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={view.confirmation.action === "clear"
                      ? "hostdeck-danger-button"
                      : "hostdeck-primary-button"}
                    disabled={!view.confirmation.confirmEnabled}
                    onClick={() => void controller.confirmAction()}
                  >
                    {view.confirmation.confirmLabel}
                  </button>
                </div>
              </section>
            )}

          </div>

          <div
            className={`hostdeck-goal-sheet__status hostdeck-tone--${view.tone}`}
            id={statusId}
            role={view.tone === "danger" ? "alert" : "status"}
            aria-live="polite"
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
              className="hostdeck-icon-button hostdeck-goal-sheet__refresh"
              aria-label={isCheckPhase(view.phase) ? "Check goal state" : "Refresh goal state"}
              title={isCheckPhase(view.phase) ? "Check goal state" : "Refresh goal state"}
              disabled={!view.refreshEnabled}
              onClick={() => void controller.refresh()}
            >
              <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          <div className="hostdeck-goal-sheet__footer">
            <button
              type="button"
              className="hostdeck-primary-button hostdeck-goal-sheet__save"
              disabled={!view.saveEnabled}
              title={view.saveDisabledReason ?? view.saveLabel}
              onClick={() => void controller.save()}
            >
              {view.submittingAction === "set" ? (
                <LoaderCircle className="hostdeck-spin" size={18} aria-hidden="true" />
              ) : null}
              {view.saveLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GoalActionButton({
  label,
  icon: Icon,
  state,
  onClick
}: Readonly<{
  label: string;
  icon: LucideIcon;
  state: GoalControlActionView;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      disabled={!state.enabled}
      title={state.disabledReason ?? label}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );
}

function GoalLoading() {
  return (
    <div className="hostdeck-goal-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function statusIcon(phase: GoalControlPhase, tone: GoalControlTone): LucideIcon {
  if (phase === "loading" || phase === "submitting") return LoaderCircle;
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return CircleCheck;
  if (tone === "attention") return Gauge;
  return CircleDot;
}

function isCheckPhase(phase: GoalControlPhase): boolean {
  return phase === "outcome_unknown" || phase === "uncertain_unknown" || phase === "uncertain_conflict";
}

function formatSeconds(value: number): string {
  return `${value.toString()} sec`;
}

function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}
