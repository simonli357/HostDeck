import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Eye,
  LoaderCircle,
  LockKeyhole,
  Radio,
  ShieldAlert,
  X
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import type { BrowserConnectionStateCoordinator } from "./connection-state.js";
import { HostDeckDialogContent } from "./dialog-content.js";
import {
  createHostLockController,
  type HostLockController,
  type HostLockControllerView,
  type HostLockProjection,
  hostLockPortFromCoordinator
} from "./host-lock-state.js";

export interface HostLockBinding {
  readonly controller: HostLockController;
  readonly view: HostLockControllerView;
  readonly begin: (origin: HTMLButtonElement) => void;
}

export interface ConnectedHostLockProps {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly createOperationId?: (() => string) | undefined;
  readonly children: (binding: HostLockBinding) => ReactNode;
}

function createHostLockOperationId(): string {
  return createSecureBrowserOperationId("host_lock");
}

export function ConnectedHostLock({
  coordinator,
  createOperationId = createHostLockOperationId,
  children
}: ConnectedHostLockProps) {
  const connection = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot
  );
  const controller = useMemo(
    () =>
      createHostLockController({
        port: hostLockPortFromCoordinator(coordinator),
        createOperationId
      }),
    [coordinator, createOperationId]
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const activeOwner = useRef<Readonly<{
    controller: HostLockController;
    token: object;
  }> | null>(null);
  const originRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    void connection;
    controller.synchronize();
  }, [connection, controller]);

  useEffect(() => {
    const token = Object.freeze({});
    activeOwner.current = Object.freeze({ controller, token });
    return () => {
      queueMicrotask(() => {
        const active = activeOwner.current;
        if (active?.controller === controller && active.token !== token) return;
        controller.close();
      });
    };
  }, [controller]);

  const begin = useCallback(
    (origin: HTMLButtonElement) => {
      originRef.current = origin;
      panelRef.current = origin.closest<HTMLElement>(".hostdeck-host-lock");
      try {
        controller.begin();
      } catch {
        controller.synchronize();
      }
    },
    [controller]
  );
  const binding = Object.freeze({ controller, view, begin });

  return (
    <>
      {children(binding)}
      <HostLockConfirmationDialog
        binding={binding}
        originRef={originRef}
        panelRef={panelRef}
      />
    </>
  );
}

export function HostLockPanel({ binding }: Readonly<{ binding: HostLockBinding }>) {
  const { view } = binding;
  const Icon = panelIcon(view.phase);
  return (
    <section
      className={`hostdeck-host-lock hostdeck-tone--${view.tone}`}
      aria-labelledby="hostdeck-host-lock-title"
      tabIndex={-1}
    >
      <div className="hostdeck-host-lock__header">
        <span className="hostdeck-host-lock__icon" aria-hidden="true">
          <Icon
            className={view.busy ? "hostdeck-spin" : undefined}
            size={22}
            strokeWidth={2}
          />
        </span>
        <span className="hostdeck-host-lock__copy">
          <h2 id="hostdeck-host-lock-title">{view.title}</h2>
          <p>{view.detail}</p>
          {view.source === null ? null : <small>{view.source}</small>}
        </span>
        {view.lockVisible ? (
          <button
            type="button"
            className="hostdeck-danger-button hostdeck-host-lock__action"
            disabled={!view.lockEnabled}
            aria-busy={view.busy || undefined}
            onClick={(event) => binding.begin(event.currentTarget)}
          >
            <LockKeyhole size={18} strokeWidth={2} aria-hidden="true" />
            <span>{view.lockLabel}</span>
          </button>
        ) : null}
      </div>
      {view.recoveryCommand === null ? null : (
        <div
          className="hostdeck-host-lock__recovery"
          role={view.urgent ? "alert" : "status"}
          aria-atomic="true"
        >
          <span>On the laptop</span>
          <code>{view.recoveryCommand}</code>
          <small>Then refresh HostDeck to read the current lock state.</small>
        </div>
      )}
    </section>
  );
}

export function HostLockRouteRail({
  projection
}: Readonly<{ projection: HostLockProjection }>) {
  if (!projection.visible || projection.title === null || projection.reason === null) {
    return null;
  }
  const Icon = projectionIcon(projection);
  return (
    <div
      className={`hostdeck-lock-rail hostdeck-lock-rail--${projection.tone}`}
      role={projection.phase === "unconfirmed" ? "alert" : "status"}
      aria-atomic="true"
      aria-busy={projection.phase === "pending" || undefined}
    >
      <Icon
        className={projection.phase === "pending" ? "hostdeck-spin" : undefined}
        size={19}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span>
        <strong>{projection.title}</strong>
        <span>{projection.reason}</span>
        {projection.source === null ? null : <small>{projection.source}</small>}
      </span>
    </div>
  );
}

