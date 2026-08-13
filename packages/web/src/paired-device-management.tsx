import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createPairedDeviceManagementController,
  HostDeckPairedDeviceManagementError,
  type PairedDeviceManagementController,
  type PairedDeviceManagementResultView,
  type PairedDeviceManagementRowView,
  type PairedDeviceManagementView,
  type PairedDeviceStatus,
  pairedDeviceManagementPortFromCoordinator
} from "./paired-device-management-state.js";

export interface ConnectedPairedDeviceManagementProps {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly connectionSnapshot: BrowserConnectionSnapshot;
  readonly createOperationId?: (() => string) | undefined;
}

const createDeviceRevokeOperationId = () =>
  createSecureBrowserOperationId("device_revoke");

export function ConnectedPairedDeviceManagement({
  coordinator,
  connectionSnapshot,
  createOperationId = createDeviceRevokeOperationId
}: ConnectedPairedDeviceManagementProps) {
  const controller = usePairedDeviceManagementController(
    coordinator,
    connectionSnapshot,
    createOperationId
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  return <PairedDeviceManagementPanel controller={controller} view={view} />;
}

export function usePairedDeviceManagementController(
  coordinator: BrowserConnectionStateCoordinator,
  connectionSnapshot: BrowserConnectionSnapshot,
  createOperationId: () => string = createDeviceRevokeOperationId,
  load: boolean = true
): PairedDeviceManagementController {
  const owner = useMemo(
    () =>
      createPairedDeviceManagementController({
        port: pairedDeviceManagementPortFromCoordinator(coordinator),
        createOperationId
      }),
    [coordinator, createOperationId]
  );
  const activeOwner = useRef<Readonly<{
    controller: PairedDeviceManagementController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    void connectionSnapshot;
    owner.synchronize();
    if (load) runDeviceAction(owner, owner.ensureLoaded());
  }, [connectionSnapshot, load, owner]);

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

export function PairedDeviceManagementPanel({
  controller,
  view
}: Readonly<{
  controller: PairedDeviceManagementController;
  view: PairedDeviceManagementView;
}>) {
  const revokeOrigin = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmation = view.confirmation;
  const confirmationRowKey = confirmation?.rowKey ?? null;

  useLayoutEffect(() => {
    if (confirmationRowKey !== null) cancelRef.current?.focus();
  }, [confirmationRowKey]);

  useEffect(() => () => {
    const pending = controller.snapshot().confirmation;
    if (pending !== null && !pending.busy) controller.cancelRevoke();
  }, [controller]);

  return (
    <section
      ref={panelRef}
      className="hostdeck-devices"
      aria-labelledby="hostdeck-devices-title"
      aria-busy={view.busy || undefined}
      tabIndex={-1}
    >
      <div className="hostdeck-devices__header">
        <span className={`hostdeck-devices__icon hostdeck-tone--${view.tone}`} aria-hidden="true">
          <Smartphone size={21} strokeWidth={2} />
        </span>
        <span className="hostdeck-devices__heading">
          <h2 id="hostdeck-devices-title">{view.title}</h2>
          <p role="status" aria-live="polite" aria-atomic="true">
            {view.detail}
          </p>
        </span>
        {view.refreshVisible ? (
          <button
            type="button"
            className="hostdeck-icon-button hostdeck-devices__refresh"
            aria-label={view.refreshLabel}
            title={view.refreshLabel}
            disabled={!view.refreshEnabled}
            onClick={() => runDeviceAction(controller, controller.refresh())}
          >
            <RefreshCw
              className={view.busy ? "hostdeck-spin" : undefined}
              size={19}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>

      {view.result === null ? null : <DeviceResult view={view.result} />}

      {view.rows.length === 0 ? (
        view.phase === "loading" ? (
          <div className="hostdeck-devices__empty" aria-hidden="true">
            <LoaderCircle className="hostdeck-spin" size={22} strokeWidth={2} />
            <span>Checking devices</span>
          </div>
        ) : null
      ) : (
        <ul className="hostdeck-device-list" aria-label="Paired devices">
          {view.rows.map((row) => (
            <DeviceRow
              key={row.key}
              row={row}
              onRevoke={(button) => {
                revokeOrigin.current = button;
                controller.beginRevoke(row.key);
              }}
            />
          ))}
        </ul>
      )}

      {view.rows.some(
        (row) => row.revokeDisabledReason === "Secure this page before revoking a device."
      ) ? (
        <p className="hostdeck-devices__notice">
          <ShieldAlert size={18} strokeWidth={2} aria-hidden="true" />
          <span>Secure this page before revoking a device.</span>
        </p>
      ) : null}

      {view.startOverVisible || view.hasNextPage ? (
        <nav className="hostdeck-device-pages" aria-label="Device pages">
          {view.startOverVisible ? (
            <button
              type="button"
              className="hostdeck-secondary-button hostdeck-device-pages__start"
              disabled={!view.startOverEnabled}
              onClick={() => runDeviceAction(controller, controller.startOver())}
            >
              <RotateCcw size={18} strokeWidth={2} aria-hidden="true" />
              <span>Start over</span>
            </button>
          ) : (
            <span className="hostdeck-device-pages__start" aria-hidden="true" />
          )}
          <span className="hostdeck-device-pages__current" aria-current="page">
            Page {view.pageOrdinal}
          </span>
          {view.hasNextPage ? (
            <button
              type="button"
              className="hostdeck-secondary-button hostdeck-device-pages__next"
              disabled={!view.nextEnabled}
              onClick={() => runDeviceAction(controller, controller.nextPage())}
            >
              <span>Next</span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : (
            <span className="hostdeck-device-pages__next" aria-hidden="true" />
          )}
        </nav>
      ) : null}

      <Dialog.Root
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && confirmation !== null && !confirmation.busy) {
            controller.cancelRevoke();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="hostdeck-sheet-overlay hostdeck-device-confirmation-overlay" />
          {confirmation === null ? null : (
            <Dialog.Content
              className="hostdeck-sheet hostdeck-device-confirmation"
              aria-describedby="hostdeck-device-confirmation-detail"
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
                const origin = revokeOrigin.current;
                revokeOrigin.current = null;
                queueMicrotask(() => {
                  if (origin?.isConnected === true && !origin.disabled) {
                    origin.focus();
                    return;
                  }
                  const row = origin?.closest<HTMLElement>(".hostdeck-device-row");
                  if (row?.isConnected === true) row.focus();
                  else focusSafeDevicePanelTarget(panelRef.current);
                });
              }}
            >
              <span className="hostdeck-sheet__handle" aria-hidden="true" />
              <div className="hostdeck-sheet__header">
                <span>
                  <Dialog.Title className="hostdeck-sheet__title">
                    {confirmation.title}
                  </Dialog.Title>
                  <span className="hostdeck-device-confirmation__target">
                    {confirmation.targetLabel}
                  </span>
                </span>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="hostdeck-icon-button"
                    aria-label="Close device revocation"
                    title="Close device revocation"
                    disabled={confirmation.busy}
                  >
                    <X size={22} strokeWidth={2} aria-hidden="true" />
                  </button>
                </Dialog.Close>
              </div>
              <div className="hostdeck-sheet__body hostdeck-device-confirmation__body">
                <div className="hostdeck-device-confirmation__risk hostdeck-tone--danger">
                  <Trash2 size={21} strokeWidth={2} aria-hidden="true" />
                  <p id="hostdeck-device-confirmation-detail">{confirmation.detail}</p>
                </div>
                {confirmation.warning === null ? null : (
                  <div className="hostdeck-device-confirmation__warning" role="alert">
                    <AlertTriangle size={20} strokeWidth={2} aria-hidden="true" />
                    <p>{confirmation.warning}</p>
                  </div>
                )}
                <div className="hostdeck-device-confirmation__actions">
                  <Dialog.Close asChild>
                    <button
                      ref={cancelRef}
                      type="button"
                      className="hostdeck-secondary-button"
                      disabled={confirmation.busy}
                    >
                      Cancel
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    className="hostdeck-danger-button"
                    disabled={!confirmation.confirmEnabled}
                    aria-busy={confirmation.busy || undefined}
                    onClick={() => runDeviceAction(controller, controller.confirmRevoke())}
                  >
                    {confirmation.busy ? (
                      <LoaderCircle
                        className="hostdeck-spin"
                        size={18}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    ) : (
                      <Trash2 size={18} strokeWidth={2} aria-hidden="true" />
                    )}
                    <span>{confirmation.busy ? "Revoking" : confirmation.confirmLabel}</span>
                  </button>
                </div>
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function DeviceRow({
  row,
  onRevoke
}: Readonly<{
  row: PairedDeviceManagementRowView;
  onRevoke: (button: HTMLButtonElement) => void;
}>) {
  const StatusIcon = deviceStatusIcon(row.status);
  const reasonId = `hostdeck-${row.key}-revoke-reason`;
  return (
    <li className={`hostdeck-device-row hostdeck-device-row--${row.status}`} tabIndex={-1}>
      <div className="hostdeck-device-row__identity">
        <span className="hostdeck-device-row__device" aria-hidden="true">
          <Smartphone size={20} strokeWidth={2} />
        </span>
        <span>
          <strong>{row.label}</strong>
          <small>
            {row.cue}{row.current ? " · This phone" : ""}
          </small>
        </span>
      </div>
      <dl className="hostdeck-device-row__facts">
        <div>
          <dt>
            {row.permission === "write" ? (
              <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Eye size={16} strokeWidth={2} aria-hidden="true" />
            )}
            <span>Permission</span>
          </dt>
          <dd>{row.permissionLabel}</dd>
        </div>
        <div>
          <dt><StatusIcon size={16} strokeWidth={2} aria-hidden="true" /><span>Status</span></dt>
          <dd>{row.statusLabel}</dd>
        </div>
        <div>
          <dt><Clock3 size={16} strokeWidth={2} aria-hidden="true" /><span>Last used</span></dt>
          <dd>{row.lastUsedLabel}</dd>
        </div>
        <div>
          <dt><Clock3 size={16} strokeWidth={2} aria-hidden="true" /><span>Expires</span></dt>
          <dd>{row.expiresLabel}</dd>
        </div>
      </dl>
      {row.revokeVisible ? (
        <span className="hostdeck-device-row__revoke">
          <button
            type="button"
            className="hostdeck-icon-button hostdeck-icon-button--danger"
            aria-label={`Revoke ${row.label}, ${row.cue}`}
            title={`Revoke ${row.label}`}
            aria-describedby={row.revokeDisabledReason === null ? undefined : reasonId}
            disabled={!row.revokeEnabled}
            onClick={(event) => onRevoke(event.currentTarget)}
          >
            <Trash2 size={19} strokeWidth={2} aria-hidden="true" />
          </button>
          {row.revokeDisabledReason === null ? null : (
            <span id={reasonId} className="hostdeck-visually-hidden">
              {row.revokeDisabledReason}
            </span>
          )}
        </span>
      ) : null}
    </li>
  );
}

function DeviceResult({ view }: Readonly<{ view: PairedDeviceManagementResultView }>) {
  const Icon = view.kind === "success"
    ? CheckCircle2
    : view.kind === "failure"
      ? ShieldAlert
      : AlertTriangle;
  return (
    <div
      className={`hostdeck-device-result hostdeck-tone--${view.tone}`}
      role={view.urgent ? "alert" : "status"}
      aria-atomic="true"
    >
      <Icon size={20} strokeWidth={2} aria-hidden="true" />
      <span><strong>{view.title}</strong><span>{view.detail}</span></span>
    </div>
  );
}

function deviceStatusIcon(status: PairedDeviceStatus) {
  switch (status) {
    case "active":
      return ShieldCheck;
    case "expired":
      return Clock3;
    case "revoked":
      return ShieldAlert;
  }
}

function focusSafeDevicePanelTarget(panel: HTMLElement | null): void {
  const outerDialog = panel?.closest<HTMLElement>('[role="dialog"]');
  const close = outerDialog?.querySelector<HTMLButtonElement>(
    'button[aria-label="Close Host and access"], button[aria-label="Close session actions"]'
  );
  if (close?.isConnected === true && !close.disabled) close.focus();
  else panel?.focus();
}

function runDeviceAction(
  controller: PairedDeviceManagementController,
  action: Promise<PairedDeviceManagementView>
): void {
  void action.catch((error: unknown) => {
    if (
      error instanceof HostDeckPairedDeviceManagementError &&
      (error.reason === "not_ready" || error.reason === "closed")
    ) {
      if (error.reason !== "closed") controller.synchronize();
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  });
}
