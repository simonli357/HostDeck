import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Box,
  CircleCheck,
  CircleDot,
  Gauge,
  Image,
  LoaderCircle,
  type LucideIcon,
  RefreshCw,
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
  createModelControlController,
  type ModelControlController,
  type ModelControlPhase,
  type ModelControlSelectInput,
  type ModelControlTone
} from "./model-control-state.js";
import { useMutationStatusReveal } from "./mutation-status-reveal.js";

export interface UseModelControlControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export interface ModelControlProps {
  readonly controller: ModelControlController;
}

const createModelOperationId = () => createSecureBrowserOperationId("model");

export function useModelControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  options: UseModelControlControllerOptions = {}
): ModelControlController {
  const createOperationId = options.createOperationId ?? createModelOperationId;
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createModelControlController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "model_read",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          },
          async select(input: ModelControlSelectInput) {
            const response = await coordinator.requestProtected(
              "model_select",
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
    controller: ModelControlController;
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

export function ModelControl({ controller }: ModelControlProps) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const statusRef = useMutationStatusReveal(view.phase);
  if (!view.visible || view.targetLabel === null) return null;

  const statusId = `hostdeck-model-status-${view.sessionId}`;
  const targetId = `hostdeck-model-target-${view.sessionId}`;
  const stateId = `hostdeck-model-state-${view.sessionId}`;
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
          title={view.actionDisabledReason ?? "Change model for the next turn"}
          aria-label={`/model for ${view.targetLabel}`}
        >
          <Box size={18} strokeWidth={2} aria-hidden="true" />
          <span>/model</span>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        <Dialog.Content
          className={`hostdeck-sheet hostdeck-model-sheet hostdeck-model-sheet--${view.tone}`}
          aria-describedby={statusId}
          onEscapeKeyDown={(event) => {
            if (view.closeDisabled) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (view.closeDisabled) event.preventDefault();
          }}
        >
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header hostdeck-model-sheet__header">
            <span>
              <Dialog.Title className="hostdeck-sheet__title">/model</Dialog.Title>
              <Dialog.Description className="hostdeck-model-sheet__target" id={targetId}>
                Target: <strong>{view.targetLabel}</strong>
              </Dialog.Description>
            </span>
            <Dialog.Close asChild>
              <button
                type="button"
                className="hostdeck-icon-button"
                aria-label="Close model control"
                disabled={view.closeDisabled}
              >
                <X size={22} strokeWidth={2} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <section
            className="hostdeck-model-sheet__body"
            aria-label="Model settings"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The state-dependent overflow owner must always be keyboard-scrollable.
            tabIndex={0}
          >
            {view.current === null ? (
              <ModelLoading phase={view.phase} />
            ) : (
              <section className="hostdeck-model-state-rail" aria-labelledby={stateId}>
                <h2 id={stateId} className="hostdeck-visually-hidden">
                  Model state
                </h2>
                <section className="hostdeck-model-state hostdeck-model-state--connected">
                  <span className="hostdeck-model-state__label">Current</span>
                  <div>
                    <Box size={20} strokeWidth={2} aria-hidden="true" />
                    <span>
                      <strong title={view.current.label}>{view.current.label}</strong>
                      <small>
                        Effort: {view.current.effort === null ? "Runtime default" : view.current.effort}
                      </small>
                      {view.current.catalogKnown ? null : (
                        <small className="hostdeck-model-state__warning">
                          Not present in the current catalog
                        </small>
                      )}
                    </span>
                  </div>
                </section>

                <section
                  className={`hostdeck-model-state hostdeck-model-state--${view.pending?.tone ?? "muted"}`}
                >
                  <span className="hostdeck-model-state__label">Next turn</span>
                  {view.pending === null ? (
                    <div>
                      <CircleDot size={20} strokeWidth={2} aria-hidden="true" />
                      <span>
                        <strong>No pending change</strong>
                        <small>Uses the confirmed current model</small>
                      </span>
                    </div>
                  ) : (
                    <div>
                      <Gauge size={20} strokeWidth={2} aria-hidden="true" />
                      <span>
                        <strong title={view.pending.label}>{view.pending.label}</strong>
                        <small>Effort: {view.pending.effort}</small>
                        <small className="hostdeck-model-state__phase">
                          {view.pending.phaseLabel}: {view.pending.detail}
                        </small>
                      </span>
                    </div>
                  )}
                </section>
              </section>
            )}

            {view.current === null ? null : (
              <fieldset
                className="hostdeck-model-options"
                disabled={!view.selectionEnabled}
                aria-describedby={`${statusId}${showSelectionReason ? " hostdeck-model-selection-reason" : ""}`}
              >
                <legend>Select model</legend>
                <div className="hostdeck-model-options__list">
                  {view.models.map((model, index) => (
                    <label key={model.id} className="hostdeck-model-option">
                      <input
                        type="radio"
                        name={`hostdeck-model-${view.sessionId}`}
                        value={model.id}
                        aria-label={`${model.label}${view.selectedModelId === model.id ? ", selected" : ""}`}
                        aria-describedby={
                          model.description === null
                            ? undefined
                            : `hostdeck-model-option-${view.sessionId}-${index}-description`
                        }
                        checked={view.selectedModelId === model.id}
                        onChange={() => controller.selectModel(model.id)}
                      />
                      <span className="hostdeck-model-option__indicator" aria-hidden="true" />
                      <span className="hostdeck-model-option__content">
                        <strong title={model.label}>{model.label}</strong>
                        {model.description === null ? null : (
                          <small
                            id={`hostdeck-model-option-${view.sessionId}-${index}-description`}
                          >
                            {model.description}
                          </small>
                        )}
                        <span className="hostdeck-model-option__metadata">
                          {model.isCurrent ? <span>Current</span> : null}
                          {model.isPending ? <span>Pending</span> : null}
                          {model.isDefault ? <span>Default</span> : null}
                          {model.supportsImages ? (
                            <span>
                              <Image size={12} strokeWidth={2} aria-hidden="true" /> Images
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                {view.efforts.length === 0 ? null : (
                  <div className="hostdeck-model-effort">
                    <span id={`hostdeck-model-effort-label-${view.sessionId}`}>Effort level</span>
                    <div
                      className="hostdeck-model-effort__choices"
                      role="radiogroup"
                      aria-labelledby={`hostdeck-model-effort-label-${view.sessionId}`}
                    >
                      {view.efforts.map((effort) => (
                        <label key={effort.id} title={effort.description ?? undefined}>
                          <input
                            type="radio"
                            name={`hostdeck-model-effort-${view.sessionId}`}
                            value={effort.id}
                            checked={view.selectedEffort === effort.id}
                            onChange={() => controller.selectEffort(effort.id)}
                          />
                          <span>{effort.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </fieldset>
            )}

            {!showSelectionReason ? null : (
              <p id="hostdeck-model-selection-reason" className="hostdeck-model-sheet__reason">
                {view.selectionDisabledReason}
              </p>
            )}

            <div
              ref={statusRef}
              className={`hostdeck-model-sheet__status hostdeck-tone--${view.tone}`}
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
                className="hostdeck-icon-button hostdeck-model-sheet__refresh"
                aria-label={view.phase === "outcome_unknown" ? "Check model state" : "Refresh model state"}
                title={view.phase === "outcome_unknown" ? "Check model state" : "Refresh model state"}
                disabled={!view.refreshEnabled}
                onClick={() => void controller.refresh()}
              >
                <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </section>

          <div className="hostdeck-model-sheet__footer">
            <Dialog.Close asChild>
              <button
                type="button"
                className="hostdeck-secondary-button hostdeck-model-sheet__cancel"
                disabled={view.closeDisabled}
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="hostdeck-primary-button hostdeck-model-sheet__submit"
              disabled={!view.submitEnabled}
              onClick={() => void controller.submit()}
            >
              {view.phase === "submitting" ? (
                <LoaderCircle className="hostdeck-spin" size={18} aria-hidden="true" />
              ) : null}
              {view.submitLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModelLoading({ phase }: Readonly<{ phase: ModelControlPhase }>) {
  if (phase !== "loading") return null;
  return (
    <div className="hostdeck-model-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function statusIcon(phase: ModelControlPhase, tone: ModelControlTone): LucideIcon {
  if (phase === "loading" || phase === "submitting") return LoaderCircle;
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return CircleCheck;
  return CircleDot;
}
