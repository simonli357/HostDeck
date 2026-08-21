import type { SessionId } from "@hostdeck/core";
import {
  AlertTriangle,
  CircleCheck,
  CircleDot,
  LoaderCircle,
  type LucideIcon,
  RotateCcw,
  Send
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
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
  createPromptComposerController,
  type PromptComposerController,
  type PromptComposerDispatchInput,
  type PromptComposerPhase,
  type PromptComposerTone,
  promptComposerMaximumDraftLength
} from "./prompt-composer-state.js";
import type { SessionDetailFeedState } from "./session-detail-feed.js";

export interface UsePromptComposerControllerOptions {
  readonly createOperationId?: (() => string) | undefined;
}

export interface PromptComposerProps {
  readonly controller: PromptComposerController;
  readonly onReload?: (() => void) | undefined;
}

const createPromptOperationId = () => createSecureBrowserOperationId("prompt");
const characterCountThreshold = 18_000;

export function usePromptComposerController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot,
  feed: SessionDetailFeedState,
  options: UsePromptComposerControllerOptions = {}
): PromptComposerController {
  const createOperationId = options.createOperationId ?? createPromptOperationId;
  const contextRef = useRef(Object.freeze({ snapshot, feed }));
  contextRef.current = Object.freeze({ snapshot, feed });
  const owner = useMemo(
    () =>
      createPromptComposerController({
        sessionId,
        context: contextRef.current,
        createOperationId,
        dispatch: Object.freeze({
          async dispatch(input: PromptComposerDispatchInput) {
            const response = await coordinator.requestProtected(
              "prompt_dispatch",
              Object.freeze({
                params: Object.freeze({ session_id: input.sessionId }),
                body: input.request
              }),
              { signal: input.signal }
            );
            return response.data;
          }
        })
      }),
    [coordinator, createOperationId, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: PromptComposerController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({ snapshot, feed }));
  }, [feed, owner, snapshot]);

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

export function PromptComposer({ controller, onReload = reloadCurrentPage }: PromptComposerProps) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousPhase = useRef<PromptComposerPhase>(view.phase);
  const instanceId = useId();

  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = view.phase;
    if (
      previous === "submitting" &&
      view.phase !== "submitting" &&
      view.visible &&
      !view.inputDisabled &&
      !view.inputReadOnly
    ) {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [view.inputDisabled, view.inputReadOnly, view.phase, view.visible]);

  if (!view.visible || view.targetLabel === null) return null;

  const statusId = `${instanceId}-status`;
  const targetId = `${instanceId}-target`;
  const inputId = `${instanceId}-input`;
  const countId = `${instanceId}-count`;
  const showCount = view.characterCount >= characterCountThreshold;
  const StatusIcon = statusIcon(view.phase, view.tone);
  const submit = () => {
    if (!view.sendEnabled) return;
    void controller.submit();
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    submit();
  };
  const handleFormPointerDown = (event: PointerEvent<HTMLFormElement>) => {
    if (event.pointerType !== "touch") return;
    const textarea = textareaRef.current;
    if (
      textarea === null ||
      textarea.disabled ||
      textarea.readOnly ||
      document.activeElement === textarea
    ) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    textarea.focus({ preventScroll: true });
  };

  return (
    <footer
      className={`hostdeck-prompt-composer hostdeck-prompt-composer--${view.tone}`}
    >
      <div className="hostdeck-prompt-composer__target" id={targetId}>
        <span>Prompt target</span>
        <strong>{view.targetLabel}</strong>
      </div>

      <form
        className="hostdeck-prompt-composer__form"
        aria-label="Prompt composer"
        onSubmit={handleSubmit}
        onPointerDownCapture={handleFormPointerDown}
      >
        <label className="hostdeck-visually-hidden" htmlFor={inputId}>
          Prompt for {view.targetLabel}
        </label>
        <textarea
          ref={textareaRef}
          id={inputId}
          name="prompt"
          rows={2}
          maxLength={promptComposerMaximumDraftLength}
          value={view.draft}
          disabled={view.inputDisabled}
          readOnly={view.inputReadOnly}
          aria-describedby={`${targetId} ${statusId}${showCount ? ` ${countId}` : ""}`}
          aria-invalid={view.status === "Prompt is too long"}
          placeholder="Write a prompt for this session"
          autoCapitalize="sentences"
          autoComplete="off"
          spellCheck="true"
          onChange={(event) => controller.setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="hostdeck-icon-button hostdeck-prompt-composer__send"
          type="submit"
          disabled={!view.sendEnabled}
          title={view.sendLabel}
          aria-label={`${view.sendLabel} to ${view.targetLabel}`}
        >
          {view.phase === "submitting" ? (
            <LoaderCircle className="hostdeck-spin" size={22} aria-hidden="true" />
          ) : (
            <Send size={22} aria-hidden="true" />
          )}
        </button>
      </form>

      <div
        className="hostdeck-prompt-composer__status"
        id={statusId}
        aria-live="polite"
        aria-atomic="true"
      >
        <StatusIcon
          className={view.phase === "submitting" ? "hostdeck-spin" : undefined}
          size={16}
          aria-hidden="true"
        />
        <span>
          <strong>{view.status}</strong>
          {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
        </span>
        {showCount ? (
          <output id={countId} aria-label="Prompt character count">
            {view.characterCount.toLocaleString("en-US")} / 20,000
          </output>
        ) : null}
      </div>

      {view.reloadRequired ? (
        <button
          className="hostdeck-prompt-composer__reload"
          type="button"
          onClick={onReload}
        >
          <RotateCcw size={16} aria-hidden="true" />
          Reload to check
        </button>
      ) : null}
    </footer>
  );
}

function statusIcon(phase: PromptComposerPhase, tone: PromptComposerTone): LucideIcon {
  if (phase === "submitting") return LoaderCircle;
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return CircleCheck;
  return CircleDot;
}

function reloadCurrentPage(): void {
  const location = globalThis.location;
  if (location === undefined || typeof location.reload !== "function") {
    throw new TypeError("HostDeck browser reload is unavailable.");
  }
  Reflect.apply(location.reload, location, []);
}