function HostLockConfirmationDialog({
  binding,
  originRef,
  panelRef
}: Readonly<{
  binding: HostLockBinding;
  originRef: { current: HTMLButtonElement | null };
  panelRef: { current: HTMLElement | null };
}>) {
  const confirmation = binding.view.confirmation;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog.Root
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open && confirmation !== null && !confirmation.busy) {
          try {
            binding.controller.cancel();
          } catch {
            binding.controller.synchronize();
          }
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay hostdeck-lock-confirmation-overlay" />
        {confirmation === null ? null : (
          <HostDeckDialogContent
            className="hostdeck-sheet hostdeck-lock-confirmation"
            aria-describedby="hostdeck-lock-confirmation-description"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (confirmation.busy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (confirmation.busy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (confirmation.busy) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const origin = originRef.current;
              const panel = panelRef.current;
              originRef.current = null;
              panelRef.current = null;
              queueMicrotask(() => {
                if (origin?.isConnected === true && !origin.disabled) {
                  origin.focus();
                } else if (panel?.isConnected === true) {
                  panel.focus();
                }
              });
            }}
          >
            <span className="hostdeck-sheet__handle" aria-hidden="true" />
            <div className="hostdeck-sheet__header">
              <span>
                <Dialog.Title className="hostdeck-sheet__title">
                  {confirmation.title}
                </Dialog.Title>
                <span className="hostdeck-lock-confirmation__target">
                  {confirmation.target}
                </span>
              </span>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="hostdeck-icon-button"
                  aria-label="Close remote write lock confirmation"
                  title="Close remote write lock confirmation"
                  disabled={confirmation.busy}
                >
                  <X size={22} strokeWidth={2} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className="hostdeck-sheet__body hostdeck-lock-confirmation__body">
              <p
                id="hostdeck-lock-confirmation-description"
                className="hostdeck-lock-confirmation__consequence"
              >
                <ShieldAlert size={21} strokeWidth={2} aria-hidden="true" />
                <span>{confirmation.consequence}</span>
              </p>
              <ul className="hostdeck-lock-confirmation__facts">
                <li>
                  <Eye size={19} strokeWidth={2} aria-hidden="true" />
                  <span>{confirmation.continuity}</span>
                </li>
                <li>
                  <Radio size={19} strokeWidth={2} aria-hidden="true" />
                  <span>{confirmation.nonCancellation}</span>
                </li>
                <li>
                  <LockKeyhole size={19} strokeWidth={2} aria-hidden="true" />
                  <span>{confirmation.recovery}</span>
                </li>
              </ul>
              <div className="hostdeck-lock-confirmation__actions">
                <Dialog.Close asChild>
                  <button
                    ref={cancelRef}
                    type="button"
                    className="hostdeck-secondary-button"
                    disabled={!confirmation.cancelEnabled}
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  className="hostdeck-danger-button"
                  disabled={!confirmation.confirmEnabled}
                  aria-busy={confirmation.busy || undefined}
                  onClick={() => {
                    void binding.controller.confirm().catch(() => undefined);
                  }}
                >
                  {confirmation.busy ? (
                    <LoaderCircle
                      className="hostdeck-spin"
                      size={18}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  ) : (
                    <LockKeyhole size={18} strokeWidth={2} aria-hidden="true" />
                  )}
                  <span>{confirmation.busy ? "Locking" : confirmation.confirmLabel}</span>
                </button>
              </div>
            </div>
          </HostDeckDialogContent>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function panelIcon(phase: HostLockControllerView["phase"]) {
  switch (phase) {
    case "unlocked":
      return CheckCircle2;
    case "confirming":
    case "dispatching":
      return LoaderCircle;
    case "locked":
      return LockKeyhole;
    case "failure":
    case "unconfirmed":
      return AlertTriangle;
    case "unavailable":
    case "closed":
      return ShieldAlert;
  }
}

function projectionIcon(projection: HostLockProjection) {
  if (projection.phase === "pending") return LoaderCircle;
  if (projection.phase === "unconfirmed") return AlertTriangle;
  return projection.current ? LockKeyhole : Clock3;
}
